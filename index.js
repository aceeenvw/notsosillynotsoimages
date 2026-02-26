/**
 * Inline Image Generation Extension for SillyTavern
 * 
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible and Gemini-compatible (nano-banana) endpoints.
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
    toastr.success('Логи экспортированы', 'Генерация картинок');
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
    maxRetries: 0, // No auto-retry - user clicks error image to retry manually
    retryDelay: 1000,
    // Nano-banana specific
    aspectRatio: '1:1', // "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
    imageSize: '1K', // "1K", "2K", "4K"
    // Naistera specific (UI only for now)
    naisteraAspectRatio: '1:1',
    naisteraPreset: '', // '', 'digital', 'realism'
    // Per-character references (charRef, userRef, npcs) keyed by character avatar/name
    npcReferences: {},
});

// Image model detection keywords (from your api_client.py)
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

// We'll parse tags manually since JSON can contain nested braces
// Tag format: [IMG:GEN:{...json...}] or <img src="[IMG:GEN:{...json...}]">

/**
 * Check if model ID is an image generation model
 */
function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    
    // Exclude video models
    for (const kw of VIDEO_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return false;
    }
    
    // Exclude vision models
    if (mid.includes('vision') && mid.includes('preview')) return false;
    
    // Check for image model keywords
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
    
    // Ensure all default keys exist
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    
    return context.extensionSettings[MODULE_NAME];
}

/**
 * Save settings
 */
function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
}

/**
 * Get the character key used for per-character references storage.
 */
function getCharacterKey() {
    const context = SillyTavern.getContext();
    return context.characters?.[context.characterId]?.avatar
        || context.characters?.[context.characterId]?.name
        || 'default';
}

/**
 * Ensure the per-character refs object exists and has the correct structure.
 * Handles migration from old array format (Round 1) to new object format (Round 2).
 * @returns {{ charRef: {name: string, imageBase64: string}, userRef: {name: string, imageBase64: string}, npcs: Array<{name: string, imageBase64: string}> }}
 */
function getCurrentCharacterRefs() {
    const settings = getSettings();
    const key = getCharacterKey();
    let data = settings.npcReferences[key];

    // Migration: old format was a plain array of NPC objects
    if (Array.isArray(data)) {
        const oldNpcs = data;
        data = {
            charRef: { name: '', imageBase64: '' },
            userRef: { name: '', imageBase64: '' },
            npcs: [],
        };
        for (let i = 0; i < 4; i++) {
            data.npcs.push(oldNpcs[i] ? { ...oldNpcs[i] } : { name: '', imageBase64: '' });
        }
        settings.npcReferences[key] = data;
        iigLog('INFO', `Migrated old NPC array to new refs structure for key "${key}"`);
    }

    // Ensure structure exists
    if (!data || typeof data !== 'object') {
        data = {
            charRef: { name: '', imageBase64: '' },
            userRef: { name: '', imageBase64: '' },
            npcs: [],
        };
        settings.npcReferences[key] = data;
    }

    if (!data.charRef) data.charRef = { name: '', imageBase64: '' };
    if (!data.userRef) data.userRef = { name: '', imageBase64: '' };
    if (!data.npcs) data.npcs = [];

    // Ensure exactly 4 NPC slots
    while (data.npcs.length < 4) {
        data.npcs.push({ name: '', imageBase64: '' });
    }

    return data;
}

/**
 * Get NPC reference list for the current character.
 * @returns {Array<{name: string, imageBase64: string}>}
 */
function getCurrentCharacterNpcs() {
    return getCurrentCharacterRefs().npcs;
}

/**
 * Match NPC references against the generation prompt.
 * Returns an array of matched NPC objects whose name appears in the prompt.
 * Matching is case-insensitive, partial (any word >2 chars from the name).
 *
 * @param {string} prompt - The image generation prompt text
 * @param {Array<{name: string, imageBase64: string}>} npcList - NPC slots
 * @returns {Array<{name: string, imageBase64: string}>} matched NPCs
 */
function matchNpcReferences(prompt, npcList) {
    if (!prompt || !npcList || npcList.length === 0) return [];

    const lowerPrompt = prompt.toLowerCase();
    const matched = [];

    for (const npc of npcList) {
        if (!npc || !npc.name || !npc.imageBase64) continue;

        const words = npc.name.trim().split(/\s+/).filter(w => w.length > 2);
        if (words.length === 0) continue;

        const isMatch = words.some(word => lowerPrompt.includes(word.toLowerCase()));
        if (isMatch) {
            matched.push({ name: npc.name, imageBase64: npc.imageBase64 });
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
        
        // Filter for image models only
        return models.filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        console.error('[IIG] Failed to fetch models:', error);
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

/**
 * Convert image URL to base64
 */

/**
 * Resize and compress a base64 image to reduce request payload size.
 * Uses canvas to cap dimensions at maxDim and output as JPEG at given quality.
 * Returns pure base64 string (no data: prefix).
 */
function compressBase64Image(base64, maxDim = 768, quality = 0.8) {
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
            // Output as JPEG for much smaller size; fall back to PNG if transparency needed
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            const b64 = dataUrl.split(',')[1];
            console.log(`[IIG] Compressed reference image: ${img.width}x${img.height} -> ${w}x${h}, ~${Math.round(b64.length / 1024)}KB`);
            resolve(b64);
        };
        img.onerror = () => reject(new Error('Failed to load image for compression'));
        img.src = 'data:image/png;base64,' + base64;
    });
}


async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                // Remove data URL prefix to get pure base64
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

/**
 * Convert image URL to data URL (data:image/...;base64,...)
 */
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
 * @param {string} dataUrl - Data URL (data:image/png;base64,...)
 * @returns {Promise<string>} - Relative path to saved file
 */
async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    
    // Extract base64 and format from data URL
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
        throw new Error('Invalid data URL format');
    }
    
    const format = match[1]; // png, jpeg, webp
    const base64Data = match[2];
    
    // Get character name for subfolder
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }
    
    // Generate unique filename
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
    console.log('[IIG] Image saved to:', result.path);
    return result.path;
}

