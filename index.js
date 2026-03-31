/**
 * Inline Image Generation Extension for SillyTavern
 * by aceeenvw — https://github.com/aceeenvw/notsosillynotsoimages
 *
 * Intercepts [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible, Gemini-compatible (nano-banana), and Naistera/Grok endpoints.
 */

const MODULE_NAME = 'inline_image_gen';

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const FETCH_TIMEOUT = IS_IOS ? 180000 : 300000; // 3 min iOS, 5 min desktop

function robustFetch(url, options = {}) {
    if (!IS_IOS) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
        return fetch(url, { ...options, signal: controller.signal })
            .then(r => { clearTimeout(timeoutId); return r; })
            .catch(e => {
                clearTimeout(timeoutId);
                if (e.name === 'AbortError') throw new Error('Request timed out after 5 minutes');
                throw e;
            });
    }
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(options.method || 'GET', url);
        xhr.timeout = FETCH_TIMEOUT;
        xhr.responseType = 'text';
        if (options.headers) {
            for (const [key, value] of Object.entries(options.headers)) {
                xhr.setRequestHeader(key, value);
            }
        }
        xhr.onload = () => {
            resolve({
                ok: xhr.status >= 200 && xhr.status < 300,
                status: xhr.status,
                statusText: xhr.statusText,
                text: () => Promise.resolve(xhr.responseText),
                json: () => Promise.resolve(JSON.parse(xhr.responseText)),
                headers: { get: (name) => xhr.getResponseHeader(name) }
            });
        };
        xhr.ontimeout = () => reject(new Error('Request timed out after 3 minutes (iOS)'));
        xhr.onerror = () => reject(new Error('Network error (iOS)'));
        xhr.onabort = () => reject(new Error('Request aborted (iOS)'));
        xhr.send(options.body || null);
    });
}

// Track messages currently being processed to prevent duplicate processing
const processingMessages = new Set();

// Cooldown: track recently-processed message IDs to prevent re-trigger loops
// caused by messageFormatting / innerHTML changes firing CHARACTER_MESSAGE_RENDERED again.
const recentlyProcessed = new Map(); // messageId → timestamp
const REPROCESS_COOLDOWN_MS = 5000; // ignore re-triggers within 5 seconds

// Global re-entry guard: absolute protection against stack overflow.
// If onMessageReceived is called while we're already inside onMessageReceived
// (for ANY message), something is recursing and we must bail.
let _eventHandlerDepth = 0;
const MAX_EVENT_HANDLER_DEPTH = 2; // allow 1 level of nesting, block deeper

// Periodically clean up stale entries to prevent memory leaks in long sessions
setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of recentlyProcessed) {
        if (now - ts > REPROCESS_COOLDOWN_MS * 2) recentlyProcessed.delete(id);
    }
}, 30000);

// Session generation stats
let sessionGenCount = 0;
let sessionErrorCount = 0;

function updateSessionStats() {
    const el = document.getElementById('iig_session_stats');
    if (!el) return;
    if (sessionGenCount === 0 && sessionErrorCount === 0) {
        el.textContent = '';
        return;
    }
    const parts = [];
    if (sessionGenCount > 0) parts.push(`${sessionGenCount} generated`);
    if (sessionErrorCount > 0) parts.push(`${sessionErrorCount} failed`);
    el.textContent = `Session: ${parts.join(' · ')}`;
}

// Log buffer for debugging
const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${timestamp}] [${level}] ${message}`;
    
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }
    
    if (level === 'ERROR') {
        console.error('[IIG]', ...args);
    } else if (level === 'WARN') {
        console.warn('[IIG]', ...args);
    } else {
        console.log('[IIG]', ...args);
    }
}

function exportLogs() {
    const logsText = logBuffer.join('\n');
    const blob = new Blob([logsText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iig-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Logs exported', 'Image Generation');
}

// Default settings
const defaultSettings = Object.freeze({
    enabled: true,
    apiType: 'openai', // 'openai' | 'gemini' | 'naistera'
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0, // No auto-retry by default — user clicks regenerate button
    retryDelay: 1000,
    // Nano-banana specific
    aspectRatio: '1:1', // "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
    imageSize: '1K', // "1K", "2K", "4K"
    // Naistera specific
    naisteraAspectRatio: '1:1',
    naisteraPreset: '', // '', 'digital', 'realism'
    // Flat reference storage (not per-character keyed — avoids reload timing bugs)
    charRef: { name: '', imageBase64: '' },
    userRef: { name: '', imageBase64: '' },
    npcReferences: [],
});

// Image model detection keywords
const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen'
];

// Video model keywords to exclude
const VIDEO_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo'
];

/**
 * Check if model ID is an image generation model
 */
function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    
    for (const kw of VIDEO_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return false;
    }
    
    if (mid.includes('vision') && mid.includes('preview')) return false;
    
    for (const kw of IMAGE_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return true;
    }
    
    return false;
}

/**
 * Check if model is Gemini/nano-banana type
 */
function isGeminiModel(modelId) {
    const mid = modelId.toLowerCase();
    return mid.includes('nano-banana');
}

/**
 * Get extension settings
 */
function getSettings() {
    const context = SillyTavern.getContext();
    
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    
    return context.extensionSettings[MODULE_NAME];
}

/**
 * Save settings (debounced) — for frequent UI changes like typing.
 * Also writes npcReferences to localStorage immediately as a mobile backup.
 */
function saveSettings() {
    const context = SillyTavern.getContext();
    // Try immediate global first, fall back to debounced
    if (typeof window.saveSettings === 'function') {
        try { window.saveSettings(); } catch(e) { context.saveSettingsDebounced(); }
    } else {
        context.saveSettingsDebounced();
    }
    persistRefsToLocalStorage();
}

function saveSettingsNow() {
    saveSettings();
}

const LS_KEY = 'iig_npc_refs_v3';

/**
 * localStorage = единственный надёжный способ хранить данные на мобильном.
 * Пишем только npcReferences — всё остальное не нужно бэкапить.
 */
function persistRefsToLocalStorage() {
    try {
        const settings = getSettings();
        const refs = JSON.parse(JSON.stringify(settings.npcReferences || {}));
        localStorage.setItem(LS_KEY, JSON.stringify(refs));
        iigLog('INFO', 'Refs saved to localStorage (' + JSON.stringify(refs).length + ' bytes)');
    } catch(e) {
        iigLog('WARN', 'persistRefsToLocalStorage failed:', e.message);
    }
}

/**
 * localStorage всегда перекрывает extensionSettings — это единственный
 * источник правды для ref-данных на мобильном.
 */
function restoreRefsFromLocalStorage() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) {
            iigLog('INFO', 'localStorage: no refs backup found');
            return;
        }
        const backup = JSON.parse(raw);
        if (!backup || typeof backup !== 'object') return;

        const settings = getSettings();
        // Всегда перезаписываем из localStorage — не проверяем условия
        settings.npcReferences = backup;
        iigLog('INFO', 'Refs restored from localStorage: ' + Object.keys(backup).length + ' char(s)');
    } catch(e) {
        iigLog('WARN', 'restoreRefsFromLocalStorage failed:', e.message);
    }
}

/**
 * Mobile safety net: flush to localStorage on visibilitychange/pagehide.
 */
function initMobileSaveListeners() {
    const flush = () => {
        persistRefsToLocalStorage();
        try { SillyTavern.getContext().saveSettingsDebounced(); } catch(e) {}
        if (typeof window.saveSettings === 'function') {
            try { window.saveSettings(); } catch(e) {}
        }
    };
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            iigLog('INFO', 'visibilitychange hidden: flushing to localStorage');
            flush();
        }
    });
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    iigLog('INFO', 'Mobile save listeners registered');
}

/**
 * Get the character key used for per-character references storage.
 */
/**
 * Get refs directly from flat settings (no per-character keying).
 * Flat structure like MommySTdxn — saves reliably on mobile.
 */
function getCurrentCharacterRefs() {
    const settings = getSettings();
    if (!settings.charRef) settings.charRef = { name: '', imageBase64: '', imagePath: '' };
    if (!settings.userRef) settings.userRef = { name: '', imageBase64: '', imagePath: '' };
    if (!Array.isArray(settings.npcReferences)) settings.npcReferences = [];
    while (settings.npcReferences.length < 4) {
        settings.npcReferences.push({ name: '', imageBase64: '', imagePath: '' });
    }
    return settings;
}

function getCurrentCharacterNpcs() {
    return getCurrentCharacterRefs().npcReferences;
}

/**
 * Match NPC references against the generation prompt.
 * Matching is case-insensitive, partial (any word >2 chars from the name).
 */
function matchNpcReferences(prompt, npcList) {
    if (!prompt || !npcList || npcList.length === 0) return [];

    const lowerPrompt = prompt.toLowerCase();
    const matched = [];

    for (const npc of npcList) {
        if (!npc || !npc.name || (!npc.imagePath && !npc.imageBase64 && !npc.imageData)) continue;

        const words = npc.name.trim().split(/\s+/).filter(w => w.length > 2);
        if (words.length === 0) continue;

        const isMatch = words.some(word => lowerPrompt.includes(word.toLowerCase()));
        if (isMatch) {
            matched.push({ name: npc.name, imageBase64: npc.imageBase64, imagePath: npc.imagePath });
        }
    }

    return matched;
}

/**
 * Fetch models list from endpoint
 */
async function fetchModels() {
    const settings = getSettings();
    
    if (!settings.endpoint || !settings.apiKey) {
        console.warn('[IIG] Cannot fetch models: endpoint or API key not set');
        return [];
    }
    
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/models`;
    
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        const models = data.data || [];
        
        return models.filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        console.error('[IIG] Failed to fetch models:', error);
        toastr.error(`Failed to load models: ${error.message}`, 'Image Generation');
        return [];
    }
}

