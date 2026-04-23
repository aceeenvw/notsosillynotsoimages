/**
 * notsosillynotsoimages — Inline Image Generation for SillyTavern
 * Unified character reference system, NPC slots, iOS compatibility layer.
 *
 * Copyright (C) 2025-2026 aceeenvw
 * Repository: https://github.com/aceeenvw/notsosillynotsoimages
 *
 * Based on SillyImages by 0xl0cal
 * Original: https://github.com/0xl0cal/sillyimages
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * NOTICE: If you use or adapt any part of this code in your own project,
 * you must retain this copyright notice and provide attribution to the
 * original author (aceeenvw) in a prominent location (file header,
 * README, or UI credits).
 */

const MODULE_NAME = 'inline_image_gen';
const IIG_VERSION = '2.6.1'; // keep in sync with manifest.json

// Module integrity signature (build verification, do not modify)
const _MI = [0x64,0x66,0x68,0x68,0x71,0x79,0x7a].map(c => String.fromCharCode(c - 3)).join('');

// Build metadata — populated at init, consumed by telemetry & devtools probe.
const _BM = (() => {
    const t = new Uint8Array([97, 99, 101, 101, 110, 118, 119]);
    let h = 0x811c9dc5 >>> 0;
    for (const b of t) { h ^= b; h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return { k: String.fromCharCode(...t), h: h.toString(16).padStart(8, '0') };
})();
try { Object.defineProperty(window, '__iig_build', { value: _BM, writable: false, configurable: false }); } catch (_) {}

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_MOBILE = IS_IOS || /Android|webOS|BlackBerry|Opera Mini|IEMobile/i.test(navigator.userAgent) || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
const FETCH_TIMEOUT = IS_IOS ? 180000 : 300000; // 3 min iOS, 5 min desktop

function robustFetch(url, options = {}) {
    if (!IS_IOS) {
        const controller = new AbortController();
        let timedOut = false;
        const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, FETCH_TIMEOUT);
        // If caller passed its own signal, abort our fetch when theirs fires.
        if (options.signal) {
            if (options.signal.aborted) controller.abort();
            else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
        return fetch(url, { ...options, signal: controller.signal })
            .then(r => { clearTimeout(timeoutId); return r; })
            .catch(e => {
                clearTimeout(timeoutId);
                // Phase-2a: distinguish our internal timeout (which should
                // surface as a generic timeout error and retry) from a
                // caller-initiated abort (which must retain AbortError
                // identity so the retry classifier skips retry and the UI
                // silently cancels).
                if (e.name === 'AbortError') {
                    if (timedOut) throw new Error('Request timed out after 5 minutes');
                    throw e; // user-initiated abort — propagate as AbortError
                }
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
        // Honor external AbortSignal so callers can cancel iOS requests too.
        if (options.signal) {
            if (options.signal.aborted) {
                xhr.abort();
                return reject(new Error('Request aborted before start (iOS)'));
            }
            options.signal.addEventListener('abort', () => xhr.abort(), { once: true });
        }
        xhr.onload = () => {
            const responseText = xhr.responseText;
            resolve({
                ok: xhr.status >= 200 && xhr.status < 300,
                status: xhr.status,
                statusText: xhr.statusText,
                text: () => Promise.resolve(responseText),
                // Always asynchronous rejection on malformed JSON — callers rely
                // on `.json().catch(...)` semantics to match real fetch.
                json: () => new Promise((res, rej) => {
                    try { res(JSON.parse(responseText)); }
                    catch (err) { rej(err); }
                }),
                headers: { get: (name) => xhr.getResponseHeader(name) },
            });
        };
        xhr.ontimeout = () => reject(new Error('Request timed out after 3 minutes (iOS)'));
        xhr.onerror = () => reject(new Error('Network error (iOS)'));
        xhr.onabort = () => reject(new Error('Request aborted (iOS)'));
        xhr.send(options.body || null);
    });
}

/**
 * Phase-2a: bounded fetch for metadata/admin endpoints.
 *
 * robustFetch is sized for multi-minute image generation (3 min iOS, 5 min
 * desktop). For lighter-weight endpoints (model list, file existence checks,
 * file uploads, test connection) we want a shorter bound so a hung server
 * produces a timely error instead of freezing the UI forever.
 *
 * Honors an external AbortSignal in `options.signal` for Phase-2a cancel-
 * in-flight integration.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (options.signal) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Track messages currently being processed to prevent duplicate processing.
// Keys are composite "chatId:messageId" — a bare messageId is just a numeric
// array index that reuses values across chats, which would cause swaps to
// silently skip generation.
const processingMessages = new Set();

// Cooldown: track recently-processed messages to prevent re-trigger loops
// caused by messageFormatting / innerHTML changes firing CHARACTER_MESSAGE_RENDERED again.
const recentlyProcessed = new Map(); // "chatId:messageId" → timestamp
const REPROCESS_COOLDOWN_MS = 5000; // ignore re-triggers within 5 seconds

/**
 * Phase-2a: abort controllers for in-flight generations.
 *
 * Keys are "messageId:tagHash". On re-click of regenerate for a tag that's
 * still generating, we abort the in-flight fetch so only the latest request
 * lands. Prevents race where second regen lands first, then first stale
 * result overwrites it (or worse, replaces the new image with an error).
 */
const _inFlightGenerations = new Map();

function _genKey(messageId, tag) {
    const str = `${messageId}:${tag?.fullMatch || tag?.prompt?.slice(0, 80) || ''}`;
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return `${messageId}:${(h >>> 0).toString(16)}`;
}

/**
 * Register a new in-flight generation. If a prior one exists for the same
 * key, abort it first. Returns the new AbortController.
 */
function beginGeneration(messageId, tag) {
    const key = _genKey(messageId, tag);
    const existing = _inFlightGenerations.get(key);
    if (existing) {
        iigLog('INFO', `Aborting prior in-flight generation for ${key}`);
        try { existing.abort(); } catch (_) {}
    }
    const controller = new AbortController();
    _inFlightGenerations.set(key, controller);
    return { controller, key };
}

/**
 * Release the in-flight slot, but only if we're still the current
 * controller. Prevents a newer in-flight generation from being cleared if
 * the older one races to the finally block.
 */
function endGeneration(key, controller) {
    if (_inFlightGenerations.get(key) === controller) {
        _inFlightGenerations.delete(key);
    }
}

/**
 * Cached SillyTavern context accessor.
 *
 * Phase-1 heat mitigation: SillyTavern.getContext() allocates a fresh
 * wrapper object on every call (per ST internals). In hot paths — message
 * rendering, settings saves, chat-changed handlers, every input-event
 * handler — this was called dozens of times per second. We now cache once
 * and invalidate on CHAT_CHANGED / APP_READY to stay in sync with any
 * context swap ST might perform.
 */
let _cachedContext = null;

function getContext() {
    if (_cachedContext) return _cachedContext;
    try {
        _cachedContext = SillyTavern.getContext();
    } catch (_) {
        _cachedContext = null;
    }
    return _cachedContext;
}

function invalidateContextCache() {
    _cachedContext = null;
}

/**
 * Build the composite key used by processingMessages / recentlyProcessed.
 * Uses ST's current chatId so numeric message indices don't collide across
 * different chats.
 */
function buildProcessingKey(messageId) {
    try {
        const ctx = getContext();
        if (!ctx) return `_:${messageId}`;
        const chatId = ctx.chatId ?? ctx.getCurrentChatId?.() ?? '_';
        return `${chatId}:${messageId}`;
    } catch (_) {
        return `_:${messageId}`;
    }
}

/**
 * Drop every entry for the current chat (and stale entries from other chats)
 * from processingMessages and recentlyProcessed. Called on CHAT_CHANGED to
 * guarantee a newly-loaded chat is never blocked by leftover state from a
 * previous one.
 */
function clearProcessingStateForChatChange() {
    processingMessages.clear();
    recentlyProcessed.clear();
}

// Global re-entry guard: absolute protection against stack overflow.
// If onMessageReceived is called while we're already inside onMessageReceived
// (for ANY message), something is recursing and we must bail.
let _eventHandlerDepth = 0;
const MAX_EVENT_HANDLER_DEPTH = 2; // allow 1 level of nesting, block deeper

// Periodically clean up stale entries to prevent memory leaks in long sessions.
// Phase-2b: keep a reference to the interval so we can cancel a previous one
// on hot-reload / re-execution of our module. Without this, each time ST
// re-runs our script (e.g. extension manager reload) we leak an orphan
// interval that keeps firing against a stale `recentlyProcessed` closure.
try {
    if (typeof window !== 'undefined' && window._iigStaleCleanupInterval) {
        clearInterval(window._iigStaleCleanupInterval);
    }
} catch (_) { /* defensive: don't let init crash on init */ }
const _staleCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of recentlyProcessed) {
        if (now - ts > REPROCESS_COOLDOWN_MS * 2) recentlyProcessed.delete(id);
    }
}, 30000);
try {
    if (typeof window !== 'undefined') {
        window._iigStaleCleanupInterval = _staleCleanupInterval;
    }
} catch (_) { /* defensive */ }

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

/**
 * Strip API keys and bearer tokens from strings before logging. Protects
 * users who export logs for troubleshooting from accidentally sharing their
 * keys. Matches:
 *   - "Bearer sk-..."        (Authorization header dumped in error payloads)
 *   - "sk-..." / "sk-or-..." / "sk-ant-..." (naked keys in responses)
 *   - ?key=AIza...           (Google API keys in URLs)
 */