/**
 * Generate image via OpenAI-compatible endpoint
 */
async function generateImageOpenAI(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;
    
    // Combine style and prompt
    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    
    // Map aspect ratio to size if provided in tag
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
    
    // Add reference image if supported (for models like GPT-Image-1, FLUX)
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
    
    // Parse response - standard OpenAI format
    const dataList = result.data || [];
    if (dataList.length === 0) {
        if (result.url) return result.url;
        throw new Error('No image data in response');
    }
    
    const imageObj = dataList[0];
    const imageData = imageObj.b64_json || imageObj.url;
    
    // Return as data URL if b64_json
    if (imageObj.b64_json) {
        return `data:image/png;base64,${imageObj.b64_json}`;
    }
    
    return imageData;
}

// Valid aspect ratios for Gemini/nano-banana
const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
// Valid image sizes for Gemini/nano-banana
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

/**
 * Generate image via Gemini-compatible endpoint (nano-banana)
 */
async function generateImageGemini(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
    
    // Determine aspect ratio: tag option > settings, with validation
    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
        iigLog('WARN', `Invalid aspect_ratio "${aspectRatio}", falling back to settings or default`);
        aspectRatio = VALID_ASPECT_RATIOS.includes(settings.aspectRatio) ? settings.aspectRatio : '1:1';
    }
    
    // Determine image size: tag option > settings, with validation
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) {
        iigLog('WARN', `Invalid image_size "${imageSize}", falling back to settings or default`);
        imageSize = VALID_IMAGE_SIZES.includes(settings.imageSize) ? settings.imageSize : '1K';
    }
    
    iigLog('INFO', `Using aspect ratio: ${aspectRatio}, image size: ${imageSize}`);
    
    // Build parts array
    const parts = [];
    
    // Add reference images first (up to 4)
    for (const imgB64 of referenceImages.slice(0, 4)) {
        parts.push({
            inlineData: {
                mimeType: 'image/jpeg',
                data: imgB64
            }
        });
    }
    
    // Add prompt with style and reference instruction
    let fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    
    // If reference images provided, add instruction to copy appearance
    if (referenceImages.length > 0) {
        const refInstruction = `[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]`;
        fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
    }
    
    parts.push({ text: fullPrompt });
    
    console.log(`[IIG] Gemini request: ${referenceImages.length} reference image(s) + prompt (${fullPrompt.length} chars)`);
    
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
    
    // Log full request config for debugging 400 errors
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
    
    // Parse Gemini response
    const candidates = result.candidates || [];
    if (candidates.length === 0) {
        throw new Error('No candidates in response');
    }
    
    const responseParts = candidates[0].content?.parts || [];
    
    for (const part of responseParts) {
        // Check both camelCase and snake_case variants
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
 * POST {endpoint}/api/generate
 * Auth: Authorization: Bearer <token>
 * Response: { data_url, content_type }
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
        errors.push('URL эндпоинта не настроен');
    }
    if (!settings.apiKey) {
        errors.push('API ключ не настроен');
    }
    if (settings.apiType !== 'naistera' && !settings.model) {
        errors.push('Модель не выбрана');
    }
    
    if (errors.length > 0) {
        throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
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
 * @param {string} prompt - Image description
 * @param {string} style - Style tag
 * @param {function} onStatusUpdate - Status callback
 * @param {object} options - Additional options (aspectRatio, quality)
 */
async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    // Validate settings first
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

        if (refs.charRef?.imageBase64) {
            referenceImages.push(refs.charRef.imageBase64);
            iigLog('INFO', `Char reference added: ${refs.charRef.name || '(no name)'}`);
        }
        if (refs.userRef?.imageBase64) {
            referenceImages.push(refs.userRef.imageBase64);
            iigLog('INFO', `User reference added: ${refs.userRef.name || '(no name)'}`);
        }

        // Matched NPCs up to total of 4
        const matchedNpcs = matchNpcReferences(prompt, refs.npcs);
        for (const npc of matchedNpcs) {
            if (referenceImages.length >= 4) break;
            referenceImages.push(npc.imageBase64);
            iigLog('INFO', `NPC reference matched: ${npc.name}`);
        }
    }

    // Naistera references: data URLs (server uploads to Grok)
    if (settings.apiType === 'naistera') {
        const refs = getCurrentCharacterRefs();

        if (refs.charRef?.imageBase64) {
            referenceDataUrls.push('data:image/jpeg;base64,' + refs.charRef.imageBase64);
            iigLog('INFO', `Char reference added (naistera): ${refs.charRef.name || '(no name)'}`);
        }
        if (refs.userRef?.imageBase64) {
            referenceDataUrls.push('data:image/jpeg;base64,' + refs.userRef.imageBase64);
            iigLog('INFO', `User reference added (naistera): ${refs.userRef.name || '(no name)'}`);
        }

        // Matched NPCs up to total of 4
        const matchedNpcs = matchNpcReferences(prompt, refs.npcs);
        for (const npc of matchedNpcs) {
            if (referenceDataUrls.length >= 4) break;
            referenceDataUrls.push('data:image/jpeg;base64,' + npc.imageBase64);
            iigLog('INFO', `NPC reference matched (naistera): ${npc.name}`);
        }
    }
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${maxRetries})` : ''}...`);
            
            // Choose API based on type or model
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
            
            // Check if retryable
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
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
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
 * 
 * @param {string} text - Message text
 * @param {object} options - Options
 * @param {boolean} options.checkExistence - Check if image files exist (for hallucination detection)
 * @param {boolean} options.forceAll - Include all instruction tags even with valid paths (for regeneration)
 */