/**
 * Resize and compress a base64 image to reduce request payload size.
 * BUG FIX: Uses data URL from FileReader directly rather than assuming PNG,
 * so JPEG/WebP uploads are loaded correctly before canvas compression.
 */
function compressBase64Image(rawBase64, maxDim = 768, quality = 0.8) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
                const scale = maxDim / Math.max(w, h);
                w = Math.round(w * scale);
                h = Math.round(h * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            const b64 = dataUrl.split(',')[1];
            iigLog('INFO', `Compressed reference image: ${img.width}x${img.height} -> ${w}x${h}, ~${Math.round(b64.length / 1024)}KB`);
            resolve(b64);
        };
        img.onerror = () => reject(new Error('Failed to load image for compression'));
        // BUG FIX: Try JPEG first since most uploads are photos; fall back to PNG
        // The browser will handle any valid image data regardless of declared MIME
        img.src = 'data:image/jpeg;base64,' + rawBase64;
    });
}


async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to base64:', error);
        return null;
    }
}

async function imageUrlToDataUrl(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();

        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to data URL:', error);
        return null;
    }
}

/**
 * Save base64 image to file via SillyTavern API
 */
async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
        throw new Error('Invalid data URL format');
    }
    
    const format = match[1];
    const base64Data = match[2];
    
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `iig_${timestamp}`;
    
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            image: base64Data,
            format: format,
            ch_name: charName,
            filename: filename
        })
    });
    
    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `Upload failed: ${response.status}`);
    }
    
    const result = await response.json();
    iigLog('INFO', 'Image saved to:', result.path);
    return result.path;
}

/**
 * Save a reference image (charRef / userRef / NPC) as a real file on the
 * SillyTavern server — same API as generated images.
 * Returns the server path string (e.g. "/user/images/...").
 * Storing only the PATH in extensionSettings keeps the JSON tiny and avoids
 * the silent save-failure that happens when base64 blobs bloat the settings.
 */
async function saveRefImageToFile(base64Data, label) {
    const context = SillyTavern.getContext();
    const safeName = label.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
    const filename = `iig_ref_${safeName}_${Date.now()}`;
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            image: base64Data,
            format: 'jpeg',
            ch_name: 'iig_refs',
            filename: filename
        })
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown' }));
        throw new Error(err.error || `Upload failed: ${response.status}`);
    }
    const result = await response.json();
    iigLog('INFO', `Ref image saved to: ${result.path}`);
    return result.path;
}

/**
 * Load a reference image from server path → base64 string.
 * Used when building the generation request payload.
 */
async function loadRefImageAsBase64(path) {
    try {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch(e) {
        iigLog('WARN', `loadRefImageAsBase64 failed for ${path}:`, e.message);
        return null;
    }
}

/**
 * Generate image via OpenAI-compatible endpoint
 */
async function generateImageOpenAI(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;
    
    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    
    let size = settings.size;
    if (options.aspectRatio) {
        if (options.aspectRatio === '16:9') size = '1792x1024';
        else if (options.aspectRatio === '9:16') size = '1024x1792';
        else if (options.aspectRatio === '1:1') size = '1024x1024';
    }
    
    const body = {
        model: settings.model,
        prompt: fullPrompt,
        n: 1,
        size: size,
        quality: options.quality || settings.quality,
        response_format: 'b64_json'
    };
    
    if (referenceImages.length > 0) {
        body.image = `data:image/png;base64,${referenceImages[0]}`;
    }
    
    const response = await robustFetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }
    
    const result = await response.json();
    
    const dataList = result.data || [];
    if (dataList.length === 0) {
        if (result.url) return result.url;
        throw new Error('No image data in response');
    }
    
    const imageObj = dataList[0];
    
    if (imageObj.b64_json) {
        return `data:image/png;base64,${imageObj.b64_json}`;
    }
    
    return imageObj.url;
}

// Valid aspect ratios for Gemini/nano-banana
const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

/**
 * Generate image via Gemini-compatible endpoint (nano-banana)
 */
async function generateImageGemini(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
    
    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
        iigLog('WARN', `Invalid aspect_ratio "${aspectRatio}", falling back to settings or default`);
        aspectRatio = VALID_ASPECT_RATIOS.includes(settings.aspectRatio) ? settings.aspectRatio : '1:1';
    }
    
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) {
        iigLog('WARN', `Invalid image_size "${imageSize}", falling back to settings or default`);
        imageSize = VALID_IMAGE_SIZES.includes(settings.imageSize) ? settings.imageSize : '1K';
    }
    
    iigLog('INFO', `Using aspect ratio: ${aspectRatio}, image size: ${imageSize}`);
    
    const parts = [];
    
    for (const imgB64 of referenceImages.slice(0, 4)) {
        parts.push({
            inlineData: {
                mimeType: 'image/jpeg',
                data: imgB64
            }
        });
    }
    
    let fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    
    if (referenceImages.length > 0) {
        const refInstruction = `[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]`;
        fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
    }
    
    parts.push({ text: fullPrompt });
    
    iigLog('INFO', `Gemini request: ${referenceImages.length} reference image(s) + prompt (${fullPrompt.length} chars)`);
    
    const body = {
        contents: [{
            role: 'user',
            parts: parts
        }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
                aspectRatio: aspectRatio,
                imageSize: imageSize
            }
        }
    };
    
    const bodyStr = JSON.stringify(body);
    iigLog('INFO', `Gemini request config: model=${model}, aspectRatio=${aspectRatio}, imageSize=${imageSize}, promptLength=${fullPrompt.length}, refImages=${referenceImages.length}, payloadSize=${Math.round(bodyStr.length/1024)}KB`);
    
    const response = await robustFetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }
    
    const result = await response.json();
    
    const candidates = result.candidates || [];
    if (candidates.length === 0) {
        throw new Error('No candidates in response');
    }
    
    const responseParts = candidates[0].content?.parts || [];
    
    for (const part of responseParts) {
        if (part.inlineData) {
            return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
        if (part.inline_data) {
            return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
        }
    }
    
    throw new Error('No image found in Gemini response');
}

/**
 * Generate image via Naistera custom endpoint
 */
async function generateImageNaistera(prompt, style, options = {}) {
    const settings = getSettings();
    const endpoint = settings.endpoint.replace(/\/$/, '');
    const url = endpoint.endsWith('/api/generate') ? endpoint : `${endpoint}/api/generate`;

    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;

    const aspectRatio = options.aspectRatio || settings.naisteraAspectRatio || '1:1';
    const preset = options.preset || settings.naisteraPreset || null;
    const referenceImages = options.referenceImages || [];

    const body = {
        prompt: fullPrompt,
        aspect_ratio: aspectRatio,
    };
    if (preset) body.preset = preset;
    if (referenceImages.length > 0) body.reference_images = referenceImages.slice(0, 4);

    const response = await robustFetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }

    const result = await response.json();
    if (!result?.data_url) {
        throw new Error('No data_url in response');
    }

    return result.data_url;
}

/**
 * Validate settings before generation
 */
function validateSettings() {
    const settings = getSettings();
    const errors = [];
    
    if (!settings.endpoint) {
        errors.push('Endpoint URL not configured');
    }
    if (!settings.apiKey) {
        errors.push('API key not configured');
    }
    if (settings.apiType !== 'naistera' && !settings.model) {
        errors.push('Model not selected');
    }
    
    if (errors.length > 0) {
        throw new Error(`Settings error: ${errors.join(', ')}`);
    }
}

/**
 * Sanitize text for safe HTML display
 */
function sanitizeForHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Generate image with retry logic
 */