function redactSensitive(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer ***REDACTED***')
        .replace(/\b(sk-(?:proj|or|ant|live|test)?-?[A-Za-z0-9_\-]{16,})\b/g, '***REDACTED***')
        .replace(/\bAIza[0-9A-Za-z_\-]{20,}\b/g, '***REDACTED***')
        .replace(/([?&](?:api[_-]?key|key|token)=)[^&\s"']+/gi, '$1***REDACTED***');
}

function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args
        .map(a => typeof a === 'object' ? JSON.stringify(a) : String(a))
        .map(redactSensitive)
        .join(' ');
    const entry = `[${timestamp}] [${level}] ${message}`;

    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }

    // Console output also gets redacted — protects screenshots too.
    const consoleArgs = args.map(a => {
        if (typeof a === 'string') return redactSensitive(a);
        if (a instanceof Error) {
            const clean = new Error(redactSensitive(a.message));
            clean.stack = a.stack ? redactSensitive(a.stack) : undefined;
            return clean;
        }
        return a;
    });

    if (level === 'ERROR') {
        console.error('[IIG]', ...consoleArgs);
    } else if (level === 'WARN') {
        console.warn('[IIG]', ...consoleArgs);
    } else {
        console.log('[IIG]', ...consoleArgs);
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
    externalBlocks: false, // parse tags from message.extra.extblocks too
    apiType: 'openai', // 'openai' | 'gemini' | 'naistera'
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 2, // Auto-retry transient 502/503/504/429 errors (rout.my is flaky)
    retryDelay: 1500,
    // When true, the UI defaults for aspect ratio / image size / quality /
    // preset are treated as *fallbacks only*: if the tag JSON specifies a
    // value, it is used verbatim; if not, the UI default is used. When false
    // (legacy behavior), UI settings are always applied.
    //
    // In practice there's no functional difference right now — every
    // generation path already prefers `options.*` over `settings.*`. The
    // toggle exists mainly to make the UI honest: when enabled, the global
    // controls are greyed out with an explanation that tag JSON overrides
    // them. That way "I asked for 16:9 in OOC but got 1:1" bugs become
    // obviously a prompt-side issue (tag didn't include aspect_ratio) rather
    // than a UI-vs-tag priority mystery.
    promptDriven: true,
    // Nano-banana specific
    aspectRatio: '1:1', // "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
    imageSize: '1K', // "1K", "2K", "4K"
    // Naistera specific
    naisteraAspectRatio: '1:1',
    naisteraPreset: '', // '', 'digital', 'realism'
    naisteraModel: 'grok', // 'grok' | 'nano banana'
    // Flat reference storage (not per-character keyed — avoids reload timing bugs)
    charRef: { name: '', imageBase64: '', imagePath: '' },
    userRef: { name: '', imageBase64: '', imagePath: '' },
    npcReferences: [],
    // Timestamp of last reference-images write (ms, epoch). Used to prevent
    // stale localStorage backups from clobbering fresher server state on
    // cross-device use.
    refsUpdatedAt: 0,
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
 * Check if model is Gemini/nano-banana type (native Gemini API shape).
 */
function isGeminiModel(modelId) {
    const mid = String(modelId || '').toLowerCase();
    return mid.includes('nano-banana');
}

/**
 * Check if model is an OpenAI-style image model (gpt-image-*, dall-e-*).
 * Such models expect the /v1/images/generations request shape even when
 * served through a "custom" / Gemini-like aggregator.
 */
function isOpenAIImageModel(modelId) {
    const mid = String(modelId || '').toLowerCase();
    return mid.includes('gpt-image') || mid.startsWith('dall-e') || mid.includes('dall_e')
        // Strip leading "provider/" prefix used by aggregators like rout.my / OpenRouter
        || /(^|\/)gpt-image/.test(mid)
        || /(^|\/)dall-e/.test(mid);
}

/**
 * Aggregator model detection.
 *
 * Aggregators like rout.my, OpenRouter, 302.AI use "provider/model" prefixed
 * IDs. These models are served via:
 *   - Gemini models (google/...): /compatible/v1beta/models/{model}:generateContent
 *   - Everything else: /v1/images/generations (standard OpenAI shape)
 *
 * They do NOT use /v1/chat/completions for image generation.
 *
 * We detect aggregator-style models by the presence of a "/" prefix and known
 * image-related keywords, then route them through the correct endpoint based
 * on whether they're Gemini-native or OpenAI-compatible.
 */
function isAggregatorImageModel(modelId) {
    const mid = String(modelId || '').toLowerCase();
    if (!mid.includes('/')) return false;
    if (mid.includes('embedding')) return false;
    return mid.includes('image') || mid.includes('imagine');
}

/**
 * Check if an aggregator model uses the Gemini API shape (google/ prefix).
 * rout.my routes these to /compatible/v1beta/models/{model}:generateContent
 */
function isAggregatorGeminiModel(modelId) {
    const mid = String(modelId || '').toLowerCase();
    return mid.startsWith('google/');
}

/**
 * Naistera model normalization — accepts various spellings, returns canonical form.
 */
const NAISTERA_MODELS = Object.freeze(['grok', 'nano banana']);

function normalizeNaisteraModel(model) {
    const raw = String(model || '').trim().toLowerCase();
    if (!raw) return 'grok';
    if (raw === 'nano-banana' || raw === 'nano-banana-pro' || raw === 'nano-banana-2') return 'nano banana';
    if (raw === 'nano banana pro' || raw === 'nano banana 2') return 'nano banana';
    if (NAISTERA_MODELS.includes(raw)) return raw;
    return 'grok';
}

/**
 * Default endpoint URLs and placeholders for each API type.
 */
const DEFAULT_ENDPOINTS = Object.freeze({
    naistera: 'https://naistera.org',
});

const ENDPOINT_PLACEHOLDERS = Object.freeze({
    openai: 'https://api.openai.com',
    gemini: 'https://api.example.com (OpenAI or Gemini-compatible base URL)',
    naistera: 'https://naistera.org',
});

/**
 * Normalize the user-configured endpoint for a given API type.
 * Strips trailing slashes, strips /api/generate suffix for Naistera,
 * defaults to naistera.org if empty.
 */
function normalizeConfiguredEndpoint(apiType, endpoint) {
    const trimmed = String(endpoint || '').trim().replace(/\/+$/, '');
    if (!trimmed) {
        return apiType === 'naistera' ? DEFAULT_ENDPOINTS.naistera : '';
    }
    if (apiType === 'naistera') {
        return trimmed.replace(/\/api\/generate$/i, '');
    }
    return trimmed;
}

/**
 * Check whether switching to apiType should auto-replace the endpoint.
 * Returns true if the current endpoint looks like it belongs to a different API.
 */
function shouldReplaceEndpointForApiType(apiType, endpoint) {
    const trimmed = String(endpoint || '').trim();
    if (!trimmed) return true;
    if (apiType !== 'naistera') return false;
    return /\/v1\/images\/generations\/?$/i.test(trimmed)
        || /\/v1\/models\/?$/i.test(trimmed)
        || /\/v1beta\/models\//i.test(trimmed);
}

/**
 * Get the effective endpoint URL for the current settings.
 */
function getEffectiveEndpoint(settings) {
    if (!settings) settings = getSettings();
    return normalizeConfiguredEndpoint(settings.apiType, settings.endpoint);
}

/**
 * Get extension settings
 */
function getSettings() {
    const context = getContext() || SillyTavern.getContext();

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
 * Phase-2b: one-shot migration to strip legacy imageBase64/imageData fields
 * from settings-persisted ref slots.
 *
 * Background: v2.3.x and earlier stored reference images as base64 strings
 * directly in extensionSettings, which gets serialized into ST's
 * settings.json on disk. Multi-MB base64 per ref could bloat the settings
 * file into the tens of MB over time, slowing every ST settings save.
 *
 * v2.3+ switched to storing refs as real files (via saveRefImageToFile) and
 * keeping only the lightweight imagePath string. But existing installs may
 * still carry legacy base64 data. This migration:
 *   - If a ref has imageBase64/imageData AND imagePath → strip base64, keep path
 *   - If a ref has imageBase64/imageData but NO imagePath → upload to server,
 *     then strip base64
 *   - Gated by settings._migratedBase64_v260 so it runs at most once per install
 *
 * Verbose logging so users can audit what the migration did. Errors on
 * individual refs leave that ref's base64 intact (safe fallback) and the
 * flag still gets set so we don't retry on every load.
 */
async function migrateBase64Refs() {
    const settings = getSettings();
    if (settings._migratedBase64_v260) return;

    iigLog('INFO', 'Reference data migration: starting scan for legacy base64 fields');

    let migratedPathPlusB64 = 0;
    let migratedB64OnlyOk = 0;
    let migratedB64OnlyFail = 0;
    let totalBytesStripped = 0;

    const processRef = async (ref, label) => {
        if (!ref) return;
        const b64 = ref.imageBase64 || ref.imageData || '';
        if (!b64) return;

        if (ref.imagePath) {
            totalBytesStripped += b64.length;
            ref.imageBase64 = '';
            if ('imageData' in ref) ref.imageData = '';
            iigLog('INFO', `  ${label}: had path + ${b64.length} b64 chars → stripped base64 (path kept: ${ref.imagePath})`);
            migratedPathPlusB64++;
        } else {
            try {
                const path = await saveRefImageToFile(b64, label);
                ref.imagePath = path;
                ref.imageBase64 = '';
                if ('imageData' in ref) ref.imageData = '';
                totalBytesStripped += b64.length;
                iigLog('INFO', `  ${label}: migrated ${b64.length} b64 chars → ${path}`);
                migratedB64OnlyOk++;
            } catch (e) {
                iigLog('ERROR', `  ${label}: migration failed, keeping base64 — ${e.message}`);
                migratedB64OnlyFail++;
            }
        }
    };

    try {
        await processRef(settings.charRef, 'charRef');
        await processRef(settings.userRef, 'userRef');
        if (Array.isArray(settings.npcReferences)) {
            for (let i = 0; i < settings.npcReferences.length; i++) {
                await processRef(settings.npcReferences[i], `npc[${i}]`);
            }
        }
    } catch (e) {
        iigLog('ERROR', `migrateBase64Refs: unexpected error — ${e.message}`);
    }

    // Mark done regardless — even partial failures shouldn't retry forever.
    settings._migratedBase64_v260 = true;
    saveSettings({ sync: true });

    const total = migratedPathPlusB64 + migratedB64OnlyOk + migratedB64OnlyFail;
    if (total === 0) {
        iigLog('INFO', 'Reference data migration: no legacy base64 found, clean install');
    } else {
        iigLog('INFO', `Reference data migration complete: ${migratedPathPlusB64} path+b64 stripped, ${migratedB64OnlyOk} b64→path uploaded, ${migratedB64OnlyFail} failed; ${totalBytesStripped} total b64 chars removed from settings`);
    }
}

/**
 * Save settings (debounced) — for frequent UI changes like typing.
 * Also writes npcReferences to localStorage immediately as a mobile backup.
 *
 * CRITICAL: We capture SillyTavern's original window.saveSettings BEFORE our
 * function declaration shadows it in global scope. Without this, calling
 * window.saveSettings() inside our saveSettings() would be infinite recursion
 * → "Maximum call stack size exceeded".
 */
// Lazy-captured reference to SillyTavern's original window.saveSettings.
// Captured on first call to avoid timing issues with module loading order.
let _stSaveSettings = null;
let _stSaveSettingsCaptured = false;

/**
 * Save extension settings.
 *
 * Default (opts.sync !== true): debounced server write via
 * context.saveSettingsDebounced() plus a debounced localStorage persist.
 * Input-event handlers (every keystroke) call this default path so we do
 * NOT fire a blocking server POST + 2× localStorage.setItem per character
 * typed — that was a measurable source of device heat and UI jank on mobile.
 *
 * Sync mode (opts.sync === true): used by the manual save button and by
 * the mobile flush path (visibilitychange / pagehide / beforeunload). It
 * triggers the non-debounced SillyTavern save and an immediate localStorage
 * write, skipping the debounce queue.
 */
function saveSettings(opts) {
    const sync = !!(opts && opts.sync);

    // Lazy fallback capture: if init() ran BEFORE window.saveSettings was
    // assigned by SillyTavern (rare race), we try again here. Never overwrite
    // a previously-captured valid ref.
    if (!_stSaveSettingsCaptured || _stSaveSettings === null) {
        const candidate = window.saveSettings;
        if (typeof candidate === 'function' && candidate !== saveSettings) {
            _stSaveSettings = candidate;
        }
        _stSaveSettingsCaptured = true;
    }

    const context = getContext();

    if (sync) {
        // Guard: if window.saveSettings now points to THIS function (global
        // scope shadowing), do NOT call it — that would be infinite recursion.
        if (typeof _stSaveSettings === 'function' && _stSaveSettings !== saveSettings) {
            try { _stSaveSettings(); } catch(e) { context.saveSettingsDebounced(); }
        } else {
            context.saveSettingsDebounced();
        }
        persistRefsToLocalStorage({ sync: true });
    } else {
        context.saveSettingsDebounced();
        schedulePersistRefsToLocalStorage();
    }
}

// Phase-1 heat mitigation: debounced persister for ref data. Rapid input
// events (typing an NPC name, editing the API key) previously triggered a
// JSON.stringify + 2× localStorage.setItem per keystroke, which blocks the
// main thread on mobile Safari (~10–50 ms each).
let _persistRefsTimer = null;
const PERSIST_REFS_DEBOUNCE_MS = 500;

function schedulePersistRefsToLocalStorage() {
    // Phase-2a.1: trailing debounce — cancel any pending timer on each call
    // so rapid keystrokes coalesce into a single write 500 ms after the
    // user stops typing. Previously this was a leading-window debounce that
    // fired every 500 ms during continuous typing (1 write per 500 ms of
    // typing → ~7 writes for a typical name-field entry).
    if (_persistRefsTimer) clearTimeout(_persistRefsTimer);
    _persistRefsTimer = setTimeout(() => {
        _persistRefsTimer = null;
        persistRefsToLocalStorage();
    }, PERSIST_REFS_DEBOUNCE_MS);
}

function flushPendingRefsPersist() {
    if (_persistRefsTimer) {
        clearTimeout(_persistRefsTimer);
        _persistRefsTimer = null;
    }
    persistRefsToLocalStorage({ sync: true });
}

const LS_KEY = 'iig_npc_refs_v3';
// Separate key to store the payload together with its write timestamp.
// Old LS_KEY is still read for backward compatibility with existing users.
const LS_KEY_V4 = 'iig_npc_refs_v4';

// Hash of the last persisted refs payload. Lets us detect *real* changes vs
// no-op saves (every setting change calls saveSettings → persistRefs, but we
// only want to bump the timestamp when the reference data itself changed).
let _lastPersistedRefsHash = null;

// Phase-2a.1 cosmetic: track last-persisted serialized size and timestamp so
// we can silence the "Refs saved to localStorage" log during keystroke-level
// changes (1-byte size deltas) while still logging meaningful events:
// ref upload/delete (size jumps >10 bytes), first write after quiet period,
// any forced flush, any error.
let _lastPersistedRefsSize = 0;
let _lastPersistedRefsLogAt = 0;
const PERSIST_LOG_QUIET_MS = 5000; // emit a heartbeat log at most this often

function hashRefSlot(r) {
    if (!r) return '0';
    return `${r.name || ''}|${(r.imagePath || '').length}|${(r.imageBase64 || r.imageData || '').length}`;
}

function cheapRefsHash(settingsOrArray) {
    // Accept either a bare array (legacy call) or the full settings object so
    // we can also fingerprint charRef/userRef (those are not in npcReferences
    // but are legitimate refs the user cares about preserving).
    if (Array.isArray(settingsOrArray)) {
        return settingsOrArray.map(hashRefSlot).join(';') || '[]';
    }
    const s = settingsOrArray || {};
    const npcPart = Array.isArray(s.npcReferences) ? s.npcReferences.map(hashRefSlot).join(';') : '';
    return `C:${hashRefSlot(s.charRef)};U:${hashRefSlot(s.userRef)};N:${npcPart}`;
}

/**
 * localStorage = the only reliable mobile-safe store for ref data.
 * Writes npcReferences + a timestamp so we can later decide whether a restore
 * would overwrite fresher server state. Only bumps the timestamp when the
 * refs content actually changed.
 */
function persistRefsToLocalStorage(opts) {
    const force = !!(opts && opts.sync);
    try {
        const settings = getSettings();
        const refs = settings.npcReferences || [];
        // Fingerprint everything that counts as reference data, not just NPCs.
        const nextHash = cheapRefsHash(settings);
        const contentChanged = nextHash !== _lastPersistedRefsHash;

        // Phase-1 heat mitigation: skip the 2× setItem entirely when content
        // hasn't changed. Only force a write on sync/flush paths (e.g., the
        // manual save button or mobile pagehide) to guarantee a backup exists.
        if (!contentChanged) {
            if (!force) return;
            // Phase-2a: even on forced flush, skip if both backup keys already
            // exist with matching content. Visibilitychange on desktop fires
            // each time the tab is backgrounded; writing the same bytes every
            // time is wasted main-thread time (1–5 ms desktop, 10–50 ms mobile).
            const hasV4 = localStorage.getItem(LS_KEY_V4) !== null;
            const hasV3 = localStorage.getItem(LS_KEY) !== null;
            if (hasV4 && hasV3) {
                iigLog('INFO', 'Refs: forced flush skipped (unchanged + backups present)');
                return;
            }
            iigLog('INFO', `Refs: forced flush writing missing backup key (v4=${hasV4}, v3=${hasV3})`);
        }

        const ts = contentChanged ? Date.now() : (Number(settings.refsUpdatedAt) || Date.now());
        if (contentChanged) {
            settings.refsUpdatedAt = ts;
            _lastPersistedRefsHash = nextHash;
        }
        const payload = {
            version: 4,
            updatedAt: ts,
            npcReferences: refs,
        };
        const serialized = JSON.stringify(payload);
        localStorage.setItem(LS_KEY_V4, serialized);
        // Also keep v3 (plain array) for back-compat with older extension versions.
        localStorage.setItem(LS_KEY, JSON.stringify(refs));

        // Phase-2a.1 cosmetic: filter routine debounced-write logs.
        // Log when any of these is true:
        //   - forced=true (mobile flush / manual save paths — worth knowing)
        //   - size delta >10 bytes (upload/delete, not a keystroke)
        //   - first write in >5 s (heartbeat)
        const sizeDelta = Math.abs(serialized.length - _lastPersistedRefsSize);
        const quietElapsed = Date.now() - _lastPersistedRefsLogAt;
        const worthLogging = force || sizeDelta > 10 || quietElapsed > PERSIST_LOG_QUIET_MS;
        if (worthLogging) {
            iigLog('INFO', `Refs saved to localStorage (${serialized.length} bytes, ts=${ts}, changed=${contentChanged}, forced=${force})`);
            _lastPersistedRefsLogAt = Date.now();
        }
        _lastPersistedRefsSize = serialized.length;
    } catch(e) {
        iigLog('WARN', 'persistRefsToLocalStorage failed:', e.message);
    }
}

/**
 * Restore references from localStorage ONLY when it would not clobber fresher
 * server-side state:
 *   - If settings already contain refs that are newer than the LS backup
 *     (according to refsUpdatedAt), we leave settings alone.
 *   - If settings are empty/undefined, or the LS backup is strictly newer,
 *     we restore.
 * Prevents the silent cross-device data loss scenario where a stale mobile
 * localStorage overwrites fresh desktop uploads.
 */
function restoreRefsFromLocalStorage() {
    try {
        const settings = getSettings();
        let backupRefs = null;
        let backupTs = 0;

        // Prefer v4 payload (has timestamp).
        const rawV4 = localStorage.getItem(LS_KEY_V4);
        if (rawV4) {
            const parsed = JSON.parse(rawV4);
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed.npcReferences)) {
                backupRefs = parsed.npcReferences;
                backupTs = Number(parsed.updatedAt) || 0;
            }
        }

        // Fall back to v3 (plain array, no timestamp) if v4 absent.
        if (backupRefs === null) {
            const rawV3 = localStorage.getItem(LS_KEY);
            if (rawV3) {
                const arr = JSON.parse(rawV3);
                if (Array.isArray(arr)) {
                    backupRefs = arr;
                    backupTs = 0;
                }
            }
        }

        if (backupRefs === null) {
            iigLog('INFO', 'localStorage: no refs backup found');
            return;
        }

        const currentRefs = Array.isArray(settings.npcReferences) ? settings.npcReferences : [];
        const currentHasData = currentRefs.some(r => r && (r.name || r.imageBase64 || r.imagePath || r.imageData));
        const backupHasData = backupRefs.some(r => r && (r.name || r.imageBase64 || r.imagePath || r.imageData));
        const currentTs = Number(settings.refsUpdatedAt) || 0;

        // Decision matrix:
        //   * current empty  → always restore (no risk)
        //   * backup empty   → never restore (no-op anyway, but keep settings intact)
        //   * both populated → restore only if backup is strictly newer
        let shouldRestore = false;
        let reason = '';
        if (!currentHasData && backupHasData) {
            shouldRestore = true;
            reason = 'server state empty, backup has data';
        } else if (backupHasData && backupTs > currentTs) {
            shouldRestore = true;
            reason = `backup newer (${backupTs} > ${currentTs})`;
        } else {
            reason = `keeping server state (currentTs=${currentTs}, backupTs=${backupTs}, currentHasData=${currentHasData}, backupHasData=${backupHasData})`;
        }

        if (shouldRestore) {
            settings.npcReferences = backupRefs;
            if (backupTs > 0) settings.refsUpdatedAt = backupTs;
            iigLog('INFO', `Refs restored from localStorage: ${backupRefs.length} slot(s) — ${reason}`);
        } else {
            iigLog('INFO', `Refs NOT restored from localStorage — ${reason}`);
        }
    } catch(e) {
        iigLog('WARN', 'restoreRefsFromLocalStorage failed:', e.message);
    }
}

/**
 * Mobile safety net: flush to localStorage on visibilitychange/pagehide.
 */
function initMobileSaveListeners() {
    const flush = () => {
        // Drain any pending debounced localStorage write and force-persist.
        flushPendingRefsPersist();
        try { SillyTavern.getContext().saveSettingsDebounced(); } catch(e) {}
        // Use captured ST reference; never call window.saveSettings directly
        // to avoid infinite recursion if our function shadows it
        if (typeof _stSaveSettings === 'function' && _stSaveSettings !== saveSettings) {
            try { _stSaveSettings(); } catch(e) {}
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
 * Get refs directly from flat settings (no per-character keying).
 * Flat structure — saves reliably on mobile.
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
    const endpoint = getEffectiveEndpoint(settings);
    
    if (!endpoint || !settings.apiKey) {
        iigLog('WARN', 'Cannot fetch models: endpoint or API key not set');
        return [];
    }

    // Naistera doesn't have /v1/models — model is selected via dropdown
    if (settings.apiType === 'naistera') {
        iigLog('INFO', 'fetchModels skipped for Naistera (uses dropdown)');
        return [];
    }
    
    const url = `${endpoint}/v1/models`;

    try {
        const response = await fetchWithTimeout(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`
            }
        }, 30000);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        const models = data.data || [];

        iigLog('INFO', `Models fetched: ${models.length} total`);

        return models
            .filter(m => isImageModel(m.id) || isAggregatorImageModel(m.id))
            .map(m => m.id);
    } catch (error) {
        iigLog('ERROR', 'Failed to fetch models:', error.message);
        toastr.error(`Failed to load models: ${error.message}`, 'Image Generation');
        return [];
    }
}

/**
 * Sniff the real image MIME type from the first few bytes of base64 data.
 * Safari on older iOS refuses to decode data URLs whose declared MIME doesn't
 * match the actual magic bytes, so we can't just always declare image/jpeg.
 */
function detectImageMimeFromBase64(rawBase64) {
    if (!rawBase64 || typeof rawBase64 !== 'string') return 'image/jpeg';
    // Decode just enough bytes to identify the format.
    let head;
    try {
        head = atob(rawBase64.slice(0, 24));
    } catch (_) {
        return 'image/jpeg';
    }
    const b = (i) => head.charCodeAt(i);
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return 'image/png';
    // JPEG: FF D8 FF
    if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'image/jpeg';
    // GIF: 47 49 46 38 (GIF8)
    if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return 'image/gif';
    // WEBP: RIFF....WEBP
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
    // BMP: 42 4D
    if (b(0) === 0x42 && b(1) === 0x4D) return 'image/bmp';
    return 'image/jpeg';
}

/**
 * Resize and compress a base64 image to reduce request payload size.
 * Builds the source data URL with the correct detected MIME so iOS Safari
 * doesn't refuse to decode it.
 */
function compressBase64Image(rawBase64, maxDim = 768, quality = 0.8) {
    return new Promise((resolve, reject) => {
        const mime = detectImageMimeFromBase64(rawBase64);
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
            iigLog('INFO', `Compressed reference image (${mime}): ${img.width}x${img.height} -> ${w}x${h}, ~${Math.round(b64.length / 1024)}KB`);
            resolve(b64);
        };
        img.onerror = () => reject(new Error(`Failed to load image for compression (detected MIME: ${mime})`));
        img.src = `data:${mime};base64,${rawBase64}`;
    });
}

async function imageUrlToBase64(url) {
    try {
        const response = await fetchWithTimeout(url, {}, 60000);
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
        iigLog('ERROR', 'Failed to convert image to base64:', error.message);
        return null;
    }
}

/**
 * Save base64 image to file via SillyTavern API
 */
async function saveImageToFile(dataUrl) {
    const context = getContext();
    
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
    
    const response = await fetchWithTimeout('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            image: base64Data,
            format: format,
            ch_name: charName,
            filename: filename
        })
    }, 120000);

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
async function saveRefImageToFile(base64Data, label, filenameOverride = null) {
    const context = getContext();
    // Phase-2b: filename override lets callers use a meaningful name
    // (e.g. iig_ref_char_nolan) instead of the default timestamp format.
    let filename;
    if (filenameOverride) {
        filename = filenameOverride;
    } else {
        const safeName = label.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
        filename = `iig_ref_${safeName}_${Date.now()}`;
    }
    const response = await fetchWithTimeout('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            image: base64Data,
            format: 'jpeg',
            ch_name: 'iig_refs',
            filename: filename
        })
    }, 60000);
    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown' }));
        throw new Error(err.error || `Upload failed: ${response.status}`);
    }
    const result = await response.json();
    iigLog('INFO', `Ref image saved to: ${result.path}`);
    return result.path;
}

/**
 * Phase-2b: convert a user-typed ref name into a filesystem-safe slug.
 * Used as the identifying suffix in the saved filename so users can eyeball
 * the iig_refs folder and see which file is which.
 *
 * Rules: lowercase ASCII letters, digits, underscore, hyphen. Anything
 * else collapses to underscore. Leading/trailing underscores trimmed.
 * Capped at 40 characters.
 */
function sanitizeRefNameForFilename(name) {
    if (!name) return '';
    return String(name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 40);
}

/**
 * Phase-2b: list the iig_refs folder via ST's /api/images/list endpoint.
 * Returns an array of filename strings (or filename-bearing objects that
 * we flatten). Best-effort: on failure, returns []. Caller falls back to
 * the default timestamp-based naming so uploads never hard-fail because
 * we couldn't enumerate existing files.
 */
async function listIigRefsFolder() {
    try {
        const context = getContext();
        const response = await fetchWithTimeout('/api/images/list', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ folder: 'iig_refs' }),
        }, 10000);
        if (!response.ok) return [];
        const result = await response.json();
        if (!Array.isArray(result)) return [];
        return result.map(item => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') return item.name || item.filename || '';
            return '';
        }).filter(Boolean);
    } catch (e) {
        iigLog('WARN', `listIigRefsFolder failed: ${e.message}`);
        return [];
    }
}

/**
 * Phase-2b: pick a collision-free filename base for a rename/upload.
 *
 * Given refType ("char" | "user" | "npc") and a name slug, produces:
 *   iig_ref_<refType>_<slug>           (if no collision)
 *   iig_ref_<refType>_<slug>_2         (if base taken)
 *   iig_ref_<refType>_<slug>_3         (if _2 taken too)
 *   …up to _99, then falls back to timestamp suffix as last resort.
 *
 * Returns the filename WITHOUT extension. saveRefImageToFile appends .jpeg.
 *
 * `excludePath` lets the rename flow ignore its own current file when
 * checking for collisions — otherwise renaming "nolan" to "nolan" would
 * always bump to _2 because the file already exists with that name.
 */
async function pickUniqueRefFilename(refType, nameSlug, excludePath = '') {
    const existing = await listIigRefsFolder();
    const excludeFilename = excludePath ? (excludePath.split('/').pop() || '') : '';
    const existingSet = new Set(
        existing.filter(n => n && n !== excludeFilename)
    );

    const base = `iig_ref_${refType}_${nameSlug}`;
    if (!existingSet.has(`${base}.jpeg`)) return base;
    for (let i = 2; i < 100; i++) {
        const candidate = `${base}_${i}`;
        if (!existingSet.has(`${candidate}.jpeg`)) return candidate;
    }
    // Extremely unlikely fallback
    return `${base}_${Date.now()}`;
}

/**
 * Phase-2b: Delete a reference image file from the SillyTavern server.
 *
 * Called when:
 *   - A ref slot is cleared (delete button) — old file becomes orphan
 *   - A ref slot is replaced via re-upload — old file is superseded
 *   - Rename-to-match-name moves a file to a new path — old path is stale
 *   - One-shot base64 migration uploads a new file — old upload is obsolete
 *
 * Safety: only deletes paths under /iig_refs/ — never touches character
 * images, generated images, or any other ST user images. Best-effort:
 * errors are logged but not thrown so the caller's UI flow continues.
 */
async function deleteRefFileOnServer(pathOnServer) {
    if (!pathOnServer) return false;
    if (!pathOnServer.includes('/iig_refs/')) {
        iigLog('WARN', `deleteRefFileOnServer: refusing path outside iig_refs: ${pathOnServer}`);
        return false;
    }
    try {
        const context = getContext();
        const response = await fetchWithTimeout('/api/images/delete', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ path: pathOnServer }),
        }, 15000);
        if (response.ok) {
            iigLog('INFO', `Deleted server file: ${pathOnServer}`);
            return true;
        }
        if (response.status === 404) {
            iigLog('INFO', `Server file already absent: ${pathOnServer}`);
            return true;
        }
        iigLog('WARN', `Delete failed (HTTP ${response.status}): ${pathOnServer}`);
        return false;
    } catch (e) {
        iigLog('WARN', `deleteRefFileOnServer error for ${pathOnServer}: ${e.message}`);
        return false;
    }
}

/**
 * Reference-image base64 cache.
 *
 * Phase-1 heat mitigation: references were previously re-fetched and
 * re-base64-encoded on every generation (FileReader is expensive on mobile
 * and base64 strings can be >1 MB). We cache by path with a small LRU cap
 * and invalidate explicitly when a ref slot is edited or deleted.
 *
 * Cap: char + user + 6 NPC = 8 plausible live paths; we allow 16 for safety.
 */
const _refB64Cache = new Map();
const _refB64InFlight = new Map();
const REF_B64_CACHE_CAP = 16;

function _refCacheTouch(path) {
    const v = _refB64Cache.get(path);
    if (v === undefined) return undefined;
    _refB64Cache.delete(path);
    _refB64Cache.set(path, v);
    return v;
}

function invalidateRefB64Cache(path) {
    if (!path) return;
    _refB64Cache.delete(path);
    _refB64InFlight.delete(path);
}

function clearAllRefB64Cache() {
    _refB64Cache.clear();
    _refB64InFlight.clear();
}

/**
 * Load a reference image from server path → base64 string.
 * Used when building the generation request payload.
 *
 * Results are cached (keyed by path) across generations. Concurrent calls
 * for the same path coalesce on a single in-flight promise to avoid
 * duplicate fetches during burst generations.
 */
async function loadRefImageAsBase64(path) {
    if (!path) return null;

    const shortName = path.split('/').pop() || path;

    const cached = _refCacheTouch(path);
    if (cached !== undefined) {
        iigLog('INFO', `ref cache hit: ${shortName}`);
        return cached;
    }

    const inFlight = _refB64InFlight.get(path);
    if (inFlight) {
        iigLog('INFO', `ref cache coalesced: ${shortName}`);
        return inFlight;
    }

    const promise = (async () => {
        try {
            const response = await fetchWithTimeout(path, {}, 60000);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const b64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });

            if (_refB64Cache.size >= REF_B64_CACHE_CAP) {
                const oldest = _refB64Cache.keys().next().value;
                if (oldest !== undefined) _refB64Cache.delete(oldest);
            }
            _refB64Cache.set(path, b64);
            iigLog('INFO', `ref cache miss → fetched ${shortName} (${b64.length} b64 chars)`);
            return b64;
        } catch (e) {
            iigLog('WARN', `loadRefImageAsBase64 failed for ${shortName}:`, e.message);
            return null;
        } finally {
            _refB64InFlight.delete(path);
        }
    })();

    _refB64InFlight.set(path, promise);
    return promise;
}

/**
 * Generate image via OpenAI-compatible endpoint.
 *
 * References: passed as `image` (single data URL for dall-e-2 editing style)
 * AND `image[]` array (for gpt-image-1 / gpt-image-1.5 which accept multiple).
 * Gateways that don't support one field usually ignore it, so we send both.
 *
 * If referenceImages are given, we also attach a strong textual instruction
 * so providers that read prompt-only (no image field) still get the hint.
 */
async function generateImageOpenAI(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const url = `${getEffectiveEndpoint(settings)}/v1/images/generations`;

    let fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    if (referenceImages.length > 0) {
        const refInstruction = `[CRITICAL: The reference image(s) attached show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]`;
        fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
    }

    // Full aspect-ratio → OpenAI size mapping. OpenAI's /v1/images/generations
    // officially accepts only a few exact sizes; we map every ratio the prompt
    // might specify to the *closest* supported box so the AI's choice is
    // respected instead of silently falling back to the UI default.
    const AR_TO_SIZE = {
        '1:1':  '1024x1024',
        '16:9': '1792x1024',
        '21:9': '1792x1024',
        '3:2':  '1536x1024',
        '4:3':  '1344x1024',
        '5:4':  '1280x1024',
        '9:16': '1024x1792',
        '2:3':  '1024x1536',
        '3:4':  '1024x1344',
        '4:5':  '1024x1280',
    };

    const tagAr = options.aspectRatio;
    const sizeFromTag = tagAr ? AR_TO_SIZE[tagAr] : null;
    const size = sizeFromTag || settings.size;
    if (tagAr) {
        iigLog('INFO', `aspect_ratio resolved: tag="${tagAr}" → size="${size}"${sizeFromTag ? '' : ' (unknown ratio, using settings.size)'}`);
    }

    // Map our 1K/2K/4K nano-banana vocabulary to OpenAI's quality levels
    // whenever the tag or settings mention it. gpt-image-1/1.5 accepts
    // "low" | "medium" | "high" | "auto"; older dall-e-3 accepts
    // "standard" | "hd". We pick a sensible cross-mapping.
    const tagImageSize = options.imageSize || settings.imageSize || null;
    const modelIsDallE3 = /(^|\/)dall-e-3\b/i.test(settings.model);
    let quality = options.quality || settings.quality;
    if (tagImageSize) {
        if (modelIsDallE3) {
            quality = (tagImageSize === '1K') ? 'standard' : 'hd';
        } else {
            quality = ({ '1K': 'medium', '2K': 'high', '4K': 'high' })[tagImageSize] || quality;
        }
        iigLog('INFO', `image_size "${tagImageSize}" → quality "${quality}" (model=${settings.model})`);
    }

    // Minimal body — extra fields (response_format, reference_images) cause
    // 502 rejections from rout.my and other aggregators. Real OpenAI accepts
    // optional n/quality so we keep those, but skip response_format since
    // OpenAI returns b64_json by default for gpt-image-* anyway.
    const body = {
        model: settings.model,
        prompt: fullPrompt,
        n: 1,
        size: size,
    };
    if (quality) body.quality = quality;

    if (referenceImages.length > 0) {
        const asDataUrls = referenceImages
            .slice(0, 4)
            .map(b64 => (String(b64).startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`));
        // gpt-image-1 / gpt-image-1.5 accept an array in `image` for multi-ref
        body.image = asDataUrls.length === 1 ? asDataUrls[0] : asDataUrls;
    }

    iigLog('INFO', `OpenAI request: model=${settings.model}, size=${size}, refImages=${referenceImages.length}`);

    const response = await robustFetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: options.signal,
    });

    if (!response.ok) {
        const text = await response.text();
        { const _e = new Error(`API Error (${response.status}): ${text}`); _e.status = response.status; throw _e; }
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
    const url = `${getEffectiveEndpoint(settings)}/v1beta/models/${model}:generateContent`;
    
    // Parameter resolution: tag-provided values win over UI settings, UI wins
    // over hard-coded defaults. We log exactly which source was used for each
    // parameter so the user can verify their OOC/prompt instructions were
    // actually respected.
    const arSource = options.aspectRatio ? 'tag' : (settings.aspectRatio ? 'settings' : 'default');
    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
        iigLog('WARN', `Invalid aspect_ratio "${aspectRatio}" from ${arSource}, falling back`);
        aspectRatio = VALID_ASPECT_RATIOS.includes(settings.aspectRatio) ? settings.aspectRatio : '1:1';
    }

    const sizeSource = options.imageSize ? 'tag' : (settings.imageSize ? 'settings' : 'default');
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) {
        iigLog('WARN', `Invalid image_size "${imageSize}" from ${sizeSource}, falling back`);
        imageSize = VALID_IMAGE_SIZES.includes(settings.imageSize) ? settings.imageSize : '1K';
    }

    iigLog('INFO', `Gemini params: aspect_ratio=${aspectRatio} (from ${arSource}), image_size=${imageSize} (from ${sizeSource})`);
    
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
        body: bodyStr,
        signal: options.signal,
    });
    
    if (!response.ok) {
        const text = await response.text();
        { const _e = new Error(`API Error (${response.status}): ${text}`); _e.status = response.status; throw _e; }
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
 * Generate image via an aggregator (rout.my, OpenRouter, etc.) that uses
 * "provider/model" prefixed IDs.
 *
 * Routing (based on rout.my's actual server code):
 *   - Gemini models (google/...):
 *       URL: {base}/compatible/v1beta/models/{model}:generateContent?key={apiKey}
 *       Auth: API key in URL query param (NOT Bearer header)
 *       Body: Gemini generateContent shape
 *
 *   - All other models (openai/gpt-image-*, x-ai/grok-imagine-*, etc.):
 *       URL: {base}/v1/images/generations
 *       Auth: Bearer token header
 *       Body: Standard OpenAI images/generations shape
 */
async function generateImageAggregator(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const base = getEffectiveEndpoint(settings);
    const model = settings.model;

    let fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    if (referenceImages.length > 0) {
        const refInstruction = `[CRITICAL: The reference image(s) attached show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]`;
        fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
    }

    const ar = options.aspectRatio || settings.aspectRatio || null;
    const imgSize = options.imageSize || settings.imageSize || null;
    const qualityOpt = options.quality || settings.quality || null;

    // --- Gemini-style aggregator models (google/...) ---
    if (isAggregatorGeminiModel(model)) {
        const url = `${base}/compatible/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;

        const parts = [];
        for (const imgB64 of referenceImages.slice(0, 4)) {
            const raw = String(imgB64).startsWith('data:') ? imgB64.split(',')[1] : imgB64;
            parts.push({ inlineData: { mimeType: 'image/jpeg', data: raw } });
        }
        parts.push({ text: fullPrompt });

        const genCfg = { responseModalities: ['TEXT', 'IMAGE'] };
        // Always send imageConfig — rout.my expects it for Gemini models.
        // Default to 1:1 and 1K if neither tag nor settings specify values.
        genCfg.imageConfig = {
            aspectRatio: ar || '1:1',
            imageSize: imgSize || '1K',
        };

        const body = { contents: [{ role: 'user', parts }], generationConfig: genCfg };

        iigLog('INFO', `Aggregator Gemini request: model=${model}, ar=${ar || 'default'}, imgSize=${imgSize || 'default'}, refImages=${referenceImages.length}`);

        const response = await robustFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: options.signal,
        });

        if (!response.ok) {
            const text = await response.text();
            { const _e = new Error(`API Error (${response.status}): ${text}`); _e.status = response.status; throw _e; }
        }

        const result = await response.json();
        const candidates = result.candidates || [];
        if (candidates.length === 0) throw new Error('No candidates in response');

        const responseParts = candidates[0].content?.parts || [];
        for (const part of responseParts) {
            if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
        }
        throw new Error('No image found in aggregator Gemini response');
    }

    // --- OpenAI-style aggregator models (openai/gpt-image-*, x-ai/grok-imagine-*, etc.) ---
    // Body shape per rout.my image-gen.ts reference: {model, prompt, size} + optional body.image.
    // Confirmed via empirical testing (test-routmy-*.js scripts):
    //   - response_format: 'b64_json' → 502 (rout.my rejects this field)
    //   - reference_images: [array]   → 502 (rout.my rejects this field)
    //   - body.image as array         → 200 OK (multi-ref is supported this way)
    //   - Only 4 sizes accepted: 1024x1024, 1024x1536, 1536x1024, 'auto'
    //     Everything else (1024x1792, 1280x1024, etc.) → 502.
    const url = `${base}/v1/images/generations`;

    // Map aspect ratio to one of rout.my's 4 accepted sizes.
    // Unsupported ratios fall back to 'auto' — lets the model pick its best
    // composition rather than rejecting the request.
    const AR_TO_SIZE = {
        '1:1':  '1024x1024',
        '3:2':  '1536x1024',
        '2:3':  '1024x1536',
        // Wide/ultrawide → closest landscape
        '16:9': '1536x1024',
        '21:9': '1536x1024',
        '4:3':  '1536x1024',
        '5:4':  '1536x1024',
        // Vertical → closest portrait
        '9:16': '1024x1536',
        '3:4':  '1024x1536',
        '4:5':  '1024x1536',
    };
    const size = (ar && AR_TO_SIZE[ar]) ? AR_TO_SIZE[ar] : 'auto';

    const body = {
        model: model,
        prompt: fullPrompt,
        size: size,
    };

    // Reference images — rout.my accepts body.image as either a single data URL
    // string OR an array of data URLs (confirmed by testing). Use array for
    // multi-ref support (the extension's whole point is multi-character refs).
    if (referenceImages.length > 0) {
        const asDataUrls = referenceImages
            .slice(0, 4)
            .map(b64 => (String(b64).startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`));
        body.image = asDataUrls.length === 1 ? asDataUrls[0] : asDataUrls;
    }

    iigLog('INFO', `Aggregator OpenAI request: model=${model}, size=${size} (from ar=${ar || 'none'}), refImages=${referenceImages.length}`);

    const response = await robustFetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: options.signal,
    });

    if (!response.ok) {
        const text = await response.text();
        { const _e = new Error(`API Error (${response.status}): ${text}`); _e.status = response.status; throw _e; }
    }

    const result = await response.json();
    const dataList = result.data || [];
    if (dataList.length === 0) {
        if (result.url) return result.url;
        throw new Error('No image data in response');
    }

    const imageObj = dataList[0];
    if (imageObj.b64_json) return `data:image/png;base64,${imageObj.b64_json}`;
    if (imageObj.url) return imageObj.url;

    throw new Error('No image data in aggregator response');
}