async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];
    
    // === NEW FORMAT: <img data-iig-instruction="{...}" src="[IMG:GEN]"> ===
    // LLM often generates broken HTML with unescaped quotes, so we parse manually
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;
    
    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;
        
        // Find the start of the <img tag
        let imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) {
            searchPos = markerPos + 1;
            continue;
        }
        
        // Find the JSON start (first { after the marker)
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
        
        // Find the end of the <img> tag
        let imgEnd = text.indexOf('>', jsonEnd);
        if (imgEnd === -1) {
            searchPos = markerPos + 1;
            continue;
        }
        imgEnd++; // Include the >
        
        const fullImgTag = text.substring(imgStart, imgEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);
        
        // Check if src needs generation
        const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
        const srcValue = srcMatch ? srcMatch[1] : '';
        
        // Determine if this needs generation
        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg'); // Our error placeholder - NO auto-retry
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;
        
        // Skip error images - user must click to retry manually (prevents conflict on swipe)
        if (hasErrorImage && !forceAll) {
            iigLog('INFO', `Skipping error image (click to retry): ${srcValue.substring(0, 50)}`);
            searchPos = imgEnd;
            continue;
        }
        
        if (forceAll) {
            // Regeneration mode: include all tags with instruction (user-triggered)
            needsGeneration = true;
            iigLog('INFO', `Force regeneration mode: including ${srcValue.substring(0, 30)}`);
        } else if (hasMarker || !srcValue) {
            // Explicit marker or empty src = needs generation
            needsGeneration = true;
        } else if (hasPath && checkExistence) {
            // Has a path - check if file actually exists
            const exists = await checkFileExists(srcValue);
            if (!exists) {
                // File doesn't exist = LLM hallucinated the path
                iigLog('WARN', `File does not exist (LLM hallucination?): ${srcValue}`);
                needsGeneration = true;
            } else {
                iigLog('INFO', `Skipping existing image: ${srcValue.substring(0, 50)}`);
            }
        } else if (hasPath) {
            // Has path but not checking existence - skip
            iigLog('INFO', `Skipping path (no existence check): ${srcValue.substring(0, 50)}`);
            searchPos = imgEnd;
            continue;
        }
        
        if (!needsGeneration) {
            searchPos = imgEnd;
            continue;
        }
        
        try {
            // Normalize JSON: AI sometimes uses single quotes, HTML entities, etc.
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
                existingSrc: hasPath ? srcValue : null // Store existing src for logging
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
        
        // Find the matching closing brace for JSON
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
 * Create loading placeholder element
 */
function createLoadingPlaceholder(tagId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = `
        <div class="iig-spinner"></div>
        <div class="iig-status">Генерация картинки...</div>
        <div class="iig-timer" style="font-size:0.75em;color:#888;margin-top:4px;"></div>
    `;
    const timerEl = placeholder.querySelector('.iig-timer');
    const startTime = Date.now();
    const tSec = FETCH_TIMEOUT / 1000;
    placeholder._timerInterval = setInterval(() => {
        const el = Math.floor((Date.now() - startTime) / 1000);
        if (el >= tSec) { timerEl.textContent = "Тайм-аут..."; clearInterval(placeholder._timerInterval); return; }
        const m = Math.floor(el/60), s = el%60;
        timerEl.textContent = `${m}:${String(s).padStart(2,"0")} / ${Math.floor(tSec/60)}:00${IS_IOS ? " (iOS)" : ""}`;
    }, 1000);
    return placeholder;
}

// Error image path - served from extension folder
const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';

/**
 * Create error placeholder element - just shows error.svg, no click handlers
 * User uses the regenerate button in message menu to retry
 */
function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = `Ошибка: ${errorMessage}`;
    img.dataset.tagId = tagId;
    
    // Preserve data-iig-instruction for regenerate button functionality
    if (tagInfo.fullMatch) {
        const instructionMatch = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instructionMatch) {
            img.setAttribute('data-iig-instruction', instructionMatch[2]);
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
    
    // Prevent duplicate processing
    if (processingMessages.has(messageId)) {
        iigLog('WARN', `Message ${messageId} is already being processed, skipping`);
        return;
    }
    
    const message = context.chat[messageId];
    if (!message || message.is_user) return;
    
    // Check for tags, with file existence check to catch LLM hallucinations
    const tags = await parseImageTags(message.mes, { checkExistence: true });
    iigLog('INFO', `parseImageTags returned: ${tags.length} tags`);
    if (tags.length > 0) {
        iigLog('INFO', `First tag: ${JSON.stringify(tags[0]).substring(0, 200)}`);
    }
    if (tags.length === 0) {
        iigLog('INFO', 'No tags found by parser');
        return;
    }
    
    // Mark as processing
    processingMessages.add(messageId);
    iigLog('INFO', `Found ${tags.length} image tag(s) in message ${messageId}`);
    toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });
    
    // DOM is ready because we use CHARACTER_MESSAGE_RENDERED event
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        console.error('[IIG] Message element not found for ID:', messageId);
        toastr.error('Не удалось найти элемент сообщения', 'Генерация картинок');
        return;
    }
    
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) return;
    
    // Process each tag in parallel
    const processTag = async (tag, index) => {
        const tagId = `iig-${messageId}-${index}`;
        
        iigLog('INFO', `Processing tag ${index}: ${tag.fullMatch.substring(0, 50)}`);
        
        // Create loading placeholder
        const loadingPlaceholder = createLoadingPlaceholder(tagId);
        let targetElement = null;
        
        if (tag.isNewFormat) {
            // NEW FORMAT: <img data-iig-instruction='...'> is a real DOM element
            // Find it by looking for img with data-iig-instruction attribute
            const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            iigLog('INFO', `Searching for img element. Found ${allImgs.length} img[data-iig-instruction] elements in DOM`);
            
            // Debug: log what we're looking for vs what's in DOM
            const searchPrompt = tag.prompt.substring(0, 30);
            iigLog('INFO', `Searching for prompt starting with: "${searchPrompt}"`);
            
            for (const img of allImgs) {
                const instruction = img.getAttribute('data-iig-instruction');
                const src = img.getAttribute('src') || '';
                iigLog('INFO', `DOM img - src: "${src.substring(0, 50)}", instruction (first 100): "${instruction?.substring(0, 100)}"`);
                
                // Try multiple matching strategies
                if (instruction) {
                    // Strategy 1: Decode HTML entities and normalize quotes, then match
                    const decodedInstruction = instruction
                        .replace(/&quot;/g, '"')
                        .replace(/&apos;/g, "'")
                        .replace(/&#39;/g, "'")
                        .replace(/&#34;/g, '"')
                        .replace(/&amp;/g, '&');
                    
                    // Also normalize the search prompt the same way
                    const normalizedSearchPrompt = searchPrompt
                        .replace(/&quot;/g, '"')
                        .replace(/&apos;/g, "'")
                        .replace(/&#39;/g, "'")
                        .replace(/&#34;/g, '"')
                        .replace(/&amp;/g, '&');
                    
                    // Check if decoded instruction contains the prompt
                    if (decodedInstruction.includes(normalizedSearchPrompt)) {
                        iigLog('INFO', `Found img element via decoded instruction match`);
                        targetElement = img;
                        break;
                    }
                    
                    // Strategy 2: Try to parse the instruction as JSON and compare prompts
                    try {
                        const normalizedJson = decodedInstruction.replace(/'/g, '"');
                        const instructionData = JSON.parse(normalizedJson);
                        if (instructionData.prompt && instructionData.prompt.substring(0, 30) === tag.prompt.substring(0, 30)) {
                            iigLog('INFO', `Found img element via JSON prompt match`);
                            targetElement = img;
                            break;
                        }
                    } catch (e) {
                        // JSON parse failed, continue with other strategies
                    }
                    
                    // Strategy 3: Raw instruction contains raw search prompt (original approach)
                    if (instruction.includes(searchPrompt)) {
                        iigLog('INFO', `Found img element via raw instruction match`);
                        targetElement = img;
                        break;
                    }
                }
            }
            
            // Alternative: find by src containing markers (when prompt matching fails)
            if (!targetElement) {
                iigLog('INFO', `Prompt matching failed, trying src marker matching...`);
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    // Check for generation markers or empty/broken src
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') {
                        iigLog('INFO', `Found img element with generation marker in src: "${src}"`);
                        targetElement = img;
                        break;
                    }
                }
            }
            
            // Strategy 4: If still not found, try looking at ALL imgs (not just those with data-iig-instruction attr)
            // This handles cases where browser didn't parse data-iig-instruction as a valid attribute
            if (!targetElement) {
                iigLog('INFO', `Trying broader img search...`);
                const allImgsInMes = mesTextEl.querySelectorAll('img');
                for (const img of allImgsInMes) {
                    const src = img.getAttribute('src') || '';
                    // Look for src containing our markers
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) {
                        iigLog('INFO', `Found img via broad search with marker src: "${src.substring(0, 50)}"`);
                        targetElement = img;
                        break;
                    }
                }
            }
        } else {
            // LEGACY FORMAT: [IMG:GEN:{...}] - use regex replacement
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
            
            // Also check for img src containing legacy tag
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
        
        // Replace target with placeholder, preserving parent styling context
        if (targetElement) {
            // Copy some styling context from parent for adaptive placeholder
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
            
            // Save image to file instead of keeping base64
            statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);
            
            // Replace placeholder with actual image
            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
            
            // Preserve instruction for future regenerations (new format only)
            if (tag.isNewFormat) {
                const instructionMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (instructionMatch) {
                    img.setAttribute('data-iig-instruction', instructionMatch[2]);
                }
            }
            
            if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
            loadingPlaceholder.replaceWith(img);
            
            // Update message.mes to persist the image
            if (tag.isNewFormat) {
                // NEW FORMAT: <img data-iig-instruction="..." src="[IMG:GEN]">
                // Just update the src attribute with the real path
                // LLM sees same format but with real path = already generated
                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);
            } else {
                // LEGACY FORMAT: [IMG:GEN:{...}]
                // Replace with completion marker so LLM doesn't copy it
                const completionMarker = `[IMG:✓:${imagePath}]`;
                message.mes = message.mes.replace(tag.fullMatch, completionMarker);
            }
            
            iigLog('INFO', `Successfully generated image for tag ${index}`);
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed to generate image for tag ${index}:`, error.message);
            
            // Replace with error placeholder
            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
            loadingPlaceholder.replaceWith(errorPlaceholder);
            
            // IMPORTANT: Mark tag as failed in message.mes - use error.svg path so it displays properly after swipe
            if (tag.isNewFormat) {
                // NEW FORMAT: update src with error image path (will be detected for retry)
                const errorTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`);
                message.mes = message.mes.replace(tag.fullMatch, errorTag);
            } else {
                // LEGACY FORMAT: replace with error marker
                const errorMarker = `[IMG:ERROR:${error.message.substring(0, 50)}]`;
                message.mes = message.mes.replace(tag.fullMatch, errorMarker);
            }
            iigLog('INFO', `Marked tag as failed in message.mes`);
            
            toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
        }
    };
    
    try {
        // Process all tags in parallel
        await Promise.all(tags.map((tag, index) => processTag(tag, index)));
    } finally {
        // Always remove from processing set
        processingMessages.delete(messageId);
        iigLog('INFO', `Finished processing message ${messageId}`);
    }
    
    // Save chat to persist changes
    await context.saveChat();
    
    // Force re-render the message to show updated content
    // Use SillyTavern's messageFormatting if available
    if (typeof context.messageFormatting === 'function') {
        const formattedMessage = context.messageFormatting(
            message.mes,
            message.name,
            message.is_system,
            message.is_user,
            messageId
        );
        mesTextEl.innerHTML = formattedMessage;
        console.log('[IIG] Message re-rendered via messageFormatting');
    } else {
        // Fallback: trigger a manual re-render by finding and updating the element
        const freshMessageEl = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
        if (freshMessageEl && message.mes) {
            // Simple approach: just reload the message content
            // This works because message.mes now contains the image path instead of the tag
            console.log('[IIG] Attempting manual refresh...');
        }
    }
}