async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();
    
    const settings = getSettings();
    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;
    
    // Collect reference images using unified refs system
    const referenceImages = [];
    const referenceDataUrls = [];

    // Gemini/nano-banana references: base64 only
    if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
        const refs = getCurrentCharacterRefs();

        const getB64 = async (ref, label) => {
            if (ref?.imagePath) {
                const b64 = await loadRefImageAsBase64(ref.imagePath);
                if (b64) { iigLog('INFO', `${label}: loaded from path`); return b64; }
            }
            if (ref?.imageBase64) return ref.imageBase64;
            if (ref?.imageData) return ref.imageData;
            return null;
        };

        const charB64 = await getB64(refs.charRef, 'charRef');
        if (charB64) referenceImages.push(charB64);

        const userB64 = await getB64(refs.userRef, 'userRef');
        if (userB64) referenceImages.push(userB64);

        const matchedNpcs = matchNpcReferences(prompt, refs.npcReferences || []);
        for (const npc of matchedNpcs) {
            if (referenceImages.length >= 4) break;
            const b64 = npc.imagePath ? await loadRefImageAsBase64(npc.imagePath) : (npc.imageBase64 || npc.imageData);
            if (b64) { referenceImages.push(b64); iigLog('INFO', `NPC matched: ${npc.name}`); }
        }
    }

    // Naistera references: data URLs
    if (settings.apiType === 'naistera') {
        const refs = getCurrentCharacterRefs();

        const getDataUrl = async (ref) => {
            if (ref?.imagePath) {
                const b64 = await loadRefImageAsBase64(ref.imagePath);
                if (b64) return 'data:image/jpeg;base64,' + b64;
            }
            const b64 = ref?.imageBase64 || ref?.imageData;
            if (b64) return 'data:image/jpeg;base64,' + b64;
            return null;
        };

        const charUrl = await getDataUrl(refs.charRef);
        if (charUrl) referenceDataUrls.push(charUrl);

        const userUrl = await getDataUrl(refs.userRef);
        if (userUrl) referenceDataUrls.push(userUrl);

        const matchedNpcs = matchNpcReferences(prompt, refs.npcReferences || []);
        for (const npc of matchedNpcs) {
            if (referenceDataUrls.length >= 4) break;
            const url = await getDataUrl(npc);
            if (url) { referenceDataUrls.push(url); iigLog('INFO', `NPC (naistera): ${npc.name}`); }
        }
    }
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Generating${attempt > 0 ? ` (retry ${attempt}/${maxRetries})` : ''}...`);
            
            if (settings.apiType === 'naistera') {
                return await generateImageNaistera(prompt, style, { ...options, referenceImages: referenceDataUrls });
            } else if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
                return await generateImageGemini(prompt, style, referenceImages, options);
            } else {
                return await generateImageOpenAI(prompt, style, referenceImages, options);
            }
        } catch (error) {
            lastError = error;
            console.error(`[IIG] Generation attempt ${attempt + 1} failed:`, error);
            
            const isRetryable = error.message?.includes('429') ||
                               error.message?.includes('503') ||
                               error.message?.includes('502') ||
                               error.message?.includes('504') ||
                               error.message?.includes('timeout') ||
                               error.message?.includes('network');
            
            if (!isRetryable || attempt === maxRetries) {
                break;
            }
            
            const delay = baseDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError;
}

/**
 * Check if a file exists on the server
 */
async function checkFileExists(path) {
    try {
        const response = await fetch(path, { method: 'HEAD' });
        return response.ok;
    } catch (e) {
        return false;
    }
}

/**
 * Parse image generation tags from message text
 * Supports two formats:
 * 1. NEW: <img data-iig-instruction='{"style":"...","prompt":"..."}' src="[IMG:GEN]">
 * 2. LEGACY: [IMG:GEN:{"style":"...","prompt":"..."}]
 */
async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];
    
    // === NEW FORMAT: <img data-iig-instruction="{...}" src="[IMG:GEN]"> ===
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;
    
    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;
        
        let imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) {
            searchPos = markerPos + 1;
            continue;
        }
        
        const afterMarker = markerPos + imgTagMarker.length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) {
            searchPos = markerPos + 1;
            continue;
        }
        
        // Find matching closing brace using brace counting
        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;
        
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            
            if (char === '\\' && inString) {
                escapeNext = true;
                continue;
            }
            
            if (char === '"') {
                inString = !inString;
                continue;
            }
            
            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }
        
        if (jsonEnd === -1) {
            searchPos = markerPos + 1;
            continue;
        }
        
        let imgEnd = text.indexOf('>', jsonEnd);
        if (imgEnd === -1) {
            searchPos = markerPos + 1;
            continue;
        }
        imgEnd++;
        
        const fullImgTag = text.substring(imgStart, imgEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);
        
        const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
        const srcValue = srcMatch ? srcMatch[1] : '';
        
        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg');
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;
        
        // Skip error images unless force regeneration
        if (hasErrorImage && !forceAll) {
            iigLog('INFO', `Skipping error image (use regenerate button): ${srcValue.substring(0, 50)}`);
            searchPos = imgEnd;
            continue;
        }
        
        if (forceAll) {
            needsGeneration = true;
            iigLog('INFO', `Force regeneration mode: including ${srcValue.substring(0, 30)}`);
        } else if (hasMarker || !srcValue) {
            needsGeneration = true;
        } else if (hasPath && checkExistence) {
            const exists = await checkFileExists(srcValue);
            if (!exists) {
                iigLog('WARN', `File does not exist (LLM hallucination?): ${srcValue}`);
                needsGeneration = true;
            } else {
                iigLog('INFO', `Skipping existing image: ${srcValue.substring(0, 50)}`);
            }
        } else if (hasPath) {
            iigLog('INFO', `Skipping path (no existence check): ${srcValue.substring(0, 50)}`);
            searchPos = imgEnd;
            continue;
        }
        
        if (!needsGeneration) {
            searchPos = imgEnd;
            continue;
        }
        
        try {
            let normalizedJson = instructionJson
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/&#39;/g, "'")
                .replace(/&#34;/g, '"')
                .replace(/&amp;/g, '&');
            
            const data = JSON.parse(normalizedJson);
            
            tags.push({
                fullMatch: fullImgTag,
                index: imgStart,
                style: data.style || '',
                prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: true,
                existingSrc: hasPath ? srcValue : null
            });
            
            iigLog('INFO', `Found NEW format tag: ${data.prompt?.substring(0, 50)}`);
        } catch (e) {
            iigLog('WARN', `Failed to parse instruction JSON: ${instructionJson.substring(0, 100)}`, e.message);
        }
        
        searchPos = imgEnd;
    }
    
    // === LEGACY FORMAT: [IMG:GEN:{...}] ===
    const marker = '[IMG:GEN:';
    let searchStart = 0;
    
    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;
        
        const jsonStart = markerIndex + marker.length;
        
        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;
        
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            
            if (char === '\\' && inString) {
                escapeNext = true;
                continue;
            }
            
            if (char === '"') {
                inString = !inString;
                continue;
            }
            
            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }
        
        if (jsonEnd === -1) {
            searchStart = jsonStart;
            continue;
        }
        
        const jsonStr = text.substring(jsonStart, jsonEnd);
        
        const afterJson = text.substring(jsonEnd);
        if (!afterJson.startsWith(']')) {
            searchStart = jsonEnd;
            continue;
        }
        
        const tagOnly = text.substring(markerIndex, jsonEnd + 1);
        
        try {
            const normalizedJson = jsonStr.replace(/'/g, '"');
            const data = JSON.parse(normalizedJson);
            
            tags.push({
                fullMatch: tagOnly,
                index: markerIndex,
                style: data.style || '',
                prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: false
            });
            
            iigLog('INFO', `Found LEGACY format tag: ${data.prompt?.substring(0, 50)}`);
        } catch (e) {
            iigLog('WARN', `Failed to parse legacy tag JSON: ${jsonStr.substring(0, 100)}`, e.message);
        }
        
        searchStart = jsonEnd + 1;
    }
    
    return tags;
}

/**
 * Resolve the error image path dynamically based on extension install location.
 * BUG FIX (v2.0.1): SillyTavern 1.17.0 changed how scripts are loaded (webpack
 * bundling, new splash screen). The old script[src] detection may not find our
 * script tag at load time. Now we also check CSS link elements and use multiple
 * fallback strategies. Additionally, the path is resolved lazily on first use
 * (not at module load time) so the DOM has time to settle.
 */
let _cachedErrorImagePath = null;

function getErrorImagePath() {
    if (_cachedErrorImagePath) return _cachedErrorImagePath;

    // Strategy 1: find our script element
    const scripts = document.querySelectorAll('script[src*="index.js"]');
    for (const script of scripts) {
        const src = script.getAttribute('src') || '';
        if (src.includes('inline_image_gen') || src.includes('sillyimages') || src.includes('notsosillynotsoimages')) {
            const basePath = src.substring(0, src.lastIndexOf('/'));
            _cachedErrorImagePath = `${basePath}/error.svg`;
            return _cachedErrorImagePath;
        }
    }

    // Strategy 2: find our CSS link element (style.css is always loaded by ST)
    const links = document.querySelectorAll('link[rel="stylesheet"][href*="style.css"]');
    for (const link of links) {
        const href = link.getAttribute('href') || '';
        if (href.includes('sillyimages') || href.includes('notsosillynotsoimages') || href.includes('inline_image_gen')) {
            const basePath = href.substring(0, href.lastIndexOf('/'));
            _cachedErrorImagePath = `${basePath}/error.svg`;
            return _cachedErrorImagePath;
        }
    }

    // Strategy 3: detect from any DOM element our extension created
    const settingsEl = document.querySelector('.iig-settings');
    if (settingsEl) {
        // Walk up to find our base URL from any loaded resource
        const anyImg = document.querySelector('img.iig-error-image[src], img.iig-ref-thumb[src]');
        if (anyImg?.src) {
            const basePath = anyImg.src.substring(0, anyImg.src.lastIndexOf('/'));
            _cachedErrorImagePath = `${basePath}/error.svg`;
            return _cachedErrorImagePath;
        }
    }

    // Strategy 4: try both possible folder names and pick whichever exists
    // This covers renamed installs and fresh installs alike
    const possiblePaths = [
        '/scripts/extensions/third-party/notsosillynotsoimages/error.svg',
        '/scripts/extensions/third-party/sillyimages/error.svg',
    ];
    // We can't do async here, so return the first candidate and verify later
    _cachedErrorImagePath = possiblePaths[0];

    // Async verification: try to HEAD both paths and cache the correct one
    (async () => {
        for (const path of possiblePaths) {
            try {
                const resp = await fetch(path, { method: 'HEAD' });
                if (resp.ok) {
                    _cachedErrorImagePath = path;
                    iigLog('INFO', `error.svg resolved to: ${path}`);
                    return;
                }
            } catch (e) { /* ignore */ }
        }
        iigLog('WARN', 'error.svg not found at any expected path');
    })();

    return _cachedErrorImagePath;
}

/**
 * Create loading placeholder element
 */
function createLoadingPlaceholder(tagId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = `
        <div class="iig-spinner-wrap">
            <div class="iig-spinner"></div>
        </div>
        <div class="iig-status">Generating image...</div>
        <div class="iig-timer"></div>
    `;
    const timerEl = placeholder.querySelector('.iig-timer');
    const startTime = Date.now();
    const tSec = FETCH_TIMEOUT / 1000;
    placeholder._timerInterval = setInterval(() => {
        const el = Math.floor((Date.now() - startTime) / 1000);
        if (el >= tSec) { timerEl.textContent = "Timeout..."; clearInterval(placeholder._timerInterval); return; }
        const m = Math.floor(el/60), s = el%60;
        timerEl.textContent = `${m}:${String(s).padStart(2,"0")} / ${Math.floor(tSec/60)}:00${IS_IOS ? " (iOS)" : ""}`;
    }, 1000);
    return placeholder;
}

/**
 * Create error placeholder element — shows error.svg, no click handlers.
 * User uses the regenerate button in message menu to retry.
 */
function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = getErrorImagePath();
    img.alt = 'Generation error';
    img.title = `Error: ${errorMessage}`;
    img.dataset.tagId = tagId;
    
    // BUG FIX: Use a more robust extraction that handles both single and double quotes
    if (tagInfo.fullMatch) {
        const instructionMatch = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(?:(['"]))([\s\S]*?)\1/i)
            || tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*([{][\s\S]*?[}])(?:\s|>)/i);
        if (instructionMatch) {
            const instructionValue = instructionMatch[2] || instructionMatch[1];
            img.setAttribute('data-iig-instruction', instructionValue);
        }
    }
    
    return img;
}

/**
 * Process image tags in a message
 */
async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    
    if (!settings.enabled) return;
    
    if (processingMessages.has(messageId)) {
        iigLog('WARN', `Message ${messageId} is already being processed, skipping`);
        return;
    }
    
    // Cooldown guard: if we just finished processing this message, skip.
    // This prevents the re-render loop where messageFormatting/innerHTML
    // re-fires CHARACTER_MESSAGE_RENDERED right after we finish.
    const lastProcessed = recentlyProcessed.get(messageId);
    if (lastProcessed && (Date.now() - lastProcessed) < REPROCESS_COOLDOWN_MS) {
        iigLog('INFO', `Message ${messageId} was recently processed (${Date.now() - lastProcessed}ms ago), skipping re-trigger`);
        return;
    }
    
    const message = context.chat[messageId];
    if (!message || message.is_user) return;
    
    const tags = await parseImageTags(message.mes, { checkExistence: true });
    iigLog('INFO', `parseImageTags returned: ${tags.length} tags`);
    if (tags.length > 0) {
        iigLog('INFO', `First tag: ${JSON.stringify(tags[0]).substring(0, 200)}`);
    }
    if (tags.length === 0) {
        iigLog('INFO', 'No tags found by parser');
        return;
    }
    
    processingMessages.add(messageId);
    iigLog('INFO', `Found ${tags.length} image tag(s) in message ${messageId}`);
    toastr.info(`Found ${tags.length} tag(s). Generating...`, 'Image Generation', { timeOut: 3000 });
    
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        console.error('[IIG] Message element not found for ID:', messageId);
        toastr.error('Could not find message element', 'Image Generation');
        processingMessages.delete(messageId);
        return;
    }
    
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) {
        processingMessages.delete(messageId);
        return;
    }
    
    const processTag = async (tag, index) => {
        const tagId = `iig-${messageId}-${index}`;
        
        iigLog('INFO', `Processing tag ${index}: ${tag.fullMatch.substring(0, 50)}`);
        
        const loadingPlaceholder = createLoadingPlaceholder(tagId);
        let targetElement = null;
        
        if (tag.isNewFormat) {
            const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            iigLog('INFO', `Searching for img element. Found ${allImgs.length} img[data-iig-instruction] elements in DOM`);
            
            const searchPrompt = tag.prompt.substring(0, 30);
            iigLog('INFO', `Searching for prompt starting with: "${searchPrompt}"`);
            
            for (const img of allImgs) {
                const instruction = img.getAttribute('data-iig-instruction');
                const src = img.getAttribute('src') || '';
                iigLog('INFO', `DOM img - src: "${src.substring(0, 50)}", instruction (first 100): "${instruction?.substring(0, 100)}"`);
                
                if (instruction) {
                    const decodedInstruction = instruction
                        .replace(/&quot;/g, '"')
                        .replace(/&apos;/g, "'")
                        .replace(/&#39;/g, "'")
                        .replace(/&#34;/g, '"')
                        .replace(/&amp;/g, '&');
                    
                    const normalizedSearchPrompt = searchPrompt
                        .replace(/&quot;/g, '"')
                        .replace(/&apos;/g, "'")
                        .replace(/&#39;/g, "'")
                        .replace(/&#34;/g, '"')
                        .replace(/&amp;/g, '&');
                    
                    if (decodedInstruction.includes(normalizedSearchPrompt)) {
                        iigLog('INFO', `Found img element via decoded instruction match`);
                        targetElement = img;
                        break;
                    }
                    
                    try {
                        const normalizedJson = decodedInstruction.replace(/'/g, '"');
                        const instructionData = JSON.parse(normalizedJson);
                        if (instructionData.prompt && instructionData.prompt.substring(0, 30) === tag.prompt.substring(0, 30)) {
                            iigLog('INFO', `Found img element via JSON prompt match`);
                            targetElement = img;
                            break;
                        }
                    } catch (e) {
                        // JSON parse failed, continue
                    }
                    
                    if (instruction.includes(searchPrompt)) {
                        iigLog('INFO', `Found img element via raw instruction match`);
                        targetElement = img;
                        break;
                    }
                }
            }
            
            if (!targetElement) {
                iigLog('INFO', `Prompt matching failed, trying src marker matching...`);
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') {
                        iigLog('INFO', `Found img element with generation marker in src: "${src}"`);
                        targetElement = img;
                        break;
                    }
                }
            }
            
            if (!targetElement) {
                iigLog('INFO', `Trying broader img search...`);
                const allImgsInMes = mesTextEl.querySelectorAll('img');
                for (const img of allImgsInMes) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) {
                        iigLog('INFO', `Found img via broad search with marker src: "${src.substring(0, 50)}"`);
                        targetElement = img;
                        break;
                    }
                }
            }
        } else {
            // LEGACY FORMAT
            const tagEscaped = tag.fullMatch
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                .replace(/"/g, '(?:"|&quot;)');
            const tagRegex = new RegExp(tagEscaped, 'g');
            
            const beforeReplace = mesTextEl.innerHTML;
            mesTextEl.innerHTML = mesTextEl.innerHTML.replace(
                tagRegex,
                `<span data-iig-placeholder="${tagId}"></span>`
            );
            
            if (beforeReplace !== mesTextEl.innerHTML) {
                targetElement = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
                iigLog('INFO', `Legacy tag replaced with placeholder span`);
            }
            
            if (!targetElement) {
                const allImgs = mesTextEl.querySelectorAll('img');
                for (const img of allImgs) {
                    if (img.src && img.src.includes('[IMG:GEN:')) {
                        targetElement = img;
                        iigLog('INFO', `Found img with legacy tag in src`);
                        break;
                    }
                }
            }
        }
        
        if (targetElement) {
            const parent = targetElement.parentElement;
            if (parent) {
                const parentStyle = window.getComputedStyle(parent);
                if (parentStyle.display === 'flex' || parentStyle.display === 'grid') {
                    loadingPlaceholder.style.alignSelf = 'center';
                }
            }
            targetElement.replaceWith(loadingPlaceholder);
            iigLog('INFO', `Loading placeholder shown (replaced target element)`);
        } else {
            iigLog('WARN', `Could not find target element, appending placeholder as fallback`);
            mesTextEl.appendChild(loadingPlaceholder);
        }
        
        const statusEl = loadingPlaceholder.querySelector('.iig-status');
        
        try {
            const dataUrl = await generateImageWithRetry(
                tag.prompt,
                tag.style,
                (status) => { statusEl.textContent = status; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset }
            );
            
            statusEl.textContent = 'Saving...';
            const imagePath = await saveImageToFile(dataUrl);
            
            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
            
            if (tag.isNewFormat) {
                const instructionMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (instructionMatch) {
                    img.setAttribute('data-iig-instruction', instructionMatch[2]);
                }
            }
            
            if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
            loadingPlaceholder.replaceWith(img);
            
            if (tag.isNewFormat) {
                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);
            } else {
                const completionMarker = `[IMG:✓:${imagePath}]`;
                message.mes = message.mes.replace(tag.fullMatch, completionMarker);
            }
            
            iigLog('INFO', `Successfully generated image for tag ${index}`);
            sessionGenCount++;
            updateSessionStats();
            toastr.success(`Image ${index + 1}/${tags.length} ready`, 'Image Generation', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed to generate image for tag ${index}:`, error.message);
            
            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
            loadingPlaceholder.replaceWith(errorPlaceholder);
            
            if (tag.isNewFormat) {
                const errorTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${getErrorImagePath()}"`);
                message.mes = message.mes.replace(tag.fullMatch, errorTag);
            } else {
                const errorMarker = `[IMG:ERROR:${error.message.substring(0, 50)}]`;
                message.mes = message.mes.replace(tag.fullMatch, errorMarker);
            }
            iigLog('INFO', `Marked tag as failed in message.mes`);
            sessionErrorCount++;
            updateSessionStats();
            
            toastr.error(`Generation error: ${error.message}`, 'Image Generation');
        }
    };
    
    try {
        await Promise.all(tags.map((tag, index) => processTag(tag, index)));
    } finally {
        try {
            iigLog('INFO', `Finished processing message ${messageId}`);
            
            // Mark this message as recently processed BEFORE any re-render
            // to prevent CHARACTER_MESSAGE_RENDERED from re-triggering us.
            recentlyProcessed.set(messageId, Date.now());
            
            await context.saveChat();
            
            // NOTE: Removed messageFormatting + innerHTML re-render.
            // This was causing "Maximum call stack size exceeded" because:
            //   1. messageFormatting() can internally trigger deep recursion
            //      when processing complex HTML with embedded <img> tags
            //   2. Setting innerHTML can fire MutationObservers / ST events
            //      that re-trigger CHARACTER_MESSAGE_RENDERED → infinite loop
            // The images are already in the DOM (replaced loading placeholders),
            // and message.mes is updated — SillyTavern will re-format on next
            // natural render cycle (swipe, reload, etc.).
        } finally {
            processingMessages.delete(messageId);
        }
    }
}