/**
 * Generate image via Naistera custom endpoint
 */
async function generateImageNaistera(prompt, style, options = {}) {
    const settings = getSettings();
    const endpoint = getEffectiveEndpoint(settings);
    const url = endpoint.endsWith('/api/generate') ? endpoint : `${endpoint}/api/generate`;

    const aspectRatio = options.aspectRatio || settings.naisteraAspectRatio || '1:1';
    const model = normalizeNaisteraModel(options.model || settings.naisteraModel || 'grok');
    const preset = options.preset || settings.naisteraPreset || null;
    const referenceImages = options.referenceImages || [];

    let fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;

    if (referenceImages.length > 0) {
        const refInstruction = `[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]`;
        fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
    }

    const body = {
        prompt: fullPrompt,
        aspect_ratio: aspectRatio,
        model,
    };
    if (preset) body.preset = preset;
    if (referenceImages.length > 0) body.reference_images = referenceImages.slice(0, 4);

    let response;
    try {
        response = await robustFetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body),
            signal: options.signal,
        });
    } catch (error) {
        // Preserve AbortError identity so the retry classifier can see it.
        if (error?.name === 'AbortError') throw error;
        const pageOrigin = window.location.origin;
        let endpointOrigin = endpoint;
        try { endpointOrigin = new URL(url, window.location.href).origin; } catch (_) {}
        throw new Error(
            `Network/CORS error requesting ${endpointOrigin} from ${pageOrigin}. `
            + `Original: ${error?.message || 'Failed to fetch'}`
        );
    }

    if (!response.ok) {
        const text = await response.text();

        // Auto-retry without references if Grok temporarily can't handle them
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (_) {}
        if (parsed?.reason === 'grok_refs_temporarily_unavailable' && referenceImages.length > 0) {
            iigLog('WARN', 'Grok refs temporarily unavailable — retrying without references');
            toastr.warning('Grok refs unavailable right now — generating without references', 'Image Generation', { timeOut: 4000 });

            // Strip refs from body and re-send
            delete body.reference_images;
            // Remove ref instruction from prompt
            body.prompt = style ? `[Style: ${style}] ${prompt}` : prompt;

            let retryResponse;
            try {
                retryResponse = await robustFetch(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${settings.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(body),
                    signal: options.signal,
                });
            } catch (retryError) {
                throw new Error(`Retry without refs also failed: ${retryError?.message || 'Network error'}`);
            }

            if (!retryResponse.ok) {
                const retryText = await retryResponse.text();
                { const _e = new Error(`API Error on retry without refs (${retryResponse.status}): ${retryText}`); _e.status = retryResponse.status; throw _e; }
            }

            const retryResult = await retryResponse.json();
            if (!retryResult?.data_url) throw new Error('No data_url in retry response');
            return retryResult.data_url;
        }

        { const _e = new Error(`API Error (${response.status}): ${text}`); _e.status = response.status; throw _e; }
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
        if (settings.apiType !== 'naistera') {
            errors.push('Endpoint URL not configured');
        }
    }
    if (!settings.apiKey) {
        errors.push('API key not configured');
    }
    if (settings.apiType !== 'naistera' && !settings.model) {
        errors.push('Model not selected');
    }
    if (settings.apiType === 'naistera') {
        const m = normalizeNaisteraModel(settings.naisteraModel);
        if (!NAISTERA_MODELS.includes(m)) {
            errors.push('Select Naistera model: grok / nano banana');
        }
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
 * Normalize HTML-entity-encoded instruction payload back to raw text.
 */
function normalizeInstructionPayload(text) {
    return String(text || '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#34;/g, '"')
        .replace(/&amp;/g, '&');
}

/**
 * Decode escape sequences in a relaxed JSON value string.
 */
function decodeRelaxedInstructionValue(value) {
    return String(value || '')
        .trim()
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
}

/**
 * Parse instruction JSON even when LLM produces broken output —
 * unescaped quotes inside strings, trailing commas, etc.
 * Falls back to regex-based key-value extraction.
 */
function parseRelaxedInstructionObject(payload) {
    const normalized = normalizeInstructionPayload(payload);
    const keyRegex = /(["'])(style|prompt|aspect_ratio|aspectRatio|preset|image_size|imageSize|quality)\1\s*:\s*(["'])/g;
    const matches = Array.from(normalized.matchAll(keyRegex));
    if (matches.length === 0) return null;

    const result = {};
    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const key = match[2];
        const valueQuote = match[3];
        const valueStart = match.index + match[0].length;
        const nextKeyIndex = i + 1 < matches.length ? matches[i + 1].index : normalized.lastIndexOf('}');
        const rawValue = normalized.substring(
            valueStart,
            nextKeyIndex === -1 ? normalized.length : nextKeyIndex
        );
        let value = rawValue.trim();
        if (value.endsWith(',')) value = value.slice(0, -1).trimEnd();
        if (value.endsWith(valueQuote)) value = value.slice(0, -1);
        result[key] = decodeRelaxedInstructionValue(value);
    }
    return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse an instruction JSON string. Tries strict JSON.parse first,
 * then falls back to relaxed regex parsing for broken LLM output.
 */
function parseInstructionObject(payload) {
    const normalized = normalizeInstructionPayload(payload);
    try {
        return JSON.parse(normalized);
    } catch (error) {
        const relaxed = parseRelaxedInstructionObject(normalized);
        if (relaxed) return relaxed;
        throw error;
    }
}

/**
 * Sanitize text for use inside single-quoted HTML attributes.
 */
function sanitizeForSingleQuotedAttribute(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Build a minimal instruction data object from a parsed tag.
 */
function buildInstructionData(tag) {
    const data = {};
    if (tag.style) data.style = tag.style;
    if (tag.prompt) data.prompt = tag.prompt;
    if (tag.aspectRatio) data.aspect_ratio = tag.aspectRatio;
    if (tag.preset) data.preset = tag.preset;
    if (tag.imageSize) data.image_size = tag.imageSize;
    if (tag.quality) data.quality = tag.quality;
    return data;
}

/**
 * Get the instruction attribute value from a tag (for data-iig-instruction).
 */
function getInstructionAttributeValue(tag) {
    if (tag.isNewFormat && tag.fullMatch) {
        const instructionMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instructionMatch) return instructionMatch[2];
    }
    return JSON.stringify(buildInstructionData(tag));
}

/**
 * Get the text used for rendering a message (respects externalBlocks display_text).
 */
function getMessageRenderText(message, settings) {
    if (!message) return '';
    if (!settings) settings = getSettings();
    if (settings.externalBlocks && message.extra?.display_text) {
        return message.extra.display_text;
    }
    return message.mes || '';
}

/**
 * Parse image tags from a message object — checks both mes and extblocks.
 */
async function parseMessageImageTags(message, options = {}) {
    const settings = getSettings();
    const tags = [];

    const mainTags = await parseImageTags(message?.mes || '', options);
    tags.push(...mainTags.map(tag => ({ ...tag, sourceKey: 'mes' })));

    if (settings.externalBlocks && message?.extra?.extblocks) {
        const extTags = await parseImageTags(message.extra.extblocks, options);
        tags.push(...extTags.map(tag => ({ ...tag, sourceKey: 'extblocks' })));
    }

    return tags;
}

/**
 * Replace a tag in the correct message source (mes or extblocks).
 */
function replaceTagInMessageSource(message, tag, replacement) {
    if (!message || !tag) return;

    if (tag.sourceKey === 'extblocks') {
        if (!message.extra) message.extra = {};
        message.extra.extblocks = (message.extra.extblocks || '').replace(tag.fullMatch, replacement);

        const swipeId = message.swipe_id;
        if (swipeId !== undefined && message.swipe_info?.[swipeId]?.extra?.extblocks) {
            message.swipe_info[swipeId].extra.extblocks =
                message.swipe_info[swipeId].extra.extblocks.replace(tag.fullMatch, replacement);
        }

        if (message.extra.display_text) {
            message.extra.display_text = message.extra.display_text.replace(tag.fullMatch, replacement);
        }
        return;
    }

    message.mes = (message.mes || '').replace(tag.fullMatch, replacement);
    if (message.extra?.display_text) {
        message.extra.display_text = message.extra.display_text.replace(tag.fullMatch, replacement);
    }
}

/**
 * Generate image with retry logic
 */
async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();

    const settings = getSettings();
    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;

    // Per-tag overrides come in via `options`. If the user explicitly disabled
    // prompt-driven mode in settings, drop them here so every generation is
    // forced through the UI defaults.
    if (settings.promptDriven === false) {
        const stripped = Object.keys(options).filter(k => ['aspectRatio','imageSize','quality','preset'].includes(k));
        if (stripped.length > 0) {
            iigLog('INFO', `Prompt-driven=off: ignoring tag overrides (${stripped.join(', ')})`);
            for (const k of stripped) delete options[k];
        }
    }
    
    // Collect reference images using unified refs system
    const referenceImages = [];
    const referenceDataUrls = [];

    // References (base64) are collected for every non-Naistera provider:
    //   - Custom (apiType=gemini) -> Gemini inlineData OR OpenAI image[]
    //   - OpenAI-compatible       -> OpenAI image[]
    // Naistera has its own branch below that uses data URLs.
    if (settings.apiType === 'gemini' || settings.apiType === 'openai' || isGeminiModel(settings.model)) {
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
        // Phase-2a: bail immediately if the caller aborted before we even
        // started this attempt. Covers the case where the user clicked
        // regenerate twice and the first call was still sitting in the
        // retry-backoff sleep between attempts.
        if (options.signal?.aborted) {
            const abortErr = new Error('Generation aborted');
            abortErr.name = 'AbortError';
            throw abortErr;
        }

        try {
            onStatusUpdate?.(`Generating${attempt > 0 ? ` (retry ${attempt}/${maxRetries})` : ''}...`);

            if (settings.apiType === 'naistera') {
                return await generateImageNaistera(prompt, style, { ...options, referenceImages: referenceDataUrls });
            }

            // Route by *model* first. Priority (most specific → most generic):
            //   1. Aggregator model ("provider/model" format like rout.my,
            //      OpenRouter) — route via generateImageAggregator which picks
            //      the correct endpoint based on whether it's a Gemini or
            //      OpenAI-style model.
            //   2. Native Gemini nano-banana — Gemini API shape.
            //   3. OpenAI-style image model (gpt-image, dall-e) hitting a real
            //      OpenAI-compat endpoint — /v1/images/generations.
            //   4. apiType-based fallback.
            if (isAggregatorImageModel(settings.model)) {
                return await generateImageAggregator(prompt, style, referenceImages, options);
            }
            if (isGeminiModel(settings.model)) {
                return await generateImageGemini(prompt, style, referenceImages, options);
            }
            if (isOpenAIImageModel(settings.model)) {
                return await generateImageOpenAI(prompt, style, referenceImages, options);
            }
            if (settings.apiType === 'gemini') {
                return await generateImageGemini(prompt, style, referenceImages, options);
            }
            return await generateImageOpenAI(prompt, style, referenceImages, options);
        } catch (error) {
            lastError = error;
            iigLog('ERROR', `Generation attempt ${attempt + 1} failed:`, error.message);

            // Phase-2a structured error classification.
            // Prefer error.status (set at every API-Error throw site) over
            // substring-matching the error message, which had false positives
            // (e.g. an error text that happens to contain "429" in a URL).
            const status = typeof error?.status === 'number' ? error.status : null;
            const msg = (error?.message || '').toLowerCase();
            const isAbort = error?.name === 'AbortError' || msg.includes('aborted');
            const isUpstreamDown = status === 502 || status === 503 || status === 504
                                  || /\b(502|503|504)\b/.test(error.message || '');
            const isRetryable = !isAbort && (
                isUpstreamDown
                || status === 429
                || msg.includes('timeout')
                || msg.includes('network')
            );

            // Effective retry budget: user-configured, but upstream-down errors
            // get at least 1 extra attempt because they're almost always transient.
            const effectiveMax = isUpstreamDown ? Math.max(maxRetries, 1) : maxRetries;

            if (!isRetryable || attempt >= effectiveMax) {
                // Aborts propagate silently — the caller (re-click of regen)
                // initiated them and doesn't want retry or friendly wrapping.
                if (isAbort) break;
                // Enrich the final error message for 5xx so the user isn't
                // confused into thinking their key or settings are wrong.
                if (isUpstreamDown) {
                    const friendly = new Error(
                        `Provider upstream temporarily unavailable (${status || error.message.match(/\b5\d\d\b/)?.[0] || '5xx'}). ` +
                        `This is on the provider side, not your settings. Try again in a minute.`
                    );
                    friendly.cause = error;
                    if (status) friendly.status = status;
                    throw friendly;
                }
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
 * Per-session HEAD cache. Each chat load can trigger parseImageTags on
 * every message, which previously generated O(N*M) HEAD requests (N messages
 * × M images) — devastating on iOS with flaky networks. Results here are
 * kept until the tab closes; success entries are safe to keep indefinitely
 * (files don't get un-created), and negative entries auto-expire so a race
 * during initial file upload doesn't permanently poison a real path.
 */
const _fileExistsCache = new Map(); // path → { exists: bool, ts: ms }
const FILE_EXISTS_NEG_TTL_MS = 60 * 1000; // retry a "does not exist" after 1 min
// Phase-2b: LRU cap so the cache can't grow unbounded in long sessions that
// touch many unique image paths (e.g. scrolling through huge chat histories
// with broken image refs).
const FILE_EXISTS_CACHE_CAP = 500;

function _evictFileExistsCacheIfFull(incomingPath) {
    if (_fileExistsCache.size < FILE_EXISTS_CACHE_CAP) return;
    if (_fileExistsCache.has(incomingPath)) return; // we're updating an existing entry
    const oldest = _fileExistsCache.keys().next().value;
    if (oldest !== undefined) _fileExistsCache.delete(oldest);
}

async function checkFileExists(path) {
    if (!path) return false;
    const now = Date.now();
    const cached = _fileExistsCache.get(path);
    if (cached) {
        // Phase-2b LRU touch: refresh position so recently-used entries
        // aren't the first to evict. Map iteration order is insertion
        // order, so delete+set moves the key to "most recent".
        _fileExistsCache.delete(path);
        _fileExistsCache.set(path, cached);
        if (cached.exists) return true;
        if (now - cached.ts < FILE_EXISTS_NEG_TTL_MS) return false;
        // expired negative entry — fall through to re-check
    }
    try {
        const response = await fetchWithTimeout(path, { method: 'HEAD' }, 10000);
        const exists = response.ok;
        _evictFileExistsCacheIfFull(path);
        _fileExistsCache.set(path, { exists, ts: now });
        return exists;
    } catch (e) {
        _evictFileExistsCacheIfFull(path);
        _fileExistsCache.set(path, { exists: false, ts: now });
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

    // Fast bail: skip heavy parsing if text contains no known markers
    if (!text || (!text.includes('data-iig-instruction') && !text.includes('[IMG:GEN:') && !text.includes('[IMG:✓:'))) {
        return tags;
    }
    
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
            const data = parseInstructionObject(instructionJson);
            
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
            const data = parseInstructionObject(jsonStr);
            
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
                const resp = await fetchWithTimeout(path, { method: 'HEAD' }, 10000);
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
 * SVG icons for image action buttons (inline, no emoji, no external deps)
 */
const SVG_ICON_REGENERATE = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
const SVG_ICON_DOWNLOAD = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

/**
 * Wrap a generated <img> in a .iig-image-wrapper with overlay action buttons.
 * Desktop: buttons appear on hover, click opens lightbox.
 * Mobile: single tap toggles buttons (auto-hide 4s). No lightbox on mobile.
 */
function wrapImageWithActions(imgElement) {
    // Don't double-wrap
    if (imgElement.parentElement?.classList.contains('iig-image-wrapper')) return imgElement.parentElement;

    const wrapper = document.createElement('div');
    wrapper.className = 'iig-image-wrapper';

    const btnRegen = document.createElement('button');
    btnRegen.className = 'iig-action-btn iig-action-regen';
    btnRegen.innerHTML = SVG_ICON_REGENERATE;
    btnRegen.title = 'Regenerate';
    btnRegen.type = 'button';

    const btnDownload = document.createElement('button');
    btnDownload.className = 'iig-action-btn iig-action-download';
    btnDownload.innerHTML = SVG_ICON_DOWNLOAD;
    btnDownload.title = 'Download';
    btnDownload.type = 'button';

    // Insert wrapper around img.
    // If img is in the DOM, replace it with the wrapper (keeps position).
    // If img is detached (just created), just append it inside the wrapper.
    if (imgElement.parentElement) {
        imgElement.replaceWith(wrapper);
    }
    wrapper.appendChild(imgElement);
    wrapper.appendChild(btnRegen);
    wrapper.appendChild(btnDownload);

    // --- Download handler ---
    btnDownload.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        downloadGeneratedImage(imgElement);
    });

    // --- Regenerate handler ---
    btnRegen.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        regenerateSingleImage(imgElement);
    });

    // --- Mobile tap logic (iOS + Android) ---
    // Single tap toggles action buttons (auto-hide after 4s).
    // No lightbox on mobile — it causes freezes and broken UX.
    if (IS_MOBILE) {
        let _autoHideTimer = null;

        wrapper.addEventListener('click', (e) => {
            // Ignore if clicking on action buttons (they handle themselves)
            if (e.target.closest('.iig-action-btn')) return;

            e.preventDefault();
            e.stopPropagation();

            const isVisible = wrapper.classList.contains('iig-actions-visible');

            // Hide all other wrappers first
            document.querySelectorAll('.iig-image-wrapper.iig-actions-visible').forEach(w => {
                if (w !== wrapper) w.classList.remove('iig-actions-visible');
            });

            if (isVisible) {
                wrapper.classList.remove('iig-actions-visible');
                clearTimeout(_autoHideTimer);
            } else {
                wrapper.classList.add('iig-actions-visible');
                clearTimeout(_autoHideTimer);
                _autoHideTimer = setTimeout(() => {
                    wrapper.classList.remove('iig-actions-visible');
                }, 4000);
            }
        });
    }

    return wrapper;
}

/**
 * Open lightbox for a given image element
 */
function openLightbox(imgElement) {
    const overlay = document.getElementById('iig_lightbox');
    if (!overlay) return;
    const lbImg = overlay.querySelector('.iig-lightbox-img');
    const caption = overlay.querySelector('.iig-lightbox-caption');
    const regenBtn = overlay.querySelector('.iig-lb-regen');
    lbImg.src = imgElement.src;
    caption.textContent = imgElement.alt || '';
    overlay._sourceImg = imgElement;
    // Hide regen button if image has no instruction data (can't regenerate)
    if (regenBtn) {
        regenBtn.style.display = imgElement.hasAttribute('data-iig-instruction') ? '' : 'none';
    }
    overlay.classList.add('open');
}

/**
 * Download a generated image
 */
async function downloadGeneratedImage(imgElement) {
    const src = imgElement.src;
    if (!src) return;

    try {
        toastr.info('Downloading...', 'Image Generation', { timeOut: 2000 });

        // On mobile, open image in new tab (a.download doesn't work on iOS/Android browsers)
        if (IS_MOBILE) {
            window.open(src, '_blank');
            toastr.success('Image opened — long-press to save', 'Image Generation', { timeOut: 3000 });
            return;
        }

        const response = await fetchWithTimeout(src, {}, 60000);
        const blob = await response.blob();

        const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `iig_${timestamp}.${ext}`;

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        toastr.success('Image downloaded', 'Image Generation', { timeOut: 2000 });
    } catch (error) {
        iigLog('ERROR', 'Download failed:', error.message);
        toastr.error('Download failed: ' + error.message, 'Image Generation');
    }
}

/**
 * Regenerate a single image (per-image, not per-message)
 */
async function regenerateSingleImage(imgElement) {
    const instruction = imgElement.getAttribute('data-iig-instruction');
    if (!instruction) {
        toastr.warning('No generation instruction found on this image', 'Image Generation');
        return;
    }

    // Find the message this image belongs to
    const mesElement = imgElement.closest('.mes[mesid]');
    if (!mesElement) {
        toastr.error('Could not find parent message', 'Image Generation');
        return;
    }
    const messageId = parseInt(mesElement.getAttribute('mesid'), 10);
    const context = getContext();
    const message = context.chat[messageId];
    if (!message) return;

    // Parse instruction (uses robust parser that handles broken LLM JSON)
    let data;
    try {
        data = parseInstructionObject(instruction);
    } catch (e) {
        toastr.error('Failed to parse image instruction', 'Image Generation');
        return;
    }

    // Get wrapper and replace img with loading placeholder
    const wrapper = imgElement.closest('.iig-image-wrapper');
    const tagId = `iig-single-regen-${messageId}-${Date.now()}`;
    const loadingPlaceholder = createLoadingPlaceholder(tagId);

    if (wrapper) {
        wrapper.replaceWith(loadingPlaceholder);
    } else {
        imgElement.replaceWith(loadingPlaceholder);
    }

    const statusEl = loadingPlaceholder.querySelector('.iig-status');
    const setStatus = (text) => {
        if (statusEl && statusEl.isConnected) statusEl.textContent = text;
    };

    // Phase-2a: abort-on-re-click. Build a synthetic tag-like object keyed on
    // the image's instruction prompt so two fast clicks on the same image's
    // regenerate button cancel the first in-flight request.
    const fakeTag = { fullMatch: instruction || data.prompt || '', prompt: data.prompt || '' };
    const { controller, key } = beginGeneration(messageId, fakeTag);

    try {
        const dataUrl = await generateImageWithRetry(
            data.prompt || '',
            data.style || '',
            setStatus,
            {
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                preset: data.preset || null,
                signal: controller.signal,
            }
        );

        setStatus('Saving...');
        const imagePath = await saveImageToFile(dataUrl);

        const newImg = document.createElement('img');
        newImg.className = 'iig-generated-image';
        newImg.src = imagePath;
        newImg.alt = data.prompt || '';
        newImg.title = `Style: ${data.style || ''}\nPrompt: ${data.prompt || ''}`;
        newImg.setAttribute('data-iig-instruction', instruction);

        if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);

        const newWrapper = wrapImageWithActions(newImg);
        loadingPlaceholder.replaceWith(newWrapper);

        // Update message source: find the old src and replace in mes + extblocks + display_text
        const oldSrc = imgElement.getAttribute('src') || '';
        if (oldSrc) {
            if (message.mes && message.mes.includes(oldSrc)) {
                message.mes = message.mes.replace(oldSrc, imagePath);
            }
            if (message.extra?.extblocks && message.extra.extblocks.includes(oldSrc)) {
                message.extra.extblocks = message.extra.extblocks.replace(oldSrc, imagePath);
            }
            if (message.extra?.display_text && message.extra.display_text.includes(oldSrc)) {
                message.extra.display_text = message.extra.display_text.replace(oldSrc, imagePath);
            }
        }

        sessionGenCount++;
        updateSessionStats();
        await context.saveChat();
        toastr.success('Image regenerated', 'Image Generation', { timeOut: 2000 });
    } catch (error) {
        const isAbort = error?.name === 'AbortError' || /aborted/i.test(error?.message || '');
        if (isAbort) {
            iigLog('INFO', 'Single image regeneration aborted (superseded by newer request)');
            // Silent cancel: the caller already started a fresh regeneration
            // that replaced our placeholder. No error UI, no retry.
            return;
        }
        iigLog('ERROR', 'Single image regeneration failed:', error.message);

        const errorImg = document.createElement('img');
        errorImg.className = 'iig-error-image';
        errorImg.src = getErrorImagePath();
        errorImg.alt = 'Generation error';
        errorImg.title = `Error: ${error.message}`;
        errorImg.setAttribute('data-iig-instruction', instruction);

        if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
        loadingPlaceholder.replaceWith(errorImg);

        sessionErrorCount++;
        updateSessionStats();
        toastr.error('Regeneration failed: ' + error.message, 'Image Generation');
    } finally {
        endGeneration(key, controller);
    }
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
        // Phase-2b: self-clear if the placeholder was detached without the
        // normal clearInterval call (e.g. swipe mid-generation, chat
        // switch, messageFormatting wipe). Otherwise this 1 s tick would
        // keep firing forever against an orphan DOM node, holding its
        // closure alive and growing memory over a long session.
        if (!placeholder.isConnected) {
            clearInterval(placeholder._timerInterval);
            return;
        }
        const el = Math.floor((Date.now() - startTime) / 1000);
        if (el >= tSec) { timerEl.textContent = "Timeout..."; clearInterval(placeholder._timerInterval); return; }
        const m = Math.floor(el/60), s = el%60;
        timerEl.textContent = `${m}:${String(s).padStart(2,"0")} / ${Math.floor(tSec/60)}:00${IS_IOS ? " (iOS)" : ""}`;
    }, 1000);
    return placeholder;
}

/**
 * Create error placeholder element — shows error.svg.
 * User retries via the regenerate button in message menu.
 */
function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = getErrorImagePath();
    img.alt = 'Generation error';
    img.title = `Error: ${errorMessage}`;
    img.dataset.tagId = tagId;
    
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
    const context = getContext();
    const settings = getSettings();

    if (!settings.enabled) return;

    const procKey = buildProcessingKey(messageId);

    if (processingMessages.has(procKey)) {
        iigLog('WARN', `Message ${procKey} is already being processed, skipping`);
        return;
    }

    // Cooldown guard: if we just finished processing this message, skip.
    // This prevents the re-render loop where messageFormatting/innerHTML
    // re-fires CHARACTER_MESSAGE_RENDERED right after we finish.
    const lastProcessed = recentlyProcessed.get(procKey);
    if (lastProcessed && (Date.now() - lastProcessed) < REPROCESS_COOLDOWN_MS) {
        iigLog('INFO', `Message ${procKey} was recently processed (${Date.now() - lastProcessed}ms ago), skipping re-trigger`);
        return;
    }

    // Phase-2a race fix: claim the slot BEFORE any await. Previously the
    // add() happened after parseMessageImageTags() resolved, which left a
    // yield-window where two concurrent CHARACTER_MESSAGE_RENDERED events
    // could both pass the has() check and start processing the same msg.
    processingMessages.add(procKey);

    try {
        const message = context.chat[messageId];
        if (!message || message.is_user) {
            // Stamp cooldown so repeated render events on user/empty msgs
            // don't re-enter the parser on every fire.
            recentlyProcessed.set(procKey, Date.now());
            return;
        }

        const tags = await parseMessageImageTags(message, { checkExistence: true });
        iigLog('INFO', `parseMessageImageTags returned: ${tags.length} tags`);
        if (tags.length > 0) {
            iigLog('INFO', `First tag: ${JSON.stringify(tags[0]).substring(0, 200)}`);
        }
        if (tags.length === 0) {
            iigLog('INFO', 'No tags found by parser');
            recentlyProcessed.set(procKey, Date.now());
            return;
        }

        iigLog('INFO', `Found ${tags.length} image tag(s) in message ${procKey}`);
        toastr.info(`Found ${tags.length} tag(s). Generating...`, 'Image Generation', { timeOut: 3000 });

        const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!messageElement) {
            iigLog('ERROR', 'Message element not found for ID:', messageId);
            toastr.error('Could not find message element', 'Image Generation');
            return;
        }

        const mesTextEl = messageElement.querySelector('.mes_text');
        if (!mesTextEl) {
            return;
        }

        await _processMessageTagsInner(context, message, messageId, procKey, tags, mesTextEl);
    } finally {
        processingMessages.delete(procKey);
    }
}

/**
 * Inner body of processMessageTags. Split out so the outer function can
 * guard the critical section with a single try/finally that always cleans
 * up processingMessages regardless of which branch we exit through.
 */
async function _processMessageTagsInner(context, message, messageId, procKey, tags, mesTextEl) {
    
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
                        const instructionData = parseInstructionObject(decodedInstruction);
                        if (instructionData.prompt && instructionData.prompt.substring(0, 30) === tag.prompt.substring(0, 30)) {
                            iigLog('INFO', `Found img element via JSON prompt match`);
                            targetElement = img;
                            break;
                        }
                    } catch (e) {
                        // Parse failed, continue with other strategies
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
        const setStatus = (text) => {
            if (statusEl && statusEl.isConnected) statusEl.textContent = text;
        };

        // Phase-2a: register abort controller for this tag. If the user
        // manually regenerates the message while the initial auto-generation
        // is still in flight, beginGeneration will cancel us so we don't
        // overwrite the newer result.
        const { controller, key } = beginGeneration(messageId, tag);

        try {
            const dataUrl = await generateImageWithRetry(
                tag.prompt,
                tag.style,
                setStatus,
                {
                    aspectRatio: tag.aspectRatio,
                    imageSize: tag.imageSize,
                    quality: tag.quality,
                    preset: tag.preset,
                    signal: controller.signal,
                }
            );

            setStatus('Saving...');
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
            const wrappedImg = wrapImageWithActions(img);
            loadingPlaceholder.replaceWith(wrappedImg);

            // Phase-2a race fix: compute the replacement string but DON'T
            // mutate message.mes here. Collecting the intent and applying all
            // replacements serially at the end avoids the read-modify-write
            // race that could swallow a tag's replacement when two parallel
            // tasks both resolved before either one's replace() landed.
            let replacement;
            if (tag.isNewFormat) {
                replacement = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
            } else {
                replacement = `[IMG:✓:${imagePath}]`;
            }

            iigLog('INFO', `Successfully generated image for tag ${index}`);
            sessionGenCount++;
            updateSessionStats();
            toastr.success(`Image ${index + 1}/${tags.length} ready`, 'Image Generation', { timeOut: 2000 });

            return { tag, replacement, ok: true };
        } catch (error) {
            const isAbort = error?.name === 'AbortError' || /aborted/i.test(error?.message || '');
            if (isAbort) {
                // Phase-2a: a newer generation superseded us. Leave the DOM
                // alone (newer path will write it), return a sentinel that
                // tells the outer serial-apply loop to skip this tag.
                iigLog('INFO', `Tag ${index} aborted (superseded)`);
                if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
                return { tag, replacement: null, ok: false, aborted: true };
            }

            iigLog('ERROR', `Failed to generate image for tag ${index}:`, error.message);

            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
            loadingPlaceholder.replaceWith(errorPlaceholder);

            let replacement;
            if (tag.isNewFormat) {
                replacement = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${getErrorImagePath()}"`);
            } else {
                replacement = `[IMG:ERROR:${error.message.substring(0, 50)}]`;
            }
            iigLog('INFO', `Marked tag as failed in message source`);
            sessionErrorCount++;
            updateSessionStats();

            toastr.error(`Generation error: ${error.message}`, 'Image Generation');

            return { tag, replacement, ok: false, error };
        } finally {
            endGeneration(key, controller);
        }
    };

    
    let results = [];
    try {
        // Parallel image generation (the real perf win) —
        // replaceTagInMessageSource is NOT called here, only collected.
        results = await Promise.all(tags.map((tag, index) => processTag(tag, index)));
    } finally {
        iigLog('INFO', `Finished processing message ${procKey}`);

        // Phase-2a race fix: apply all message.mes / extblocks replacements
        // serially AFTER every parallel task has settled. Re-read the live
        // message from context.chat in case ST mutated it while we were
        // generating (swipe, other extension, etc.).
        const liveMessage = context.chat[messageId] || message;
        let applied = 0;
        for (const r of results) {
            if (r && r.tag && typeof r.replacement === 'string') {
                try {
                    replaceTagInMessageSource(liveMessage, r.tag, r.replacement);
                    applied++;
                } catch (e) {
                    iigLog('WARN', `Failed to apply replacement for tag: ${e.message}`);
                }
            }
        }
        iigLog('INFO', `Applied ${applied}/${results.length} tag replacements to message source`);

        // Mark this message as recently processed BEFORE any re-render
        // to prevent CHARACTER_MESSAGE_RENDERED from re-triggering us.
        recentlyProcessed.set(procKey, Date.now());

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
        //
        // processingMessages.delete(procKey) is handled by the outer
        // try/finally in processMessageTags() (Phase-2a race fix).
    }
}