/**
 * Regenerate all images in a message (user-triggered)
 */
async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    
    if (!message) {
        toastr.error('Сообщение не найдено', 'Генерация картинок');
        return;
    }
    
    // Parse ALL instruction tags, forcing regeneration
    const tags = await parseImageTags(message.mes, { forceAll: true });
    
    if (tags.length === 0) {
        toastr.warning('Нет тегов для перегенерации', 'Генерация картинок');
        return;
    }
    
    iigLog('INFO', `Regenerating ${tags.length} images in message ${messageId}`);
    toastr.info(`Перегенерация ${tags.length} картинок...`, 'Генерация картинок');
    
    // Process using existing logic
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
            // Find the existing img element with data-iig-instruction
            const existingImg = mesTextEl.querySelector(`img[data-iig-instruction]`);
            if (existingImg) {
                // Preserve the instruction for future regenerations
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
                
                statusEl.textContent = 'Сохранение...';
                const imagePath = await saveImageToFile(dataUrl);
                
                const img = document.createElement('img');
                img.className = 'iig-generated-image';
                img.src = imagePath;
                img.alt = tag.prompt;
                // Preserve instruction for future regenerations
                if (instruction) {
                    img.setAttribute('data-iig-instruction', instruction);
                }
                if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
                loadingPlaceholder.replaceWith(img);
                
                // Update message.mes
                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);
                
                toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
            }
        } catch (error) {
            iigLog('ERROR', `Regeneration failed for tag ${index}:`, error.message);
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
        }
    }
    
    processingMessages.delete(messageId);
    await context.saveChat();
    iigLog('INFO', `Regeneration complete for message ${messageId}`);
}