/**
 * Regenerate all images in a message (user-triggered).
 * BUG FIX: Now correctly targets each tag's corresponding img element by index
 * instead of always grabbing the first img[data-iig-instruction] in the message.
 */
async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    
    if (!message) {
        toastr.error('Message not found', 'Image Generation');
        return;
    }
    
    const tags = await parseImageTags(message.mes, { forceAll: true });
    
    if (tags.length === 0) {
        toastr.warning('No tags to regenerate', 'Image Generation');
        return;
    }
    
    iigLog('INFO', `Regenerating ${tags.length} images in message ${messageId}`);
    toastr.info(`Regenerating ${tags.length} image(s)...`, 'Image Generation');
    
    processingMessages.add(messageId);
    
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        processingMessages.delete(messageId);
        return;
    }
    
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) {
        processingMessages.delete(messageId);
        return;
    }
    
    for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const tagId = `iig-regen-${messageId}-${index}`;
        
        try {
            // BUG FIX: Get ALL instruction images and pick by index, not just the first one
            const allInstructionImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            const existingImg = allInstructionImgs[index] || null;
            
            if (existingImg) {
                const instruction = existingImg.getAttribute('data-iig-instruction');
                
                const loadingPlaceholder = createLoadingPlaceholder(tagId);
                existingImg.replaceWith(loadingPlaceholder);
                
                const statusEl = loadingPlaceholder.querySelector('.iig-status');
                
                const dataUrl = await generateImageWithRetry(
                    tag.prompt,
                    tag.style,
                    (status) => { statusEl.textContent = status; },
                    { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset }
                );
                
                statusEl.textContent = 'Saving...';
                const imagePath = await saveImageToFile(dataUrl);
                
                const img = document.createElement('img');
                img.className = 'iig-generated-image';
                img.src = imagePath;
                img.alt = tag.prompt;
                if (instruction) {
                    img.setAttribute('data-iig-instruction', instruction);
                }
                if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
                loadingPlaceholder.replaceWith(img);
                
                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);
                
                toastr.success(`Image ${index + 1}/${tags.length} ready`, 'Image Generation', { timeOut: 2000 });
            }
        } catch (error) {
            iigLog('ERROR', `Regeneration failed for tag ${index}:`, error.message);
            toastr.error(`Error: ${error.message}`, 'Image Generation');
        }
    }
    
    processingMessages.delete(messageId);
    recentlyProcessed.set(messageId, Date.now());
    await context.saveChat();
    iigLog('INFO', `Regeneration complete for message ${messageId}`);
}