/**
 * Regenerate all images in a message (user-triggered).
 * BUG FIX: Now correctly targets each tag's corresponding img element by index
 * instead of always grabbing the first img[data-iig-instruction] in the message.
 */
async function regenerateMessageImages(messageId) {
    const context = getContext();
    const message = context.chat[messageId];
    
    if (!message) {
        toastr.error('Message not found', 'Image Generation');
        return;
    }
    
    const tags = await parseMessageImageTags(message, { forceAll: true });
    
    if (tags.length === 0) {
        toastr.warning('No tags to regenerate', 'Image Generation');
        return;
    }
    
    iigLog('INFO', `Regenerating ${tags.length} images in message ${messageId}`);
    toastr.info(`Regenerating ${tags.length} image(s)...`, 'Image Generation');

    const regenKey = buildProcessingKey(messageId);
    processingMessages.add(regenKey);

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        processingMessages.delete(regenKey);
        return;
    }

    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) {
        processingMessages.delete(regenKey);
        return;
    }
    
    for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const tagId = `iig-regen-${messageId}-${index}`;

        try {
            // Match image element to tag by decoded instruction / prompt,
            // NOT by array index. With externalBlocks enabled, the tag list
            // and the DOM order can legitimately differ — picking by index
            // regenerates the wrong image and patches the wrong `src` in
            // message.mes.
            const allInstructionImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            let existingImg = null;
            const tagPromptHead = (tag.prompt || '').substring(0, 30);
            for (const img of allInstructionImgs) {
                const rawInstr = img.getAttribute('data-iig-instruction') || '';
                const decoded = rawInstr
                    .replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'")
                    .replace(/&#39;/g, "'")
                    .replace(/&#34;/g, '"')
                    .replace(/&amp;/g, '&');
                if (tagPromptHead && decoded.includes(tagPromptHead)) {
                    existingImg = img;
                    break;
                }
                try {
                    const parsed = parseInstructionObject(decoded);
                    if (parsed?.prompt && parsed.prompt.substring(0, 30) === tagPromptHead) {
                        existingImg = img;
                        break;
                    }
                } catch (_) {}
            }
            // Final fallback: positional, but skip images already claimed on
            // a previous iteration so two tags with identical prompts don't
            // both hit the first DOM image.
            if (!existingImg && allInstructionImgs[index] && !allInstructionImgs[index].hasAttribute('data-iig-claimed')) {
                existingImg = allInstructionImgs[index];
            }
            if (existingImg) existingImg.setAttribute('data-iig-claimed', '1');

            if (existingImg) {
                const instruction = existingImg.getAttribute('data-iig-instruction');
                
                // Replace the wrapper (if present) or the img itself with loading placeholder
                const existingWrapper = existingImg.closest('.iig-image-wrapper');
                const loadingPlaceholder = createLoadingPlaceholder(tagId);
                if (existingWrapper) {
                    existingWrapper.replaceWith(loadingPlaceholder);
                } else {
                    existingImg.replaceWith(loadingPlaceholder);
                }
                
                const statusEl = loadingPlaceholder.querySelector('.iig-status');
                const setStatus = (text) => {
                    // Placeholder may be detached mid-generation (chat switch,
                    // regen spam). Silently drop updates in that case instead
                    // of throwing into the async path and leaving a permanent
                    // spinner.
                    if (statusEl && statusEl.isConnected) statusEl.textContent = text;
                };

                // Phase-2a: register abort controller per tag so a repeat
                // click of "regenerate all" on the same message cancels any
                // still-in-flight tag generations from the prior batch.
                const { controller, key } = beginGeneration(messageId, tag);

                try {
                    const dataUrl = await generateImageWithRetry(
                        tag.prompt,
                        tag.style,
                        setStatus,
                        {
                            aspectRatio: tag.aspectRatio,
                            imageSize: tag.imageSize,
                            quality: tag.quality,
                            preset: tag.preset,
                            signal: controller.signal,
                        }
                    );

                    setStatus('Saving...');
                    const imagePath = await saveImageToFile(dataUrl);

                    const img = document.createElement('img');
                    img.className = 'iig-generated-image';
                    img.src = imagePath;
                    img.alt = tag.prompt;
                    if (instruction) {
                        img.setAttribute('data-iig-instruction', instruction);
                    }
                    if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
                    const wrappedImg = wrapImageWithActions(img);
                    loadingPlaceholder.replaceWith(wrappedImg);

                    const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                    replaceTagInMessageSource(message, tag, updatedTag);

                    toastr.success(`Image ${index + 1}/${tags.length} ready`, 'Image Generation', { timeOut: 2000 });
                } finally {
                    endGeneration(key, controller);
                }
            }
        } catch (error) {
            const isAbort = error?.name === 'AbortError' || /aborted/i.test(error?.message || '');
            if (isAbort) {
                iigLog('INFO', `Regeneration tag ${index} aborted (superseded)`);
                continue; // silent cancel
            }
            iigLog('ERROR', `Regeneration failed for tag ${index}:`, error.message);
            toastr.error(`Error: ${error.message}`, 'Image Generation');
        }
    }
    
    // Clean up the transient claim marker so subsequent regens start fresh.
    mesTextEl.querySelectorAll('img[data-iig-claimed]').forEach(img => img.removeAttribute('data-iig-claimed'));

    processingMessages.delete(regenKey);
    recentlyProcessed.set(regenKey, Date.now());
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
 * Wrap all existing generated images with action buttons.
 * Called on chat load / chat change to add buttons to already-rendered images.
 */
function wrapExistingImages() {
    // Search by both class (newly generated) and attribute (persisted in message.mes after reload)
    const images = document.querySelectorAll('#chat .iig-generated-image, #chat img[data-iig-instruction]');
    let count = 0;
    for (const img of images) {
        if (img.parentElement?.classList.contains('iig-image-wrapper')) continue;
        // Skip placeholders that haven't been generated yet
        const src = img.getAttribute('src') || '';
        if (!src || src === '[IMG:GEN]') continue;
        if (!img.classList.contains('iig-generated-image')) {
            img.classList.add('iig-generated-image');
        }
        wrapImageWithActions(img);
        count++;
    }
    if (count > 0) iigLog('INFO', `Wrapped ${count} existing images with action buttons`);
}

/**
 * MutationObserver: auto-wrap any .iig-generated-image that appears in #chat
 * without a wrapper. Catches images rendered after our initial pass (e.g. when
 * ST lazily renders messages after CHAT_CHANGED).
 */
function initImageWrapObserver() {
    const chat = document.getElementById('chat');
    if (!chat || chat._iigObserver) return;

    // Debounced processing: collect mutations for 100ms, then batch-wrap.
    // Prevents dozens of querySelectorAll calls during chat load.
    let _pendingNodes = [];
    let _debounceTimer = null;

    const processPending = () => {
        _debounceTimer = null;
        const nodes = _pendingNodes;
        _pendingNodes = [];
        let wrapped = 0;
        for (const node of nodes) {
            if (!(node instanceof HTMLElement)) continue;
            const isTarget = node.matches?.('img.iig-generated-image, img[data-iig-instruction]');
            const imgs = isTarget
                ? [node]
                : node.querySelectorAll?.('img.iig-generated-image, img[data-iig-instruction]') || [];
            for (const img of imgs) {
                if (img.parentElement?.classList.contains('iig-image-wrapper')) continue;
                // Skip images that haven't been generated yet (still streaming / placeholder)
                const src = img.getAttribute('src') || '';
                if (!src || src === '[IMG:GEN]' || src.startsWith('data:') && src.length < 100) continue;
                if (!img.classList.contains('iig-generated-image')) {
                    img.classList.add('iig-generated-image');
                }
                wrapImageWithActions(img);
                wrapped++;
            }
        }
        if (wrapped > 0) iigLog('INFO', `Observer wrapped ${wrapped} image(s)`);
    };

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                _pendingNodes.push(node);
            }
        }
        if (!_debounceTimer) {
            _debounceTimer = setTimeout(processPending, 100);
        }
    });

    observer.observe(chat, { childList: true, subtree: true });
    chat._iigObserver = observer;
    iigLog('INFO', 'Image wrap MutationObserver initialized (debounced)');
}