/**
 * Add regenerate button to message extra menu (three dots)
 */
function addRegenerateButton(messageElement, messageId) {
    // Check if button already exists
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    
    // Find the extraMesButtons container (three dots menu)
    const extraMesButtons = messageElement.querySelector('.extraMesButtons');
    if (!extraMesButtons) return;
    
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
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
        
        // Only add to AI messages (not user messages)
        if (message && !message.is_user) {
            addRegenerateButton(messageElement, messageId);
            addedCount++;
        }
    }
    
    iigLog('INFO', `Added regenerate buttons to ${addedCount} existing messages`);
}

// NOTE: No click handlers on error images - user uses the regenerate button in message menu

/**
 * Handle CHARACTER_MESSAGE_RENDERED event
 * This fires AFTER the message is rendered to DOM
 */
async function onMessageReceived(messageId) {
    iigLog('INFO', `onMessageReceived: ${messageId}`);
    
    const settings = getSettings();
    if (!settings.enabled) {
        iigLog('INFO', 'Extension disabled, skipping');
        return;
    }
    
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    
    // Always add regenerate button for AI messages
    addRegenerateButton(messageElement, messageId);
    
    await processMessageTags(messageId);
}

/**
 * Render all reference slots (char, user, 4 NPCs) in the settings panel.
 * Reads from the current character's refs structure.
 */
function renderRefSlots() {
    const refs = getCurrentCharacterRefs();
    const context = SillyTavern.getContext();

    // --- Char slot ---
    const charSlot = document.querySelector('.iig-ref-slot[data-ref-type="char"]');
    if (charSlot) {
        const thumb = charSlot.querySelector('.iig-ref-thumb');
        const nameInput = charSlot.querySelector('.iig-ref-name');

        if (refs.charRef && refs.charRef.imageBase64) {
            thumb.src = 'data:image/jpeg;base64,' + refs.charRef.imageBase64;
        } else {
            thumb.src = '';
        }

        // Auto-fill name from character if stored name is empty
        let charName = refs.charRef ? refs.charRef.name : '';
        if (!charName && context.characters?.[context.characterId]) {
            charName = context.characters[context.characterId].name || '';
            if (charName && refs.charRef) {
                refs.charRef.name = charName;
                saveSettings();
            }
        }
        nameInput.value = charName;
    }

    // --- User slot ---
    const userSlot = document.querySelector('.iig-ref-slot[data-ref-type="user"]');
    if (userSlot) {
        const thumb = userSlot.querySelector('.iig-ref-thumb');
        const nameInput = userSlot.querySelector('.iig-ref-name');

        if (refs.userRef && refs.userRef.imageBase64) {
            thumb.src = 'data:image/jpeg;base64,' + refs.userRef.imageBase64;
        } else {
            thumb.src = '';
        }

        nameInput.value = refs.userRef ? (refs.userRef.name || '') : '';
    }

    // --- NPC slots ---
    for (let i = 0; i < 4; i++) {
        const slot = document.querySelector(`.iig-ref-slot[data-ref-type="npc"][data-npc-index="${i}"]`);
        if (!slot) continue;

        const npc = refs.npcs[i] || null;

        const thumb = slot.querySelector('.iig-ref-thumb');
        const nameInput = slot.querySelector('.iig-ref-name');

        if (npc && npc.imageBase64) {
            thumb.src = 'data:image/jpeg;base64,' + npc.imageBase64;
        } else {
            thumb.src = '';
        }

        nameInput.value = npc ? (npc.name || '') : '';
    }
}

/**
 * Create settings UI
 */