/**
 * Add regenerate button to message extra menu (three dots)
 */
function addRegenerateButton(messageElement, messageId) {
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    
    const extraMesButtons = messageElement.querySelector('.extraMesButtons');
    if (!extraMesButtons) return;
    
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Regenerate images';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await regenerateMessageImages(messageId);
    });
    
    extraMesButtons.appendChild(btn);
}

/**
 * Add regenerate buttons to all existing AI messages in chat
 */
function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    const messageElements = document.querySelectorAll('#chat .mes');
    let addedCount = 0;
    
    for (const messageElement of messageElements) {
        const mesId = messageElement.getAttribute('mesid');
        if (mesId === null) continue;
        
        const messageId = parseInt(mesId, 10);
        const message = context.chat[messageId];
        
        if (message && !message.is_user) {
            addRegenerateButton(messageElement, messageId);
            addedCount++;
        }
    }
    
    iigLog('INFO', `Added regenerate buttons to ${addedCount} existing messages`);
}

/**
 * Handle CHARACTER_MESSAGE_RENDERED event
 */
async function onMessageReceived(messageId) {
    // Circuit breaker: prevent stack overflow from recursive event re-triggering.
    // SillyTavern 1.17.0 can emit CHARACTER_MESSAGE_RENDERED from multiple paths
    // (finalizeIntermediaryMessage, onFinishStreaming, onErrorStreaming, saveReply)
    // and any of those paths could be triggered while we're still processing.
    if (_eventHandlerDepth >= MAX_EVENT_HANDLER_DEPTH) {
        iigLog('WARN', `Blocked recursive onMessageReceived (depth=${_eventHandlerDepth}) for message ${messageId}`);
        return;
    }
    _eventHandlerDepth++;
    
    try {
        iigLog('INFO', `onMessageReceived: ${messageId}`);
        
        const settings = getSettings();
        if (!settings.enabled) {
            iigLog('INFO', 'Extension disabled, skipping');
            return;
        }
        
        const context = SillyTavern.getContext();
        
        const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!messageElement) return;
        
        addRegenerateButton(messageElement, messageId);
        
        await processMessageTags(messageId);
    } finally {
        _eventHandlerDepth--;
    }
}

/**
 * Render all reference slots (char, user, 4 NPCs) in the settings panel.
 */
function renderRefSlots() {
    const settings = getCurrentCharacterRefs();

    const setThumb = (slot, ref) => {
        const thumb = slot?.querySelector('.iig-ref-thumb');
        const wrap = slot?.querySelector('.iig-ref-thumb-wrap');
        if (!thumb) return;
        if (ref?.imagePath) { thumb.src = ref.imagePath; }
        else if (ref?.imageBase64) { thumb.src = 'data:image/jpeg;base64,' + ref.imageBase64; }
        else if (ref?.imageData) { thumb.src = 'data:image/jpeg;base64,' + ref.imageData; }
        else { thumb.src = ''; }
        // Toggle has-image class for visual state
        if (wrap) wrap.classList.toggle('has-image', !!(ref?.imagePath || ref?.imageBase64 || ref?.imageData));
    };

    const charSlot = document.querySelector('.iig-ref-slot[data-ref-type="char"]');
    if (charSlot) {
        setThumb(charSlot, settings.charRef);
        charSlot.querySelector('.iig-ref-name').value = settings.charRef?.name || '';
    }

    const userSlot = document.querySelector('.iig-ref-slot[data-ref-type="user"]');
    if (userSlot) {
        setThumb(userSlot, settings.userRef);
        userSlot.querySelector('.iig-ref-name').value = settings.userRef?.name || '';
    }

    for (let i = 0; i < 4; i++) {
        const slot = document.querySelector(`.iig-ref-slot[data-ref-type="npc"][data-npc-index="${i}"]`);
        if (!slot) continue;
        const npc = settings.npcReferences[i] || null;
        setThumb(slot, npc);
        slot.querySelector('.iig-ref-name').value = npc?.name || '';
    }
}