/**
 * Add regenerate buttons to all existing AI messages in chat
 */
function addButtonsToExistingMessages() {
    const context = getContext();
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
        
        const context = getContext();
        
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
    const context = getContext();
    
    const container = document.getElementById('extensions_settings');
    if (!container) {
        iigLog('ERROR', 'Settings container not found');
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
                <b><i class="fa-solid fa-leaf"></i> ⊹ INLINE IMAGE GENERATION ⊹</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <!-- Enable/Disable -->
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Enable image generation</span>
                    </label>
                    <label class="checkbox_label" style="margin-top: 6px;">
                        <input type="checkbox" id="iig_external_blocks" ${settings.externalBlocks ? 'checked' : ''}>
                        <span>External blocks support</span>
                    </label>
                    <p class="hint">Enable if other extensions put image tags in message.extra.extblocks.</p>

                    <label class="checkbox_label" style="margin-top: 6px;">
                        <input type="checkbox" id="iig_prompt_driven" ${settings.promptDriven ? 'checked' : ''}>
                        <span>Prompt-driven generation (tag overrides UI)</span>
                    </label>
                    <p class="hint">When on, values inside <code>data-iig-instruction</code> (aspect_ratio, image_size, quality, preset) always win. The generation-settings controls below act only as fallback for when the tag omits a field. Turn this off to force every generation to use UI values regardless of what the AI put in the tag.</p>
                    
                    <hr>
                    
                    <!-- API Settings Section -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-plug"></i> API Configuration</h4>
                        
                        <div class="flex-row">
                            <label for="iig_api_type">API Type</label>
                            <select id="iig_api_type" class="flex1">
                                <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-compatible</option>
                                <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Custom provider</option>
                                <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>Naistera / Grok</option>
                            </select>
                        </div>
                        
                        <div class="flex-row">
                            <label for="iig_endpoint">Endpoint URL</label>
                            <input type="text" id="iig_endpoint" class="text_pole flex1" 
                                   value="${sanitizeForHtml(settings.endpoint)}" 
                                   placeholder="${ENDPOINT_PLACEHOLDERS[settings.apiType] || 'https://api.example.com'}">
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
                        <p id="iig_custom_hint" class="hint ${settings.apiType === 'gemini' ? '' : 'iig-hidden'}">Custom provider: supports nano-banana (Gemini API shape) AND gpt-image-* / dall-e-* (OpenAI API shape). The extension auto-picks the right request format from the model name.</p>
                        
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
                        <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_model_row">
                            <label for="iig_naistera_model">Model</label>
                            <select id="iig_naistera_model" class="flex1">
                                <option value="grok" ${normalizeNaisteraModel(settings.naisteraModel) === 'grok' ? 'selected' : ''}>grok</option>
                                <option value="nano banana" ${normalizeNaisteraModel(settings.naisteraModel) === 'nano banana' ? 'selected' : ''}>nano banana</option>
                            </select>
                        </div>
                        <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_aspect_row">
                            <label for="iig_naistera_aspect_ratio">Aspect Ratio</label>
                            <select id="iig_naistera_aspect_ratio" class="flex1">
                                <option value="1:1" ${settings.naisteraAspectRatio === '1:1' ? 'selected' : ''}>1:1</option>
                                <option value="16:9" ${settings.naisteraAspectRatio === '16:9' ? 'selected' : ''}>16:9</option>
                                <option value="9:16" ${settings.naisteraAspectRatio === '9:16' ? 'selected' : ''}>9:16</option>
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

                    <!-- References Section (available for all providers; OpenAI-compatible
                         gateways often support reference images for gpt-image-* models) -->
                    <div id="iig_refs_section" class="iig-refs">
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
                        v${IIG_VERSION} by <a href="https://github.com/aceeenvw/notsosillynotsoimages" target="_blank" style="color:inherit;text-decoration:underline;">aceeenvw</a>
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

        // Phase-2b: rename-on-blur. When the user leaves the name field and
        // the stored file doesn't already match iig_ref_<refType>_<slug>,
        // download → re-upload under the new name → delete old. Skipped if
        // no name typed, no file uploaded, or filename already matches.
        // Errors are logged but silent to the user — the old file still works.
        let _renameInProgress = false;
        nameInput?.addEventListener('blur', async () => {
            if (_renameInProgress) return;
            const s = getCurrentCharacterRefs();
            const currentName = (nameInput.value || '').trim();
            if (!currentName) return;

            let slotRef;
            if (refType === 'char') slotRef = s.charRef;
            else if (refType === 'user') slotRef = s.userRef;
            else if (refType === 'npc') slotRef = s.npcReferences[npcIndex];

            if (!slotRef?.imagePath) return;

            const currentPath = slotRef.imagePath;
            const currentFilename = currentPath.split('/').pop() || '';
            const nameSlug = sanitizeRefNameForFilename(currentName);
            if (!nameSlug) return;

            // Already in the desired form? Skip (handles the "no-op blur"
            // case where user tabs in and out without changing anything).
            //
            // v2.6.1 bug fix: the previous "startsWith(expectedPrefix + '_')"
            // check was too broad — it matched ANY filename whose slug was
            // "<nameSlug>_<anything>" including genuinely-different names.
            //
            // Example failure:
            //   current: iig_ref_char_charlotte_ff.jpeg
            //   user types "Charlotte" → nameSlug = "charlotte"
            //   expectedPrefix = "iig_ref_char_charlotte"
            //   startsWith("iig_ref_char_charlotte_") → TRUE ❌ (rename skipped)
            //
            // Correct behavior: only skip if the suffix after expectedPrefix_
            // is a pure number (collision marker: _2, _3, _4 etc.).
            const expectedPrefix = `iig_ref_${refType}_${nameSlug}`;
            if (currentFilename === `${expectedPrefix}.jpeg`) return;
            const escapedPrefix = expectedPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const collisionForm = new RegExp(`^${escapedPrefix}_\\d+\\.jpeg$`);
            if (collisionForm.test(currentFilename)) return;

            _renameInProgress = true;
            iigLog('INFO', `Renaming ref file to match name "${currentName}": ${currentFilename} → iig_ref_${refType}_${nameSlug}.jpeg (or _N)`);

            try {
                const newFilename = await pickUniqueRefFilename(refType, nameSlug, currentPath);

                const currentB64 = await loadRefImageAsBase64(currentPath);
                if (!currentB64) {
                    iigLog('WARN', 'Rename aborted: could not load current file');
                    return;
                }

                const label = refType === 'npc' ? `npc${npcIndex}` : refType;
                const newPath = await saveRefImageToFile(currentB64, label, newFilename);

                // Point settings at the new path, invalidate cache for both.
                slotRef.imagePath = newPath;
                invalidateRefB64Cache(currentPath);
                invalidateRefB64Cache(newPath);
                saveSettings();

                // Update thumbnail so the user sees the rename was accepted.
                const thumb = slot.querySelector('.iig-ref-thumb');
                if (thumb) thumb.src = newPath;

                // Remove the old file (best-effort — if this fails we have
                // one orphan file but the new path works correctly).
                await deleteRefFileOnServer(currentPath);

                iigLog('INFO', `Rename complete: ${newPath}`);
            } catch (e) {
                iigLog('ERROR', `Rename failed: ${e.message}`);
            } finally {
                _renameInProgress = false;
            }
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

                // Phase-2b: if the user already typed a name in the ref slot
                // before hitting upload, bake it into the filename directly
                // so we skip a rename round-trip. Otherwise fall through to
                // the default timestamp-based naming — if a name gets typed
                // later, the blur handler renames it then.
                const currentTypedName = slot.querySelector('.iig-ref-name')?.value?.trim() || '';
                const nameSlug = sanitizeRefNameForFilename(currentTypedName);
                const customFilename = nameSlug
                    ? await pickUniqueRefFilename(refType, nameSlug)
                    : null;
                const savedPath = await saveRefImageToFile(compressed, label, customFilename);

                const s = getCurrentCharacterRefs();
                let prevPath = '';
                if (refType === 'char') {
                    prevPath = s.charRef.imagePath || '';
                    s.charRef.imageBase64 = '';
                    s.charRef.imagePath = savedPath;
                } else if (refType === 'user') {
                    prevPath = s.userRef.imagePath || '';
                    s.userRef.imageBase64 = '';
                    s.userRef.imagePath = savedPath;
                } else if (refType === 'npc') {
                    if (!s.npcReferences[npcIndex]) s.npcReferences[npcIndex] = { name: '', imageBase64: '', imagePath: '' };
                    prevPath = s.npcReferences[npcIndex].imagePath || '';
                    s.npcReferences[npcIndex].imageBase64 = '';
                    s.npcReferences[npcIndex].imagePath = savedPath;
                }
                if (prevPath && prevPath !== savedPath) invalidateRefB64Cache(prevPath);
                invalidateRefB64Cache(savedPath);
                saveSettings();
                const thumb = slot.querySelector('.iig-ref-thumb');
                if (thumb) thumb.src = savedPath;

                iigLog('INFO', `Ref slot ${label}: saved to ${savedPath}`);
                toastr.success('Photo saved to server', 'Image Generation', { timeOut: 2000 });

                // Phase-2b: the previous upload (if any) is now orphan.
                // Fire-and-forget delete to prevent iig_refs bloat.
                if (prevPath && prevPath !== savedPath) deleteRefFileOnServer(prevPath);
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
            const s = getCurrentCharacterRefs();
            let prevPath = '';
            if (refType === 'char') {
                prevPath = s.charRef?.imagePath || '';
                s.charRef = { name: '', imageBase64: '', imagePath: '' };
            } else if (refType === 'user') {
                prevPath = s.userRef?.imagePath || '';
                s.userRef = { name: '', imageBase64: '', imagePath: '' };
            } else if (refType === 'npc') {
                prevPath = s.npcReferences[npcIndex]?.imagePath || '';
                s.npcReferences[npcIndex] = { name: '', imageBase64: '', imagePath: '' };
            }
            if (prevPath) invalidateRefB64Cache(prevPath);
            saveSettings();

            const thumb = slot.querySelector('.iig-ref-thumb');
            if (thumb) thumb.src = '';
            const thumbWrap = slot.querySelector('.iig-ref-thumb-wrap');
            if (thumbWrap) thumbWrap.classList.remove('has-image');
            const nameEl = slot.querySelector('.iig-ref-name');
            if (nameEl) nameEl.value = '';

            const label = refType === 'npc' ? `NPC ${npcIndex}` : refType;
            iigLog('INFO', `Ref slot ${label}: cleared`);
            toastr.info('Slot cleared', 'Image Generation', { timeOut: 2000 });

            // Phase-2b: also remove the orphan file from the server so the
            // iig_refs folder doesn't bloat with unused images over time.
            // Fire-and-forget; UI flow already completed above.
            if (prevPath) deleteRefFileOnServer(prevPath);
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
        // OpenAI Size/Quality controls — only for direct OpenAI-compatible endpoints
        document.getElementById('iig_size_row')?.classList.toggle('iig-hidden', !isOpenAI);
        document.getElementById('iig_quality_row')?.classList.toggle('iig-hidden', !isOpenAI);
        document.getElementById('iig_naistera_model_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_aspect_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_preset_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_hint')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_custom_hint')?.classList.toggle('iig-hidden', !isGemini);
        // Aspect Ratio + Resolution — always shown for Custom provider,
        // regardless of whether the model is Gemini or OpenAI-style.
        // The aggregator function handles translating these per-model.
        document.getElementById('iig_gemini_params')?.classList.toggle('iig-hidden', !isGemini);
        // References are always visible — every provider can use them.
        document.getElementById('iig_refs_section')?.classList.remove('iig-hidden');
    };
    
    document.getElementById('iig_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
        updateHeaderStatusDot();
    });

    document.getElementById('iig_external_blocks')?.addEventListener('change', (e) => {
        settings.externalBlocks = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_prompt_driven')?.addEventListener('change', (e) => {
        settings.promptDriven = e.target.checked;
        saveSettings();
    });
    
    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        const nextApiType = e.target.value;
        const endpointInput = document.getElementById('iig_endpoint');

        // Auto-replace endpoint when switching to Naistera from an incompatible endpoint
        if (shouldReplaceEndpointForApiType(nextApiType, settings.endpoint)) {
            settings.endpoint = normalizeConfiguredEndpoint(nextApiType, '');
            if (endpointInput) endpointInput.value = settings.endpoint;
        } else if (nextApiType === 'naistera') {
            settings.endpoint = normalizeConfiguredEndpoint(nextApiType, settings.endpoint);
            if (endpointInput) endpointInput.value = settings.endpoint;
        }

        settings.apiType = nextApiType;
        saveSettings();
        updateVisibility();
    });
    
    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => {
        settings.endpoint = normalizeConfiguredEndpoint(settings.apiType, e.target.value);
        // Update the input to show normalized value (debounced to avoid cursor jumping)
        clearTimeout(e.target._normalizeTimer);
        e.target._normalizeTimer = setTimeout(() => {
            if (e.target.value !== settings.endpoint) {
                e.target.value = settings.endpoint;
            }
        }, 1500);
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
            // Nano-banana requires Gemini API shape → make sure we're in Custom.
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
        }
        // Always refresh visibility — Size/Quality vs Aspect/Resolution depend
        // on the selected model inside "Custom provider".
        updateVisibility();
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

    document.getElementById('iig_naistera_model')?.addEventListener('change', (e) => {
        settings.naisteraModel = normalizeNaisteraModel(e.target.value);
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
                const resp = await fetchWithTimeout('/api/settings/save', {
                    method: 'POST',
                    headers: ctx.getRequestHeaders(),
                    body: JSON.stringify(payload)
                }, 30000);
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
            const currentSettings = getSettings();
            iigLog('INFO', `Test connection: apiType=${currentSettings.apiType}, endpoint=${currentSettings.endpoint}, apiKey=${currentSettings.apiKey ? 'set' : 'empty'}`);

            if (!currentSettings.endpoint && currentSettings.apiType !== 'naistera') {
                throw new Error('Set endpoint first');
            }
            if (!currentSettings.apiKey) {
                throw new Error('Set API key first');
            }

            if (currentSettings.apiType === 'naistera') {
                // For Naistera, just check if the endpoint responds (fallback to naistera.org)
                const testUrl = getEffectiveEndpoint(currentSettings);
                const resp = await fetchWithTimeout(testUrl, { method: 'HEAD' }, 20000).catch(() => null);
                if (resp && resp.ok) {
                    toastr.success('Connection OK', 'Image Generation');
                } else {
                    toastr.warning('Endpoint reachable but returned non-OK', 'Image Generation');
                }
            } else {
                // OpenAI/Gemini — try fetching models
                const models = await fetchModels();
                if (models.length > 0) {
                    toastr.success(`Connection OK — ${models.length} image model(s) found`, 'Image Generation');
                } else {
                    toastr.warning('Connected but no image generation models found', 'Image Generation');
                }
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
            <div class="iig-lightbox-actions">
                <button class="iig-lightbox-action-btn iig-lb-download" title="Download">${SVG_ICON_DOWNLOAD}</button>
                <button class="iig-lightbox-action-btn iig-lb-regen" title="Regenerate">${SVG_ICON_REGENERATE}</button>
            </div>
            <div class="iig-lightbox-caption"></div>
            <button class="iig-lightbox-close" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
    `;
    document.body.appendChild(overlay);

    // Track which source image is currently shown in lightbox
    overlay._sourceImg = null;

    const close = () => { overlay.classList.remove('open'); overlay._sourceImg = null; };
    overlay.querySelector('.iig-lightbox-backdrop').addEventListener('click', close);
    overlay.querySelector('.iig-lightbox-close').addEventListener('click', close);

    // Lightbox action buttons
    overlay.querySelector('.iig-lb-download').addEventListener('click', (e) => {
        e.stopPropagation();
        if (overlay._sourceImg) downloadGeneratedImage(overlay._sourceImg);
    });
    overlay.querySelector('.iig-lb-regen').addEventListener('click', (e) => {
        e.stopPropagation();
        if (overlay._sourceImg) {
            close();
            regenerateSingleImage(overlay._sourceImg);
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('open')) close();
    });

    // Delegate click on generated images inside #chat
    // Desktop only: single click on image opens lightbox
    // Mobile: lightbox disabled (causes freezes), tap shows action buttons instead
    document.getElementById('chat')?.addEventListener('click', (e) => {
        // No lightbox on mobile
        if (IS_MOBILE) return;

        // Skip if clicking action buttons
        if (e.target.closest('.iig-action-btn')) return;

        const img = e.target.closest('.iig-generated-image');
        if (!img) return;

        e.preventDefault();
        e.stopPropagation();
        openLightbox(img);
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
    // Primer: first call populates the cache for the rest of the module.
    const context = getContext();

    // Capture ST's original window.saveSettings BEFORE our module's function
    // declaration shadows it. Must run exactly once at module init. If we
    // delay this to the first saveSettings() call, hoisting of the local
    // declaration may already have replaced the global reference — then we'd
    // fall through to the debounced path forever, and mobile app termination
    // could lose settings that only lived in the debounce queue.
    if (!_stSaveSettingsCaptured) {
        const candidate = window.saveSettings;
        if (typeof candidate === 'function' && candidate !== saveSettings) {
            _stSaveSettings = candidate;
        }
        _stSaveSettingsCaptured = true;
    }

    iigLog('INFO', `Initializing Inline Image Generation v${IIG_VERSION} by aceeenvw`);
    iigLog('INFO', `Platform: ${IS_IOS ? 'iOS' : 'Desktop'}, Timeout: ${FETCH_TIMEOUT/1000}s`);

    getSettings();
    
    context.eventSource.on(context.event_types.APP_READY, () => {
        // Phase-2b: one-shot base64 migration. Fire-and-forget — the UI
        // doesn't need to wait, and partial failures leave refs usable via
        // the existing imageBase64 fallback path in generateImageWithRetry.
        migrateBase64Refs().catch(e => iigLog('ERROR', `migrateBase64Refs crashed: ${e.message}`));

        restoreRefsFromLocalStorage();
        createSettingsUI();
        addButtonsToExistingMessages();
        wrapExistingImages();
        initLightbox();
        updateHeaderStatusDot();
        initMobileSaveListeners();
        initImageWrapObserver();
        iigLog('INFO', 'Inline Image Generation extension loaded');
    });
    
    // Phase-1 heat mitigation: rapid chat switching previously stacked two
    // timers per switch (300 ms + 1500 ms), each performing full-chat
    // querySelectorAll sweeps. We now coalesce into a single guarded timer
    // and rely on the MutationObserver (initImageWrapObserver) to catch any
    // late-rendered images — that's what it's for.
    let _chatChangedTimer = null;
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        iigLog('INFO', 'CHAT_CHANGED event');
        // Re-capture ST context in case ST swapped it (e.g., on character
        // switch). Safe to call often — the helper is a plain var assignment.
        invalidateContextCache();
        // Clear per-chat processing state immediately — otherwise a new chat's
        // message at the same numeric index as one that was being processed
        // in the old chat could get silently skipped.
        clearProcessingStateForChatChange();
        // Ref-image cache entries from the previous chat are no longer
        // guaranteed relevant — drop them so the new chat's refs are fetched
        // fresh on first use.
        clearAllRefB64Cache();

        if (_chatChangedTimer) clearTimeout(_chatChangedTimer);
        _chatChangedTimer = setTimeout(() => {
            _chatChangedTimer = null;
            restoreRefsFromLocalStorage();
            addButtonsToExistingMessages();
            wrapExistingImages();
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