function createSettingsUI() {
    const settings = getSettings();
    const context = SillyTavern.getContext();
    
    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.error('[IIG] Settings container not found');
        return;
    }

    // Build NPC slots HTML (4 slots) for the unified refs section
    let npcSlotsHtml = '';
    for (let i = 0; i < 4; i++) {
        npcSlotsHtml += `
            <div class="iig-ref-slot" data-ref-type="npc" data-npc-index="${i}">
                <div class="iig-ref-label">NPC ${i + 1}</div>
                <div class="iig-ref-preview"><img src="" alt="NPC" class="iig-ref-thumb"></div>
                <input type="text" class="text_pole iig-ref-name" placeholder="Имя NPC" value="">
                <label class="menu_button iig-ref-upload-btn" title="Загрузить фото">
                    <i class="fa-solid fa-upload"></i>
                    <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                </label>
                <div class="menu_button iig-ref-delete-btn" title="Удалить"><i class="fa-solid fa-trash"></i></div>
            </div>`;
    }

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Генерация картинок</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <!-- Вкл/Выкл -->
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>
                    
                    <hr>
                    
                    <h4>Настройки API</h4>
                    
                    <!-- Тип эндпоинта -->
                    <div class="flex-row">
                        <label for="iig_api_type">Тип API</label>
                        <select id="iig_api_type" class="flex1">
                            <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый (/v1/images/generations)</option>
                            <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini-совместимый (nano-banana)</option>
                            <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>Naistera/Grok (naistera.org)</option>
                        </select>
                    </div>
                    
                    <!-- URL эндпоинта -->
                    <div class="flex-row">
                        <label for="iig_endpoint">URL эндпоинта</label>
                        <input type="text" id="iig_endpoint" class="text_pole flex1" 
                               value="${settings.endpoint}" 
                               placeholder="https://api.example.com">
                    </div>
                    
                    <!-- API ключ -->
                    <div class="flex-row">
                        <label for="iig_api_key">API ключ</label>
                        <input type="password" id="iig_api_key" class="text_pole flex1" 
                               value="${settings.apiKey}">
                        <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть">
                            <i class="fa-solid fa-eye"></i>
                        </div>
                    </div>
                    <p id="iig_naistera_hint" class="hint ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}">Для Naistera/Grok: вставьте токен из Telegram бота. Модель не требуется.</p>
                    
                    <!-- Модель -->
                    <div class="flex-row ${settings.apiType === 'naistera' ? 'iig-hidden' : ''}" id="iig_model_row">
                        <label for="iig_model">Модель</label>
                        <select id="iig_model" class="flex1">
                            ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">-- Выберите модель --</option>'}
                        </select>
                        <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить список">
                            <i class="fa-solid fa-sync"></i>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <h4>Параметры генерации</h4>
                    
                    <!-- Размер (OpenAI) -->
                    <div class="flex-row ${settings.apiType !== 'openai' ? 'iig-hidden' : ''}" id="iig_size_row">
                        <label for="iig_size">Размер</label>
                        <select id="iig_size" class="flex1">
                            <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024x1024 (Квадрат)</option>
                            <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>1792x1024 (Альбомная)</option>
                            <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>1024x1792 (Портретная)</option>
                            <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512x512 (Маленький)</option>
                        </select>
                    </div>
                    
                    <!-- Качество (OpenAI) -->
                    <div class="flex-row ${settings.apiType !== 'openai' ? 'iig-hidden' : ''}" id="iig_quality_row">
                        <label for="iig_quality">Качество</label>
                        <select id="iig_quality" class="flex1">
                            <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Стандартное</option>
                            <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option>
                        </select>
                    </div>

                    <!-- Naistera params -->
                    <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_aspect_row">
                        <label for="iig_naistera_aspect_ratio">Соотношение сторон</label>
                        <select id="iig_naistera_aspect_ratio" class="flex1">
                            <option value="1:1" ${settings.naisteraAspectRatio === '1:1' ? 'selected' : ''}>1:1</option>
                            <option value="3:2" ${settings.naisteraAspectRatio === '3:2' ? 'selected' : ''}>3:2</option>
                            <option value="2:3" ${settings.naisteraAspectRatio === '2:3' ? 'selected' : ''}>2:3</option>
                        </select>
                    </div>
                    <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_preset_row">
                        <label for="iig_naistera_preset">Пресеты</label>
                        <select id="iig_naistera_preset" class="flex1">
                            <option value="" ${!settings.naisteraPreset ? 'selected' : ''}>без пресета</option>
                            <option value="digital" ${settings.naisteraPreset === 'digital' ? 'selected' : ''}>digital</option>
                            <option value="realism" ${settings.naisteraPreset === 'realism' ? 'selected' : ''}>realism</option>
                        </select>
                    </div>
                    
                    <hr>

                    <!-- Nano-Banana params (aspect ratio, image size) -->
                    <div id="iig_gemini_params" class="${settings.apiType !== 'gemini' ? 'iig-hidden' : ''}">
                        <h4>Настройки Nano-Banana</h4>
                        
                        <!-- Aspect Ratio -->
                        <div class="flex-row">
                            <label for="iig_aspect_ratio">Соотношение сторон</label>
                            <select id="iig_aspect_ratio" class="flex1">
                                <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>1:1 (Квадрат)</option>
                                <option value="2:3" ${settings.aspectRatio === '2:3' ? 'selected' : ''}>2:3 (Портрет)</option>
                                <option value="3:2" ${settings.aspectRatio === '3:2' ? 'selected' : ''}>3:2 (Альбом)</option>
                                <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>3:4 (Портрет)</option>
                                <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>4:3 (Альбом)</option>
                                <option value="4:5" ${settings.aspectRatio === '4:5' ? 'selected' : ''}>4:5 (Портрет)</option>
                                <option value="5:4" ${settings.aspectRatio === '5:4' ? 'selected' : ''}>5:4 (Альбом)</option>
                                <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>9:16 (Вертикальный)</option>
                                <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>16:9 (Широкий)</option>
                                <option value="21:9" ${settings.aspectRatio === '21:9' ? 'selected' : ''}>21:9 (Ультраширокий)</option>
                            </select>
                        </div>
                        
                        <!-- Image Size -->
                        <div class="flex-row">
                            <label for="iig_image_size">Разрешение</label>
                            <select id="iig_image_size" class="flex1">
                                <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>1K (по умолчанию)</option>
                                <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K</option>
                                <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K</option>
                            </select>
                        </div>
                    </div>

                    <!-- Unified References Section (visible for gemini and naistera) -->
                    <div id="iig_refs_section" class="iig-refs ${settings.apiType === 'openai' ? 'iig-hidden' : ''}">
                        <h4>Референсы</h4>
                        <p class="hint">Загрузите фото для консистентной генерации. Макс. 4 фото отправляются в API. Char и User отправляются всегда, NPC — только если имя упомянуто в промпте.</p>
                        
                        <!-- Char slot -->
                        <div class="iig-ref-slot" data-ref-type="char">
                            <div class="iig-ref-label">{{char}}</div>
                            <div class="iig-ref-preview"><img src="" alt="Char" class="iig-ref-thumb"></div>
                            <input type="text" class="text_pole iig-ref-name" placeholder="Имя персонажа" value="">
                            <label class="menu_button iig-ref-upload-btn" title="Загрузить фото">
                                <i class="fa-solid fa-upload"></i>
                                <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                            </label>
                            <div class="menu_button iig-ref-delete-btn" title="Удалить"><i class="fa-solid fa-trash"></i></div>
                        </div>
                        
                        <!-- User slot -->
                        <div class="iig-ref-slot" data-ref-type="user">
                            <div class="iig-ref-label">{{user}}</div>
                            <div class="iig-ref-preview"><img src="" alt="User" class="iig-ref-thumb"></div>
                            <input type="text" class="text_pole iig-ref-name" placeholder="Имя пользователя" value="">
                            <label class="menu_button iig-ref-upload-btn" title="Загрузить фото">
                                <i class="fa-solid fa-upload"></i>
                                <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                            </label>
                            <div class="menu_button iig-ref-delete-btn" title="Удалить"><i class="fa-solid fa-trash"></i></div>
                        </div>
                        
                        <hr>
                        
                        <!-- 4 NPC slots -->
                        ${npcSlotsHtml}
                    </div>
                    
                    <hr>
                    
                    <h4>Обработка ошибок</h4>
                    
                    <!-- Макс. повторов -->
                    <div class="flex-row">
                        <label for="iig_max_retries">Макс. повторов</label>
                        <input type="number" id="iig_max_retries" class="text_pole flex1" 
                               value="${settings.maxRetries}" min="0" max="5">
                    </div>
                    
                    <!-- Задержка -->
                    <div class="flex-row">
                        <label for="iig_retry_delay">Задержка (мс)</label>
                        <input type="number" id="iig_retry_delay" class="text_pole flex1" 
                               value="${settings.retryDelay}" min="500" max="10000" step="500">
                    </div>
                    
                    <hr>
                    
                    <h4>Отладка</h4>
                    
                    <div class="flex-row">
                        <div id="iig_export_logs" class="menu_button" style="width: 100%;">
                            <i class="fa-solid fa-download"></i> Экспорт логов
                        </div>
                    </div>
                    <p class="hint">Экспортировать логи расширения для отладки проблем.</p>
                </div>
            </div>
        </div>
    `;
    
    container.insertAdjacentHTML('beforeend', html);
    
    // Bind event handlers
    bindSettingsEvents();

    // Render all ref slots for current character
    renderRefSlots();
}

/**
 * Bind event handlers for all 6 unified ref slots (char, user, 4 NPCs).
 */
function bindRefSlotEvents() {
    const allSlots = document.querySelectorAll('.iig-ref-slot');

    for (const slot of allSlots) {
        const refType = slot.dataset.refType; // 'char', 'user', or 'npc'
        const npcIndex = parseInt(slot.dataset.npcIndex, 10); // only for npc

        // Name input change
        const nameInput = slot.querySelector('.iig-ref-name');
        nameInput?.addEventListener('input', (e) => {
            const refs = getCurrentCharacterRefs();
            if (refType === 'char') {
                refs.charRef.name = e.target.value;
            } else if (refType === 'user') {
                refs.userRef.name = e.target.value;
            } else if (refType === 'npc') {
                if (!refs.npcs[npcIndex]) {
                    refs.npcs[npcIndex] = { name: '', imageBase64: '' };
                }
                refs.npcs[npcIndex].name = e.target.value;
            }
            saveSettings();
        });

        // File upload
        const fileInput = slot.querySelector('.iig-ref-file-input');
        fileInput?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;

            try {
                // Read file as base64
                const rawBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        const b64 = reader.result.split(',')[1];
                        resolve(b64);
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });

                // Compress
                const compressed = await compressBase64Image(rawBase64, 768, 0.8);

                // Store
                const refs = getCurrentCharacterRefs();
                if (refType === 'char') {
                    refs.charRef.imageBase64 = compressed;
                } else if (refType === 'user') {
                    refs.userRef.imageBase64 = compressed;
                } else if (refType === 'npc') {
                    if (!refs.npcs[npcIndex]) {
                        refs.npcs[npcIndex] = { name: '', imageBase64: '' };
                    }
                    refs.npcs[npcIndex].imageBase64 = compressed;
                }
                saveSettings();

                // Update thumbnail
                const thumb = slot.querySelector('.iig-ref-thumb');
                if (thumb) {
                    thumb.src = 'data:image/jpeg;base64,' + compressed;
                }

                const label = refType === 'npc' ? `NPC ${npcIndex}` : refType;
                iigLog('INFO', `Ref slot ${label}: image uploaded (~${Math.round(compressed.length / 1024)}KB)`);
                toastr.success('Фото загружено', 'Генерация картинок', { timeOut: 2000 });
            } catch (err) {
                const label = refType === 'npc' ? `NPC ${npcIndex}` : refType;
                iigLog('ERROR', `Ref slot ${label}: upload failed`, err.message);
                toastr.error('Ошибка загрузки фото', 'Генерация картинок');
            }

            // Reset file input so same file can be re-selected
            e.target.value = '';
        });

        // Delete button
        const deleteBtn = slot.querySelector('.iig-ref-delete-btn');
        deleteBtn?.addEventListener('click', () => {
            const refs = getCurrentCharacterRefs();
            if (refType === 'char') {
                refs.charRef = { name: '', imageBase64: '' };
            } else if (refType === 'user') {
                refs.userRef = { name: '', imageBase64: '' };
            } else if (refType === 'npc') {
                refs.npcs[npcIndex] = { name: '', imageBase64: '' };
            }
            saveSettings();

            // Reset UI
            const thumb = slot.querySelector('.iig-ref-thumb');
            if (thumb) thumb.src = '';
            const nameEl = slot.querySelector('.iig-ref-name');
            if (nameEl) nameEl.value = '';

            const label = refType === 'npc' ? `NPC ${npcIndex}` : refType;
            iigLog('INFO', `Ref slot ${label}: cleared`);
            toastr.info('Слот очищен', 'Генерация картинок', { timeOut: 2000 });
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

        // Model is used for OpenAI and Gemini; Naistera does not need a model.
        document.getElementById('iig_model_row')?.classList.toggle('iig-hidden', isNaistera);

        // OpenAI-only params
        document.getElementById('iig_size_row')?.classList.toggle('iig-hidden', !isOpenAI);
        document.getElementById('iig_quality_row')?.classList.toggle('iig-hidden', !isOpenAI);

        // Naistera-only params
        document.getElementById('iig_naistera_aspect_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_preset_row')?.classList.toggle('iig-hidden', !isNaistera);

        document.getElementById('iig_naistera_hint')?.classList.toggle('iig-hidden', !isNaistera);

        // Gemini params (aspect ratio, image size)
        document.getElementById('iig_gemini_params')?.classList.toggle('iig-hidden', !isGemini);

        // Unified refs section: visible for gemini and naistera, hidden for openai
        document.getElementById('iig_refs_section')?.classList.toggle('iig-hidden', isOpenAI);
    };
    
    // Enable toggle
    document.getElementById('iig_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
    });
    
    // API Type
    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value;
        saveSettings();
        updateVisibility();
    });
    
    // Endpoint
    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => {
        settings.endpoint = e.target.value;
        saveSettings();
    });
    
    // API Key
    document.getElementById('iig_api_key')?.addEventListener('input', (e) => {
        settings.apiKey = e.target.value;
        saveSettings();
    });
    
    // API Key toggle visibility
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
    
    // Model
    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value;
        saveSettings();
        
        // Auto-switch API type based on model
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
            updateVisibility();
        }
    });
    
    // Refresh models
    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            
            // Keep current selection if it exists in new list
            const currentModel = settings.model;
            
            select.innerHTML = '<option value="">-- Выберите модель --</option>';
            
            for (const model of models) {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                option.selected = model === currentModel;
                select.appendChild(option);
            }
            
            toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
        } catch (error) {
            toastr.error('Ошибка загрузки моделей', 'Генерация картинок');
        } finally {
            btn.classList.remove('loading');
        }
    });
    
    // Size
    document.getElementById('iig_size')?.addEventListener('change', (e) => {
        settings.size = e.target.value;
        saveSettings();
    });
    
    // Quality
    document.getElementById('iig_quality')?.addEventListener('change', (e) => {
        settings.quality = e.target.value;
        saveSettings();
    });
    
    // Aspect Ratio (nano-banana)
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => {
        settings.aspectRatio = e.target.value;
        saveSettings();
    });
    
    // Image Size (nano-banana)
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => {
        settings.imageSize = e.target.value;
        saveSettings();
    });

    // Naistera aspect ratio
    document.getElementById('iig_naistera_aspect_ratio')?.addEventListener('change', (e) => {
        settings.naisteraAspectRatio = e.target.value;
        saveSettings();
    });

    // Naistera preset
    document.getElementById('iig_naistera_preset')?.addEventListener('change', (e) => {
        settings.naisteraPreset = e.target.value;
        saveSettings();
    });
    
    // Max retries
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => {
        settings.maxRetries = parseInt(e.target.value) || 3;
        saveSettings();
    });
    
    // Retry delay
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => {
        settings.retryDelay = parseInt(e.target.value) || 1000;
        saveSettings();
    });
    
    // Export logs
    document.getElementById('iig_export_logs')?.addEventListener('click', () => {
        exportLogs();
    });

    // === Unified References event handlers ===
    bindRefSlotEvents();

    // Apply initial state
    updateVisibility();
}

/**
 * Initialize extension
 */
(function init() {
    const context = SillyTavern.getContext();
    
    // Debug: log available event types
    console.log('[IIG] Available event_types:', context.event_types);
    console.log('[IIG] CHARACTER_MESSAGE_RENDERED:', context.event_types.CHARACTER_MESSAGE_RENDERED);
    console.log('[IIG] MESSAGE_SWIPED:', context.event_types.MESSAGE_SWIPED);
    
    // Load settings
    getSettings();
    
    // Create settings UI when app is ready
    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        // Add buttons to any messages already in chat
        addButtonsToExistingMessages();
        console.log('[IIG] Inline Image Generation extension loaded');
    });
    
    // When chat is loaded/changed, add buttons to all existing messages and refresh refs UI
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        iigLog('INFO', 'CHAT_CHANGED event - adding buttons to existing messages');
        // Small delay to ensure DOM is ready
        setTimeout(() => {
            addButtonsToExistingMessages();
            // Refresh all ref slots for the new character
            renderRefSlots();
        }, 100);
    });
    
    // Wrapper to add debug logging
    const handleMessage = async (messageId) => {
        console.log('[IIG] Event triggered for message:', messageId);
        await onMessageReceived(messageId);
    };
    
    // Listen for new messages AFTER they're rendered in DOM
    // CHARACTER_MESSAGE_RENDERED fires after addOneMessage() completes
    // This is the ONLY event we handle - no auto-retry on swipe/update
    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);
    
    // NOTE: We intentionally DO NOT handle MESSAGE_SWIPED or MESSAGE_UPDATED
    // Swipe = user wants NEW content, not to retry old error images
    // If user wants to retry failed images, they use the regenerate button in menu
    
    console.log('[IIG] Inline Image Generation extension initialized');
})();