/**
 * Create settings UI — redesigned with section cards and improved layout.
 * by aceeenvw
 */
function createSettingsUI() {
    const settings = getSettings();
    const context = SillyTavern.getContext();
    
    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.error('[IIG] Settings container not found');
        return;
    }

    // Build NPC slots HTML
    let npcSlotsHtml = '';
    for (let i = 0; i < 4; i++) {
        npcSlotsHtml += `
            <div class="iig-ref-slot" data-ref-type="npc" data-npc-index="${i}">
                <div class="iig-ref-thumb-wrap">
                    <img src="" alt="NPC" class="iig-ref-thumb">
                    <div class="iig-ref-empty-icon"><i class="fa-solid fa-user-plus"></i></div>
                    <label class="iig-ref-upload-overlay" title="Upload photo">
                        <i class="fa-solid fa-camera"></i>
                        <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                    </label>
                </div>
                <div class="iig-ref-info">
                    <div class="iig-ref-label">NPC ${i + 1}</div>
                    <input type="text" class="text_pole iig-ref-name" placeholder="Name" value="">
                </div>
                <div class="iig-ref-actions">
                    <label class="menu_button iig-ref-upload-btn" title="Upload photo">
                        <i class="fa-solid fa-upload"></i>
                        <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                    </label>
                    <div class="menu_button iig-ref-delete-btn" title="Remove"><i class="fa-solid fa-trash-can"></i></div>
                </div>
            </div>`;
    }

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-leaf"></i> Inline Image Generation</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <!-- Enable/Disable -->
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Enable image generation</span>
                    </label>
                    
                    <hr>
                    
                    <!-- API Settings Section -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-plug"></i> API Configuration</h4>
                        
                        <div class="flex-row">
                            <label for="iig_api_type">API Type</label>
                            <select id="iig_api_type" class="flex1">
                                <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-compatible</option>
                                <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini / Nano-Banana</option>
                                <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>Naistera / Grok</option>
                            </select>
                        </div>
                        
                        <div class="flex-row">
                            <label for="iig_endpoint">Endpoint URL</label>
                            <input type="text" id="iig_endpoint" class="text_pole flex1" 
                                   value="${sanitizeForHtml(settings.endpoint)}" 
                                   placeholder="https://api.example.com">
                        </div>
                        
                        <div class="flex-row">
                            <label for="iig_api_key">API Key</label>
                            <input type="password" id="iig_api_key" class="text_pole flex1" 
                                   value="${sanitizeForHtml(settings.apiKey)}">
                            <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Show/Hide">
                                <i class="fa-solid fa-eye"></i>
                            </div>
                        </div>
                        <p id="iig_naistera_hint" class="hint ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}">Naistera/Grok: paste token from Telegram bot. No model needed.</p>
                        
                        <div class="flex-row ${settings.apiType === 'naistera' ? 'iig-hidden' : ''}" id="iig_model_row">
                            <label for="iig_model">Model</label>
                            <select id="iig_model" class="flex1">
                                ${settings.model ? `<option value="${sanitizeForHtml(settings.model)}" selected>${sanitizeForHtml(settings.model)}</option>` : '<option value="">-- Select model --</option>'}
                            </select>
                            <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Refresh models list">
                                <i class="fa-solid fa-sync"></i>
                            </div>
                        </div>
                        
                        <!-- Test Connection -->
                        <div id="iig_test_connection" class="menu_button iig-test-connection" title="Test API connection">
                            <i class="fa-solid fa-wifi"></i> Test Connection
                        </div>
                    </div>
                    
                    <hr>
                    
                    <!-- Generation Params Section -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-sliders"></i> Generation Settings</h4>
                        
                        <!-- OpenAI params -->
                        <div class="flex-row ${settings.apiType !== 'openai' ? 'iig-hidden' : ''}" id="iig_size_row">
                            <label for="iig_size">Size</label>
                            <select id="iig_size" class="flex1">
                                <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024x1024 (Square)</option>
                                <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>1792x1024 (Landscape)</option>
                                <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>1024x1792 (Portrait)</option>
                                <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512x512 (Small)</option>
                            </select>
                        </div>
                        
                        <div class="flex-row ${settings.apiType !== 'openai' ? 'iig-hidden' : ''}" id="iig_quality_row">
                            <label for="iig_quality">Quality</label>
                            <select id="iig_quality" class="flex1">
                                <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Standard</option>
                                <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option>
                            </select>
                        </div>

                        <!-- Naistera params -->
                        <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_aspect_row">
                            <label for="iig_naistera_aspect_ratio">Aspect Ratio</label>
                            <select id="iig_naistera_aspect_ratio" class="flex1">
                                <option value="1:1" ${settings.naisteraAspectRatio === '1:1' ? 'selected' : ''}>1:1</option>
                                <option value="3:2" ${settings.naisteraAspectRatio === '3:2' ? 'selected' : ''}>3:2</option>
                                <option value="2:3" ${settings.naisteraAspectRatio === '2:3' ? 'selected' : ''}>2:3</option>
                            </select>
                        </div>
                        <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_preset_row">
                            <label for="iig_naistera_preset">Preset</label>
                            <select id="iig_naistera_preset" class="flex1">
                                <option value="" ${!settings.naisteraPreset ? 'selected' : ''}>None</option>
                                <option value="digital" ${settings.naisteraPreset === 'digital' ? 'selected' : ''}>Digital</option>
                                <option value="realism" ${settings.naisteraPreset === 'realism' ? 'selected' : ''}>Realism</option>
                            </select>
                        </div>

                        <!-- Nano-Banana params -->
                        <div id="iig_gemini_params" class="${settings.apiType !== 'gemini' ? 'iig-hidden' : ''}">
                            <div class="flex-row">
                                <label for="iig_aspect_ratio">Aspect Ratio</label>
                                <select id="iig_aspect_ratio" class="flex1">
                                    <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>1:1 (Square)</option>
                                    <option value="2:3" ${settings.aspectRatio === '2:3' ? 'selected' : ''}>2:3 (Portrait)</option>
                                    <option value="3:2" ${settings.aspectRatio === '3:2' ? 'selected' : ''}>3:2 (Landscape)</option>
                                    <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>3:4 (Portrait)</option>
                                    <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>4:3 (Landscape)</option>
                                    <option value="4:5" ${settings.aspectRatio === '4:5' ? 'selected' : ''}>4:5 (Portrait)</option>
                                    <option value="5:4" ${settings.aspectRatio === '5:4' ? 'selected' : ''}>5:4 (Landscape)</option>
                                    <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>9:16 (Vertical)</option>
                                    <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>16:9 (Widescreen)</option>
                                    <option value="21:9" ${settings.aspectRatio === '21:9' ? 'selected' : ''}>21:9 (Ultra-wide)</option>
                                </select>
                            </div>
                            
                            <div class="flex-row">
                                <label for="iig_image_size">Resolution</label>
                                <select id="iig_image_size" class="flex1">
                                    <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>1K (default)</option>
                                    <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K</option>
                                    <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <!-- References Section (visible for gemini and naistera) -->
                    <div id="iig_refs_section" class="iig-refs ${settings.apiType === 'openai' ? 'iig-hidden' : ''}">
                        <h4><i class="fa-solid fa-user-group"></i> Character References</h4>
                        <p class="hint">Upload reference photos for consistent generation. Max 4 per request. Char & User always sent; NPCs only when named in prompt.</p>
                        
                        <div class="iig-refs-grid">
                            <!-- Main characters -->
                            <div class="iig-refs-row iig-refs-main">
                                <!-- Char slot -->
                                <div class="iig-ref-slot" data-ref-type="char">
                                    <div class="iig-ref-thumb-wrap">
                                        <img src="" alt="Char" class="iig-ref-thumb">
                                        <div class="iig-ref-empty-icon"><i class="fa-solid fa-user"></i></div>
                                        <label class="iig-ref-upload-overlay" title="Upload photo">
                                            <i class="fa-solid fa-camera"></i>
                                            <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                                        </label>
                                    </div>
                                    <div class="iig-ref-info">
                                        <div class="iig-ref-label">{{char}}</div>
                                        <input type="text" class="text_pole iig-ref-name" placeholder="Name" value="">
                                    </div>
                                    <div class="iig-ref-actions">
                                        <label class="menu_button iig-ref-upload-btn" title="Upload photo">
                                            <i class="fa-solid fa-upload"></i>
                                            <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                                        </label>
                                        <div class="menu_button iig-ref-delete-btn" title="Remove"><i class="fa-solid fa-trash-can"></i></div>
                                    </div>
                                </div>
                                
                                <!-- User slot -->
                                <div class="iig-ref-slot" data-ref-type="user">
                                    <div class="iig-ref-thumb-wrap">
                                        <img src="" alt="User" class="iig-ref-thumb">
                                        <div class="iig-ref-empty-icon"><i class="fa-solid fa-user"></i></div>
                                        <label class="iig-ref-upload-overlay" title="Upload photo">
                                            <i class="fa-solid fa-camera"></i>
                                            <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                                        </label>
                                    </div>
                                    <div class="iig-ref-info">
                                        <div class="iig-ref-label">{{user}}</div>
                                        <input type="text" class="text_pole iig-ref-name" placeholder="Name" value="">
                                    </div>
                                    <div class="iig-ref-actions">
                                        <label class="menu_button iig-ref-upload-btn" title="Upload photo">
                                            <i class="fa-solid fa-upload"></i>
                                            <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                                        </label>
                                        <div class="menu_button iig-ref-delete-btn" title="Remove"><i class="fa-solid fa-trash-can"></i></div>
                                    </div>
                                </div>
                            </div>

                            <div class="iig-refs-divider"><span>NPCs</span></div>

                            <!-- NPC slots -->
                            <div class="iig-refs-row iig-refs-npcs">
                                ${npcSlotsHtml}
                            </div>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <!-- Error Handling Section -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-rotate"></i> Retry Settings</h4>
                        
                        <div class="flex-row">
                            <label for="iig_max_retries">Max Retries</label>
                            <input type="number" id="iig_max_retries" class="text_pole flex1" 
                                   value="${settings.maxRetries}" min="0" max="5">
                        </div>
                        
                        <div class="flex-row">
                            <label for="iig_retry_delay">Delay (ms)</label>
                            <input type="number" id="iig_retry_delay" class="text_pole flex1" 
                                   value="${settings.retryDelay}" min="500" max="10000" step="500">
                        </div>
                        <p class="hint">Auto-retry on 429/502/503/504 errors. Set to 0 for manual retry only.</p>
                    </div>
                    
                    <hr>
                    
                    <!-- Debug Section -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-bug"></i> Debug</h4>
                        <div id="iig_export_logs" class="menu_button iig-export-logs-btn">
                            <i class="fa-solid fa-download"></i> Export Logs
                        </div>
                        <p class="hint">Download extension logs for troubleshooting.</p>
                    </div>
                    
                    <!-- Manual Save Button — especially useful on mobile -->
                    <div id="iig_manual_save" class="menu_button" style="width:100%;text-align:center;margin-bottom:6px;background:#2a6a2a;">
                        <i class="fa-solid fa-floppy-disk"></i> Сохранить настройки
                    </div>
                    <p id="iig_save_status" class="hint" style="text-align:center;font-size:0.85em;min-height:1.2em;"></p>

                    <p class="hint" style="text-align:center;opacity:0.5;margin-top:4px;">
                        v2.0.0 by <a href="https://github.com/aceeenvw/notsosillynotsoimages" target="_blank" style="color:inherit;text-decoration:underline;">aceeenvw</a>
                    </p>
                    <p id="iig_session_stats" class="hint" style="text-align:center;opacity:0.35;margin-top:2px;font-size:0.8em;"></p>
                </div>
            </div>
        </div>
    `;
    
    container.insertAdjacentHTML('beforeend', html);
    
    bindSettingsEvents();
    renderRefSlots();
}

/**
 * Bind event handlers for all 6 unified ref slots (char, user, 4 NPCs).
 */
function bindRefSlotEvents() {
    const allSlots = document.querySelectorAll('.iig-ref-slot');

    for (const slot of allSlots) {
        const refType = slot.dataset.refType;
        const npcIndex = parseInt(slot.dataset.npcIndex, 10);

        const nameInput = slot.querySelector('.iig-ref-name');
        nameInput?.addEventListener('input', (e) => {
            const s = getCurrentCharacterRefs();
            if (refType === 'char') {
                s.charRef.name = e.target.value;
            } else if (refType === 'user') {
                s.userRef.name = e.target.value;
            } else if (refType === 'npc') {
                if (!s.npcReferences[npcIndex]) s.npcReferences[npcIndex] = { name: '', imageBase64: '' };
                s.npcReferences[npcIndex].name = e.target.value;
            }
            saveSettings();
        });

        // Bind ALL file inputs in the slot (button + thumbnail overlay)
        const fileInputs = slot.querySelectorAll('.iig-ref-file-input');
        const fileHandler = async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;

            try {
                const rawBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        const b64 = reader.result.split(',')[1];
                        resolve(b64);
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });

                const compressed = await compressBase64Image(rawBase64, 768, 0.8);

                // Save ref as file on server, store only the lightweight path
                const label = refType === 'npc' ? `npc${npcIndex}` : refType;
                const savedPath = await saveRefImageToFile(compressed, label);

                const s = getCurrentCharacterRefs();
                if (refType === 'char') {
                    s.charRef.imageBase64 = '';
                    s.charRef.imagePath = savedPath;
                } else if (refType === 'user') {
                    s.userRef.imageBase64 = '';
                    s.userRef.imagePath = savedPath;
                } else if (refType === 'npc') {
                    if (!s.npcReferences[npcIndex]) s.npcReferences[npcIndex] = { name: '', imageBase64: '', imagePath: '' };
                    s.npcReferences[npcIndex].imageBase64 = '';
                    s.npcReferences[npcIndex].imagePath = savedPath;
                }
                saveSettings();
                const thumb = slot.querySelector('.iig-ref-thumb');
                if (thumb) thumb.src = savedPath;

                iigLog('INFO', `Ref slot ${label}: saved to ${savedPath}`);
                toastr.success('Photo saved to server', 'Image Generation', { timeOut: 2000 });
            } catch (err) {
                const label = refType === 'npc' ? `NPC ${npcIndex}` : refType;
                iigLog('ERROR', `Ref slot ${label}: upload failed`, err.message);
                toastr.error('Photo upload failed', 'Image Generation');
            }

            e.target.value = '';
            // Also update the thumb-wrap state class
            const thumbWrap = slot.querySelector('.iig-ref-thumb-wrap');
            if (thumbWrap) thumbWrap.classList.add('has-image');
        };
        for (const fi of fileInputs) fi.addEventListener('change', fileHandler);

        const deleteBtn = slot.querySelector('.iig-ref-delete-btn');
        deleteBtn?.addEventListener('click', () => {
            const refs = getCurrentCharacterRefs();
            const s = getCurrentCharacterRefs();
            if (refType === 'char') {
                s.charRef = { name: '', imageBase64: '', imagePath: '' };
            } else if (refType === 'user') {
                s.userRef = { name: '', imageBase64: '', imagePath: '' };
            } else if (refType === 'npc') {
                s.npcReferences[npcIndex] = { name: '', imageBase64: '', imagePath: '' };
            }
            saveSettingsNow();

            const thumb = slot.querySelector('.iig-ref-thumb');
            if (thumb) thumb.src = '';
            const thumbWrap = slot.querySelector('.iig-ref-thumb-wrap');
            if (thumbWrap) thumbWrap.classList.remove('has-image');
            const nameEl = slot.querySelector('.iig-ref-name');
            if (nameEl) nameEl.value = '';

            const label = refType === 'npc' ? `NPC ${npcIndex}` : refType;
            iigLog('INFO', `Ref slot ${label}: cleared`);
            toastr.info('Slot cleared', 'Image Generation', { timeOut: 2000 });
        });
    }
}

/**
 * Bind settings event handlers
 */
function bindSettingsEvents() {
    const settings = getSettings();

    const updateVisibility = () => {
        const apiType = settings.apiType;
        const isNaistera = apiType === 'naistera';
        const isGemini = apiType === 'gemini';
        const isOpenAI = apiType === 'openai';

        document.getElementById('iig_model_row')?.classList.toggle('iig-hidden', isNaistera);
        document.getElementById('iig_size_row')?.classList.toggle('iig-hidden', !isOpenAI);
        document.getElementById('iig_quality_row')?.classList.toggle('iig-hidden', !isOpenAI);
        document.getElementById('iig_naistera_aspect_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_preset_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_hint')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_gemini_params')?.classList.toggle('iig-hidden', !isGemini);
        document.getElementById('iig_refs_section')?.classList.toggle('iig-hidden', isOpenAI);
    };
    
    document.getElementById('iig_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
        updateHeaderStatusDot();
    });
    
    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value;
        saveSettings();
        updateVisibility();
    });
    
    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => {
        settings.endpoint = e.target.value;
        saveSettings();
    });
    
    document.getElementById('iig_api_key')?.addEventListener('input', (e) => {
        settings.apiKey = e.target.value;
        saveSettings();
    });
    
    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.replace('fa-eye', 'fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.replace('fa-eye-slash', 'fa-eye');
        }
    });
    
    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value;
        saveSettings();
        
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
            updateVisibility();
        }
    });
    
    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            const currentModel = settings.model;
            
            select.innerHTML = '<option value="">-- Select model --</option>';
            
            for (const model of models) {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                option.selected = model === currentModel;
                select.appendChild(option);
            }
            
            toastr.success(`Found ${models.length} model(s)`, 'Image Generation');
        } catch (error) {
            toastr.error('Failed to load models', 'Image Generation');
        } finally {
            btn.classList.remove('loading');
        }
    });
    
    document.getElementById('iig_size')?.addEventListener('change', (e) => {
        settings.size = e.target.value;
        saveSettings();
    });
    
    document.getElementById('iig_quality')?.addEventListener('change', (e) => {
        settings.quality = e.target.value;
        saveSettings();
    });
    
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => {
        settings.aspectRatio = e.target.value;
        saveSettings();
    });
    
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => {
        settings.imageSize = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_naistera_aspect_ratio')?.addEventListener('change', (e) => {
        settings.naisteraAspectRatio = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_naistera_preset')?.addEventListener('change', (e) => {
        settings.naisteraPreset = e.target.value;
        saveSettings();
    });
    
    // BUG FIX: maxRetries handler now correctly allows 0 (no auto-retry)
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        settings.maxRetries = Number.isNaN(val) ? 0 : Math.max(0, Math.min(5, val));
        saveSettings();
    });
    
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        settings.retryDelay = Number.isNaN(val) ? 1000 : Math.max(500, val);
        saveSettings();
    });
    
    document.getElementById('iig_export_logs')?.addEventListener('click', () => {
        exportLogs();
    });

    // Manual save button — directly writes to server, shows result
    document.getElementById('iig_manual_save')?.addEventListener('click', async () => {
        const btn = document.getElementById('iig_manual_save');
        const status = document.getElementById('iig_save_status');
        btn.style.opacity = '0.6';
        status.style.color = '';
        status.textContent = 'Сохраняю...';

        let ok = false;
        const errors = [];

        // 1. Try window.saveSettings (non-debounced)
        if (typeof window.saveSettings === 'function') {
            try {
                await window.saveSettings();
                ok = true;
                iigLog('INFO', 'Manual save: window.saveSettings OK');
            } catch(e) {
                errors.push('window.saveSettings: ' + e.message);
            }
        }

        // 2. Always also call debounced as belt-and-suspenders
        try {
            SillyTavern.getContext().saveSettingsDebounced();
        } catch(e) { errors.push('debounced: ' + e.message); }

        // 3. Always write localStorage backup
        persistRefsToLocalStorage();

        // 4. Try direct API call as final fallback
        if (!ok) {
            try {
                const ctx = SillyTavern.getContext();
                const payload = {};
                for (const k of ['power_user','oai_settings','extension_settings']) {
                    if (window[k] !== undefined) payload[k] = window[k];
                }
                payload['extension_settings'] = ctx.extensionSettings;
                const resp = await fetch('/api/settings/save', {
                    method: 'POST',
                    headers: ctx.getRequestHeaders(),
                    body: JSON.stringify(payload)
                });
                if (resp.ok) { ok = true; iigLog('INFO', 'Manual save: API OK'); }
                else { errors.push('API: HTTP ' + resp.status); }
            } catch(e) { errors.push('API: ' + e.message); }
        }

        btn.style.opacity = '1';
        if (ok) {
            status.style.color = '#4caf50';
            status.textContent = '✓ Сохранено!';
            setTimeout(() => { status.textContent = ''; }, 3000);
        } else {
            status.style.color = '#f44336';
            status.textContent = '✗ Ошибка: ' + errors.join('; ');
            iigLog('ERROR', 'Manual save failed:', errors.join('; '));
        }
    });

    // Test connection button
    document.getElementById('iig_test_connection')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (btn.classList.contains('testing')) return;
        btn.classList.add('testing');
        const icon = btn.querySelector('i');
        const origClass = icon.className;
        icon.className = 'fa-solid fa-spinner';
        
        try {
            if (!settings.endpoint || !settings.apiKey) {
                throw new Error('Set endpoint and API key first');
            }

            if (settings.apiType === 'naistera') {
                // For Naistera, just check if the endpoint responds
                const testUrl = settings.endpoint.replace(/\/$/, '');
                const resp = await fetch(testUrl, { method: 'HEAD' }).catch(() => null);
                if (resp && resp.ok) {
                    toastr.success('Connection OK', 'Image Generation');
                } else {
                    toastr.warning('Endpoint reachable but returned non-OK', 'Image Generation');
                }
            } else {
                // OpenAI/Gemini — try fetching models
                const models = await fetchModels();
                toastr.success(`Connection OK — ${models.length} image model(s) found`, 'Image Generation');
            }
            // Visual success flash
            btn.classList.add('test-success');
            setTimeout(() => btn.classList.remove('test-success'), 700);
        } catch (error) {
            toastr.error(`Connection failed: ${error.message}`, 'Image Generation');
            // Visual failure flash
            btn.classList.add('test-fail');
            setTimeout(() => btn.classList.remove('test-fail'), 700);
        } finally {
            btn.classList.remove('testing');
            icon.className = origClass;
        }
    });

    // Unified references event handlers
    bindRefSlotEvents();

    // Apply initial state
    updateVisibility();
}

/**
 * Lightbox — click any generated image to view full-size with a dark overlay.
 * Press Escape or click the backdrop to close.
 */
function initLightbox() {
    // Create lightbox overlay once
    if (document.getElementById('iig_lightbox')) return;

    const overlay = document.createElement('div');
    overlay.id = 'iig_lightbox';
    overlay.className = 'iig-lightbox';
    overlay.innerHTML = `
        <div class="iig-lightbox-backdrop"></div>
        <div class="iig-lightbox-content">
            <img class="iig-lightbox-img" src="" alt="Full-size preview">
            <div class="iig-lightbox-caption"></div>
            <button class="iig-lightbox-close" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.classList.remove('open');
    overlay.querySelector('.iig-lightbox-backdrop').addEventListener('click', close);
    overlay.querySelector('.iig-lightbox-close').addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('open')) close();
    });

    // Delegate click on generated images inside #chat
    document.getElementById('chat')?.addEventListener('click', (e) => {
        const img = e.target.closest('.iig-generated-image');
        if (!img) return;

        e.preventDefault();
        e.stopPropagation();

        const lbImg = overlay.querySelector('.iig-lightbox-img');
        const caption = overlay.querySelector('.iig-lightbox-caption');

        lbImg.src = img.src;
        caption.textContent = img.alt || '';
        overlay.classList.add('open');
    });

    iigLog('INFO', 'Lightbox initialized');
}

/**
 * Update the drawer header status dot to show enabled/disabled state.
 */
function updateHeaderStatusDot() {
    const settings = getSettings();
    const header = document.querySelector('.inline-drawer-header');
    if (!header) return;

    let dot = header.querySelector('.iig-header-dot');
    if (!dot) {
        dot = document.createElement('span');
        dot.className = 'iig-header-dot';
        // Insert before the chevron icon
        const chevron = header.querySelector('.inline-drawer-icon');
        if (chevron) {
            header.insertBefore(dot, chevron);
        } else {
            header.appendChild(dot);
        }
    }

    dot.classList.toggle('active', settings.enabled);
    dot.title = settings.enabled ? 'Generation enabled' : 'Generation disabled';
}

/**
 * Initialize extension
 * by aceeenvw — https://github.com/aceeenvw/notsosillynotsoimages
 */
(function init() {
    const context = SillyTavern.getContext();
    
    iigLog('INFO', 'Initializing Inline Image Generation v2.0.0 by aceeenvw');
    iigLog('INFO', `Platform: ${IS_IOS ? 'iOS' : 'Desktop'}, Timeout: ${FETCH_TIMEOUT/1000}s`);
    
    getSettings();
    
    context.eventSource.on(context.event_types.APP_READY, () => {
        restoreRefsFromLocalStorage();
        createSettingsUI();
        addButtonsToExistingMessages();
        initLightbox();
        updateHeaderStatusDot();
        initMobileSaveListeners();
        iigLog('INFO', 'Inline Image Generation extension loaded');
    });
    
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        iigLog('INFO', 'CHAT_CHANGED event');
        // Delay to let ST set characterId before we read it
        setTimeout(() => {
            restoreRefsFromLocalStorage();
            addButtonsToExistingMessages();
            renderRefSlots();
        }, 300);
    });
    
    const handleMessage = async (messageId) => {
        iigLog('INFO', `Event triggered for message: ${messageId}`);
        await onMessageReceived(messageId);
    };
    
    // Listen for new messages AFTER they're rendered in DOM
    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);
    
    // NOTE: We intentionally DO NOT handle MESSAGE_SWIPED or MESSAGE_UPDATED
    // Swipe = user wants NEW content, not to retry old error images
    // If user wants to retry failed images, they use the regenerate button in menu
    
    iigLog('INFO', 'Inline Image Generation extension initialized');
})();
