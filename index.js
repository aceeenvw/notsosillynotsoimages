/**
 * notsosillynotsoimages — Inline Image Generation for SillyTavern
 * Character references, NPC slots, iOS compatibility layer.
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

import { chat_completion_sources, createGenerationParameters, getChatCompletionModel, promptManager } from '/scripts/openai.js';
import { playMessageSound } from '/scripts/power-user.js';
import { updateViewMessageIds } from '/script.js';

// A replacement must not race an older instance's persistence rollback.
{
    let previous;
    do {
        previous = window.IIG;
        await previous?.cleanup?.();
    } while (window.IIG !== previous);
}

let _iigDisposed = false;
let _iigCleanupPromise = null;
let _iigCleanupWork = null;
let _iigRefsRestored = false;
const IIG_CLEANUP_TIMEOUT_MS = 15000;
const _iigLifetime = new AbortController();
const _iigDisposers = new Set();
const _iigTasks = new Set();
const _iigTimers = new Set();

function addIigDisposer(dispose) {
    if (_iigDisposed) { dispose(); return () => {}; }
    _iigDisposers.add(dispose);
    return () => _iigDisposers.delete(dispose);
}

function trackIigTask(task) {
    const promise = Promise.resolve(task);
    _iigTasks.add(promise);
    promise.then(() => _iigTasks.delete(promise), () => _iigTasks.delete(promise));
    return promise;
}

function iigHandler(handler) {
    return function (...args) {
        if (_iigDisposed) return;
        const result = handler.apply(this, args);
        if (result?.then) return trackIigTask(result);
        return result;
    };
}

function bindIig(target, type, handler, options) {
    if (!_iigDisposed) target?.addEventListener(type, iigHandler(handler), options);
}

// Only long-lived targets belong here; local controls are collected with their root.
function listenIig(target, type, handler, options) {
    if (!target || _iigDisposed) return () => {};
    const listener = iigHandler(handler);
    target.addEventListener(type, listener, options);
    const dispose = () => target.removeEventListener(type, listener, options);
    const forget = addIigDisposer(dispose);
    return () => { forget(); dispose(); };
}

function subscribeIig(source, type, handler, last = false) {
    if (_iigDisposed) return;
    const listener = iigHandler(handler);
    // APP_READY can replay synchronously inside on().
    addIigDisposer(() => source.removeListener(type, listener));
    source[last ? 'makeLast' : 'on'](type, listener);
}

function setIigTimeout(callback, delay) {
    if (_iigDisposed) return null;
    const timer = setTimeout(() => {
        _iigTimers.delete(timer);
        if (!_iigDisposed) callback();
    }, delay);
    _iigTimers.add(timer);
    return timer;
}

function clearIigTimeout(timer) {
    clearTimeout(timer);
    _iigTimers.delete(timer);
}

function waitIig(promise) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('Extension disposed'), { name: 'AbortError', reason: 'cleanup' }));
        if (_iigDisposed) { Promise.resolve(promise).catch(() => {}); abort(); return; }
        _iigLifetime.signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => _iigLifetime.signal.removeEventListener('abort', abort));
    });
}

function readIigBase64(file) {
    return new Promise((resolve, reject) => {
        throwIfSignalAborted();
        const reader = new FileReader();
        const release = () => {
            _iigLifetime.signal.removeEventListener('abort', abort);
            reader.onload = reader.onerror = reader.onabort = null;
        };
        const abort = () => { reader.abort(); release(); reject(Object.assign(new Error('Read aborted'), { name: 'AbortError' })); };
        reader.onload = () => { const value = String(reader.result).split(',')[1]; release(); resolve(value); };
        reader.onerror = () => { const error = reader.error; release(); reject(error || new Error('Read failed')); };
        reader.onabort = abort;
        _iigLifetime.signal.addEventListener('abort', abort, { once: true });
        try { reader.readAsDataURL(file); }
        catch (error) { release(); reject(error); }
    });
}

async function showIigPopup(popup, beforeShow = null, onDispose = null) {
    const ctx = getContext();
    let shown = false;
    let showing;
    const dispose = () => {
        onDispose?.();
        popup.onOpen = null;
        if (shown) {
            if (popup.dlg?.hasAttribute('closing')) return showing;
            popup.onClosing = () => true;
            return popup.complete(ctx.POPUP_RESULT.CANCELLED);
        }
        if (popup.dlg?.open) popup.dlg.close();
        popup.dlg?.remove();
        const popups = ctx.Popup.util?.popups;
        const index = popups?.indexOf(popup) ?? -1;
        if (index >= 0) popups.splice(index, 1);
    };
    if (_iigDisposed) { dispose(); return null; }
    const forget = addIigDisposer(dispose);
    try {
        if (beforeShow) await beforeShow();
        if (_iigDisposed) return null;
        showing = popup.show();
        shown = true;
        return await showing;
    } catch (error) {
        shown = false;
        throw error;
    } finally {
        forget();
        if (!shown) dispose();
    }
}

async function showIigInput(title, text, value) {
    const ctx = getContext();
    if (_iigDisposed) return Promise.resolve(null);
    const result = await showIigPopup(new ctx.Popup(`<h3>${title}</h3>${text}`, ctx.POPUP_TYPE.INPUT, value));
    return result === '' ? '' : result ? String(result) : null;
}

async function showIigConfirm(title, text) {
    const ctx = getContext();
    if (_iigDisposed) return false;
    const result = await showIigPopup(new ctx.Popup(`<h3>${title}</h3>${text}`, ctx.POPUP_TYPE.CONFIRM, ''));
    return result === ctx.POPUP_RESULT.AFFIRMATIVE;
}

const MODULE_NAME = 'inline_image_gen';
const IIG_VERSION = '3.3.0';

const _BUILD_SEED_DELTA = [2, 2, 0, 9, 8, 1];
function stableBuildHash(input) {
    const seed = [0x61];
    for (const delta of _BUILD_SEED_DELTA) seed.push(seed[seed.length - 1] + delta);
    let hash = 0x811c9dc5;
    for (const value of [...seed, ...String(input)].map(value => typeof value === 'number' ? value : value.charCodeAt(0))) {
        hash ^= value;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return { seed: String.fromCharCode(...seed), value: hash.toString(16).padStart(8, '0') };
}
const _BUILD_HASH = stableBuildHash(`${MODULE_NAME}:${IIG_VERSION}`);

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_MOBILE_OS = IS_IOS || /Android|webOS|BlackBerry|Opera Mini|IEMobile/i.test(navigator.userAgent);
const IS_MOBILE = IS_MOBILE_OS || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
const USE_TAP_IMAGE_ACTIONS = IS_MOBILE || !!window.matchMedia?.('(hover: none), (pointer: coarse)')?.matches;
const IS_DESKTOP_OS = !IS_MOBILE_OS;
const FETCH_TIMEOUT = IS_IOS ? 180000 : 300000; // 3 min iOS, 5 min desktop

function playDesktopCompletionSound() {
    if (!_iigDisposed && IS_DESKTOP_OS) playMessageSound();
}

function throwIfSignalAborted(signal) {
    if (!_iigDisposed && !signal?.aborted) return;
    const error = new Error('Request aborted');
    error.name = 'AbortError';
    error.reason = signal?.reason ?? (_iigDisposed ? 'cleanup' : undefined);
    throw error;
}

// Main transport. timeoutMs lets callers extend the abort window.
function robustFetch(url, options = {}, timeoutMs = FETCH_TIMEOUT) {
    if (!IS_IOS) {
        return fetchIigResponse(url, options, timeoutMs, `Request timed out after ${Math.round(timeoutMs / 60000)} minutes`);
    }
    return new Promise((resolve, reject) => {
        throwIfSignalAborted(options.signal);
        const xhr = new XMLHttpRequest();
        xhr.open(options.method || 'GET', url);
        xhr.timeout = timeoutMs;
        xhr.responseType = 'text';
        if (options.headers) {
            for (const [key, value] of Object.entries(options.headers)) {
                xhr.setRequestHeader(key, value);
            }
        }
        // Honor external AbortSignal so callers can cancel iOS requests too.
        // Build an AbortError that carries the signal's reason (e.g. 'user-cancel')
        // so downstream classification works on iOS too.
        const _abortErr = () => {
            const reason = options.signal?.reason ?? _iigLifetime.signal.reason;
            const e = new Error(typeof reason === 'string' ? reason : 'Request aborted (iOS)');
            e.name = 'AbortError';
            if (reason !== undefined) e.reason = reason;
            return e;
        };
        const abort = () => xhr.abort();
        const release = () => {
            options.signal?.removeEventListener('abort', abort);
            _iigLifetime.signal.removeEventListener('abort', abort);
            xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
        };
        options.signal?.addEventListener('abort', abort, { once: true });
        _iigLifetime.signal.addEventListener('abort', abort, { once: true });
        xhr.onload = () => {
            const responseText = xhr.responseText;
            release();
            resolve({
                ok: xhr.status >= 200 && xhr.status < 300,
                status: xhr.status,
                statusText: xhr.statusText,
                text: async () => { throwIfSignalAborted(options.signal); return responseText; },
                // Async rejection on bad JSON, matching real fetch's .json().catch().
                json: () => new Promise((res, rej) => {
                    try { throwIfSignalAborted(options.signal); res(JSON.parse(responseText)); }
                    catch (err) { rej(err); }
                }),
                headers: { get: (name) => xhr.getResponseHeader(name) },
            });
        };
        xhr.ontimeout = () => { release(); reject(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} minutes (iOS)`)); };
        xhr.onerror = () => { release(); reject(new Error('Network error (iOS)')); };
        xhr.onabort = () => { release(); reject(_abortErr()); };
        try { xhr.send(options.body || null); }
        catch (error) { release(); reject(error); }
    });
}

/** Short-timeout fetch for metadata/admin endpoints (models, file checks, uploads). */
function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    return fetchIigResponse(url, options, timeoutMs, `Request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
}

async function fetchIigResponse(url, options, timeoutMs, timeoutMessage) {
    throwIfSignalAborted(options.signal);
    const controller = new AbortController();
    let timedOut = false;
    const forwardAbort = () => controller.abort(options.signal?.reason);
    const stop = () => controller.abort(_iigLifetime.signal.reason);
    const release = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', forwardAbort);
        _iigLifetime.signal.removeEventListener('abort', stop);
        controller.signal.removeEventListener('abort', release);
    };
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    _iigLifetime.signal.addEventListener('abort', stop, { once: true });
    controller.signal.addEventListener('abort', release, { once: true });
    const normalizeError = error => {
        if (!controller.signal.aborted) throw error;
        if (timedOut) throw new Error(timeoutMessage);
        const abortError = new Error(error?.message || 'Request aborted');
        abortError.name = 'AbortError';
        abortError.reason = options.signal?.reason ?? controller.signal.reason;
        throw abortError;
    };
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        throwIfSignalAborted(controller.signal);
        response.iigDiscard = () => { controller.abort(); release(); };
        // Keep cancellation alive through body consumption, not just response headers.
        for (const method of ['json', 'text', 'blob', 'arrayBuffer', 'formData']) {
            const read = response[method];
            if (typeof read !== 'function') continue;
            response[method] = async (...args) => {
                try {
                    throwIfSignalAborted(controller.signal);
                    const value = await read.apply(response, args);
                    throwIfSignalAborted(controller.signal);
                    return value;
                } catch (error) { return normalizeError(error); }
                finally { release(); }
            };
        }
        if (!response.body) release();
        return response;
    } catch (error) {
        release();
        return normalizeError(error);
    }
}

/**
 * Promise-based delay that resolves early when `signal` aborts (e.g. user Stop),
 * so retry backoffs don't block cancellation. Removes its abort listener on the
 * normal timeout path, so it is safe to call repeatedly without leaking listeners.
 */
function abortableDelay(ms, signal = null) {
    return new Promise((resolve) => {
        if (_iigDisposed || signal?.aborted) { resolve(); return; }
        let timer = null;
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            _iigLifetime.signal.removeEventListener('abort', onAbort);
            resolve();
        };
        timer = setTimeout(onAbort, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
        _iigLifetime.signal.addEventListener('abort', onAbort, { once: true });
    });
}

// Dedup: messages currently processing. Key is "chatId:messageId" — bare
// messageId collides across chats because it's a numeric array index.
const processingMessages = new Set();

// Cooldown against re-trigger loops from messageFormatting / innerHTML
// changes re-firing CHARACTER_MESSAGE_RENDERED.
const recentlyProcessed = new Map();
const REPROCESS_COOLDOWN_MS = 5000;

// In-flight generations, keyed by "messageId:tagHash". Reclick aborts the prior
// fetch so only the latest result lands (no stale-overwrite races).
const _inFlightGenerations = new Map();
const _regenBatchTokens = new Map();

function _genKey(messageId, tag) {
    const messageKey = buildProcessingKey(messageId);
    const str = `${messageKey}:${tag?.sourceKey || '_'}:${tag?.sourceIndex ?? '_'}:${tag?.occurrence ?? '_'}:${tag?.fullMatch || tag?.prompt?.slice(0, 80) || ''}`;
    return `${messageKey}:${stableBuildHash(str).value}`;
}

// Register a new in-flight generation, aborting any prior one for the same key.
function beginGeneration(messageId, tag) {
    throwIfSignalAborted();
    const key = _genKey(messageId, tag);
    const existing = _inFlightGenerations.get(key);
    if (existing) {
        iigLog('DEBUG:api', `Aborting prior in-flight generation for ${key}`);
        try { existing.abort(); } catch (_) {}
    }
    const controller = new AbortController();
    _inFlightGenerations.set(key, controller);
    return { controller, key };
}

// Release the slot only if still current, so an older finally can't clear a newer gen.
function endGeneration(key, controller) {
    if (_inFlightGenerations.get(key) === controller) {
        _inFlightGenerations.delete(key);
    }
}

// Per-placeholder abort controllers, keyed by the UI tagId. Lets a Stop button
// on a specific loading placeholder cancel ONLY that generation.
const tagAbortControllers = new Map();
let _singleImageGenerationSerial = 0;

// Cancel the generation behind a given placeholder tagId (user Stop click).
function abortGenerationForTag(tagId) {
    const controller = tagAbortControllers.get(String(tagId || ''));
    if (controller) {
        try { controller.abort('user-cancel'); } catch (_) {}
        return true;
    }
    return false;
}

function abortAllMediaGenerations(reason = 'chat-changed') {
    const controllers = new Set([..._inFlightGenerations.values(), ...tagAbortControllers.values()]);
    for (const controller of controllers) {
        try { controller.abort(reason); } catch (_) {}
    }
    _inFlightGenerations.clear();
    tagAbortControllers.clear();
    _regenBatchTokens.clear();
}

// Cached ST context (getContext allocates per call; hot paths hit it often).
// Invalidated on CHAT_CHANGED / APP_READY.
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

// Composite key (chatId:messageId) so numeric indices don't collide across chats.
function getMessageSwipeId(message) {
    const swipeId = Number(message?.swipe_id ?? 0);
    return Number.isInteger(swipeId) && swipeId >= 0 ? swipeId : 0;
}

function getCurrentSwipeId(messageId) {
    try {
        const message = getContext()?.chat?.[messageId];
        return getMessageSwipeId(message);
    } catch (_) {
        return 0;
    }
}

function buildProcessingKey(messageId) {
    try {
        const ctx = getContext();
        if (!ctx) return `_:${messageId}:0`;
        const chatId = ctx.chatId ?? ctx.getCurrentChatId?.() ?? '_';
        return `${chatId}:${messageId}:${getCurrentSwipeId(messageId)}`;
    } catch (_) {
        return `_:${messageId}:0`;
    }
}

function assertMediaOperationCurrent(messageId, message, scope, key = null, controller = null) {
    const current = getContext();
    const valid = !_iigDisposed && current?.chat?.[messageId] === message
        && buildProcessingKey(messageId) === scope
        && (!key || _inFlightGenerations.get(key) === controller);
    if (valid) return;
    const error = new Error('Media generation context changed');
    error.name = 'AbortError';
    error.reason = 'context-changed';
    throw error;
}

// Clear processing/cooldown state on CHAT_CHANGED so the new chat isn't blocked.
function clearProcessingStateForChatChange() {
    processingMessages.clear();
    recentlyProcessed.clear();
    _regenBatchTokens.clear();
}

// Global re-entry guard against stack overflow from recursive event dispatch.
let _eventHandlerDepth = 0;
const MAX_EVENT_HANDLER_DEPTH = 2;

// True while ST is streaming a reply. The image-wrap observer queues nodes but
// holds its heavy DOM pass until streaming ends, to avoid per-token CPU churn.
let _iigGenerating = false;
// Catch-up trigger set by the observer; run once when generation ends.
let _iigFlushWrapQueue = null;

function releaseStreamingGate() {
    if (_iigDisposed) return;
    _iigGenerating = false;
    try { _iigFlushWrapQueue?.(); } catch (_) {}
}

// Debounced re-wrap pass; restores action buttons after ST re-renders a message.
let _wrapPassTimer = null;
function scheduleWrapPass(delay = _wrapPassDelay()) {
    if (_iigDisposed) return;
    if (_wrapPassTimer) clearIigTimeout(_wrapPassTimer);
    _wrapPassTimer = setIigTimeout(() => {
        _wrapPassTimer = null;
        _iigGenerating = false; // clear the streaming gate
        try { wrapExistingImages(); } catch (_) {}
    }, delay);
}

// Low-power mode state. Each sub-flag applies only while the master is on.
const WRAP_DEBOUNCE_NORMAL = 100;
const WRAP_DEBOUNCE_SLOW = 500;
function _lowPowerSlowUpdates() {
    const s = getSettings();
    return !!(s.lowPowerMode && s.lpSlowUpdates);
}
function _lowPowerAnimationsOff() {
    const s = getSettings();
    return !!(s.lowPowerMode && s.lpDisableAnimations);
}
// Observer debounce (ms); wrap-pass runs a touch later.
function _wrapDebounceMs() { return _lowPowerSlowUpdates() ? WRAP_DEBOUNCE_SLOW : WRAP_DEBOUNCE_NORMAL; }
function _wrapPassDelay() { return _wrapDebounceMs() + 100; }

// Toggle the body class that gates the animation-disabling CSS.
function applyLowPowerMode() {
    try { document.body.classList.toggle('iig-low-power', _lowPowerAnimationsOff()); } catch (_) {}
}

// =========================================================================
// Shared placeholder ticker
// =========================================================================
//
// One 1s ticker drives every live placeholder and stops itself when the last
// one leaves. The period is fixed; each entry carries its own intervalMs,
// since image placeholders count every second while the prompt-model
// composing placeholder slows to 5s in low-power mode.
//
// _staleCleanupInterval below is a separate singleton, not part of this.
const _placeholderTicks = new Map();
let _placeholderTickerId = null;

function _runPlaceholderTicks() {
    // Snapshot: a callback may unregister itself or another entry.
    const now = Date.now();
    for (const [el, entry] of [..._placeholderTicks]) {
        if (!el || !el.isConnected) {
            unregisterPlaceholderTick(el);
            continue;
        }
        if (now - entry.lastRun < entry.intervalMs) continue;
        entry.lastRun = now;
        try {
            entry.fn();
        } catch (_) {
            unregisterPlaceholderTick(el);
        }
    }
    if (_placeholderTicks.size === 0 && _placeholderTickerId !== null) {
        clearInterval(_placeholderTickerId);
        _placeholderTickerId = null;
    }
}

/** Register a periodic callback for a placeholder element. */
function registerPlaceholderTick(el, fn, intervalMs = 1000) {
    if (_iigDisposed || !el || typeof fn !== 'function') return;
    _placeholderTicks.set(el, { fn, intervalMs: Math.max(1, intervalMs), lastRun: Date.now() });
    if (_placeholderTickerId === null) {
        _placeholderTickerId = setInterval(_runPlaceholderTicks, 1000);
    }
}

/** Stop ticking for a placeholder. Idempotent; a falsy element is a no-op. */
function unregisterPlaceholderTick(el) {
    if (!el) return;
    _placeholderTicks.delete(el);
    if (_placeholderTicks.size === 0 && _placeholderTickerId !== null) {
        clearInterval(_placeholderTickerId);
        _placeholderTickerId = null;
    }
}

// Clear a stale-cleanup interval left by a previous module instance.
try {
    if (typeof window !== 'undefined' && window._iigStaleCleanupInterval) {
        clearInterval(window._iigStaleCleanupInterval);
        delete window._iigStaleCleanupInterval;
    }
} catch (_) {}

const RECENTLY_PROCESSED_MAX = 64;

function markRecentlyProcessed(key) {
    const now = Date.now();
    for (const [id, ts] of recentlyProcessed) {
        if (now - ts > REPROCESS_COOLDOWN_MS * 2) recentlyProcessed.delete(id);
    }
    recentlyProcessed.set(key, now);
    // Insertion order: a burst inside the cooldown evicts its oldest first.
    while (recentlyProcessed.size > RECENTLY_PROCESSED_MAX) {
        const oldest = recentlyProcessed.keys().next();
        if (oldest.done) break;
        recentlyProcessed.delete(oldest.value);
    }
}

// Per-session counters shown in the settings panel (generated / failed).
let sessionGenCount = 0;
let sessionErrorCount = 0;

function updateSessionStats() {
    if (_iigDisposed) return;
    const el = document.getElementById('iig_session_stats');
    if (!el) return;
    if (sessionGenCount === 0 && sessionErrorCount === 0) {
        el.textContent = '';
        return;
    }
    const parts = [];
    if (sessionGenCount > 0) parts.push(iigT('iig_generatedCount', { count: sessionGenCount }));
    if (sessionErrorCount > 0) parts.push(iigT('iig_failedCount', { count: sessionErrorCount }));
    el.textContent = iigT('iig_session', { counts: parts.join(' · ') });
}

// Last saved media. Exposed via window.IIG.getLastGenerated() and broadcast as
// CustomEvent('iig:image-saved') so other extensions can auto-refresh.
let _lastGenerated = null;

function _emitMediaSaved(path, mediaType) {
    if (_iigDisposed) return;
    try {
        _lastGenerated = { path, mediaType, ts: Date.now() };
        window.dispatchEvent(new CustomEvent('iig:image-saved', { detail: { path, mediaType } }));
    } catch (_) { /* event dispatch must never break a save */ }
}

// Rolling in-memory log, surfaced by the Export Logs button.
const logBuffer = [];
const MAX_LOG_ENTRIES = 400;

// DEBUG is always buffered; console only with Verbose on. Mirrored from
// settings.verboseLogging so the log path never calls getContext().
const LOG_LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const LOG_STYLES = {
    DEBUG: 'color:#7a8a9a',
    INFO: 'color:#4a6a8a;font-weight:600',
    WARN: 'color:#b8860b;font-weight:600',
    ERROR: 'color:#c0392b;font-weight:600',
};
const LOG_SCOPE_WIDTH = 6;
let _verboseLogging = false;

function setVerboseLogging(on) {
    _verboseLogging = !!on;
}

// Mask recognizable credentials; opaque host-owned secrets cannot be inferred.
// Covers Bearer headers, sk-*/AIza* keys, and ?key=/?api_key= URL params.
function redactSensitive(text, redact = null) {
    if (typeof text !== 'string') {
        const seen = new WeakSet();
        let remaining = 100;
        const clean = (value, depth = 0) => {
            if (--remaining < 0 || depth > 5) return '[Truncated]';
            if (typeof value === 'string') return (redact || redactSensitive)(value);
            if (!value || typeof value !== 'object') {
                return typeof value === 'function' || typeof value === 'symbol' ? '[Omitted]' : value;
            }
            if (seen.has(value)) return '[Circular]';
            seen.add(value);
            try {
                const domError = typeof DOMException !== 'undefined' && value instanceof DOMException;
                const isError = value instanceof Error || domError;
                const ErrorType = [SyntaxError, TypeError, RangeError, URIError, ReferenceError, EvalError]
                    .find(type => value instanceof type) || Error;
                const result = isError ? new ErrorType()
                    : Array.isArray(value) ? [] : Object.create(null);
                // Never retain live objects or invoke custom getters/toJSON.
                const fields = isError ? ['name', 'message', 'stack', 'status', 'reason', 'i18n', 'i18nVars', 'cause'] : [];
                let count = 0;
                for (const key in value) {
                    if (++count > 32) break;
                    if (Object.hasOwn(value, key) && !fields.includes(key)) fields.push(key);
                }
                for (const key of fields) {
                    let descriptor = Object.getOwnPropertyDescriptor(value, key);
                    if (!descriptor && isError && !domError && key === 'name') {
                        let prototype = Object.getPrototypeOf(value);
                        for (let depth = 0; prototype && depth < 5 && !descriptor; depth++) {
                            descriptor = Object.getOwnPropertyDescriptor(prototype, key);
                            prototype = Object.getPrototypeOf(prototype);
                        }
                    }
                    if (!descriptor) {
                        if (domError && (key === 'name' || key === 'message')) {
                            result[key] = clean(Object.getOwnPropertyDescriptor(DOMException.prototype, key).get.call(value), depth + 1);
                        }
                        continue;
                    }
                    let field = 'value' in descriptor ? clean(descriptor.value, depth + 1) : '[Accessor]';
                    // V8 exposes native Error stacks through a lazy intrinsic getter.
                    if (isError && key === 'stack' && descriptor.get
                        && result.name !== '[Accessor]' && result.message !== '[Accessor]'
                        && descriptor.get === Object.getOwnPropertyDescriptor(result, 'stack')?.get) {
                        try { field = clean(descriptor.get.call(value), depth + 1); } catch (_) {}
                    }
                    Object.defineProperty(result, (redact || redactSensitive)(key), {
                        value: /^(?:authorization|(?:x-goog-)?api[-_]?key|token|secret|password)$/i.test(key)
                            ? '***REDACTED***' : field,
                        enumerable: true, configurable: true, writable: true,
                    });
                }
                return result;
            } catch (_) {
                return '[Uninspectable]';
            }
        };
        return clean(text);
    }
    if (redact) return redact(text);
    return text
        .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer ***REDACTED***')
        .replace(/\b(sk-(?:proj|or|ant|live|test)?-?[A-Za-z0-9_\-]{16,})\b/g, '***REDACTED***')
        .replace(/\bAIza[0-9A-Za-z_\-]{20,}\b/g, '***REDACTED***')
        .replace(/([?&](?:api[_-]?key|key|token)=)[^&\s"']+/gi, '$1***REDACTED***');
}

function _consolePrefix(scope) {
    return scope ? `IIG ${scope.padEnd(LOG_SCOPE_WIDTH)}` : 'IIG';
}

/** Accepts bare levels such as 'INFO' or scoped levels such as 'INFO:api'. */
function iigLog(level, ...args) {
    const [rawLevel, rawScope = ''] = String(level).split(':');
    const lvl = LOG_LEVELS[rawLevel] ? rawLevel : 'INFO';
    const scope = rawScope.slice(0, LOG_SCOPE_WIDTH);

    const timestamp = new Date().toISOString();
    const consoleArgs = args.map(a => redactSensitive(a));
    const message = consoleArgs
        .map(a => typeof a === 'object' ? JSON.stringify(a, (_, value) => typeof value === 'bigint' ? String(value) : value) : String(a))
        .join(' ');

    logBuffer.push(`[${timestamp}] [${lvl}] ${scope ? `[${scope}] ` : ''}${message}`);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }

    if (lvl === 'DEBUG' && !_verboseLogging) return;

    // Mobile webviews print %c and its CSS argument literally, so they get text.
    const p = _consolePrefix(scope);
    const css = LOG_STYLES[lvl];
    if (lvl === 'ERROR') {
        if (IS_MOBILE) console.error(p, ...consoleArgs);
        else console.error(`%c${p}`, css, ...consoleArgs);
    } else if (lvl === 'WARN') {
        if (IS_MOBILE) console.warn(p, ...consoleArgs);
        else console.warn(`%c${p}`, css, ...consoleArgs);
    } else {
        if (IS_MOBILE) console.log(p, ...consoleArgs);
        else console.log(`%c${p}`, css, ...consoleArgs);
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
    toastr.success(sanitizeForHtml(iigT('iig_logsExported')), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
}

// apiType is the single source of truth for request routing — no model-name
// heuristics, no provider auto-detection. Non-standard providers use the
// Advanced path override to replace the auto-appended URL suffix.
const defaultSettings = Object.freeze({
    enabled: true,
    apiType: 'openai',              // 'openai' | 'gemini' | 'naistera'
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'auto',
    maxRetries: 2,                  // auto-retry 429/500/502/503/504 — see RETRYABLE_STATUSES
    retryDelay: 1500,               // base; capped + jittered by computeRetryDelay
    // Prompt-driven: tag JSON wins over UI defaults. Off = UI always applied.
    // Aspect ratio is always tag-driven regardless of this flag.
    promptDriven: true,
    imageSize: '1K',                // Gemini: 1K/2K/4K
    // User toggle for providers or models that reject references.
    geminiSendRefs: true,
    // Naistera
    naisteraPreset: '',             // '' | 'digital' | 'realism' (Grok family)
    naisteraModel: 'grok',          // 'grok' | 'grok-pro' | 'nano banana 2' | 'novelai'
    // User toggle to skip refs regardless of model capability.
    naisteraSendRefs: true,
    // Advanced escape hatches for non-standard providers.
    pathOverride: '',               // replaces the auto-appended URL suffix
    showAllModels: false,           // disable fetchModels() keyword filter
    // API presets are stored with the extension settings.
    presets: [],
    activePresetName: '',
    promptModel: {
        enabled: false,
        connection: 'default',
        model: '',
        tag: 'image_gen',
        gemini: {
            endpoint: '',
            apiKey: '',
            model: '',
            presets: [],
            activePresetName: '',
        },
        snapshot: {
            content: '',
            name: '',
            sourceId: '',
            importedAt: 0,
        },
    },
    // Existing flat fields remain the Global reference container.
    charRef: { name: '', imageBase64: '', imagePath: '', packAssetId: '' },
    userRef: { name: '', imageBase64: '', imagePath: '', packAssetId: '' },
    npcReferences: [],
    characterRefs: {},
    // When true, the char/user ref is sent on every generation regardless of
    // whether its name appears in the prompt. Off = name-gated (like NPCs).
    charRefAlways: false,
    userRefAlways: false,
    cropOnUpload: true,
    // Reference scope:
    //   'global'   — one ref set used in every chat (the fields above).
    //   'per-character' — one set per character card or group.
    //   'per-chat' — chat metadata, inheriting character then global.
    refScope: 'global',
    // Epoch ms of last ref write. Prevents stale localStorage backups from
    // clobbering fresher server state on cross-device use.
    refsUpdatedAt: 0,
    refsFolderClearedAt: 0,
    refsFolderClearExceptions: [],
    // Print DEBUG lines to the console. Export Logs always includes them.
    verboseLogging: false,
    // Low-power mode: master + opt-out sub-toggles (animations off, slower DOM passes).
    lowPowerMode: false,
    lpDisableAnimations: true,
    lpSlowUpdates: true,
});

// Keyword-based image model filter used by fetchModels() suggestions.
const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'nai-diffusion', 'wanx', 'qwen',
];
// Negative filter: these are generation endpoints for other media, and a few
// of them also match an IMAGE_MODEL_KEYWORDS entry. Checked first so they can
// never reach the image dropdown.
const NON_IMAGE_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'gen-3', 'minimax', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo',
];

function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    for (const kw of NON_IMAGE_MODEL_KEYWORDS) if (mid.includes(kw)) return false;
    if (mid.includes('vision') && mid.includes('preview')) return false;
    for (const kw of IMAGE_MODEL_KEYWORDS) if (mid.includes(kw)) return true;
    return false;
}

// Matches native and provider-prefixed GPT Image IDs, including snapshots.
function isGptImageModel(modelId) {
    const id = String(modelId || '').trim().split('/').pop();
    return /^gpt-image-(?:1(?:\.5|-mini)?|2)(?:$|-)/i.test(id)
        || /^chatgpt-image-latest(?:$|-)/i.test(id);
}

function isGptImage2Model(modelId) {
    const id = String(modelId || '').trim().split('/').pop();
    return /^gpt-image-2(?:$|-)/i.test(id);
}

const NOVELAI_RESOLUTIONS = Object.freeze([
    '1024x1024', '1536x1536', '1344x768', '768x1344',
    '1536x1024', '1216x832', '1024x1536', '832x1216',
]);

function isRoutMyNovelAiModel(modelId) {
    return String(modelId || '').trim().toLowerCase().startsWith('novelai/nai-diffusion-');
}

function parseRoutMyNovelAiModel(modelId) {
    const value = String(modelId || '').trim();
    const match = value.match(/^(novelai\/nai-diffusion-.+)-(\d+x\d+)-(s\d+)$/i);
    if (!match) return null;
    return { family: match[1], resolution: match[2].toLowerCase(), steps: match[3] };
}

function resolveRoutMyNovelAiModel(modelId, aspectRatio) {
    const parsed = parseRoutMyNovelAiModel(modelId);
    const ratioMatch = String(aspectRatio || '').match(/^(\d+):(\d+)$/);
    if (!parsed || !ratioMatch) return String(modelId || '').trim();

    const targetRatio = Number(ratioMatch[1]) / Number(ratioMatch[2]);
    if (!Number.isFinite(targetRatio) || targetRatio <= 0) return String(modelId || '').trim();

    let best = NOVELAI_RESOLUTIONS.includes(parsed.resolution)
        ? parsed.resolution
        : NOVELAI_RESOLUTIONS[0];
    let bestDistance = Infinity;
    for (const resolution of [best, ...NOVELAI_RESOLUTIONS]) {
        const [width, height] = resolution.split('x').map(Number);
        const distance = Math.abs(Math.log((width / height) / targetRatio));
        if (distance < bestDistance) {
            best = resolution;
            bestDistance = distance;
        }
    }
    return `${parsed.family}-${best}-${parsed.steps}`;
}

// Naistera upstreams via /api/generate.
const NAISTERA_MODELS = Object.freeze(['grok', 'grok-pro', 'nano banana 2', 'novelai']);

function normalizeNaisteraModel(model) {
    const raw = String(model || '').trim().toLowerCase();
    if (!raw) return 'grok';
    if (raw === 'grok pro' || raw === 'grok-imagine-pro' || raw === 'imagine-pro') return 'grok-pro';
    if (raw === 'nano-banana' || raw === 'nano banana'
        || raw === 'nano-banana-pro' || raw === 'nano banana pro'
        || raw === 'nano-banana-2' || raw === 'nano banana 2') {
        return 'nano banana 2';
    }
    if (raw === 'novel ai' || raw === 'novel-ai') return 'novelai';
    if (NAISTERA_MODELS.includes(raw)) return raw;
    return 'grok';
}

function naisteraModelSupportsReferences(model) {
    const normalized = normalizeNaisteraModel(model);
    return normalized !== 'novelai' && normalized !== 'grok-pro';
}

// Presets apply to the Grok family; nano banana 2 and novelai ignore them.
function naisteraModelSupportsPreset(model) {
    const normalized = normalizeNaisteraModel(model);
    return normalized === 'grok' || normalized === 'grok-pro';
}

// Wire values stay canonical (Naistera-accepted); labels get capitalized for UI.
function naisteraModelDisplayLabel(canonical) {
    switch (canonical) {
        case 'grok':          return 'Grok';
        case 'grok-pro':      return 'Grok Pro';
        case 'nano banana 2': return 'Nano Banana 2';
        case 'novelai':       return 'NovelAI';
        default:              return canonical;
    }
}

const DEFAULT_ENDPOINTS = Object.freeze({
    naistera: 'https://naistera.org',
});

/**
 * Normalize the user-configured endpoint for a given API type.
 * Strips trailing slashes, strips known auto-appended suffixes
 * (/api/generate, /v1/images/generations, /v1/images/edits,
 * /v1beta/models/...) so users
 * who paste the full documented path still end up with the right base
 * URL. Defaults to naistera.org if empty under apiType='naistera'.
 */
function normalizeConfiguredEndpoint(apiType, endpoint) {
    const trimmed = String(endpoint || '').trim().replace(/\/+$/, '');
    if (!trimmed) {
        return apiType === 'naistera' ? DEFAULT_ENDPOINTS.naistera : '';
    }
    if (apiType === 'naistera') {
        return trimmed.replace(/\/api\/generate$/i, '');
    }
    if (apiType === 'openai') {
        return trimmed.replace(/\/v1\/images\/(?:generations|edits)$/i, '')
                      .replace(/\/v1\/models$/i, '');
    }
    if (apiType === 'gemini') {
        return trimmed.replace(/\/v1beta\/models(\/[^?]*)?$/i, '');
    }
    return trimmed;
}

// True if the current endpoint clearly belongs to a different API's
// convention and keeping it would break the newly-selected type. Also fires
// when switching AWAY from Naistera so a stale naistera.org doesn't leak.
function shouldReplaceEndpointForApiType(apiType, endpoint) {
    const trimmed = String(endpoint || '').trim();
    if (!trimmed) return true;

    const looksLikeNaistera = /naistera\.org/i.test(trimmed) || /\/api\/generate\/?$/i.test(trimmed);
    const looksLikeOpenAI = /\/v1\/images\/generations\/?$/i.test(trimmed)
                            || /\/v1\/models\/?$/i.test(trimmed);
    const looksLikeGemini = /\/v1beta\/models\//i.test(trimmed);

    if (apiType === 'naistera') {
        return looksLikeOpenAI || looksLikeGemini;
    }
    if (looksLikeNaistera) {
        return true;
    }
    if (apiType === 'openai' && looksLikeGemini) return true;
    if (apiType === 'gemini' && looksLikeOpenAI) return true;
    return false;
}

function getEffectiveEndpoint(settings) {
    if (!settings) settings = getSettings();
    return normalizeConfiguredEndpoint(settings.apiType, settings.endpoint);
}

function getNaisteraGenerationUrl(settings) {
    const endpoint = getEffectiveEndpoint(settings);
    return endpoint.endsWith('/api/generate') ? endpoint : `${endpoint}/api/generate`;
}

// One plaintext-endpoint warning per session — a nag on every generation would
// train users to ignore it.
let _warnedPlaintextEndpoint = false;

function isLoopbackHostname(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost'
        || h.endsWith('.localhost')
        || h === '::1'
        || h === '0.0.0.0'
        || /^127\./.test(h);
}

/**
 * Shape-check a configured endpoint. The API key is attached to every request
 * to this host, so an unparseable or non-HTTP value must not silently become a
 * request.
 *
 * Returns an error string for validateSettings, or null when acceptable.
 *
 * Plain http:// to a NON-loopback host is deliberately NOT an error — it logs
 * one WARN per session and proceeds. Rejecting it outright breaks local
 * proxies and A1111-style setups.
 */
function validateEndpointShape(endpoint) {
    const raw = String(endpoint || '').trim();
    if (!raw) return 'Endpoint URL not configured';

    // Resolve against the page so a same-origin relative base ("/proxy") stays
    // valid — same tactic endpointNeedsGoogleHeader already uses.
    let parsed;
    try {
        parsed = new URL(raw, window.location.href);
    } catch (_) {
        return `Endpoint is not a valid URL: ${raw}`;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `Endpoint must use http:// or https:// (got "${parsed.protocol}")`;
    }
    if (parsed.href.includes('?') || parsed.href.includes('#') || parsed.username || parsed.password) {
        return 'Use a base endpoint without credentials, query parameters or fragments';
    }

    if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname) && !_warnedPlaintextEndpoint) {
        _warnedPlaintextEndpoint = true;
        iigLog('WARN', `Endpoint uses plaintext http:// to a remote host (${parsed.hostname}); your API key is sent unencrypted. Use https:// unless this is a local proxy.`);
    }

    return null;
}

// =========================================================================
// Provider quirk memo
// =========================================================================
//
// Session-only request-shape memo, keyed by API type and normalized endpoint.
// Keeping the full endpoint distinguishes bare and /compatible Gemini routes.
const _providerQuirks = new Map();
const PROVIDER_QUIRK_CAP = 8;

function providerQuirkKey(settings) {
    const apiType = settings?.apiType || '';
    return `${apiType}|${normalizeConfiguredEndpoint(apiType, settings?.endpoint)}`;
}

function getProviderQuirks(settings) {
    return _providerQuirks.get(providerQuirkKey(settings)) || {};
}

function setProviderQuirk(settings, quirk, value) {
    const key = providerQuirkKey(settings);
    const existing = _providerQuirks.get(key);
    // Re-insert to refresh LRU position (Map preserves insertion order).
    if (existing) _providerQuirks.delete(key);
    else if (_providerQuirks.size >= PROVIDER_QUIRK_CAP) {
        const oldest = _providerQuirks.keys().next().value;
        if (oldest !== undefined) _providerQuirks.delete(oldest);
    }
    _providerQuirks.set(key, { ...(existing || {}), [quirk]: value });
    iigLog('DEBUG:api', `Provider quirk learned for this session: ${quirk}=${value} (${key})`);
}

/** Drop request-shape memos after provider changes or preset loads. */
function clearProviderQuirks(reason) {
    if (_providerQuirks.size === 0) return;
    _providerQuirks.clear();
    iigLog('DEBUG:api', `Provider quirk memo cleared (${reason})`);
}

// =========================================================================
// API Presets — named snapshots of API-config fields
// =========================================================================

// Only API-routing fields. Generation params / refs / retries stay on live
// settings so switching providers doesn't wipe unrelated preferences.
const PRESET_FIELDS = Object.freeze([
    'apiType',
    'endpoint',
    'apiKey',
    'model',
    'pathOverride',
    'showAllModels',
    'naisteraModel',
    'naisteraSendRefs',
    'geminiSendRefs',
]);

function snapshotApiConfig(settings) {
    const snap = {};
    for (const f of PRESET_FIELDS) snap[f] = settings[f] ?? '';
    return snap;
}

// Missing fields fall back to '' so a partially-populated preset still applies cleanly.
function applyPresetToSettings(settings, preset) {
    for (const f of PRESET_FIELDS) {
        settings[f] = preset[f] ?? '';
    }
    // Presets can change provider and endpoint together.
    clearProviderQuirks('preset loaded');
}

// Case-sensitive name lookup; empty name is not valid.
function findPreset(settings, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    const presets = Array.isArray(settings.presets) ? settings.presets : [];
    return presets.find(p => p && p.name === trimmed) || null;
}

// Google's native Gemini REST API requires x-goog-api-key; aggregators (rout.my,
// linkapi, etc.) speak Bearer only and some reject requests with the Google
// header attached. Hostname check is the single brand-specific branch here.
function endpointNeedsGoogleHeader(endpoint) {
    try {
        const h = new URL(endpoint, window.location.href).hostname.toLowerCase();
        return h.endsWith('googleapis.com');
    } catch (_) {
        return false;
    }
}

/** Encode model-ID segments while preserving provider-prefix slashes; reject traversal. */
function encodeModelForPath(model) {
    const raw = String(model || '');
    const segments = raw.split('/');
    if (segments.some(s => s === '' || s === '.' || s === '..')) {
        throw iigError(`Invalid model id for URL path: ${raw}`, 'iig_modelPathInvalid', { model: raw });
    }
    return segments.map(encodeURIComponent).join('/');
}

/**
 * True if a base URL already carries a `/compatible` path segment.
 *
 * Matches on the PATH only. A hostname like `compatible.example.com` or a
 * query string containing the word must not count, or the Gemini probe would
 * skip a provider that actually needs the prefix. Segment-anchored so
 * `/compatibility` does not match either.
 */
function endpointHasCompatiblePrefix(base) {
    let path;
    try {
        path = new URL(base, window.location.href).pathname;
    } catch (_) {
        // Unparseable bases never reach the wire (validateEndpointShape rejects
        // them first); assume the prefix is present so the probe stays quiet.
        return true;
    }
    return /(^|\/)compatible(\/|$)/i.test(path);
}

// OpenAI Images lives outside a terminal Gemini `/compatible` namespace.
// Preserve the configured host (including mirrors), port and preceding path.
function openAIBaseFromEndpoint(endpoint) {
    const original = String(endpoint || '').trim();
    if (!original) return original;
    try {
        const url = new URL(original, window.location.href);
        if (!/\/compatible\/?$/i.test(url.pathname)) return original;
        url.pathname = url.pathname.replace(/\/compatible\/?$/i, '') || '/';
        let result = url.toString();
        if (url.pathname === '/') result = result.replace(/\/(?=[?#]|$)/, '');
        return result;
    } catch (_) {
        return original;
    }
}

// Build full request URL from base + suffix. settings.pathOverride replaces
// the default suffix entirely when set.
function buildApiUrl(settings, defaultSuffix, modelForSuffix) {
    const base = getEffectiveEndpoint(settings);
    let suffix = (settings.pathOverride || '').trim();
    if (!suffix) {
        suffix = defaultSuffix.replace('{model}', modelForSuffix || '');
    } else if (!suffix.startsWith('/')) {
        suffix = '/' + suffix;
    }
    return `${base}${suffix}`;
}

function getSettings() {
    const context = getContext() || SillyTavern.getContext();

    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
        }
    }

    // Normalize the Naistera model name at read-time.
    const s = context.extensionSettings[MODULE_NAME];
    if (!s.promptModel || typeof s.promptModel !== 'object' || Array.isArray(s.promptModel)) {
        s.promptModel = structuredClone(defaultSettings.promptModel);
    }
    for (const key of Object.keys(defaultSettings.promptModel)) {
        if (!Object.hasOwn(s.promptModel, key)) {
            s.promptModel[key] = structuredClone(defaultSettings.promptModel[key]);
        }
    }
    if (!s.promptModel.snapshot || typeof s.promptModel.snapshot !== 'object' || Array.isArray(s.promptModel.snapshot)) {
        s.promptModel.snapshot = structuredClone(defaultSettings.promptModel.snapshot);
    }
    for (const key of Object.keys(defaultSettings.promptModel.snapshot)) {
        if (!Object.hasOwn(s.promptModel.snapshot, key)) {
            s.promptModel.snapshot[key] = defaultSettings.promptModel.snapshot[key];
        }
    }
    if (!s.promptModel.gemini || typeof s.promptModel.gemini !== 'object' || Array.isArray(s.promptModel.gemini)) {
        s.promptModel.gemini = structuredClone(defaultSettings.promptModel.gemini);
    }
    for (const key of Object.keys(defaultSettings.promptModel.gemini)) {
        if (!Object.hasOwn(s.promptModel.gemini, key)) {
            s.promptModel.gemini[key] = structuredClone(defaultSettings.promptModel.gemini[key]);
        }
    }
    s.promptModel.connection = s.promptModel.connection === 'gemini' ? 'gemini' : 'default';
    if (!Array.isArray(s.promptModel.gemini.presets)) s.promptModel.gemini.presets = [];
    if (typeof s.naisteraModel === 'string') {
        const canonical = normalizeNaisteraModel(s.naisteraModel);
        if (canonical !== s.naisteraModel) s.naisteraModel = canonical;
    }
    if (!s.characterRefs || typeof s.characterRefs !== 'object' || Array.isArray(s.characterRefs)) {
        s.characterRefs = {};
    }
    if (!Array.isArray(s.refsFolderClearExceptions)) s.refsFolderClearExceptions = [];
    s.refScope = normalizeRefScope(s.refScope);

    setVerboseLogging(s.verboseLogging);

    return s;
}

// One-time migration of inline base64 references to server files.
async function migrateBase64Refs() {
    if (_iigDisposed) return;
    const settings = getSettings();
    if (settings._migratedBase64_v260) return;

    iigLog('DEBUG:init', 'Reference data migration: starting scan for legacy base64 fields');

    let migratedPathPlusB64 = 0;
    let migratedB64OnlyOk = 0;
    let migratedB64OnlyFail = 0;
    let totalBytesStripped = 0;

    const processRef = async (ref, label) => {
        if (_iigDisposed || !ref) return;
        const b64 = ref.imageBase64 || ref.imageData || '';
        if (!b64) return;

        if (ref.imagePath) {
            totalBytesStripped += b64.length;
            ref.imageBase64 = '';
            if ('imageData' in ref) ref.imageData = '';
            iigLog('DEBUG:refs', `  ${label}: had path + ${b64.length} b64 chars → stripped base64 (path kept: ${ref.imagePath})`);
            migratedPathPlusB64++;
        } else {
            try {
                const path = await saveRefImageToFile(b64, label);
                if (_iigDisposed) return;
                ref.imagePath = path;
                ref.imageBase64 = '';
                if ('imageData' in ref) ref.imageData = '';
                totalBytesStripped += b64.length;
                iigLog('DEBUG:refs', `  ${label}: migrated ${b64.length} b64 chars → ${path}`);
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
    if (!_iigDisposed) settings._migratedBase64_v260 = true;
    saveSettings({ sync: true });

    const total = migratedPathPlusB64 + migratedB64OnlyOk + migratedB64OnlyFail;
    if (total === 0) {
        iigLog('DEBUG:init', 'Reference data migration: no legacy base64 found, clean install');
    } else {
        iigLog('INFO', `Reference data migration complete: ${migratedPathPlusB64} path+b64 stripped, ${migratedB64OnlyOk} b64→path uploaded, ${migratedB64OnlyFail} failed; ${totalBytesStripped} total b64 chars removed from settings`);
    }
}

// Optional synchronous hook exposed by some host versions.
let _stSaveSettings = null;
let _stSaveSettingsCaptured = false;

// opts.sync === true: non-debounced write + immediate localStorage flush.
// Used by mobile visibilitychange/pagehide and explicit settings mutations.
// Default: debounced — input-event handlers call this per keystroke.
function saveSettings(opts) {
    const sync = !!(opts && opts.sync);
    const reportFailure = error => iigLog('WARN', 'Settings save failed:', error);

    if (!_stSaveSettingsCaptured || _stSaveSettings === null) {
        const candidate = window.saveSettings;
        if (typeof candidate === 'function' && candidate !== saveSettings) {
            _stSaveSettings = candidate;
        }
        _stSaveSettingsCaptured = true;
    }

    const context = getContext();

    if (sync) {
        if (typeof _stSaveSettings === 'function' && _stSaveSettings !== saveSettings) {
            try { trackIigTask(Promise.resolve(_stSaveSettings()).catch(reportFailure)); }
            catch(e) { trackIigTask(Promise.resolve(context.saveSettingsDebounced()).catch(reportFailure)); }
        } else {
            trackIigTask(Promise.resolve(context.saveSettingsDebounced()).catch(reportFailure));
        }
        persistRefsToLocalStorage({ sync: true });
    } else {
        trackIigTask(Promise.resolve(context.saveSettingsDebounced()).catch(reportFailure));
        schedulePersistRefsToLocalStorage();
    }
}

function persistIigMetadata(context) {
    trackIigTask(context?.saveMetadata?.()).catch(error => iigLog('WARN', 'Reference metadata save failed:', error));
}

// =========================================================================
// ⊹ PROMPT MODEL ⊹
// =========================================================================

const PROMPT_MODEL_TIMEOUT_MS = 120000;
const PROMPT_MODEL_TEST_TIMEOUT_MS = 30000;
const PROMPT_MODEL_TAG_DEFAULT = 'image_gen';
const PROMPT_MODEL_GUIDANCE_KEY = 'iig_prompt_model_guidance';

const IIG_MESSAGES_I18N = {
    en: {
        title: 'Image Generation',
        cleanupEditActive: 'Finish or cancel the open Prompt Model message edit before stopping or replacing Image Generation. Your draft has not been changed.',
        cleanupTimedOut: 'Image Generation cleanup is still waiting for pending work or saves. Replacement remains blocked to protect your data. Wait for them to finish, then retry cleanup.',
        logsExported: 'Logs exported',
        grokRefsUnavailable: 'Grok refs unavailable right now - generating without references',
        unsafeImageUrl: 'Refusing to open an unsafe image URL',
        unsafeDownloadUrl: 'Refusing to download an unsafe URL',
        downloading: 'Downloading...',
        imageOpened: 'Image opened - long-press to save',
        imageDownloaded: 'Image downloaded',
        downloadFailed: 'Download failed: {error}',
        instructionMissing: 'No generation instruction found on this image',
        parentMessageMissing: 'Could not find parent message',
        instructionParseFailed: 'Failed to parse image instruction',
        imageRegenerated: 'Image regenerated',
        generationStopped: 'Generation stopped',
        stoppedRetry: 'Generation stopped - click retry',
        sourceChanged: 'Image source changed; regeneration was not applied.',
        chatSaveFailed: 'Image generated, but the chat could not be saved.',
        generationError: 'Generation error',
        error: 'Error: {error}',
        generationFailed: 'Generation error: {error}',
        regenerationFailed: 'Regeneration failed: {error}',
        tagsFound: 'Found {count} tag(s). Generating...',
        messageElementMissing: 'Could not find message element',
        imageReady: 'Image {index}/{count} ready',
        messageMissing: 'Message not found',
        noTags: 'No tags to regenerate',
        regeneratingImages: 'Regenerating {count} image(s)...',
        photoSaved: 'Photo saved to server',
        cropTitle: 'Crop image',
        cropFailed: 'Could not crop the image',
        photoUploadFailed: 'Photo upload failed: {error}',
        slotCleared: 'Slot cleared',
        session: 'Session: {counts}',
        generatedCount: '{count} generated',
        failedCount: '{count} failed',
        noMatchingModels: 'No matching models',
        loadModels: 'Load models to show suggestions',
        modelsShowing: 'Showing {limit} of {count}; type to narrow the list',
        bytes: 'B',
        kilobytes: 'KB',
        megabytes: 'MB',
        gigabytes: 'GB',
        refStorageStale: 'Reference storage changed - check again.',
        regenerate: 'Regenerate',
        regenerateImage: 'Regenerate image',
        regenerateImages: 'Regenerate images',
        openToSave: 'Open image to save',
        download: 'Download',
        downloadImage: 'Download image',
        retry: 'Retry',
        retryImage: 'Retry image generation',
        imageDetails: 'Style: {style}\nPrompt: {prompt}',
        generatingImage: 'Generating image...',
        generating: 'Generating...',
        generatingRetry: 'Generating (retry {attempt})...',
        generatingRetryCount: 'Generating (retry {attempt}/{count})...',
        retryDelay: 'Retrying in {seconds}s...',
        saving: 'Saving...',
        stopGeneration: 'Stop generation',
        stop: 'Stop',
        stopping: 'Stopping...',
        timeout: 'Timeout...',
        fullSizePreview: 'Full-size preview',
        close: 'Close',
        closeViewer: 'Close image viewer',
        generationEnabled: 'Generation enabled',
        generationDisabled: 'Generation disabled',
        settingsError: 'Settings error: {errors}',
        endpointMissing: 'Endpoint URL not configured',
        endpointInvalid: 'Endpoint is not a valid URL: {endpoint}',
        endpointProtocol: 'Endpoint must use http:// or https:// (got "{protocol}")',
        endpointBaseOnly: 'Use a base endpoint without credentials, query parameters or fragments.',
        apiKeyMissing: 'API key not configured',
        modelMissing: 'Model not selected',
        modelPathInvalid: 'Invalid model id for URL path: {model}',
        novelAiModelInvalid: 'NovelAI requires a full model ID ending in -WIDTHxHEIGHT-sSTEPS',
        naisteraModelInvalid: 'Select Naistera model: Grok / Grok Pro / Nano Banana 2 / NovelAI',
        unknownApiType: 'Unknown apiType: {apiType}',
        upstreamUnavailable: 'Provider upstream unavailable ({status}). Retry in a minute.',
        imageRequestFailed: 'Image request failed ({status})',
        downloadTypeInvalid: 'Unexpected download type: {type}',
        imageDownloadLimit: 'Image download is too large or streaming is unavailable (maximum 32 MB).',
        imageUrlInvalid: 'Invalid image URL.',
        noFile: 'No file provided',
        refFolderClearing: 'Reference folder is being cleared',
        imageSourceMissing: 'Could not identify the selected image source',
        hintTitle: 'Image Generation - hint',
        hintOpenai404: 'Endpoint returned 404. If your provider speaks the Gemini protocol, try switching API Type to "Gemini-compatible".',
        hintGemini404Probed: 'Endpoint returned 404 on the standard Gemini path and on /compatible. Check the Endpoint URL against your provider\'s docs, confirm the model ID exists, or switch API Type to "OpenAI-compatible".',
        hintGemini404: 'Endpoint returned 404. Check the Endpoint URL against your provider\'s docs and confirm the model ID exists, or switch API Type to "OpenAI-compatible".',
        hintAuth: 'Authentication rejected (HTTP {status}). Verify your API key, and make sure it belongs to the provider at this endpoint.',
        hintGptImageApi: 'GPT Image uses the OpenAI Images API on this endpoint. Select "OpenAI-compatible" and use the base Endpoint URL without /compatible.',
        hintGeminiBody: 'Provider rejected the Gemini request body. Switch API Type to "OpenAI-compatible".',
        hintGptQuality: 'GPT Image quality accepts low, medium, high, or auto. Retry.',
        hintOpenaiField: 'Provider rejected an OpenAI-specific field. Switch API Type to "Gemini-compatible".',
        hintUpstream: 'Provider upstream returned {status}. Retry in a minute.',
        hintNetwork: 'Network/CORS error. Check that your Endpoint URL is reachable from SillyTavern and allows cross-origin requests.',
        hintSafetyRequest: 'Provider safety filter rejected this request. Rephrase the prompt, or turn off Send reference images.',
        hintSafetyImage: 'Provider safety filter rejected this prompt or image. Rephrase the prompt, or turn off reference images.',
        hintNoImage: 'Provider returned a response without an image. Rephrase the prompt or retry.',
        hintUnknownShape: 'Provider returned an unexpected response shape. Open Export Logs; the response keys are recorded as a WARN entry.',
        hintGptAccess: 'Provider rejected the request before inference. Verify gpt-image-2 is enabled on your provider plan and that the key has access.',
        hintEmptyEnvelope: 'Provider returned an empty envelope after recovery. Verify the model is enabled on your provider plan.',
        hintErrorEnvelope: 'Provider returned an error envelope (HTTP 200 with error body). Check API key scope, quota, and whether the selected model is enabled on your account.',
    },
    ru: {
        title: 'Генерация изображений',
        cleanupEditActive: 'Завершите или отмените открытое редактирование сообщения модели промпта перед остановкой или заменой расширения генерации изображений. Ваш черновик не изменён.',
        cleanupTimedOut: 'Очистка расширения генерации изображений всё ещё ожидает завершения операций или сохранений. Замена остаётся заблокированной для защиты данных. Дождитесь их завершения и повторите очистку.',
        logsExported: 'Логи экспортированы',
        grokRefsUnavailable: 'Референсы Grok сейчас недоступны - генерация без референсов',
        unsafeImageUrl: 'Небезопасный URL изображения не будет открыт',
        unsafeDownloadUrl: 'Скачивание по небезопасному URL запрещено',
        downloading: 'Скачивание...',
        imageOpened: 'Изображение открыто - удерживайте его для сохранения',
        imageDownloaded: 'Изображение скачано',
        downloadFailed: 'Не удалось скачать: {error}',
        instructionMissing: 'У этого изображения нет инструкции генерации',
        parentMessageMissing: 'Не удалось найти исходное сообщение',
        instructionParseFailed: 'Не удалось разобрать инструкцию изображения',
        imageRegenerated: 'Изображение создано заново',
        generationStopped: 'Генерация остановлена',
        stoppedRetry: 'Генерация остановлена - нажмите для повтора',
        sourceChanged: 'Источник изображения изменился; результат повторной генерации не применен.',
        chatSaveFailed: 'Изображение создано, но не удалось сохранить чат.',
        generationError: 'Ошибка генерации',
        error: 'Ошибка: {error}',
        generationFailed: 'Ошибка генерации: {error}',
        regenerationFailed: 'Не удалось создать заново: {error}',
        tagsFound: 'Найдено тегов: {count}. Генерация...',
        messageElementMissing: 'Не удалось найти элемент сообщения',
        imageReady: 'Изображение {index}/{count} готово',
        messageMissing: 'Сообщение не найдено',
        noTags: 'Нет тегов для повторной генерации',
        regeneratingImages: 'Повторная генерация изображений: {count}...',
        photoSaved: 'Фото сохранено на сервере',
        cropTitle: 'Обрезать изображение',
        cropFailed: 'Не удалось обрезать изображение',
        photoUploadFailed: 'Не удалось загрузить фото: {error}',
        slotCleared: 'Слот очищен',
        session: 'За сеанс: {counts}',
        generatedCount: 'создано: {count}',
        failedCount: 'ошибок: {count}',
        noMatchingModels: 'Подходящие модели не найдены',
        loadModels: 'Загрузите модели для показа подсказок',
        modelsShowing: 'Показано {limit} из {count}; введите текст для уточнения списка',
        bytes: 'Б',
        kilobytes: 'КБ',
        megabytes: 'МБ',
        gigabytes: 'ГБ',
        refStorageStale: 'Хранилище референсов изменилось - проверьте снова.',
        regenerate: 'Создать заново',
        regenerateImage: 'Создать изображение заново',
        regenerateImages: 'Создать изображения заново',
        openToSave: 'Открыть изображение для сохранения',
        download: 'Скачать',
        downloadImage: 'Скачать изображение',
        retry: 'Повторить',
        retryImage: 'Повторить генерацию изображения',
        imageDetails: 'Стиль: {style}\nПромпт: {prompt}',
        generatingImage: 'Генерация изображения...',
        generating: 'Генерация...',
        generatingRetry: 'Генерация (повтор {attempt})...',
        generatingRetryCount: 'Генерация (повтор {attempt}/{count})...',
        retryDelay: 'Повтор через {seconds} с...',
        saving: 'Сохранение...',
        stopGeneration: 'Остановить генерацию',
        stop: 'Стоп',
        stopping: 'Остановка...',
        timeout: 'Время ожидания истекло...',
        fullSizePreview: 'Полноразмерный просмотр',
        close: 'Закрыть',
        closeViewer: 'Закрыть просмотр изображения',
        generationEnabled: 'Генерация включена',
        generationDisabled: 'Генерация выключена',
        settingsError: 'Ошибка настроек: {errors}',
        endpointMissing: 'URL endpoint не настроен',
        endpointInvalid: 'Некорректный URL endpoint: {endpoint}',
        endpointProtocol: 'Endpoint должен использовать http:// или https:// (указано "{protocol}")',
        endpointBaseOnly: 'Укажите базовый адрес без учётных данных, параметров запроса и фрагментов.',
        apiKeyMissing: 'API-ключ не настроен',
        modelMissing: 'Модель не выбрана',
        modelPathInvalid: 'Недопустимый ID модели для пути URL: {model}',
        novelAiModelInvalid: 'NovelAI требует полный ID модели с окончанием -WIDTHxHEIGHT-sSTEPS',
        naisteraModelInvalid: 'Выберите модель Naistera: Grok / Grok Pro / Nano Banana 2 / NovelAI',
        unknownApiType: 'Неизвестный тип API: {apiType}',
        upstreamUnavailable: 'Сервер провайдера недоступен ({status}). Повторите через минуту.',
        imageRequestFailed: 'Не удалось запросить изображение ({status})',
        downloadTypeInvalid: 'Неожиданный тип скачанного файла: {type}',
        imageDownloadLimit: 'Изображение слишком большое или потоковая загрузка недоступна (максимум 32 МБ).',
        imageUrlInvalid: 'Некорректный адрес изображения.',
        noFile: 'Файл не выбран',
        refFolderClearing: 'Папка референсов очищается',
        imageSourceMissing: 'Не удалось определить источник выбранного изображения',
        hintTitle: 'Генерация изображений - подсказка',
        hintOpenai404: 'Endpoint вернул 404. Если провайдер использует протокол Gemini, попробуйте тип API "Gemini-совместимый".',
        hintGemini404Probed: 'Endpoint вернул 404 на стандартном пути Gemini и на /compatible. Сверьте URL endpoint с документацией провайдера, проверьте ID модели или выберите тип API "OpenAI-совместимый".',
        hintGemini404: 'Endpoint вернул 404. Сверьте URL endpoint с документацией провайдера и проверьте ID модели или выберите тип API "OpenAI-совместимый".',
        hintAuth: 'Авторизация отклонена (HTTP {status}). Проверьте API-ключ и убедитесь, что он принадлежит провайдеру этого endpoint.',
        hintGptImageApi: 'GPT Image использует OpenAI Images API на этом endpoint. Выберите "OpenAI-совместимый" и укажите базовый URL endpoint без /compatible.',
        hintGeminiBody: 'Провайдер отклонил тело запроса Gemini. Выберите тип API "OpenAI-совместимый".',
        hintGptQuality: 'Качество GPT Image принимает значения low, medium, high или auto. Повторите запрос.',
        hintOpenaiField: 'Провайдер отклонил поле OpenAI. Выберите тип API "Gemini-совместимый".',
        hintUpstream: 'Сервер провайдера вернул {status}. Повторите через минуту.',
        hintNetwork: 'Ошибка сети/CORS. Проверьте доступность URL endpoint из SillyTavern и разрешение межсайтовых запросов.',
        hintSafetyRequest: 'Фильтр безопасности провайдера отклонил запрос. Переформулируйте промпт или отключите отправку референсов.',
        hintSafetyImage: 'Фильтр безопасности провайдера отклонил промпт или изображение. Переформулируйте промпт или отключите референсы.',
        hintNoImage: 'Провайдер вернул ответ без изображения. Переформулируйте промпт или повторите запрос.',
        hintUnknownShape: 'Провайдер вернул ответ неожиданной структуры. Экспортируйте логи: ключи ответа записаны в строке WARN.',
        hintGptAccess: 'Провайдер отклонил запрос до генерации. Проверьте, что gpt-image-2 доступна в вашем тарифе и для этого ключа.',
        hintEmptyEnvelope: 'После попытки восстановления провайдер вернул пустой ответ. Проверьте доступность модели в вашем тарифе.',
        hintErrorEnvelope: 'Провайдер вернул ошибку в теле ответа с HTTP 200. Проверьте права API-ключа, квоту и доступность выбранной модели в аккаунте.',
    },
};

const PROMPT_MODEL_I18N = {
    en: {
        title: 'Prompt Model',
        enabled: 'Use separate prompt model',
        offHint: 'Off: the main model writes image blocks.',
        notChatCompletion: 'Prompt Model requires the Chat Completion API.',
        provider: 'Provider',
        main: 'Main',
        connection: 'Connection',
        defaultConnection: 'Default (SillyTavern)',
        geminiConnection: 'Gemini-compatible',
        geminiHint: 'Uses this connection only for Prompt Model requests.',
        geminiEndpoint: 'Base endpoint',
        geminiEndpointPlaceholder: 'https://your-provider.example',
        geminiApiKey: 'API key',
        geminiModel: 'Model ID',
        geminiPresets: '-- Gemini presets --',
        saveGeminiPreset: 'Save Gemini preset',
        deleteGeminiPreset: 'Delete selected Gemini preset',
        presetLimit: 'You can save up to 20 Gemini presets. Delete one before adding another.',
        connectionRecovered: 'The selected Gemini preset no longer exists. Using the current connection fields.',
        geminiEndpointRequired: 'Set the Prompt Model Gemini endpoint first.',
        geminiEndpointBaseOnly: 'Use a base endpoint without query parameters or fragments.',
        geminiKeyRequired: 'Set the Prompt Model Gemini API key first.',
        geminiModelRequired: 'Set the Prompt Model model ID first.',
        testConnection: 'Test connection',
        connectionOk: 'Connection OK.',
        connectionOkBlocked: 'Connection OK, but the provider blocked the test prompt.',
        connectionOkNoText: 'Connection OK, but the model returned no text for the test prompt.',
        connectionInvalidResponse: 'The provider returned an invalid Gemini response.',
        connectionTimedOut: 'Connection test timed out.',
        model: 'Model',
        promptTag: 'Prompt tag',
        reset: 'Reset',
        import: 'Import prompt...',
        imported: 'Imported',
        nothingImported: 'Nothing imported',
        preview: 'Preview',
        sourceMissing: 'source not in this preset',
        importTitle: 'Import image prompt',
        importHint: 'Select a matching preset prompt. Nothing changes until you confirm.',
        noMatches: 'No matching prompts were found in the current preset.',
        importConfirm: 'Import & disable in preset',
        cancel: 'Cancel',
        importedToast: 'Prompt imported and disabled in the preset.',
        adoptedToast: 'Prompt Model adopted "{name}" from the preset.',
        needSnapshot: 'Import a prompt before enabling Prompt Model.',
        sourceDeleted: 'Source prompt deleted - enable one manually in the Prompt Manager.',
        chooseModel: 'Choose a prompt model before enabling Prompt Model.',
        showModels: 'Show or hide model list',
        refreshModels: 'Refresh model list',
        composing: 'composing image...',
        stop: 'Stop',
        stopping: 'Stopping...',
        stopped: 'Prompt composition stopped.',
        retry: 'Retry prompt model',
        reroll: 'Rewrite prompt + regenerate this image',
        guidanceButton: 'Image guidance',
        guidanceActive: 'Image guidance active',
        guidanceTitle: 'Prompt Model guidance',
        guidanceIntro: 'This direction is sent only to the separate prompt model. The main narrative model never sees it.',
        guidanceLabel: 'Persistent guidance for this chat',
        guidancePlaceholder: 'Example: Focus on the doorway confrontation. Use a wide horizontal composition and keep Ace in frame.',
        guidancePersistence: 'Stays active for this chat until you clear it.',
        guidanceSet: 'Active',
        guidanceEmpty: 'Not set',
        guidanceLocationHint: 'Use OOC for directions only the prompt model should see.',
        guidanceApply: 'Apply guidance',
        guidanceClear: 'Clear',
        guidanceSaved: 'Image guidance saved for this chat.',
        guidanceCleared: 'Image guidance cleared.',
        guidanceUnavailable: 'Enable Prompt Model to use image-only guidance.',
        selectedPromptMissing: 'Selected prompt no longer exists',
        modelStatusError: 'Model status returned {status}',
        catalogFailed: 'Could not load the model catalog.',
        catalogHttpError: 'Model catalog request failed (HTTP {status})',
        catalogUnavailable: 'No model catalog endpoint responded',
        noRequestText: 'Prompt Model request has no text content',
        providerError: 'Prompt Model provider error: {detail}',
        providerBlocked: 'Prompt blocked by provider: {reason}',
        noResponseText: 'Prompt Model returned no text',
        noResponseTextReason: 'Prompt Model returned no text (finishReason={reason})',
        apiError: 'Prompt Model API error ({status}): {detail}',
        requestTimedOut: 'Prompt Model request timed out',
        requestAborted: 'Prompt Model request aborted',
        requestFailed: 'Prompt Model request failed',
        errorDetail: 'Operation failed: {detail}',
        contextUnavailable: 'The exact generation context is no longer available',
        sanitizerUnavailable: 'DOMPurify is unavailable; Prompt Model output cannot be safely processed',
        imageBlockMissing: 'Response did not contain an IIG image block',
        pendingTagMissing: 'Response contained no valid pending image tag',
        instructionPromptMissing: 'Image instruction is missing a prompt',
        singleBlockRequired: 'Response must contain exactly one pending IIG image block',
        failed: 'Prompt Model failed',
        rerollContextChanged: 'Prompt reroll context changed',
        mainModelMissing: 'No current Chat Completion model is selected',
        imageSourceChanged: 'Selected image source changed before replacement',
        editSanitizerUnavailable: 'DOMPurify is unavailable; edited sidecar cannot be safely processed',
        editFailed: 'Could not safely process the edited image block; your edit was not applied.',
        copyConfirm: 'Create a copy of this message with its edited image block?',
        copyFailed: 'Could not complete the message copy.',
        endpointInvalid: 'Set a valid HTTP or HTTPS endpoint for Prompt Model.',
    },
    ru: {
        title: 'Модель промпта',
        enabled: 'Использовать отдельную модель промпта',
        offHint: 'Выкл.: блоки изображений пишет основная модель.',
        notChatCompletion: 'Модель промпта работает только с Chat Completion API.',
        provider: 'Провайдер',
        main: 'Основная',
        connection: 'Подключение',
        defaultConnection: 'По умолчанию (SillyTavern)',
        geminiConnection: 'Gemini-совместимое',
        geminiHint: 'Это подключение используется только для запросов модели промпта.',
        geminiEndpoint: 'Базовый endpoint',
        geminiEndpointPlaceholder: 'https://ваш-провайдер.example',
        geminiApiKey: 'API-ключ',
        geminiModel: 'ID модели',
        geminiPresets: '-- Пресеты Gemini --',
        saveGeminiPreset: 'Сохранить пресет Gemini',
        deleteGeminiPreset: 'Удалить выбранный пресет Gemini',
        presetLimit: 'Можно сохранить до 20 пресетов Gemini. Удалите один, прежде чем добавлять новый.',
        connectionRecovered: 'Выбранный пресет Gemini больше не существует. Используются текущие поля подключения.',
        geminiEndpointRequired: 'Сначала укажите endpoint Gemini для модели промпта.',
        geminiEndpointBaseOnly: 'Укажите базовый endpoint без параметров запроса и фрагментов.',
        geminiKeyRequired: 'Сначала укажите API-ключ Gemini для модели промпта.',
        geminiModelRequired: 'Сначала укажите ID модели для модели промпта.',
        testConnection: 'Проверить подключение',
        connectionOk: 'Подключение работает.',
        connectionOkBlocked: 'Подключение работает, но провайдер заблокировал тестовый промпт.',
        connectionOkNoText: 'Подключение работает, но модель не вернула текст на тестовый промпт.',
        connectionInvalidResponse: 'Провайдер вернул некорректный ответ Gemini.',
        connectionTimedOut: 'Время проверки подключения истекло.',
        model: 'Модель',
        promptTag: 'Тег промпта',
        reset: 'Сбросить',
        import: 'Импортировать промпт...',
        imported: 'Импортирован',
        nothingImported: 'Ничего не импортировано',
        preview: 'Предпросмотр',
        sourceMissing: 'источника нет в этом пресете',
        importTitle: 'Импорт промпта изображения',
        importHint: 'Выберите промпт из пресета. До подтверждения ничего не изменится.',
        noMatches: 'В текущем пресете нет подходящих промптов.',
        importConfirm: 'Импортировать и отключить в пресете',
        cancel: 'Отмена',
        importedToast: 'Промпт импортирован и отключен в пресете.',
        adoptedToast: 'Модель промпта приняла «{name}» из пресета.',
        needSnapshot: 'Сначала импортируйте промпт.',
        sourceDeleted: 'Исходный промпт удален - включите нужный вручную в Prompt Manager.',
        chooseModel: 'Перед включением выберите модель промпта.',
        showModels: 'Показать или скрыть список моделей',
        refreshModels: 'Обновить список моделей',
        composing: 'создаю изображение...',
        stop: 'Стоп',
        stopping: 'Останавливаю...',
        stopped: 'Создание промпта остановлено.',
        retry: 'Повторить модель промпта',
        reroll: 'Переписать промпт и обновить это изображение',
        guidanceButton: 'Указания для изображения',
        guidanceActive: 'Указания для изображения активны',
        guidanceTitle: 'Указания для модели промпта',
        guidanceIntro: 'Эти указания получает только отдельная модель промпта. Основная модель повествования их не видит.',
        guidanceLabel: 'Постоянные указания для этого чата',
        guidancePlaceholder: 'Например: Сфокусируйся на конфликте у двери. Используй широкую горизонтальную композицию и оставь Эйс в кадре.',
        guidancePersistence: 'Остаются активными в этом чате, пока вы их не очистите.',
        guidanceSet: 'Активны',
        guidanceEmpty: 'Не заданы',
        guidanceLocationHint: 'Используйте OOC для указаний только модели промпта.',
        guidanceApply: 'Применить',
        guidanceClear: 'Очистить',
        guidanceSaved: 'Указания для изображения сохранены для этого чата.',
        guidanceCleared: 'Указания для изображения очищены.',
        guidanceUnavailable: 'Включите модель промпта для отдельных указаний.',
        selectedPromptMissing: 'Выбранный промпт больше не существует',
        modelStatusError: 'Проверка моделей вернула код {status}',
        catalogFailed: 'Не удалось загрузить список моделей.',
        catalogHttpError: 'Не удалось загрузить каталог моделей (HTTP {status})',
        catalogUnavailable: 'Ни один endpoint каталога моделей не ответил',
        noRequestText: 'Запрос модели промпта не содержит текста',
        providerError: 'Ошибка провайдера модели промпта: {detail}',
        providerBlocked: 'Провайдер заблокировал промпт: {reason}',
        noResponseText: 'Модель промпта не вернула текст',
        noResponseTextReason: 'Модель промпта не вернула текст (finishReason={reason})',
        apiError: 'Ошибка API модели промпта ({status}): {detail}',
        requestTimedOut: 'Время запроса модели промпта истекло',
        requestAborted: 'Запрос модели промпта отменен',
        requestFailed: 'Запрос модели промпта завершился ошибкой',
        errorDetail: 'Не удалось выполнить операцию: {detail}',
        contextUnavailable: 'Точный контекст генерации больше недоступен',
        sanitizerUnavailable: 'DOMPurify недоступен; невозможно безопасно обработать ответ модели промпта',
        imageBlockMissing: 'Ответ не содержит блока изображения IIG',
        pendingTagMissing: 'Ответ не содержит корректного тега изображения для генерации',
        instructionPromptMissing: 'В инструкции изображения отсутствует промпт',
        singleBlockRequired: 'Ответ должен содержать ровно один блок изображения IIG для генерации',
        failed: 'Ошибка модели промпта',
        rerollContextChanged: 'Контекст повторного создания промпта изменился',
        mainModelMissing: 'Не выбрана текущая модель Chat Completion',
        imageSourceChanged: 'Источник выбранного изображения изменился до замены',
        editSanitizerUnavailable: 'DOMPurify недоступен; невозможно безопасно обработать измененный блок изображения',
        editFailed: 'Не удалось безопасно обработать измененный блок изображения; изменения не применены.',
        copyConfirm: 'Создать копию сообщения с измененным блоком изображения?',
        copyFailed: 'Не удалось завершить копирование сообщения.',
        endpointInvalid: 'Укажите корректный HTTP или HTTPS endpoint для модели промпта.',
    },
};

function iigT(key, vars = null) {
    const english = IIG_STRINGS[key] ?? key;
    let text = english;
    try {
        const ctx = getContext();
        text = ctx?.translate?.(english, key) || english;
    } catch (_) {}
    return String(text).replace(/\{([^{}]+)\}/g, (match, name) =>
        vars && Object.hasOwn(vars, name) ? String(vars[name]) : match);
}

function registerIigLocale() {
    const ctx = getContext();
    const locale = ctx?.getCurrentLocale?.();
    if (Object.hasOwn(IIG_LOCALES, locale)) ctx?.addLocaleData?.(locale, IIG_LOCALES[locale]);
}

function iigError(message, key, vars = null) {
    const error = new Error(message);
    error.i18n = key;
    error.i18nVars = vars;
    return error;
}

function iigErrorText(error) {
    const text = error?.i18n ? iigT(error.i18n, error.i18nVars)
        : pmT('errorDetail', { detail: error?.message || String(error || pmT('failed')) });
    return redactPromptModelGeminiError(text, promptModelGeminiSettings()?.apiKey);
}

function pmT(key, vars = null) {
    return iigT('iig_pm_' + key, vars);
}

const IMAGE_PACKS_I18N = {
    en: {
        title: 'Image Packs',
        pill: 'Packs',
        pillTitle: 'Pick a reference from your image packs',
        sourceBadge: 'Pack',
        intro: 'Saved locally in this browser. Click an image to use it as a reference.',
        packs: 'Packs',
        newPack: 'New pack',
        newPackPrompt: 'Pack name',
        renamePack: 'Rename pack',
        renamePackPrompt: 'New pack name',
        packRenamed: 'Pack renamed.',
        deletePack: 'Delete pack',
        deletePackConfirm: 'Delete "{name}" and its {count} image(s)?',
        addImages: 'Add images',
        packOption: '{name} ({count})',
        sort: 'Sort images',
        sortNewest: 'Newest',
        sortOldest: 'Oldest',
        sortNameAsc: 'Name A–Z',
        sortNameDesc: 'Name Z–A',
        checkStorage: 'Check storage',
        checkingStorage: 'Checking storage…',
        storageSummary: 'Packs: {packs} · Images: {images} · {size}',
        storageChanged: 'Storage changed — check again.',
        storageMeasureFailed: 'Could not measure image pack storage.',
        usePhoto: 'Use {name} as reference',
        photoActionsFor: 'Actions for {name}',
        renamePhoto: 'Rename image',
        renamePhotoPrompt: 'New image name',
        photoRenamed: 'Image renamed.',
        movePhoto: 'Move image',
        movePhotoTo: 'Move to pack',
        newDestination: 'New pack…',
        photoMoved: 'Moved to {name}.',
        deletePhoto: 'Delete image',
        deletePhotoConfirm: 'Delete "{name}" from this pack? Reference slots already using it will stay unchanged.',
        photoDeleted: 'Image deleted.',
        photoNameRequired: 'Enter an image name.',
        updateFailed: 'Could not update that image.',
        noPacks: 'No packs yet. Create one to get started.',
        emptyPack: 'This pack is empty.',
        page: '{page} / {pages}',
        prev: 'Previous page',
        next: 'Next page',
        importing: 'Importing... {done}/{total}',
        busyClose: 'An operation is in progress. Wait for it to finish before closing.',
        imported: 'Added {count} image(s).',
        importedSome: 'Added {count} image(s); skipped {skipped}.',
        importedNone: 'Nothing added; skipped {skipped}.',
        rejectedType: 'Only PNG, JPG and WebP images are supported.',
        rejectedSize: 'Images must be under {max}.',
        applying: 'Setting reference…',
        applied: 'Reference set.',
        applyFailed: 'Could not set that reference.',
        storageFailed: 'Image pack storage is unavailable.',
        quotaExceeded: 'Browser storage is full. Remove unused images or packs, then try again.',
        nameRequired: 'Enter a pack name.',
        cancel: 'Cancel',
        close: 'Close',
    },
    ru: {
        title: 'Наборы изображений',
        pill: 'Наборы',
        pillTitle: 'Выбрать референс из наборов изображений',
        sourceBadge: 'Набор',
        intro: 'Хранится локально в этом браузере. Нажмите на изображение, чтобы использовать его как референс.',
        packs: 'Наборы',
        newPack: 'Новый набор',
        newPackPrompt: 'Название набора',
        renamePack: 'Переименовать набор',
        renamePackPrompt: 'Новое название набора',
        packRenamed: 'Набор переименован.',
        deletePack: 'Удалить набор',
        deletePackConfirm: 'Удалить «{name}» и изображений: {count}?',
        addImages: 'Добавить изображения',
        packOption: '{name} ({count})',
        sort: 'Сортировка изображений',
        sortNewest: 'Сначала новые',
        sortOldest: 'Сначала старые',
        sortNameAsc: 'Имя А–Я',
        sortNameDesc: 'Имя Я–А',
        checkStorage: 'Проверить хранилище',
        checkingStorage: 'Проверяем хранилище…',
        storageSummary: 'Наборов: {packs} · изображений: {images} · {size}',
        storageChanged: 'Хранилище изменилось — проверьте снова.',
        storageMeasureFailed: 'Не удалось измерить хранилище наборов.',
        usePhoto: 'Использовать {name} как референс',
        photoActionsFor: 'Действия для {name}',
        renamePhoto: 'Переименовать изображение',
        renamePhotoPrompt: 'Новое название изображения',
        photoRenamed: 'Изображение переименовано.',
        movePhoto: 'Переместить изображение',
        movePhotoTo: 'Переместить в набор',
        newDestination: 'Новый набор…',
        photoMoved: 'Перемещено в «{name}».',
        deletePhoto: 'Удалить изображение',
        deletePhotoConfirm: 'Удалить «{name}» из этого набора? Уже заполненные слоты референсов не изменятся.',
        photoDeleted: 'Изображение удалено.',
        photoNameRequired: 'Введите название изображения.',
        updateFailed: 'Не удалось изменить изображение.',
        noPacks: 'Наборов пока нет. Создайте первый.',
        emptyPack: 'Этот набор пуст.',
        page: '{page} / {pages}',
        prev: 'Предыдущая страница',
        next: 'Следующая страница',
        importing: 'Импортируем... {done}/{total}',
        busyClose: 'Выполняется операция. Дождитесь её завершения, прежде чем закрыть окно.',
        imported: 'Добавлено изображений: {count}.',
        importedSome: 'Добавлено: {count}, пропущено: {skipped}.',
        importedNone: 'Ничего не добавлено, пропущено: {skipped}.',
        rejectedType: 'Поддерживаются только PNG, JPG и WebP.',
        rejectedSize: 'Размер изображения должен быть меньше {max}.',
        applying: 'Устанавливаем референс…',
        applied: 'Референс установлен.',
        applyFailed: 'Не удалось установить этот референс.',
        storageFailed: 'Хранилище наборов недоступно.',
        quotaExceeded: 'Хранилище браузера заполнено. Удалите ненужные изображения или наборы и повторите попытку.',
        nameRequired: 'Введите название набора.',
        cancel: 'Отмена',
        close: 'Закрыть',
    },
};

function packT(key, vars = null) {
    return iigT('iig_pack_' + key, vars);
}

function normalizePromptTag(raw) {
    const clean = String(raw || '')
        .replace(/[<>/]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9_.:-]/g, '');
    return clean || PROMPT_MODEL_TAG_DEFAULT;
}

function promptModelSettings() {
    const settings = getSettings().promptModel;
    settings.tag = normalizePromptTag(settings.tag);
    return settings;
}

const PROMPT_MODEL_GEMINI_PRESET_FIELDS = Object.freeze(['endpoint', 'apiKey', 'model']);

function promptModelGeminiSettings() {
    return promptModelSettings().gemini;
}

function snapshotPromptModelGeminiConfig(config) {
    const snapshot = {};
    for (const field of PROMPT_MODEL_GEMINI_PRESET_FIELDS) snapshot[field] = String(config?.[field] || '').trim();
    return snapshot;
}

function findPromptModelGeminiPreset(config, name) {
    const target = String(name || '').trim();
    if (!target) return null;
    return config.presets.find(preset => preset?.name === target)
        || config.presets.find(preset => typeof preset?.name === 'string' && preset.name.toLowerCase() === target.toLowerCase())
        || null;
}

function applyPromptModelGeminiPreset(config, preset) {
    for (const field of PROMPT_MODEL_GEMINI_PRESET_FIELDS) config[field] = String(preset?.[field] || '').trim();
}

function refreshPromptModelGeminiPresetSelect() {
    if (_iigDisposed) return;
    const select = document.getElementById('iig_pm_gemini_preset');
    if (!select) return;
    const config = promptModelGeminiSettings();
    const label = pmT('geminiPresets');
    const options = [{ name: label, value: '' }, ...config.presets.filter(preset => preset?.name)
        .map(preset => ({ name: preset.name, value: preset.name }))];
    const value = findPromptModelGeminiPreset(config, config.activePresetName)?.name || '';
    if (select.getAttribute('aria-label') !== label) select.setAttribute('aria-label', label);
    if (select.options.length !== options.length || options.some((option, index) =>
        select.options[index].value !== option.value || select.options[index].textContent !== option.name)) {
        select.textContent = '';
        for (const option of options) select.appendChild(new Option(option.name, option.value, false, option.value === value));
    }
    if (select.value !== value) select.value = value;
}

function resolvePromptModelGeminiConfig() {
    const config = promptModelGeminiSettings();
    if (config.activePresetName && !findPromptModelGeminiPreset(config, config.activePresetName)) {
        config.activePresetName = '';
        saveSettings();
        refreshPromptModelGeminiPresetSelect();
        toastr.warning(pmT('connectionRecovered'), pmT('title'));
    }
    const resolved = snapshotPromptModelGeminiConfig(config);
    if (!resolved.endpoint) throw iigError(PROMPT_MODEL_I18N.en.geminiEndpointRequired, 'iig_pm_geminiEndpointRequired');
    if (!resolved.apiKey) throw iigError(PROMPT_MODEL_I18N.en.geminiKeyRequired, 'iig_pm_geminiKeyRequired');
    if (!resolved.model) throw iigError(PROMPT_MODEL_I18N.en.geminiModelRequired, 'iig_pm_geminiModelRequired');
    const endpointError = validatePromptModelGeminiEndpoint(resolved.endpoint);
    if (endpointError) throw endpointError;
    return resolved;
}

function normalizePromptModelGeminiEndpoint(endpoint, stripVersion = true) {
    const base = String(endpoint || '').trim().replace(/\/+$/, '')
        .replace(/\/v1beta\/models\/.+:generateContent$/i, '')
        .replace(/\/v1beta\/models$/i, '')
        .replace(/\/v1$/i, '');
    return stripVersion ? base.replace(/\/v1beta$/i, '') : base;
}

function validatePromptModelGeminiEndpoint(endpoint) {
    const base = normalizePromptModelGeminiEndpoint(endpoint);
    const shapeError = validateEndpointShape(base);
    if (shapeError) return iigError(shapeError, 'iig_pm_endpointInvalid');
    const parsed = new URL(base, window.location.href);
    return parsed.search || parsed.hash
        ? iigError(PROMPT_MODEL_I18N.en.geminiEndpointBaseOnly, 'iig_pm_geminiEndpointBaseOnly') : null;
}

function buildPromptModelGeminiUrl(config, compatible = false, base = normalizePromptModelGeminiEndpoint(config.endpoint)) {
    const prefix = compatible && !endpointHasCompatiblePrefix(base) ? '/compatible' : '';
    return `${base}${prefix}/v1beta/models/${encodeModelForPath(config.model)}:generateContent`;
}

function getPromptModelGuidance() {
    try {
        const ctx = getContext();
        const chatId = ctx?.chatId ?? ctx?.getCurrentChatId?.();
        if (chatId === undefined || chatId === null || chatId === '') return '';
        return String(ctx.chatMetadata?.[PROMPT_MODEL_GUIDANCE_KEY] || '');
    } catch (_) {
        return '';
    }
}

async function setPromptModelGuidance(value) {
    if (_iigDisposed) return;
    const ctx = getContext();
    if (!ctx?.chatMetadata) return false;
    const metadata = ctx.chatMetadata;
    const previous = metadata[PROMPT_MODEL_GUIDANCE_KEY];
    const guidance = String(value || '').trim();
    if (guidance) metadata[PROMPT_MODEL_GUIDANCE_KEY] = guidance;
    else delete metadata[PROMPT_MODEL_GUIDANCE_KEY];
    try {
        await ctx.saveMetadata?.();
    } catch (error) {
        if (metadata[PROMPT_MODEL_GUIDANCE_KEY] === (guidance || undefined)) {
            if (previous === undefined) delete metadata[PROMPT_MODEL_GUIDANCE_KEY];
            else metadata[PROMPT_MODEL_GUIDANCE_KEY] = previous;
        }
        refreshPromptModelGuidanceButton();
        throw error;
    }
    refreshPromptModelGuidanceButton();
    return true;
}

function isPromptModelAvailable() {
    return globalThis.SillyTavern?.getContext?.()?.mainApi === 'openai' && !!promptManager;
}

function allCompletionPrompts() {
    return getContext()?.chatCompletionSettings?.prompts || [];
}

function matchingPromptModelPrompts() {
    const open = `<${normalizePromptTag(promptModelSettings().tag)}>`;
    return allCompletionPrompts().filter(prompt =>
        typeof prompt?.content === 'string' && prompt.content.trimStart().startsWith(open));
}

function promptModelPromptById(id) {
    return allCompletionPrompts().find(prompt => prompt?.identifier === id) || null;
}

function promptModelOrderList() {
    const settings = getContext()?.chatCompletionSettings;
    const characterId = promptManager?.activeCharacter?.id ?? 100001;
    return (settings?.prompt_order || [])
        .find(entry => String(entry.character_id) === String(characterId))?.order || [];
}

function promptModelOrderEntry(id) {
    return promptModelOrderList().find(entry => entry?.identifier === id) || null;
}

function activePromptModelPrompt() {
    const ids = new Set(matchingPromptModelPrompts().map(prompt => prompt.identifier));
    const enabled = promptModelOrderList().find(entry => entry?.enabled && ids.has(entry.identifier));
    return enabled ? promptModelPromptById(enabled.identifier) : null;
}

function setPromptModelOrderEnabled(id, enabled) {
    const entry = promptModelOrderEntry(id);
    if (!entry) return false;
    entry.enabled = !!enabled;
    return true;
}

function persistPromptModelState() {
    try { promptManager?.render?.(false); } catch (error) { iigLog('WARN', 'Prompt Manager render failed:', error.message); }
    saveSettings();
}

function snapshotPromptModelPrompt(prompt) {
    if (!prompt) return false;
    const pm = promptModelSettings();
    pm.snapshot = {
        content: String(prompt.content || ''),
        name: String(prompt.name || prompt.identifier || ''),
        sourceId: String(prompt.identifier || ''),
        importedAt: Date.now(),
    };
    return true;
}

function refreshPromptModelStatus() {
    if (_iigDisposed) return;
    const status = document.getElementById('iig_pm_status');
    if (!status) return;
    const pm = promptModelSettings();
    if (pm.connection === 'gemini') {
        status.textContent = `${pmT('provider')}: ${pmT('geminiConnection')} · ${pmT('model')}: ${pm.gemini.model || '-'}`;
        return;
    }
    const oai = getContext()?.chatCompletionSettings || {};
    const mainModel = getContext()?.getChatCompletionModel?.() || '';
    status.textContent = `${pmT('provider')}: ${oai.chat_completion_source || '-'} · ${pmT('main')}: ${mainModel || '-'}`;
}

function refreshPromptModelUI() {
    if (_iigDisposed) return;
    const pm = promptModelSettings();
    const gemini = pm.gemini;
    const available = isPromptModelAvailable();
    const toggle = document.getElementById('iig_pm_enabled');
    if (toggle) {
        toggle.checked = available && pm.enabled;
        toggle.disabled = !available;
    }
    const unavailable = document.getElementById('iig_pm_unavailable');
    unavailable?.classList.toggle('iig-hidden', available);
    const controls = document.getElementById('iig_pm_controls');
    controls?.classList.toggle('iig-pm-disabled', !available);

    const connection = document.getElementById('iig_pm_connection');
    if (connection) connection.value = pm.connection;
    document.getElementById('iig_pm_default_connection')?.classList.toggle('iig-hidden', pm.connection !== 'default');
    document.getElementById('iig_pm_gemini_connection')?.classList.toggle('iig-hidden', pm.connection !== 'gemini');
    const endpoint = document.getElementById('iig_pm_gemini_endpoint');
    const apiKey = document.getElementById('iig_pm_gemini_key');
    const model = document.getElementById('iig_pm_gemini_model');
    if (endpoint) endpoint.value = gemini.endpoint;
    if (apiKey) apiKey.value = gemini.apiKey;
    if (model) model.value = gemini.model;
    refreshPromptModelGeminiPresetSelect();

    refreshPromptModelStatus();

    const snapshotStatus = document.getElementById('iig_pm_snapshot_status');
    if (snapshotStatus) {
        if (!pm.snapshot.content) {
            snapshotStatus.textContent = pmT('nothingImported');
        } else {
            const date = pm.snapshot.importedAt ? new Date(pm.snapshot.importedAt).toLocaleDateString() : '';
            const missing = pm.snapshot.sourceId && !promptModelPromptById(pm.snapshot.sourceId);
            snapshotStatus.textContent = `${pmT('imported')}: ${pm.snapshot.name || pm.snapshot.sourceId}${date ? ` · ${date}` : ''}${missing ? ` · ${pmT('sourceMissing')}` : ''}`;
        }
    }
    const preview = document.getElementById('iig_pm_preview');
    if (preview) preview.value = pm.snapshot.content || '';
    refreshPromptModelGuidanceButton();
}

function refreshPromptModelGuidanceButton() {
    if (_iigDisposed) return;
    const button = document.getElementById('iig_pm_guidance_button');
    if (!button) return;
    const pm = promptModelSettings();
    const ctx = getContext();
    const chatId = ctx?.chatId ?? ctx?.getCurrentChatId?.();
    const visible = isPromptModelAvailable() && pm.enabled && chatId !== undefined && chatId !== null && chatId !== '';
    const guidance = getPromptModelGuidance();
    button.classList.toggle('iig-pm-guidance-hidden', !visible);
    button.classList.toggle('active', visible && !!guidance);
    button.title = guidance ? pmT('guidanceActive') : pmT('guidanceButton');
    button.setAttribute('aria-label', button.title);
}

async function openPromptModelGuidancePopup() {
    if (_iigDisposed) return;
    if (!promptModelSettings().enabled || !isPromptModelAvailable()) {
        toastr.info(pmT('guidanceUnavailable'), pmT('title'));
        return;
    }
    const ctx = getContext();
    const root = document.createElement('div');
    root.className = 'iig-pm-guidance-popup';

    const title = document.createElement('div');
    title.className = 'iig-pm-guidance-title';
    const titleGlyphStart = document.createElement('span');
    titleGlyphStart.className = 'iig-pm-guidance-glyph';
    titleGlyphStart.textContent = '✦';
    titleGlyphStart.setAttribute('aria-hidden', 'true');
    const titleText = document.createElement('h3');
    titleText.id = 'iig_pm_guidance_popup_title';
    titleText.textContent = pmT('guidanceTitle');
    const titleGlyphEnd = titleGlyphStart.cloneNode(true);
    title.append(titleGlyphStart, titleText, titleGlyphEnd);
    root.appendChild(title);

    const intro = document.createElement('p');
    intro.className = 'iig-pm-guidance-copy';
    intro.textContent = pmT('guidanceIntro');
    root.appendChild(intro);

    const editorBlock = document.createElement('section');
    editorBlock.className = 'iig-pm-guidance-block';
    const blockHead = document.createElement('div');
    blockHead.className = 'iig-pm-guidance-block-head';
    const blockLabel = document.createElement('span');
    blockLabel.textContent = pmT('guidanceLabel');
    const state = document.createElement('span');
    const currentGuidance = getPromptModelGuidance();
    state.className = `iig-pm-guidance-state${currentGuidance ? ' active' : ''}`;
    state.textContent = currentGuidance ? pmT('guidanceSet') : pmT('guidanceEmpty');
    blockHead.append(blockLabel, state);
    editorBlock.appendChild(blockHead);

    const textarea = document.createElement('textarea');
    textarea.className = 'text_pole iig-pm-guidance-textarea';
    textarea.value = currentGuidance;
    textarea.placeholder = pmT('guidancePlaceholder');
    textarea.rows = 7;
    textarea.setAttribute('aria-label', pmT('guidanceLabel'));
    editorBlock.appendChild(textarea);

    const persistence = document.createElement('p');
    persistence.className = 'iig-pm-guidance-persistence';
    persistence.innerHTML = `<i class="fa-solid fa-thumbtack" aria-hidden="true"></i><span>${sanitizeForHtml(pmT('guidancePersistence'))}</span>`;
    editorBlock.appendChild(persistence);
    root.appendChild(editorBlock);

    const footer = document.createElement('div');
    footer.className = 'iig-pm-guidance-footer';
    const actions = document.createElement('div');
    actions.className = 'iig-pm-guidance-actions';
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'menu_button iig-pm-guidance-clear';
    clearButton.innerHTML = `<i class="fa-solid fa-eraser" aria-hidden="true"></i><span>${sanitizeForHtml(pmT('guidanceClear'))}</span>`;
    const applyButton = document.createElement('button');
    applyButton.type = 'button';
    applyButton.className = 'menu_button iig-pm-guidance-apply';
    applyButton.innerHTML = `<i class="fa-solid fa-check" aria-hidden="true"></i><span>${sanitizeForHtml(pmT('guidanceApply'))}</span>`;
    actions.append(clearButton, applyButton);
    footer.appendChild(actions);
    root.appendChild(footer);

    const popup = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        okButton: pmT('cancel'),
        cancelButton: false,
    });
    popup.dlg?.setAttribute('aria-labelledby', titleText.id);

    const apply = async () => {
        if (applyButton.disabled) return;
        const guidance = textarea.value.trim();
        applyButton.disabled = true;
        clearButton.disabled = true;
        try {
            await setPromptModelGuidance(guidance);
            if (_iigDisposed) return;
            toastr[guidance ? 'success' : 'info'](guidance ? pmT('guidanceSaved') : pmT('guidanceCleared'), pmT('title'));
            popup.complete(ctx.POPUP_RESULT.AFFIRMATIVE);
        } finally {
            applyButton.disabled = false;
            clearButton.disabled = false;
        }
    };
    bindIig(applyButton, 'click', () => apply().catch(error => {
        iigLog('ERROR', 'Saving Prompt Model guidance failed:', error.message);
        toastr.error(sanitizeForHtml(iigErrorText(error)), sanitizeForHtml(pmT('title')), { escapeHtml: false });
    }));
    bindIig(clearButton, 'click', async () => {
        applyButton.disabled = true;
        clearButton.disabled = true;
        try {
            await setPromptModelGuidance('');
            if (_iigDisposed) return;
            toastr.info(pmT('guidanceCleared'), pmT('title'));
            popup.complete(ctx.POPUP_RESULT.AFFIRMATIVE);
        } catch (error) {
            iigLog('ERROR', 'Clearing Prompt Model guidance failed:', error.message);
            toastr.error(sanitizeForHtml(iigErrorText(error)), sanitizeForHtml(pmT('title')), { escapeHtml: false });
        } finally {
            applyButton.disabled = false;
            clearButton.disabled = false;
        }
    });
    bindIig(textarea, 'keydown', event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            return apply().catch(error => {
                iigLog('ERROR', 'Saving Prompt Model guidance failed:', error.message);
                toastr.error(sanitizeForHtml(iigErrorText(error)), sanitizeForHtml(pmT('title')), { escapeHtml: false });
            });
        }
    });
    if (window.matchMedia?.('(pointer: fine)').matches) {
        setIigTimeout(() => {
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        }, 0);
    }
    await showIigPopup(popup);
}

function initPromptModelGuidanceButton() {
    if (document.getElementById('iig_pm_guidance_button')) {
        refreshPromptModelGuidanceButton();
        return;
    }
    const sendControls = document.getElementById('rightSendForm');
    const sendButton = document.getElementById('send_but');
    if (!sendControls || !sendButton) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'iig_pm_guidance_button';
    button.className = 'interactable iig-pm-guidance-button iig-pm-guidance-hidden';
    const label = document.createElement('span');
    label.className = 'iig-pm-guidance-label';
    label.textContent = 'OOC';
    button.appendChild(label);
    button.setAttribute('aria-haspopup', 'dialog');
    const openGuidance = () => openPromptModelGuidancePopup().catch(error => {
        iigLog('ERROR', 'Prompt Model guidance popup failed:', error.message);
        toastr.error(sanitizeForHtml(iigErrorText(error)), sanitizeForHtml(pmT('title')), { escapeHtml: false });
    });
    bindIig(button, 'click', openGuidance);
    sendControls.insertBefore(button, sendButton);
    refreshPromptModelGuidanceButton();
}

async function openPromptModelImportPopup() {
    if (_iigDisposed) return;
    if (!isPromptModelAvailable()) {
        toastr.warning(pmT('notChatCompletion'), pmT('title'));
        return false;
    }
    const ctx = getContext();
    const prompts = matchingPromptModelPrompts();
    const root = document.createElement('div');
    root.className = 'iig-pm-popup';
    const hint = document.createElement('p');
    hint.className = 'iig-pm-popup-hint';
    hint.textContent = prompts.length ? pmT('importHint') : pmT('noMatches');
    root.appendChild(hint);

    let selectedId = activePromptModelPrompt()?.identifier || prompts[0]?.identifier || '';
    const list = document.createElement('div');
    list.className = 'iig-pm-prompt-list';
    const preview = document.createElement('textarea');
    preview.className = 'text_pole monospace iig-pm-popup-preview';
    preview.readOnly = true;

    const renderSelection = () => {
        list.querySelectorAll('[data-prompt-id]').forEach(row => {
            row.classList.toggle('selected', row.dataset.promptId === selectedId);
        });
        preview.value = promptModelPromptById(selectedId)?.content || '';
    };

    for (const prompt of prompts) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'menu_button iig-pm-prompt-row';
        row.dataset.promptId = prompt.identifier;
        const dot = document.createElement('span');
        dot.className = `iig-pm-prompt-dot${promptModelOrderEntry(prompt.identifier)?.enabled ? ' enabled' : ''}`;
        const name = document.createElement('span');
        name.textContent = prompt.name || prompt.identifier;
        row.append(dot, name);
        row.addEventListener('click', () => { selectedId = prompt.identifier; renderSelection(); });
        list.appendChild(row);
    }
    root.append(list, preview);

    const actions = document.createElement('div');
    actions.className = 'iig-pm-popup-actions';
    const importButton = document.createElement('button');
    importButton.type = 'button';
    importButton.className = 'menu_button iig-pm-import-confirm';
    importButton.textContent = pmT('importConfirm');
    importButton.disabled = !selectedId;
    actions.appendChild(importButton);
    root.appendChild(actions);
    renderSelection();

    let imported = false;
    const popup = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, pmT('importTitle'), {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: pmT('cancel'),
        cancelButton: false,
    });
    bindIig(importButton, 'click', async () => {
        if (importButton.disabled) return;
        importButton.disabled = true;
        importButton.classList.add('busy');
        try {
            const prompt = promptModelPromptById(selectedId);
            if (!prompt) throw iigError('Selected prompt no longer exists', 'iig_pm_selectedPromptMissing');
            const previousSourceId = promptModelSettings().snapshot.sourceId;
            if (!promptModelSettings().enabled && previousSourceId && previousSourceId !== prompt.identifier) {
                setPromptModelOrderEnabled(previousSourceId, true);
            }
            snapshotPromptModelPrompt(prompt);
            setPromptModelOrderEnabled(prompt.identifier, false);
            persistPromptModelState();
            imported = true;
            refreshPromptModelUI();
            toastr.success(pmT('importedToast'), pmT('title'));
            popup.complete(ctx.POPUP_RESULT.AFFIRMATIVE);
        } catch (error) {
            iigLog('ERROR', 'Prompt import failed:', error.message);
            toastr.error(sanitizeForHtml(iigErrorText(error)), sanitizeForHtml(pmT('title')), { escapeHtml: false });
            importButton.disabled = false;
            importButton.classList.remove('busy');
        }
    });
    await showIigPopup(popup);
    return imported;
}

async function setPromptModelEnabled(enabled) {
    const pm = promptModelSettings();
    if (enabled) {
        if (!isPromptModelAvailable()) {
            toastr.warning(pmT('notChatCompletion'), pmT('title'));
            refreshPromptModelUI();
            return false;
        }
        if (!pm.snapshot.content) {
            toastr.warning(pmT('needSnapshot'), pmT('title'));
            await openPromptModelImportPopup();
            refreshPromptModelUI();
            return false;
        }
        if (pm.connection === 'gemini') {
            try {
                resolvePromptModelGeminiConfig();
            } catch (error) {
                toastr.warning(sanitizeForHtml(iigErrorText(error)), sanitizeForHtml(pmT('title')), { escapeHtml: false });
                refreshPromptModelUI();
                return false;
            }
        } else if (!pm.model) {
            toastr.warning(pmT('chooseModel'), pmT('title'));
            refreshPromptModelUI();
            return false;
        }
        const live = promptModelPromptById(pm.snapshot.sourceId);
        if (live) snapshotPromptModelPrompt(live);
        if (pm.snapshot.sourceId) setPromptModelOrderEnabled(pm.snapshot.sourceId, false);
        pm.enabled = true;
    } else {
        pm.enabled = false;
        abortAllPromptModelRequests('prompt-model-disabled');
        if (pm.snapshot.sourceId && !setPromptModelOrderEnabled(pm.snapshot.sourceId, true)) {
            toastr.warning(pmT('sourceDeleted'), pmT('title'));
        }
    }
    persistPromptModelState();
    refreshPromptModelUI();
    return pm.enabled === enabled;
}

async function adoptActivePromptModelPrompt(dryRun) {
    const pm = promptModelSettings();
    if (dryRun || !pm.enabled || !isPromptModelAvailable()) return;
    const active = activePromptModelPrompt();
    if (!active) return;
    snapshotPromptModelPrompt(active);
    for (const prompt of matchingPromptModelPrompts()) {
        if (promptModelOrderEntry(prompt.identifier)?.enabled) setPromptModelOrderEnabled(prompt.identifier, false);
    }
    persistPromptModelState();
    refreshPromptModelUI();
    toastr.info(sanitizeForHtml(pmT('adoptedToast', { name: active.name || active.identifier })), sanitizeForHtml(pmT('title')), { escapeHtml: false });
}

const PROMPT_MODEL_CONTROLS = Object.freeze({
    [chat_completion_sources.OPENAI]: 'model_openai_select',
    [chat_completion_sources.AZURE_OPENAI]: 'model_azure_openai_select',
    [chat_completion_sources.CLAUDE]: 'model_claude_select',
    [chat_completion_sources.OPENROUTER]: 'model_openrouter_select',
    [chat_completion_sources.AI21]: 'model_ai21_select',
    [chat_completion_sources.MAKERSUITE]: 'model_google_select',
    [chat_completion_sources.VERTEXAI]: 'model_vertexai_select',
    [chat_completion_sources.MISTRALAI]: 'model_mistralai_select',
    [chat_completion_sources.CUSTOM]: 'custom_model_id',
    [chat_completion_sources.COHERE]: 'model_cohere_select',
    [chat_completion_sources.PERPLEXITY]: 'model_perplexity_select',
    [chat_completion_sources.GROQ]: 'model_groq_select',
    [chat_completion_sources.CHUTES]: 'model_chutes_select',
    [chat_completion_sources.SILICONFLOW]: 'model_siliconflow_select',
    [chat_completion_sources.MINIMAX]: 'model_minimax_select',
    [chat_completion_sources.ELECTRONHUB]: 'model_electronhub_select',
    [chat_completion_sources.NANOGPT]: 'model_nanogpt_select',
    [chat_completion_sources.DEEPSEEK]: 'model_deepseek_select',
    [chat_completion_sources.AIMLAPI]: 'model_aimlapi_select',
    [chat_completion_sources.XAI]: 'model_xai_select',
    [chat_completion_sources.POLLINATIONS]: 'model_pollinations_select',
    [chat_completion_sources.MOONSHOT]: 'model_moonshot_select',
    [chat_completion_sources.FIREWORKS]: 'model_fireworks_select',
    [chat_completion_sources.COMETAPI]: 'model_cometapi_select',
    [chat_completion_sources.ZAI]: 'model_zai_select',
    [chat_completion_sources.WORKERS_AI]: 'model_workers_ai_select',
});

function getPromptModelDomOptions() {
    const source = getContext()?.chatCompletionSettings?.chat_completion_source;
    const control = document.getElementById(PROMPT_MODEL_CONTROLS[source]);
    if (control instanceof HTMLSelectElement) {
        return Array.from(control.options)
            .filter(option => option.value)
            .map(option => ({ value: option.value, label: option.textContent?.trim() || option.value }));
    }
    if (control instanceof HTMLInputElement) {
        const options = [{ value: control.value, label: control.value }];
        if (control.list instanceof HTMLDataListElement) {
            for (const option of control.list.options) {
                if (option.value) options.push({ value: option.value, label: option.label || option.value });
            }
        }
        return options.filter(option => option.value);
    }
    return [];
}

function populatePromptModelSelect(extraModels = [], open = false) {
    const pm = promptModelSettings();
    const models = new Map();
    for (const option of [...getPromptModelDomOptions(), ...extraModels]) {
        const value = String(option?.value || option?.id || '').trim();
        if (value && !models.has(value)) models.set(value, String(option?.label || option?.name || value));
    }
    if (pm.model && !models.has(pm.model)) models.set(pm.model, pm.model);
    updateModelCatalog('iig_pm_model', Array.from(models, ([value, label]) => ({ value, label })), open);
}

async function refreshPromptModelCatalog() {
    invalidateContextCache();
    const ctx = getContext();
    const oai = ctx?.chatCompletionSettings;
    if (!oai || ctx.mainApi !== 'openai') return;
    const button = document.getElementById('iig_pm_refresh_models');
    const request = Symbol();
    if (button) button._iigCatalogRequest = request;
    const connection = JSON.stringify(oai);
    const isCurrent = () => {
        invalidateContextCache();
        return !_iigDisposed && (!button || button.isConnected && button._iigCatalogRequest === request)
            && getContext()?.mainApi === 'openai' && JSON.stringify(getContext()?.chatCompletionSettings) === connection;
    };
    button?.classList.add('loading');
    try {
        const body = {
            chat_completion_source: oai.chat_completion_source,
            reverse_proxy: oai.reverse_proxy || undefined,
            proxy_password: oai.reverse_proxy ? oai.proxy_password : undefined,
            custom_url: oai.custom_url || undefined,
            custom_include_headers: oai.custom_include_headers || undefined,
            vertexai_auth_mode: oai.vertexai_auth_mode || undefined,
            vertexai_region: oai.vertexai_region || undefined,
            vertexai_express_project_id: oai.vertexai_express_project_id || undefined,
            zai_endpoint: oai.zai_endpoint || undefined,
            siliconflow_endpoint: oai.siliconflow_endpoint || undefined,
            minimax_endpoint: oai.minimax_endpoint || undefined,
            workers_ai_account_id: oai.workers_ai_account_id || undefined,
            azure_base_url: oai.azure_base_url || undefined,
            azure_deployment_name: oai.azure_deployment_name || undefined,
            azure_api_version: oai.azure_api_version || undefined,
        };
        Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);
        const response = await fetchWithTimeout('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify(body),
        }, 30000);
        if (!response.ok) {
            response.iigDiscard?.();
            throw iigError(`Model status returned ${response.status}`, 'iig_pm_modelStatusError', { status: response.status });
        }
        const json = await response.json();
        if (!isCurrent()) return;
        const catalog = Array.isArray(json?.data) ? json.data : [];
        const models = catalog.map(model => ({
            value: model?.id || model?.name || model,
            label: model?.name || model?.id || model,
        }));
        populatePromptModelSelect(models, models.length > 0);
    } catch {
        if (!isCurrent()) return;
        iigLog('WARN', 'Prompt model catalog refresh failed');
        populatePromptModelSelect();
        toastr.warning(sanitizeForHtml(pmT('catalogFailed')), sanitizeForHtml(pmT('title')), { escapeHtml: false });
    } finally {
        if (!_iigDisposed && button?._iigCatalogRequest === request) button.classList.remove('loading');
    }
}

async function refreshPromptModelGeminiCatalog() {
    const config = snapshotPromptModelGeminiConfig(promptModelGeminiSettings());
    const isCurrentConnection = () => {
        const current = snapshotPromptModelGeminiConfig(promptModelGeminiSettings());
        return current.endpoint === config.endpoint && current.apiKey === config.apiKey;
    };
    if (!config.endpoint) throw iigError(PROMPT_MODEL_I18N.en.geminiEndpointRequired, 'iig_pm_geminiEndpointRequired');
    if (!config.apiKey) throw iigError(PROMPT_MODEL_I18N.en.geminiKeyRequired, 'iig_pm_geminiKeyRequired');
    const endpointError = validatePromptModelGeminiEndpoint(config.endpoint);
    if (endpointError) throw endpointError;

    const endpoint = normalizePromptModelGeminiEndpoint(config.endpoint, false);
    const normalizedEndpoint = normalizePromptModelGeminiEndpoint(config.endpoint);
    const headers = endpointNeedsGoogleHeader(endpoint)
        ? { 'x-goog-api-key': config.apiKey }
        : { 'Authorization': `Bearer ${config.apiKey}` };
    const paths = ['/v1/models', '/v1beta/models'];
    if (!endpointHasCompatiblePrefix(endpoint)) paths.push('/compatible/v1/models');

    let catalogEndpoint = endpoint;
    let lastError = null;
    let receivedCatalog = false;
    for (const path of paths) {
        try {
            let response = await fetchWithTimeout(`${catalogEndpoint}${path}`, { method: 'GET', headers }, 10000);
            if (!response.ok && response.status === 404 && catalogEndpoint !== normalizedEndpoint) {
                response.iigDiscard?.();
                catalogEndpoint = normalizedEndpoint;
                response = await fetchWithTimeout(`${catalogEndpoint}${path}`, { method: 'GET', headers }, 10000);
            }
            if (!response.ok) {
                response.iigDiscard?.();
                lastError = iigError(`HTTP ${response.status}`, 'iig_pm_catalogHttpError', { status: response.status });
                continue;
            }
            const data = await response.json();
            if (!isCurrentConnection()) return [];
            receivedCatalog = true;
            const raw = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
            const models = raw.map(model => {
                const rawId = String(model?.id || model?.name || model || '');
                const value = rawId.startsWith('models/') ? rawId.slice('models/'.length) : rawId;
                return { value, label: value };
            }).filter(model => model.value);
            if (!models.length) continue;
            if (config.model && !models.some(model => model.value === config.model)) {
                models.push({ value: config.model, label: config.model });
            }
            updateModelCatalog('iig_pm_gemini_model', models, true);
            return models;
        } catch (error) {
            throwIfSignalAborted();
            const detail = redactPromptModelGeminiError(error?.message || error, config.apiKey);
            lastError = iigError(detail, 'iig_pm_providerError', { detail });
        }
    }

    if (receivedCatalog) {
        if (!isCurrentConnection()) return [];
        updateModelCatalog('iig_pm_gemini_model', config.model ? [config.model] : [], false, true);
        return [];
    }
    const error = lastError || iigError('No model catalog endpoint responded', 'iig_pm_catalogUnavailable');
    iigLog('WARN', 'Prompt Model Gemini catalog failed:', error.message);
    throw error;
}

let _promptModelGeneration = null;
const _promptModelCaptures = new Map();
const _promptModelControllers = new Map();
const _promptModelCaptureCache = new Map();
const PROMPT_MODEL_CAPTURE_CACHE_LIMIT = 3;

function cachePromptModelCapture(key, capture, messageId) {
    if (!key || !capture?.chat) return;
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) return;
    const record = { capture: structuredClone(capture), message, messageId, chat: context.chat,
        swipe: message.swipe_info?.[getMessageSwipeId(message)] };
    _promptModelCaptureCache.delete(key);
    _promptModelCaptureCache.set(key, record);
    while (_promptModelCaptureCache.size > PROMPT_MODEL_CAPTURE_CACHE_LIMIT) {
        _promptModelCaptureCache.delete(_promptModelCaptureCache.keys().next().value);
    }
    return record;
}

function getOwnedPromptModelCapture(cache, key) {
    invalidateContextCache();
    const record = cache.get(key);
    const context = getContext();
    if (!record || context.chat !== record.chat || context.chat[record.messageId] !== record.message
        || buildProcessingKey(record.messageId) !== key
        || record.message.swipe_info?.[getMessageSwipeId(record.message)] !== record.swipe) {
        cache.delete(key);
        return null;
    }
    return record.capture;
}

function getCachedPromptModelCapture(key) {
    const cached = getOwnedPromptModelCapture(_promptModelCaptureCache, key);
    if (!cached) return null;
    const record = _promptModelCaptureCache.get(key);
    _promptModelCaptureCache.delete(key);
    _promptModelCaptureCache.set(key, record);
    return {
        ...structuredClone(cached),
        guidance: getPromptModelGuidance(),
    };
}

function beginPromptModelCapture(type, dryRun) {
    const allowedTypes = new Set(['normal', 'regenerate', 'swipe', 'continue', 'append', 'appendFinal']);
    if (dryRun || !allowedTypes.has(String(type || 'normal')) || getContext()?.mainApi !== 'openai') {
        _promptModelGeneration = null;
        return;
    }
    _promptModelGeneration = {
        type: String(type || 'normal'),
        chat: null,
        guidance: getPromptModelGuidance(),
    };
}

function capturePromptModelContext(data) {
    if (!_promptModelGeneration || data?.dryRun || !Array.isArray(data?.chat)) return;
    try {
        _promptModelGeneration.chat = structuredClone(data.chat);
    } catch (error) {
        iigLog('WARN', 'Prompt context capture failed:', error.message);
    }
}

function bindPromptModelCapture(messageId, type) {
    if (!_promptModelGeneration?.chat) return null;
    const key = buildProcessingKey(messageId);
    const capture = {
        ..._promptModelGeneration,
        type: String(type || _promptModelGeneration.type || 'normal'),
    };
    const record = cachePromptModelCapture(key, capture, messageId);
    if (record) _promptModelCaptures.set(key, record);
    _promptModelGeneration = null;
    if (_promptModelCaptures.size > 30) _promptModelCaptures.delete(_promptModelCaptures.keys().next().value);
    return capture;
}

function buildPromptModelFallbackContext(messageId) {
    const ctx = getContext();
    const messages = [];
    try {
        const card = ctx?.getCharacterCardFields?.();
        const description = card?.description || card?.personality || '';
        if (description) messages.push({ role: 'system', content: String(description) });
    } catch (_) {}
    const start = Math.max(0, Number(messageId) - 11);
    for (let index = start; index < Number(messageId); index++) {
        const message = ctx?.chat?.[index];
        if (!message || message.is_system) continue;
        messages.push({ role: message.is_user ? 'user' : 'assistant', content: String(message.mes || '') });
    }
    iigLog('WARN', `Prompt Model using degraded context for message ${messageId}`);
    return messages;
}

function buildPromptModelMessages(messageId, narrative, capture, corrective = '') {
    const pm = promptModelSettings();
    const messages = capture?.chat ? structuredClone(capture.chat) : buildPromptModelFallbackContext(messageId);
    if (!capture?.chat) {
        messages.unshift({
            role: 'system',
            content: 'You are the dedicated image-block composer. Do not continue the roleplay or explain your answer. Return only the requested IIG HTML image block.',
        });
    }
    const type = capture?.type || 'normal';
    if (type === 'continue') {
        const assistantIndex = messages.findLastIndex(message => message?.role === 'assistant');
        if (assistantIndex >= 0) {
            messages.splice(assistantIndex + 1);
            messages[assistantIndex] = { ...messages[assistantIndex], content: narrative };
        } else {
            messages.push({ role: 'assistant', content: narrative });
        }
    } else {
        messages.push({ role: 'assistant', content: narrative });
    }
    const snapshot = getContext()?.substituteParams?.(pm.snapshot.content) || pm.snapshot.content;
    const capturedGuidance = capture && Object.hasOwn(capture, 'guidance')
        ? capture.guidance
        : getPromptModelGuidance();
    const guidance = capturedGuidance
        ? (getContext()?.substituteParams?.(capturedGuidance) || capturedGuidance)
        : '';
    const outputRule = [
        snapshot,
        guidance ? `[Additional image direction from the user - apply this to the image block only]\n${guidance}` : '',
        '[Output ONLY the HTML image block in this exact structure: <img data-iig-instruction=\'{"prompt":"detailed visual prompt"}\' src="[IMG:GEN]">. Additional supported instruction fields may be included. No narrative, markdown fences, or commentary.]',
        corrective,
    ].filter(Boolean).join('\n');
    messages.push({ role: 'user', content: outputRule });
    return messages;
}

function promptModelMessageText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(part => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
    }).filter(Boolean).join('\n');
}

function buildPromptModelGeminiBody(messages) {
    const systemParts = [];
    const contents = [];
    let droppedContent = false;
    for (const message of messages) {
        const content = message?.content;
        const parts = Array.isArray(content) ? content : [content];
        if (parts.some(part => part && typeof part === 'object'
            && (!Array.isArray(content) || (typeof part.text !== 'string' && typeof part.content !== 'string')))) {
            droppedContent = true;
        }
        const text = promptModelMessageText(message?.content).trim();
        if (!text) continue;
        if (message?.role === 'system' || message?.role === 'developer') {
            systemParts.push({ text });
            continue;
        }
        const role = message?.role === 'assistant' || message?.role === 'model' ? 'model' : 'user';
        const previous = contents[contents.length - 1];
        if (previous?.role === role) previous.parts.push({ text });
        else contents.push({ role, parts: [{ text }] });
    }
    if (droppedContent) iigLog('WARN', 'Prompt Model Gemini omitted non-text context; only text is sent.');
    if (!contents.length) throw iigError('Prompt Model request has no text content', 'iig_pm_noRequestText');
    const body = { contents };
    if (systemParts.length) body.systemInstruction = { parts: systemParts };
    return body;
}

function redactPromptModelGeminiError(value, apiKey) {
    let text = String(value || '');
    const secret = String(apiKey || '');
    if (secret) {
        const escape = part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hexCase = part => part.replace(/[a-f]/gi, char => `[${char.toLowerCase()}${char.toUpperCase()}]`);
        const jsonPattern = secret.split('').map(char => {
            const forms = [JSON.stringify(char).slice(1, -1)];
            if (char === '/') forms.push('\\/');
            return `(?:\\\\u${hexCase(char.charCodeAt(0).toString(16).padStart(4, '0'))}|${forms.map(escape).join('|')})`;
        }).join('');
        let pattern = `${jsonPattern}|${escape(secret)}`;
        // A malformed UTF-16 key still needs exact and JSON-escaped redaction.
        try {
            pattern += '|' + encodeURIComponent(secret).split(/(%[0-9a-f]{2})/i)
                .map(part => /^%[0-9a-f]{2}$/i.test(part) ? hexCase(part) : escape(part)).join('');
        } catch (_) {}
        const match = new RegExp(pattern, 'g');
        // Short secrets cannot be distinguished from prose: suppress the whole
        // diagnostic on a match rather than leak the key or shred nearby words.
        if (secret.length < 8 && match.test(text)) return '***REDACTED***';
        text = text.replace(match, '***REDACTED***');
    }
    return redactSensitive(text);
}

function parsePromptModelGeminiResponse(result, connectionTest = false) {
    if (result?.error) {
        const message = result.error.message || result.error.status || result.error.code || 'Provider error';
        const error = iigError(String(message), 'iig_pm_providerError', { detail: String(message) });
        if (typeof result.error.code === 'number') error.status = result.error.code;
        throw error;
    }
    const feedback = result?.promptFeedback || result?.prompt_feedback;
    if (connectionTest) {
        const object = value => value && typeof value === 'object' && !Array.isArray(value);
        const reason = feedback?.blockReason || feedback?.block_reason;
        const blocked = object(feedback) && typeof reason === 'string' && reason.trim();
        const candidates = Array.isArray(result?.candidates) && result.candidates.every(candidate =>
            object(candidate)
            && (candidate.content === undefined || (object(candidate.content)
                && Array.isArray(candidate.content.parts) && candidate.content.parts.every(part =>
                    object(part) && (part.text === undefined || typeof part.text === 'string'))))
            && (candidate.finishReason === undefined || typeof candidate.finishReason === 'string')
            && (candidate.finish_reason === undefined || typeof candidate.finish_reason === 'string'));
        if (!object(result) || Object.hasOwn(result, 'error') || (!blocked && !candidates)
            || (result.candidates !== undefined && !candidates)) {
            throw iigError(PROMPT_MODEL_I18N.en.connectionInvalidResponse, 'iig_pm_connectionInvalidResponse');
        }
        if (blocked) return { caveat: 'connectionOkBlocked' };
    }
    if (feedback?.blockReason || feedback?.block_reason) {
        const reason = feedback.blockReason || feedback.block_reason;
        throw iigError(`Prompt blocked by provider: ${reason}`, 'iig_pm_providerBlocked', { reason });
    }
    const candidate = Array.isArray(result?.candidates) ? result.candidates[0] : null;
    const text = (candidate?.content?.parts || [])
        .map(part => part?.thought === true ? '' : (typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('')
        .trim();
    if (text) return text;
    if (connectionTest) return { caveat: 'connectionOkNoText' };
    const finishReason = candidate?.finishReason || candidate?.finish_reason;
    throw iigError(finishReason
        ? `Prompt Model returned no text (finishReason=${finishReason})`
        : 'Prompt Model returned no text', finishReason ? 'iig_pm_noResponseTextReason' : 'iig_pm_noResponseText', { reason: finishReason });
}

function promptModelGeminiNeedsBodyModel(status, detail) {
    if (Number(status) !== 400) return false;
    const message = String(detail || '');
    return /未指定模型名称|模型名称不能为空/.test(message)
        || /\bmodel(?: name)?\b[^\n]{0,48}\b(?:required|missing|empty|cannot be empty)\b/i.test(message);
}

async function requestPromptModelGemini(messages, config, signal, connectionTest = false) {
    const apiKey = config.apiKey;
    try {
        const base = normalizePromptModelGeminiEndpoint(config.endpoint, false);
        const normalizedBase = normalizePromptModelGeminiEndpoint(config.endpoint);
        const quirkSettings = { apiType: 'prompt-gemini', endpoint: base };
        const quirks = getProviderQuirks(quirkSettings);
        const googleEndpoint = endpointNeedsGoogleHeader(base);
        const canProbeCompatible = !endpointHasCompatiblePrefix(base);
        let compatible = canProbeCompatible && quirks.geminiPath === 'compatible';
        const learnedCompatible = compatible;
        let normalizeBase = quirks.geminiNormalizeBase === true;
        let includeBodyModel = !googleEndpoint && quirks.geminiBodyModel === true;
        let url = buildPromptModelGeminiUrl(config, compatible, normalizeBase ? normalizedBase : base);
        const initialUrl = url;
        const headers = googleEndpoint
            ? {
                'x-goog-api-key': apiKey,
                'Content-Type': 'application/json',
            }
            : {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            };
        const payload = buildPromptModelGeminiBody(messages);
        const post = target => robustFetch(target, {
            method: 'POST', headers,
            body: JSON.stringify(includeBodyModel ? { ...payload, model: config.model } : payload), signal,
        });
        let response = await post(url);
        // Keep an accepted legacy URL until the provider rejects its path.
        if (!response.ok && response.status === 404 && !normalizeBase && base !== normalizedBase) {
            normalizeBase = true;
            url = buildPromptModelGeminiUrl(config, compatible, normalizedBase);
            response.iigDiscard?.();
            response = await post(url);
        }
        let originalError = null;
        if (!response.ok && response.status === 404 && canProbeCompatible && !compatible) {
            const originalText = redactPromptModelGeminiError(await response.text().catch(() => ''), apiKey);
            originalError = iigError(`Prompt Model API error (404): ${originalText.slice(0, 500)}`, 'iig_pm_apiError', { status: 404, detail: originalText.slice(0, 500) });
            originalError.status = 404;
            compatible = true;
            url = buildPromptModelGeminiUrl(config, true, normalizeBase ? normalizedBase : base);
            response = await post(url);
        }

        let detail = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            detail = response.ok ? '' : await response.text().catch(() => '');
            if (!googleEndpoint && !includeBodyModel && promptModelGeminiNeedsBodyModel(response.status, detail)) {
                includeBodyModel = true;
                response = await post(url);
                detail = response.ok ? '' : await response.text().catch(() => '');
                if (response.ok) setProviderQuirk(quirkSettings, 'geminiBodyModel', true);
            }
            if (response.ok || attempt > 0 || !normalizeBase || !canProbeCompatible || base === normalizedBase) break;
            // Normalization must not hide the legacy compatible candidate.
            const legacyUrl = buildPromptModelGeminiUrl(config, true, base);
            if (legacyUrl === initialUrl) break;
            compatible = true;
            normalizeBase = false;
            url = legacyUrl;
            response = await post(url);
        }

        if (response.ok && compatible) setProviderQuirk(quirkSettings, 'geminiPath', 'compatible');
        if (response.ok && normalizeBase && base !== normalizedBase) setProviderQuirk(quirkSettings, 'geminiNormalizeBase', true);
        if (response.ok && !normalizeBase && quirks.geminiNormalizeBase === true) delete getProviderQuirks(quirkSettings).geminiNormalizeBase;
        if (!response.ok) {
            detail = redactPromptModelGeminiError(detail, apiKey);
            if (response.status === 404 && learnedCompatible) delete getProviderQuirks(quirkSettings).geminiPath;
            if (response.status === 404 && quirks.geminiNormalizeBase === true) delete getProviderQuirks(quirkSettings).geminiNormalizeBase;
            const error = iigError(`Prompt Model API error (${response.status}): ${detail.slice(0, 500)}`, 'iig_pm_apiError', { status: response.status, detail: detail.slice(0, 500) });
            error.status = response.status;
            if (originalError) error.cause = originalError;
            throw error;
        }
        return parsePromptModelGeminiResponse(await response.json(), connectionTest);
    } catch (error) {
        // Use the request-time key before callers can persist or log the failure.
        const safe = redactSensitive(error, value => redactPromptModelGeminiError(value, apiKey));
        const failure = safe instanceof Error ? safe
            : iigError(typeof safe === 'string' ? safe : 'Prompt Model request failed', 'iig_pm_requestFailed');
        if (!(safe instanceof Error) && safe && typeof safe === 'object') {
            Object.defineProperties(failure, Object.getOwnPropertyDescriptors(safe));
        }
        failure.iigPromptModelRedacted = true;
        throw failure;
    }
}

async function testPromptModelGeminiConnection() {
    throwIfSignalAborted();
    const controller = new AbortController();
    const timeout = setIigTimeout(() => controller.abort('timeout'), PROMPT_MODEL_TEST_TIMEOUT_MS);
    let config;
    try {
        config = resolvePromptModelGeminiConfig();
        return await requestPromptModelGemini(
            [{ role: 'user', content: 'Reply OK' }],
            config,
            controller.signal,
            true,
        );
    } catch (error) {
        const timedOut = controller.signal.aborted && controller.signal.reason === 'timeout';
        const apiKey = config?.apiKey || promptModelGeminiSettings().apiKey;
        const detail = timedOut ? PROMPT_MODEL_I18N.en.connectionTimedOut
            : redactPromptModelGeminiError(error?.message || error, apiKey);
        iigLog('WARN', 'Prompt Model Gemini connection test failed:', detail);
        const vars = error?.i18nVars ? Object.fromEntries(Object.entries(error.i18nVars)
            .map(([key, value]) => [key, redactPromptModelGeminiError(value, apiKey)])) : { detail };
        throw iigError(detail, timedOut ? 'iig_pm_connectionTimedOut' : error?.i18n || 'iig_pm_providerError', timedOut ? null : vars);
    } finally {
        clearIigTimeout(timeout);
    }
}

function abortPromptModelRequest(key, reason = 'superseded') {
    const controller = _promptModelControllers.get(key);
    if (!controller) return;
    try { controller.abort(reason); } catch (_) {}
    _promptModelControllers.delete(key);
}

function abortAllPromptModelRequests(reason = 'chat-changed') {
    for (const [key, controller] of _promptModelControllers) {
        try { controller.abort(reason); } catch (_) {}
        _promptModelControllers.delete(key);
    }
    _promptModelCaptures.clear();
    _promptModelGeneration = null;
}

async function requestPromptModelBlock(messageId, narrative, capture, corrective = '') {
    throwIfSignalAborted();
    const ctx = getContext();
    const pm = promptModelSettings();
    const key = buildProcessingKey(messageId);
    abortPromptModelRequest(key);
    const controller = new AbortController();
    _promptModelControllers.set(key, controller);
    const timeout = setIigTimeout(() => controller.abort('timeout'), PROMPT_MODEL_TIMEOUT_MS);
    try {
        const messages = buildPromptModelMessages(messageId, narrative, capture, corrective);
        if (pm.connection === 'gemini') {
            return await requestPromptModelGemini(messages, resolvePromptModelGeminiConfig(), controller.signal);
        }
        const requestSettings = structuredClone(ctx.chatCompletionSettings);
        requestSettings.stream_openai = false;
        requestSettings.n = 1;
        requestSettings.request_images = false;
        requestSettings.show_thoughts = false;
        const { generate_data: payload } = await waitIig(createGenerationParameters(
            requestSettings,
            pm.model,
            'quiet',
            messages,
        ));
        throwIfSignalAborted(controller.signal);
        payload.stream = false;
        delete payload.n;
        const result = await waitIig(ctx.ChatCompletionService.processRequest(payload, {}, true, controller.signal));
        return String(result?.content || '').trim();
    } catch (error) {
        if (controller.signal.aborted) {
            const timedOut = controller.signal.reason === 'timeout';
            const abortError = iigError(timedOut ? 'Prompt Model request timed out' : 'Prompt Model request aborted',
                timedOut ? 'iig_pm_requestTimedOut' : 'iig_pm_requestAborted');
            abortError.name = 'AbortError';
            abortError.reason = controller.signal.reason;
            throw abortError;
        }
        throw error instanceof Error ? error : iigError(String(error || 'Prompt Model request failed'),
            error ? 'iig_pm_providerError' : 'iig_pm_requestFailed', { detail: String(error || '') });
    } finally {
        clearIigTimeout(timeout);
        if (_promptModelControllers.get(key) === controller) _promptModelControllers.delete(key);
    }
}

function findTagOccurrenceIndex(source, fullMatch, occurrence, excludedRange = null) {
    const text = String(source || '');
    if (!fullMatch) return -1;
    let from = 0;
    for (let index = 0; index <= occurrence;) {
        const found = text.indexOf(fullMatch, from);
        if (found < 0) return -1;
        from = found + fullMatch.length;
        if (excludedRange && found >= excludedRange.start && found < excludedRange.end) continue;
        if (index++ === occurrence) return found;
    }
    return -1;
}

function buildMainModelRerollMessages(cleanNarrative, capture, corrective = '') {
    if (!capture?.chat) throw iigError('The exact generation context is no longer available', 'iig_pm_contextUnavailable');
    const messages = structuredClone(capture.chat);
    const assistantIndex = messages.findLastIndex(message => message?.role === 'assistant');
    if (capture.type === 'continue' && assistantIndex >= 0) {
        messages.splice(assistantIndex + 1);
        messages[assistantIndex] = { ...messages[assistantIndex], content: cleanNarrative };
    } else {
        messages.push({ role: 'assistant', content: cleanNarrative });
    }
    messages.push({
        role: 'user',
        content: [
            '[Regenerate only the selected image instruction for the assistant response above.]',
            '[Output exactly one HTML image block in this structure: <img data-iig-instruction=\'{"prompt":"detailed visual prompt"}\' src="[IMG:GEN]">.]',
            '[Do not continue the narrative. Do not use markdown fences or commentary.]',
            corrective,
        ].filter(Boolean).join('\n'),
    });
    return messages;
}

async function requestCurrentMainModelBlock(messages, requestSettings, model, controller, assertCurrent = null) {
    throwIfSignalAborted(controller.signal);
    const ctx = getContext();
    const { generate_data: payload } = await waitIig(createGenerationParameters(
        requestSettings,
        model,
        'quiet',
        messages,
    ));
    throwIfSignalAborted(controller.signal);
    assertCurrent?.();
    payload.stream = false;
    delete payload.n;
    const result = await waitIig(ctx.ChatCompletionService.processRequest(payload, {}, true, controller.signal));
    return String(result?.content || '').trim();
}

async function validatePromptModelOutput(raw) {
    if (typeof globalThis.DOMPurify?.sanitize !== 'function') {
        throw iigError('DOMPurify is unavailable; Prompt Model output cannot be safely processed', 'iig_pm_sanitizerUnavailable');
    }
    let output = String(raw || '').trim();
    output = output.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (!output.includes('data-iig-instruction') || !output.includes('[IMG:GEN]')) {
        throw iigError('Response did not contain an IIG image block', 'iig_pm_imageBlockMissing');
    }
    const sanitized = globalThis.DOMPurify.sanitize(output, {
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
        FORBID_ATTR: ['srcdoc'],
    });
    const tags = await parseImageTags(sanitized, { checkExistence: false });
    const pending = tags.filter(tag => tag?.isNewFormat && tag.fullMatch?.includes('[IMG:GEN]'));
    if (!pending.length) throw iigError('Response contained no valid pending image tag', 'iig_pm_pendingTagMissing');
    for (const tag of pending) {
        if (!tag.prompt) throw iigError('Image instruction is missing a prompt', 'iig_pm_instructionPromptMissing');
        parseInstructionObject(getInstructionAttributeValue(tag));
    }
    return canonicalizePromptModelInstructionAttributes(sanitized);
}

async function validateSinglePromptModelOutput(raw) {
    const validated = await validatePromptModelOutput(raw);
    const template = document.createElement('template');
    template.innerHTML = validated;
    const images = template.content.querySelectorAll('img');
    const tags = await parseImageTags(validated, { forceAll: true });
    if (images.length !== 1 || images[0].getAttribute('src') !== '[IMG:GEN]' || tags.length !== 1
        || !tags[0].isNewFormat || !tags[0].fullMatch.includes('[IMG:GEN]')) {
        throw iigError('Response must contain exactly one pending IIG image block', 'iig_pm_singleBlockRequired');
    }
    return tags[0].fullMatch;
}

function promptModelResponseShape(raw) {
    const text = String(raw || '').trim();
    return `length=${text.length}, instruction=${text.includes('data-iig-instruction')}, marker=${text.includes('[IMG:GEN]')}, fenced=${text.startsWith('```')}`;
}

function canonicalizePromptModelInstructionAttributes(source) {
    return String(source || '').replace(
        /data-iig-instruction\s*=\s*(["'])([\s\S]*?)\1/gi,
        (fullMatch, quote, payload) => {
            try {
                const instruction = parseInstructionObject(payload);
                const json = JSON.stringify(instruction);
                return `data-iig-instruction='${sanitizeForSingleQuotedAttribute(json)}'`;
            } catch (_) {
                return fullMatch;
            }
        },
    );
}

function formatPromptModelInstructionAttributesForEdit(source) {
    return String(source || '').replace(
        /data-iig-instruction\s*=\s*(["'])([\s\S]*?)\1/gi,
        (fullMatch, quote, payload) => {
            try {
                return `data-iig-instruction='${JSON.stringify(parseInstructionObject(payload))}'`;
            } catch (_) {
                return fullMatch;
            }
        },
    );
}

function promptModelSourceHasSidecar(message) {
    const display = String(message?.extra?.display_text || '');
    const narrative = String(message?.mes || '');
    return display.includes('data-iig-sidecar="1"')
        || display.includes('data-iig-sidecar-error="1"')
        || display.includes('data-iig-instruction')
        || narrative.includes('data-iig-instruction');
}

function writePromptModelDisplayText(message, displayText) {
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    message.extra.display_text = displayText;
    const swipeId = getMessageSwipeId(message);
    const swipeInfo = message.swipe_info?.[swipeId];
    if (swipeInfo) {
        if (!swipeInfo.extra || typeof swipeInfo.extra !== 'object') swipeInfo.extra = {};
        swipeInfo.extra.display_text = displayText;
    }
}

function appendPromptModelSidecar(message, block) {
    const base = String(message.extra?.display_text ?? message.mes ?? '');
    const spacer = base && !base.endsWith('\n') ? '\n\n' : '';
    const canonicalBlock = canonicalizePromptModelInstructionAttributes(block);
    writePromptModelDisplayText(message, `${base}${spacer}<div class="iig-sidecar" data-iig-sidecar="1">${canonicalBlock}</div>`);
}

function stripPromptModelArtifactsFromHtml(value) {
    const template = document.createElement('template');
    template.innerHTML = String(value || '');
    template.content.querySelectorAll('[data-iig-sidecar="1"], [data-iig-sidecar-error="1"]').forEach(node => node.remove());
    return template.innerHTML.trimEnd();
}

function appendPromptModelError(message, error) {
    const base = stripPromptModelArtifactsFromHtml(message.extra?.display_text ?? message.mes ?? '');
    // Persisted into the chat file and its exports, so redact before storing.
    const safe = sanitizeForHtml(iigErrorText(error || iigError('Prompt Model failed', 'iig_pm_failed')));
    const spacer = base && !base.endsWith('\n') ? '\n\n' : '';
    writePromptModelDisplayText(message,
        `${base}${spacer}<div class="iig-pm-error" data-iig-sidecar-error="1">`
        + `<span>${safe}</span><button type="button" class="menu_button iig-pm-retry" data-iig-pm-retry="1">${sanitizeForHtml(pmT('retry'))}</button></div>`);
}

function removePromptModelArtifacts(message) {
    if (!message) return false;
    const current = message.extra?.display_text;
    if (typeof current !== 'string') return false;
    const cleaned = stripPromptModelArtifactsFromHtml(current);
    if (cleaned === current) return false;
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    if (cleaned.trim() === String(message.mes || '').trim()) delete message.extra.display_text;
    else message.extra.display_text = cleaned;
    const swipeId = getMessageSwipeId(message);
    const swipeExtra = message.swipe_info?.[swipeId]?.extra;
    if (swipeExtra && typeof swipeExtra.display_text === 'string') {
        const swipeCleaned = stripPromptModelArtifactsFromHtml(swipeExtra.display_text);
        if (swipeCleaned.trim() === String(message.mes || '').trim()) delete swipeExtra.display_text;
        else swipeExtra.display_text = swipeCleaned;
    }
    return true;
}

function showPromptModelComposing(messageId, requestKey) {
    const text = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!text || text.querySelector('.iig-pm-composing')) return null;
    const placeholder = createPromptModelComposing(() => abortPromptModelRequest(requestKey, 'user-cancel'));
    text.appendChild(placeholder);
    return placeholder;
}

function createPromptModelComposing(onStop) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-pm-composing';
    placeholder.innerHTML = `<span class="iig-pm-spark">✦</span>`
        + `<span class="iig-pm-composing-text"></span>`
        + `<button type="button" class="menu_button iig-pm-stop" title="${sanitizeForHtml(pmT('stop'))}" aria-label="${sanitizeForHtml(pmT('stop'))}">`
        + `${SVG_ICON_STOP}<span>${sanitizeForHtml(pmT('stop'))}</span></button>`;
    const status = placeholder.querySelector('.iig-pm-composing-text');
    const stopButton = placeholder.querySelector('.iig-pm-stop');
    placeholder._stopRequested = false;
    stopButton?.addEventListener('click', () => {
        if (stopButton.disabled) return;
        placeholder._stopRequested = true;
        stopButton.disabled = true;
        stopButton.querySelector('span').textContent = pmT('stopping');
        onStop();
    });
    const startedAt = Date.now();
    const updateInterval = _lowPowerSlowUpdates() ? 5000 : 1000;
    const timeoutSeconds = PROMPT_MODEL_TIMEOUT_MS / 1000;
    const composingText = pmT('composing');
    const updateElapsed = () => {
        const elapsed = Math.min(Math.floor((Date.now() - startedAt) / 1000), timeoutSeconds);
        const minutes = Math.floor(elapsed / 60);
        const seconds = String(elapsed % 60).padStart(2, '0');
        status.textContent = `${composingText} · ${minutes}:${seconds}`;
        if (elapsed >= timeoutSeconds) unregisterPlaceholderTick(placeholder);
    };
    updateElapsed();
    registerPlaceholderTick(placeholder, updateElapsed, updateInterval);
    return placeholder;
}

async function generatePromptModelSidecar(messageId, type, options = {}) {
    if (_iigDisposed) return false;
    const ctx = getContext();
    const pm = promptModelSettings();
    const safeError = error => {
        const template = typeof error?.i18n === 'string' && error.i18n.startsWith('iig_pm_')
            && PROMPT_MODEL_I18N.en[error.i18n.slice(7)];
        // Host-owned credentials are unavailable. Do not expose unknown diagnostics.
        return typeof template === 'string' && (error.iigPromptModelRedacted === true || !template.includes('{'))
            ? error : iigError('Prompt Model request failed', 'iig_pm_requestFailed');
    };
    const message = ctx?.chat?.[messageId];
    const allowedTypes = new Set(['normal', 'regenerate', 'swipe', 'continue', 'append', 'appendFinal']);
    if (!getSettings().enabled || !pm.enabled || !isPromptModelAvailable() || !pm.snapshot.content) return false;
    if (!message || message.is_user || message.is_system || !allowedTypes.has(String(type || 'normal'))) return false;
    if (!options.retry && promptModelSourceHasSidecar(message)) return false;

    if (options.retry && removePromptModelArtifacts(message)) {
        ctx.updateMessageBlock(messageId, message);
    }
    const key = buildProcessingKey(messageId);
    const narrative = String(message.mes || '');
    const capture = options.capture || getOwnedPromptModelCapture(_promptModelCaptures, key) || bindPromptModelCapture(messageId, type);
    const placeholder = showPromptModelComposing(messageId, key);
    const throwIfStopped = () => {
        throwIfSignalAborted();
        if (!placeholder?._stopRequested) return;
        const error = iigError('Prompt Model request aborted', 'iig_pm_requestAborted');
        error.name = 'AbortError';
        error.reason = 'user-cancel';
        throw error;
    };
    try {
        if (typeof globalThis.DOMPurify?.sanitize !== 'function') {
            throw iigError('DOMPurify is unavailable; Prompt Model output cannot be safely processed', 'iig_pm_sanitizerUnavailable');
        }
        let raw = await requestPromptModelBlock(messageId, narrative, capture);
        throwIfStopped();
        let block;
        try {
            block = await validatePromptModelOutput(raw);
            throwIfStopped();
        } catch (firstError) {
            throwIfStopped();
            if (typeof globalThis.DOMPurify?.sanitize !== 'function') throw firstError;
            iigLog('WARN', `Prompt Model output invalid; retrying: ${iigErrorText(safeError(firstError))}; ${promptModelResponseShape(raw)}`);
            raw = await requestPromptModelBlock(
                messageId,
                narrative,
                capture,
                '[Correction: your previous response was invalid. Return only valid HTML with a brace-parseable data-iig-instruction JSON object and src="[IMG:GEN]".]',
            );
            throwIfStopped();
            try {
                block = await validatePromptModelOutput(raw);
            } catch (secondError) {
                iigLog('WARN', `Prompt Model corrective output invalid: ${iigErrorText(safeError(secondError))}; ${promptModelResponseShape(raw)}`);
                throw secondError;
            }
            throwIfStopped();
        }

        const liveMessage = getContext()?.chat?.[messageId];
        if (_iigDisposed || !getSettings().enabled || !promptModelSettings().enabled || !liveMessage
            || buildProcessingKey(messageId) !== key || String(liveMessage.mes || '') !== narrative) {
            iigLog('INFO', `Discarded stale Prompt Model result for ${key}`);
            return false;
        }
        appendPromptModelSidecar(liveMessage, block);
        recentlyProcessed.delete(key);
        ctx.updateMessageBlock(messageId, liveMessage);
        await ctx.saveChat();
        const savedMessage = getContext()?.chat?.[messageId];
        if (getSettings().enabled && promptModelSettings().enabled && savedMessage === liveMessage
            && buildProcessingKey(messageId) === key && String(savedMessage.mes || '') === narrative) {
            playDesktopCompletionSound();
        }
        await processMessageTags(messageId, { force: true });
        _promptModelCaptures.delete(key);
        return true;
    } catch (error) {
        const aborted = error?.name === 'AbortError' || /abort/i.test(error?.message || '');
        if (aborted && error?.reason !== 'timeout') {
            iigLog('INFO', `Prompt Model request aborted for ${key}`);
            _promptModelCaptures.delete(key);
            if (error?.reason === 'user-cancel') {
                toastr.info(pmT('stopped'), pmT('title'), { timeOut: 2000 });
            }
            return false;
        }
        const liveMessage = getContext()?.chat?.[messageId];
        if (_iigDisposed || !getSettings().enabled || !promptModelSettings().enabled || !liveMessage
            || buildProcessingKey(messageId) !== key || String(liveMessage.mes || '') !== narrative) {
            _promptModelCaptures.delete(key);
            return false;
        }
        error = safeError(error);
        iigLog('ERROR', 'Prompt Model generation failed:', iigErrorText(error));
        appendPromptModelError(liveMessage, error);
        ctx.updateMessageBlock(messageId, liveMessage);
        await ctx.saveChat();
        sessionErrorCount++;
        updateSessionStats();
        toastr.error(sanitizeForHtml(iigErrorText(error)), sanitizeForHtml(pmT('title')), { escapeHtml: false });
        return false;
    } finally {
        unregisterPlaceholderTick(placeholder);
        placeholder?.remove();
    }
}

function schedulePromptModelSidecar(messageId, type) {
    if (_iigDisposed) return;
    bindPromptModelCapture(messageId, type);
    if (!promptModelSettings().enabled || !isPromptModelAvailable()) {
        _promptModelCaptures.delete(buildProcessingKey(messageId));
        return;
    }
    queueMicrotask(() => {
        if (_iigDisposed) return;
        trackIigTask(generatePromptModelSidecar(messageId, type)).catch(() =>
            iigLog('ERROR', 'Prompt Model sidecar task crashed'));
    });
}

async function retryPromptModelSidecar(messageId) {
    const capture = getCachedPromptModelCapture(buildProcessingKey(messageId));
    return generatePromptModelSidecar(messageId, 'normal', { retry: true, capture });
}

async function rerollSelectedMessageImage(imgElement, resolvedSource = null) {
    if (_iigDisposed) return false;
    const resolved = resolvedSource || await resolveRenderedImageSource(imgElement);
    if (_iigDisposed) return false;
    if (!resolved || !resolved.tag.isNewFormat) return false;
    const { messageId, message, tag, source } = resolved;
    invalidateContextCache();
    const context = getContext();
    const scope = buildProcessingKey(messageId);
    const capture = getCachedPromptModelCapture(scope);
    if (!capture?.chat) {
        toastr.warning(pmT('contextUnavailable'), pmT('title'));
        return false;
    }
    if (context?.mainApi !== 'openai') {
        toastr.warning(pmT('notChatCompletion'), pmT('title'));
        return false;
    }

    const wrapper = imgElement.closest('.iig-image-wrapper');
    const messageElement = imgElement.closest('.mes[mesid]');
    if (!wrapper || !messageElement || wrapper._iigRewriteController || wrapper._iigRegenerateController) return false;
    const wasHidden = wrapper.hidden;
    const focusedControl = wrapper.contains(document.activeElement) ? document.activeElement : null;
    const sidecar = tag.inSidecar === true;
    const swipeId = getMessageSwipeId(message);
    const swipeInfo = message.swipe_info?.[swipeId];
    const swipes = message.swipes;
    const original = { mes: message.mes, display: message.extra?.display_text,
        swipe: swipes?.[swipeId], swipeDisplay: swipeInfo?.extra?.display_text };
    let expected = original;
    const originalSrc = imgElement.getAttribute('src');
    const originalInstruction = imgElement.getAttribute('data-iig-instruction');
    const renderedImages = Array.from(messageElement.querySelectorAll('.mes_text img[data-iig-instruction]'));
    const { controller, key } = beginGeneration(messageId, tag);
    wrapper._iigRewriteController = controller;
    const tagId = `iig-rewrite-${messageId}-${++_singleImageGenerationSerial}`;
    tagAbortControllers.set(tagId, controller);
    let timeout = null;
    let placeholder = null;
    let settingsSnapshot;
    let completionSnapshot;
    let guidance;
    let phase = 'prompt';
    const controls = Array.from(wrapper.querySelectorAll('.iig-action-regen, .iig-action-prompt-regen'))
        .map(button => ({ button, disabled: button.disabled }));
    const sameScope = () => {
        invalidateContextCache();
        const current = getContext();
        return current?.chat === context.chat && current?.chat?.[messageId] === message
            && current.characterId === context.characterId && current.groupId === context.groupId
            && buildProcessingKey(messageId) === scope && message.swipes === swipes
            && message.swipe_info?.[swipeId] === swipeInfo;
    };
    const assertCurrent = () => {
        const scoped = sameScope();
        const current = getContext();
        const images = Array.from(messageElement.querySelectorAll('.mes_text img[data-iig-instruction]'));
        const valid = scoped && !_iigDisposed && !controller.signal.aborted
            && _inFlightGenerations.get(key) === controller && current?.mainApi === 'openai'
            && getSettings().enabled && JSON.stringify(getSettings()) === settingsSnapshot
            && JSON.stringify(current.chatCompletionSettings) === completionSnapshot
            && getPromptModelGuidance() === guidance
            && message.mes === expected.mes && message.extra?.display_text === expected.display
            && swipes?.[swipeId] === expected.swipe && swipeInfo?.extra?.display_text === expected.swipeDisplay
            && !_promptModelEditSessions.has(message) && !messageElement.querySelector('.mes_edit_textarea')
            && imgElement.isConnected && imgElement.closest('.mes[mesid]') === messageElement
            && messageElement.getAttribute('mesid') === String(messageId)
            && imgElement.parentElement === wrapper && wrapper._iigRewriteController === controller
            && imgElement.getAttribute('src') === originalSrc
            && imgElement.getAttribute('data-iig-instruction') === originalInstruction
            && images.length === renderedImages.length && images.every((img, index) => img === renderedImages[index]);
        if (valid) return;
        const error = iigError('Prompt reroll context changed', 'iig_pm_rerollContextChanged');
        error.name = 'AbortError';
        error.reason = controller.signal.reason || 'context-changed';
        if (!controller.signal.aborted) controller.abort(error.reason);
        throw error;
    };

    try {
        const pm = promptModelSettings();
        if (sidecar && (!pm.enabled || !pm.snapshot.content || !isPromptModelAvailable())) {
            throw iigError('Prompt Model request failed', 'iig_pm_requestFailed');
        }
        const gemini = sidecar && pm.connection === 'gemini' ? resolvePromptModelGeminiConfig() : null;
        settingsSnapshot = JSON.stringify(getSettings());
        completionSnapshot = JSON.stringify(context.chatCompletionSettings);
        guidance = getPromptModelGuidance();
        const requestSettings = structuredClone(context.chatCompletionSettings);
        requestSettings.stream_openai = false;
        requestSettings.n = 1;
        requestSettings.request_images = false;
        requestSettings.show_thoughts = false;
        const model = gemini?.model || (sidecar ? pm.model : getChatCompletionModel(requestSettings));
        if (!model) throw iigError('No current Chat Completion model is selected', 'iig_pm_mainModelMissing');
        assertCurrent();
        if (getMessageTagSource(message, tag.sourceKey) !== source
            || source.slice(tag.sourceIndex, tag.sourceIndex + tag.fullMatch.length) !== tag.fullMatch) {
            throw iigError('Selected image source changed before replacement', 'iig_pm_imageSourceChanged');
        }
        controls.forEach(({ button }) => { button.disabled = true; });
        placeholder = createPromptModelComposing(() => abortGenerationForTag(tagId));
        placeholder.dataset.tagId = tagId;
        wrapper.after(placeholder);
        wrapper.hidden = true;
        if (focusedControl) placeholder.querySelector('.iig-pm-stop')?.focus({ preventScroll: true });
        const setStatus = text => {
            assertCurrent();
            const status = placeholder.querySelector('.iig-status');
            if (status) status.textContent = text;
        };
        timeout = setIigTimeout(() => controller.abort('timeout'), PROMPT_MODEL_TIMEOUT_MS);
        const cleanNarrative = tag.sourceKey === 'mes'
            ? source.slice(0, tag.sourceIndex) + source.slice(tag.sourceIndex + tag.fullMatch.length)
            : String(message.mes || '');
        const selected = `[Rewrite only this selected image instruction, preserving relevant reference names and configuration. Return exactly one pending image, not the surrounding block.]\n${JSON.stringify(parseInstructionObject(originalInstruction))}`;
        const messages = sidecar
            ? buildPromptModelMessages(messageId, cleanNarrative, capture, selected)
            : buildMainModelRerollMessages(cleanNarrative, capture, selected);
        const request = () => {
            assertCurrent();
            return gemini ? requestPromptModelGemini(messages, gemini, controller.signal)
                : requestCurrentMainModelBlock(messages, requestSettings, model, controller, assertCurrent);
        };
        let raw = await request();
        assertCurrent();
        let block;
        try {
            block = await validateSinglePromptModelOutput(raw);
        } catch (firstError) {
            assertCurrent();
            if (typeof globalThis.DOMPurify?.sanitize !== 'function') throw firstError;
            messages[messages.length - 1].content += '\n[Correction: return exactly one valid HTML image block with brace-parseable instruction JSON and src="[IMG:GEN]".]';
            raw = await request();
            assertCurrent();
            block = await validateSinglePromptModelOutput(raw);
        }
        assertCurrent();
        clearIigTimeout(timeout);
        timeout = null;
        const [replacementTag] = await parseImageTags(block, { forceAll: true });
        assertCurrent();
        const instruction = getInstructionAttributeValue(replacementTag);
        const data = parseInstructionObject(instruction);
        phase = 'image';
        const focusProgress = placeholder.contains(document.activeElement);
        unregisterPlaceholderTick(placeholder);
        placeholder.remove();
        placeholder = createLoadingPlaceholder(tagId);
        wrapper.after(placeholder);
        if (focusProgress) placeholder.querySelector('.iig-stop-btn')?.focus({ preventScroll: true });
        const dataUrl = await generateImageWithRetry(data.prompt, data.style || '', setStatus, {
            aspectRatio: data.aspect_ratio || data.aspectRatio || null,
            imageSize: data.image_size || data.imageSize || null,
            quality: data.quality || null, preset: data.preset || null, signal: controller.signal,
        });
        assertCurrent();
        setStatus(iigT('iig_saving'));
        const imagePath = await saveImageToFile(dataUrl, controller.signal);
        assertCurrent();
        if (!safeMediaUrlOrNull(imagePath)) throw new Error('Invalid saved image path');
        // Persist only a canonical image, never model-authored event attributes or surrounding HTML.
        const replacement = `<img data-iig-instruction='${sanitizeForSingleQuotedAttribute(JSON.stringify(data))}' src="${escapeAttr(imagePath)}">`;
        phase = 'save';
        await queueSingleImageCommit(message, async () => {
            assertCurrent();
            const writes = [];
            const write = (owner, field, value, owns) => {
                if (writes.some(entry => entry.owner === owner && entry.field === field)) return;
                writes.push({ owner, field, value, before: owner[field], had: Object.hasOwn(owner, field), owns });
            };
            const splice = (text, index) => text.slice(0, index) + replacement + text.slice(index + tag.fullMatch.length);
            let display = original.display;
            if (tag.sourceKey === 'mes') {
                const mes = splice(source, tag.sourceIndex);
                write(message, 'mes', mes, () => true);
                if (Array.isArray(swipes) && typeof original.swipe === 'string') {
                    if (original.swipe !== original.mes) throw iigError('Selected image source changed before replacement', 'iig_pm_imageSourceChanged');
                    write(swipes, swipeId, mes, () => message.swipes === swipes);
                }
                if (typeof display === 'string') {
                    const index = findTagOccurrenceIndex(display, tag.fullMatch, tag.occurrence, findPromptModelSidecarRange(display));
                    if (index >= 0) display = splice(display, index);
                }
            } else {
                display = splice(source, tag.sourceIndex);
            }
            if (display !== original.display) {
                const extra = message.extra;
                write(extra, 'display_text', display, () => message.extra === extra);
                if (swipeInfo) {
                    if (original.swipeDisplay !== undefined && original.swipeDisplay !== original.display) {
                        throw iigError('Selected image source changed before replacement', 'iig_pm_imageSourceChanged');
                    }
                    if (!swipeInfo.extra) swipeInfo.extra = {};
                    const extra = swipeInfo.extra;
                    write(extra, 'display_text', display, () => swipeInfo.extra === extra);
                }
            }
            // The host save cannot be canceled. Stop applies until this synchronous commit boundary.
            const stop = placeholder.querySelector('.iig-stop-btn');
            if (stop) stop.disabled = true;
            tagAbortControllers.delete(tagId);
            for (const entry of writes) entry.owner[entry.field] = entry.value;
            expected = { mes: message.mes, display: message.extra?.display_text,
                swipe: swipes?.[swipeId], swipeDisplay: swipeInfo?.extra?.display_text };
            try {
                await context.saveChat();
            } catch (_) {
                // A rejected save can only undo our still-owned values, never a later edit or swipe.
                let restored = false;
                if (!_iigDisposed && sameScope()) for (const entry of writes) {
                    if (!entry.owns() || entry.owner[entry.field] !== entry.value) continue;
                    if (entry.had) entry.owner[entry.field] = entry.before;
                    else delete entry.owner[entry.field];
                    restored = true;
                }
                if (restored && !_iigDisposed && sameScope()) {
                    try { await context.saveChat(); }
                    catch (_) { iigLog('ERROR', 'Selected image recovery save failed'); }
                }
                throw iigError('Chat save failed', 'iig_chatSaveFailed');
            }
        });
        assertCurrent();
        const newImg = document.createElement('img');
        newImg.className = 'iig-generated-image';
        newImg.src = imagePath;
        newImg.alt = data.prompt;
        newImg.title = iigT('iig_imageDetails', { style: data.style || '', prompt: data.prompt });
        newImg.setAttribute('data-iig-instruction', JSON.stringify(data));
        const focusReplacement = placeholder.contains(document.activeElement);
        const newWrapper = wrapImageWithActions(newImg);
        wrapper.replaceWith(newWrapper);
        if (focusReplacement) newWrapper.querySelector('.iig-action-prompt-regen')?.focus({ preventScroll: true });
        sessionGenCount++;
        updateSessionStats();
        playDesktopCompletionSound();
        toastr.success(sanitizeForHtml(iigT('iig_imageRegenerated')), sanitizeForHtml(iigT('iig_title')), { timeOut: 2000, escapeHtml: false });
        return true;
    } catch (error) {
        if (_iigDisposed || !sameScope()) return false;
        if ((error?.name === 'AbortError' || controller.signal.aborted) && controller.signal.reason !== 'timeout') {
            if (controller.signal.reason === 'user-cancel') {
                toastr.info(pmT('stopped'), pmT('title'), { timeOut: 2000 });
            }
            return false;
        }
        const template = typeof error?.i18n === 'string' && error.i18n.startsWith('iig_pm_')
            && PROMPT_MODEL_I18N.en[error.i18n.slice(7)];
        const text = controller.signal.reason === 'timeout' ? pmT('requestTimedOut')
            : phase === 'save' ? iigT('iig_chatSaveFailed')
                : typeof template === 'string' && (error.iigPromptModelRedacted === true || !template.includes('{'))
                    ? iigErrorText(error) : pmT('requestFailed');
        iigLog('ERROR', 'Selected image rewrite failed:', text);
        toastr.error(sanitizeForHtml(text), sanitizeForHtml(pmT('title')), { escapeHtml: false });
        return false;
    } finally {
        const restoreFocus = placeholder?.contains(document.activeElement);
        clearIigTimeout(timeout);
        unregisterPlaceholderTick(placeholder);
        placeholder?.remove();
        if (wrapper._iigRewriteController === controller) {
            delete wrapper._iigRewriteController;
            if (!_iigDisposed) {
                wrapper.hidden = wasHidden;
                controls.forEach(({ button, disabled }) => { if (button.isConnected) button.disabled = disabled; });
                if (restoreFocus && focusedControl?.isConnected) {
                    // The delegated sparkle handler disables its button before resolving the source.
                    if (focusedControl.dataset.iigPmReroll === '1') focusedControl.disabled = false;
                    focusedControl.focus({ preventScroll: true });
                }
            }
        }
        tagAbortControllers.delete(tagId);
        endGeneration(key, controller);
    }
}

const _promptModelEditSessions = new Map();
let _promptModelEditBridgeReady = false;
let _promptModelEditObserver = null;
const PROMPT_MODEL_EDIT_MARKER = '<!-- iig -->';

function findPromptModelSidecarRange(source) {
    const text = String(source || '');
    const opening = /<div\b(?=[^>]*\bdata-iig-sidecar(?:-error)?\s*=\s*(['"])1\1)[^>]*>/i.exec(text);
    if (!opening) return null;

    let depth = 1;
    let cursor = opening.index + opening[0].length;
    while (cursor < text.length) {
        const tagStart = text.indexOf('<', cursor);
        if (tagStart < 0) break;
        let quote = '';
        let tagEnd = -1;
        for (let index = tagStart + 1; index < text.length; index++) {
            const char = text[index];
            if (quote) {
                if (char === quote && text[index - 1] !== '\\') quote = '';
                continue;
            }
            if (char === '"' || char === "'") {
                quote = char;
            } else if (char === '>') {
                tagEnd = index + 1;
                break;
            }
        }
        if (tagEnd < 0) break;
        const tag = text.slice(tagStart, tagEnd);
        if (/^<div\b/i.test(tag) && !/\/\s*>$/.test(tag)) depth++;
        if (/^<\/div\s*>$/i.test(tag)) {
            depth--;
            if (depth === 0) return { start: opening.index, end: tagEnd };
        }
        cursor = tagEnd;
    }
    return { start: opening.index, end: text.length };
}

function promptModelSidecarInnerHtml(wrapper) {
    const text = String(wrapper || '');
    const openingEnd = text.indexOf('>');
    const closingStart = text.lastIndexOf('</div>');
    if (openingEnd < 0 || closingStart < openingEnd) return text;
    return text.slice(openingEnd + 1, closingStart);
}

function canonicalizeEditedPromptModelInstructions(source, replacements = null) {
    const text = String(source || '');
    const attributeStart = /data-iig-instruction\s*=\s*(["'])/gi;
    let output = '';
    let cursor = 0;
    let match;

    while ((match = attributeStart.exec(text))) {
        output += text.slice(cursor, match.index);
        const quote = match[1];
        const valueStart = match.index + match[0].length;
        let valueEnd = -1;
        let instruction = null;

        for (let index = valueStart; index < text.length; index++) {
            if (text[index] !== quote || text[index - 1] === '\\') continue;
            try {
                instruction = JSON.parse(normalizeInstructionPayload(text.slice(valueStart, index)));
                valueEnd = index;
                break;
            } catch (_) {}
        }

        if (valueEnd < 0) {
            output += text.slice(match.index);
            return output;
        }

        const replacement = `${match[0].slice(0, -1)}'${sanitizeForSingleQuotedAttribute(JSON.stringify(instruction))}'`;
        output += replacement;
        cursor = valueEnd + 1;
        replacements?.push({ end: cursor, delta: replacement.length - (cursor - match.index) });
        attributeStart.lastIndex = cursor;
    }

    return output + text.slice(cursor);
}

/** Repair edited JSON quoting before HTML parsing; canonicalize sanitized output
 * afterward so the brace scanner receives literal JSON double quotes. */
function sanitizeSidecarHtml(html) {
    if (typeof globalThis.DOMPurify?.sanitize !== 'function') {
        throw iigError('DOMPurify is unavailable; edited sidecar cannot be safely processed', 'iig_pm_editSanitizerUnavailable');
    }
    return globalThis.DOMPurify.sanitize(String(html || ''), {
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
        FORBID_ATTR: ['srcdoc'],
    });
}

// Throws if DOMPurify is unavailable — see sanitizeSidecarHtml.
function splitPromptModelEditableSource(source) {
    const text = String(source || '');
    const markerPattern = new RegExp(`(^|\\n\\n)${PROMPT_MODEL_EDIT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\r?\\n|$)`, 'g');
    let markerIndex = -1;
    for (const match of text.matchAll(markerPattern)) markerIndex = match.index + match[1].length;
    if (markerIndex >= 0) {
        let narrative = text.slice(0, markerIndex);
        if (narrative.endsWith('\n\n')) narrative = narrative.slice(0, -2);
        const inner = text.slice(markerIndex + PROMPT_MODEL_EDIT_MARKER.length).replace(/^\r?\n/, '').trim();
        const canonicalInner = canonicalizeEditedPromptModelInstructions(
            sanitizeSidecarHtml(canonicalizeEditedPromptModelInstructions(inner)));
        const sidecar = canonicalInner
            ? `<div class="iig-sidecar" data-iig-sidecar="1">${canonicalInner}</div>`
            : '';
        return { narrative, sidecar };
    }
    const replacements = [];
    const repaired = canonicalizeEditedPromptModelInstructions(text, replacements);
    const range = findPromptModelSidecarRange(repaired);
    if (!range) {
        const narrative = text.endsWith('\n\n') ? text.slice(0, -2) : text;
        return { narrative, sidecar: '' };
    }
    // Map repaired HTML offsets back to the untouched surrounding narrative.
    const originalOffset = offset => {
        let delta = 0;
        for (const replacement of replacements) {
            if (replacement.end + delta + replacement.delta > offset) break;
            delta += replacement.delta;
        }
        return offset - delta;
    };
    let before = text.slice(0, originalOffset(range.start));
    if (before.endsWith('\n\n')) before = before.slice(0, -2);
    const narrative = `${before}${text.slice(originalOffset(range.end))}`;
    const sidecar = canonicalizePromptModelInstructionAttributes(
        sanitizeSidecarHtml(repaired.slice(range.start, range.end).trim())
    );
    return { narrative, sidecar };
}

function promptModelEditableSource(message) {
    const display = String(message?.extra?.display_text || '');
    const range = findPromptModelSidecarRange(display);
    if (!range) return '';
    const sidecar = canonicalizePromptModelInstructionAttributes(display.slice(range.start, range.end).trim());
    const narrative = String(message?.mes || '');
    if (!sidecar.includes('data-iig-sidecar="1"')) {
        return `${narrative}${narrative ? '\n\n' : ''}${sidecar}`;
    }
    const inner = formatPromptModelInstructionAttributesForEdit(promptModelSidecarInnerHtml(sidecar)).trim();
    return `${narrative}${narrative ? '\n\n' : ''}${PROMPT_MODEL_EDIT_MARKER}\n${inner}`;
}

function isPromptModelEditSessionCurrent(message) {
    const session = _promptModelEditSessions.get(message);
    if (_iigDisposed || !message || !session) return false;
    invalidateContextCache();
    const context = getContext();
    return context.chat === session.chat && context.chatId === session.chatId && context.chat.includes(message)
        && getMessageSwipeId(message) === session.swipeId
        && (!session.swipe || message.swipe_info?.[session.swipeId] === session.swipe);
}

function reconcilePromptModelEdit(message, source) {
    if (!isPromptModelEditSessionCurrent(message)) return false;
    const session = _promptModelEditSessions.get(message);

    let split;
    try {
        split = splitPromptModelEditableSource(source);
    } catch (e) {
        // The host writes the draft before MESSAGE_EDITED. Keep that failed draft in the editor only.
        if (message.mes === source) message.mes = session.narrative;
        if (message.swipes?.[session.swipeId] === source) message.swipes[session.swipeId] = session.narrative;
        iigLog('ERROR', `Prompt Model edit not applied — ${e.message}`);
        toastr.error(pmT('editFailed'), iigT('iig_title'));
        return false;
    }
    writePromptModelEditedSource(message, split, session.swipeId);
    session.narrative = split.narrative;
    return true;
}

function writePromptModelEditedSource(message, { narrative, sidecar }, swipeId = getMessageSwipeId(message)) {
    message.mes = narrative;
    if (Array.isArray(message.swipes) && swipeId < message.swipes.length) {
        message.swipes[swipeId] = narrative;
    }

    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    const displayText = sidecar ? `${narrative}${narrative ? '\n\n' : ''}${sidecar}` : '';
    if (displayText) message.extra.display_text = displayText;
    else delete message.extra.display_text;

    const swipeInfo = message.swipe_info?.[swipeId];
    if (swipeInfo) {
        if (!swipeInfo.extra || typeof swipeInfo.extra !== 'object') swipeInfo.extra = {};
        if (displayText) swipeInfo.extra.display_text = displayText;
        else delete swipeInfo.extra.display_text;
    }
}

async function copyPromptModelEditedMessage(button, textarea, message) {
    if (_iigDisposed || button.disabled || !isPromptModelEditSessionCurrent(message)) return;
    invalidateContextCache();
    const context = getContext();
    const id = context.chat.indexOf(message);
    const scope = buildProcessingKey(id);
    const swipe = message.swipe_info?.[getMessageSwipeId(message)];
    const draft = textarea.value;
    const mes = message.mes, display = message.extra?.display_text;
    button.disabled = true;
    try {
        if (!await showIigConfirm(sanitizeForHtml(pmT('title')), sanitizeForHtml(pmT('copyConfirm')))) return;
        if (!isMessageImageScopeCurrent(context, message, id, scope) || !isPromptModelEditSessionCurrent(message) || !textarea.isConnected
            || textarea.closest('.mes[mesid]')?.getAttribute('mesid') !== String(id)
            || textarea.value !== draft || message.mes !== mes || message.extra?.display_text !== display
            || message.swipe_info?.[getMessageSwipeId(message)] !== swipe) return;
        const split = splitPromptModelEditableSource(draft);
        if (context.powerUserSettings?.trim_spaces) split.narrative = split.narrative.trim();
        const clone = structuredClone(message);
        clone.send_date = Date.now();
        writePromptModelEditedSource(clone, split);
        context.chat.splice(id + 1, 0, clone);
        context.addOneMessage(clone, { insertAfter: id, scroll: false });
        updateViewMessageIds();
        scheduleWrapPass();
        await context.saveChat();
    } catch (_) {
        if (!_iigDisposed && isMessageImageScopeCurrent(context, message, id, scope)) {
            iigLog('ERROR', 'Prompt Model message copy failed');
            toastr.error(pmT('copyFailed'), iigT('iig_title'));
        }
    } finally {
        if (!_iigDisposed && button.isConnected) button.disabled = false;
    }
}

function initPromptModelEditBridge() {
    if (_iigDisposed || _promptModelEditBridgeReady) return;
    _promptModelEditBridgeReady = true;
    const ctx = getContext();

    listenIig(document, 'click', event => {
        const button = event.target.closest('.mes_edit_copy');
        const element = button?.closest('.mes[mesid]');
        const textarea = element?.querySelector('#curEditTextarea');
        if (!(textarea instanceof HTMLTextAreaElement) || textarea.dataset.iigPromptModelEdit !== '1') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        invalidateContextCache();
        const message = getContext()?.chat?.[Number(element.getAttribute('mesid'))];
        if (!message || !_promptModelEditSessions.has(message)) return;
        return copyPromptModelEditedMessage(button, textarea, message);
    }, true);

    listenIig(document, 'click', event => {
        const button = event.target.closest('.mes_edit');
        const messageElement = button?.closest('.mes[mesid]');
        if (!messageElement) return;
        _promptModelEditObserver?.disconnect();
        _promptModelEditObserver = null;
        const messageId = Number.parseInt(messageElement.getAttribute('mesid') || '', 10);
        const message = getContext()?.chat?.[messageId];
        const editable = promptModelEditableSource(message);
        if (!Number.isInteger(messageId) || !editable) return;
        const swipeId = getMessageSwipeId(message);
        const injectWhenReady = () => {
            invalidateContextCache();
            if (_iigDisposed || !messageElement.isConnected || getContext()?.chat?.[messageId] !== message
                || getMessageSwipeId(message) !== swipeId) {
                _promptModelEditObserver?.disconnect();
                _promptModelEditObserver = null;
                return;
            }
            const textarea = messageElement.querySelector('#curEditTextarea');
            if (!(textarea instanceof HTMLTextAreaElement)) return;
            _promptModelEditObserver?.disconnect();
            _promptModelEditObserver = null;
            const current = getContext();
            _promptModelEditSessions.set(message, { swipeId, swipe: message.swipe_info?.[swipeId],
                chat: current.chat, chatId: current.chatId, narrative: message.mes });
            textarea.value = editable;
            textarea.dataset.iigPromptModelEdit = '1';
            textarea.style.height = '';
            textarea.setSelectionRange(editable.length, editable.length);
        };
        _promptModelEditObserver = new MutationObserver(injectWhenReady);
        _promptModelEditObserver.observe(document.getElementById('chat') || document.body, { childList: true, subtree: true });
        queueMicrotask(injectWhenReady);
    }, true);

    listenIig(document, 'input', event => {
        const textarea = event.target;
        if (!(textarea instanceof HTMLTextAreaElement) || textarea.dataset.iigPromptModelEdit !== '1') return;
        if (getContext()?.powerUserSettings?.auto_save_msg_edits !== true) return;
        const messageElement = textarea.closest('.mes[mesid]');
        const messageId = Number.parseInt(messageElement?.getAttribute('mesid') || '', 10);
        const message = getContext()?.chat?.[messageId];
        if (!Number.isInteger(messageId) || !_promptModelEditSessions.has(message)) return;
        queueMicrotask(() => { if (!_iigDisposed) reconcilePromptModelEdit(message, message.mes); });
    }, true);

    subscribeIig(ctx.eventSource, ctx.event_types.MESSAGE_EDITED, messageId => {
        const id = Number(messageId);
        const message = getContext()?.chat?.[id];
        if (!_promptModelEditSessions.has(message) || !message) return;
        reconcilePromptModelEdit(message, message.mes);
    });

    subscribeIig(ctx.eventSource, ctx.event_types.MESSAGE_UPDATED, messageId => {
        const id = Number(messageId);
        const current = getContext();
        const message = current?.chat?.[id];
        if (!_promptModelEditSessions.has(message)) return;
        if (message) {
            current.updateMessageBlock(id, message);
            scheduleWrapPass();
        }
        _promptModelEditSessions.delete(message);
    });
}

// Trailing debounce for ref-data persistence. Keystroke events coalesce
// into one write 500 ms after typing stops, avoiding main-thread stalls
// from JSON.stringify + 2× localStorage.setItem per keystroke on mobile.
let _persistRefsTimer = null;
const PERSIST_REFS_DEBOUNCE_MS = 500;

function schedulePersistRefsToLocalStorage() {
    if (_iigDisposed) return;
    if (_persistRefsTimer) clearIigTimeout(_persistRefsTimer);
    _persistRefsTimer = setIigTimeout(() => {
        _persistRefsTimer = null;
        persistRefsToLocalStorage();
    }, PERSIST_REFS_DEBOUNCE_MS);
}

function flushPendingRefsPersist() {
    if (_persistRefsTimer) {
        clearIigTimeout(_persistRefsTimer);
        _persistRefsTimer = null;
    }
    persistRefsToLocalStorage({ sync: true });
}

const LS_KEY = 'iig_npc_refs_v3';       // legacy array-only format
const LS_KEY_V4 = 'iig_npc_refs_v4';    // current {version, updatedAt, refs}

// Hash of last persisted refs. Every setting change triggers persistRefs,
// but we only bump the timestamp when ref data actually changed.
let _lastPersistedRefsHash = null;

// Log-throttling state for routine debounced writes.
let _lastPersistedRefsSize = 0;
let _lastPersistedRefsLogAt = 0;
const PERSIST_LOG_QUIET_MS = 5000;

function hashRefSlot(r) {
    if (!r) return '0';
    return JSON.stringify([r.name || '', r.imagePath || '', (r.imageBase64 || r.imageData || '').length, r.packAssetId || '']);
}

/** Fingerprint either a settings reference set or a bare NPC-reference array. */
function cheapRefsHash(settingsOrArray) {
    if (Array.isArray(settingsOrArray)) {
        return settingsOrArray.map(hashRefSlot).join(';') || '[]';
    }
    const s = settingsOrArray || {};
    const npcPart = Array.isArray(s.npcReferences) ? s.npcReferences.map(hashRefSlot).join(';') : '';
    return `C:${hashRefSlot(s.charRef)};U:${hashRefSlot(s.userRef)};N:${npcPart}`;
}

/**
 * Persist refs to localStorage (mobile-safe backup). Skips unchanged content;
 * bumps timestamp only on real change so a restore won't clobber fresher state.
 */
function persistRefsToLocalStorage(opts) {
    const force = !!(opts && opts.sync);
    try {
        const settings = getSettings();
        const refs = settings.npcReferences || [];
        const nextHash = cheapRefsHash(settings);
        const contentChanged = nextHash !== _lastPersistedRefsHash;

        if (!contentChanged) {
            if (!force) return;
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
        localStorage.setItem(LS_KEY, JSON.stringify(refs));

        const sizeDelta = Math.abs(serialized.length - _lastPersistedRefsSize);
        const quietElapsed = Date.now() - _lastPersistedRefsLogAt;
        const worthLogging = force || sizeDelta > 10 || quietElapsed > PERSIST_LOG_QUIET_MS;
        if (worthLogging) {
            iigLog('DEBUG:refs', `Refs saved to localStorage (${serialized.length} bytes, ts=${ts}, changed=${contentChanged}, forced=${force})`);
            _lastPersistedRefsLogAt = Date.now();
        }
        _lastPersistedRefsSize = serialized.length;
    } catch(e) {
        iigLog('WARN', 'persistRefsToLocalStorage failed:', e.message);
    }
}

/**
 * Restore refs from localStorage, but only when it wouldn't clobber fresher
 * server state. Prevents stale mobile overwriting a newer desktop edit.
 */
function restoreRefsFromLocalStorage() {
    try {
        const settings = getSettings();
        let backupRefs = null;
        let backupTs = 0;

        // v4 payload includes a timestamp; prefer it.
        const rawV4 = localStorage.getItem(LS_KEY_V4);
        if (rawV4) {
            const parsed = JSON.parse(rawV4);
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed.npcReferences)) {
                backupRefs = parsed.npcReferences;
                backupTs = Number(parsed.updatedAt) || 0;
            }
        }

        // Fallback to v3 format (plain array, no timestamp).
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
            iigLog('DEBUG:refs', 'localStorage: no refs backup found');
            return;
        }

        const currentRefs = Array.isArray(settings.npcReferences) ? settings.npcReferences : [];
        const currentHasData = currentRefs.some(r => r && (r.name || r.imageBase64 || r.imagePath || r.imageData));
        const backupHasData = backupRefs.some(r => r && (r.name || r.imageBase64 || r.imagePath || r.imageData));
        const currentTs = Number(settings.refsUpdatedAt) || 0;

        // An empty timestamped state is an intentional deletion.
        let shouldRestore = false;
        let reason = '';
        if (!currentHasData && backupHasData && !currentTs) {
            shouldRestore = true;
            reason = 'server state empty, backup has data';
        } else if (backupTs > currentTs) {
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
            iigLog('DEBUG:refs', `Refs NOT restored from localStorage — ${reason}`);
        }
    } catch(e) {
        iigLog('WARN', 'restoreRefsFromLocalStorage failed:', e.message);
    }
}

/** Mobile safety net: force-flush pending ref writes on tab background/navigation. */
function initMobileSaveListeners() {
    const reportFailure = error => iigLog('WARN', 'Reference background save failed:', error);
    const flush = () => {
        flushPendingRefsPersist();
        try { trackIigTask(Promise.resolve(SillyTavern.getContext().saveSettingsDebounced()).catch(reportFailure)); }
        catch (error) { reportFailure(error); }
        // Use the optional immediate host hook when available.
        if (typeof _stSaveSettings === 'function' && _stSaveSettings !== saveSettings) {
            try { trackIigTask(Promise.resolve(_stSaveSettings()).catch(reportFailure)); }
            catch (error) { reportFailure(error); }
        }
    };
    listenIig(document, 'visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            iigLog('DEBUG:refs', 'visibilitychange hidden: flushing to localStorage');
            flush();
        }
    });
    listenIig(window, 'pagehide', flush);
    listenIig(window, 'beforeunload', flush);
    iigLog('DEBUG:init', 'Mobile save listeners registered');
}

// Ensure a ref container has charRef, userRef, and 4 NPC slots.
function ensureRefSlots(container) {
    if (!container.charRef || typeof container.charRef !== 'object' || Array.isArray(container.charRef)) {
        container.charRef = { name: '', imageBase64: '', imagePath: '' };
    }
    if (!container.userRef || typeof container.userRef !== 'object' || Array.isArray(container.userRef)) {
        container.userRef = { name: '', imageBase64: '', imagePath: '' };
    }
    if (!Array.isArray(container.npcReferences)) container.npcReferences = [];
    while (container.npcReferences.length < 4) {
        container.npcReferences.push({ name: '', imageBase64: '', imagePath: '' });
    }
    for (let index = 0; index < container.npcReferences.length; index++) {
        const ref = container.npcReferences[index];
        if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
            container.npcReferences[index] = { name: '', imageBase64: '', imagePath: '' };
        }
    }
    for (const ref of [container.charRef, container.userRef, ...container.npcReferences]) {
        if (typeof ref.packAssetId !== 'string' || !(ref.imagePath || ref.imageBase64 || ref.imageData)) ref.packAssetId = '';
    }
    return container;
}

function cloneRefContainer(container) {
    const source = ensureRefSlots(container || {});
    return {
        charRef: { ...source.charRef },
        userRef: { ...source.userRef },
        npcReferences: source.npcReferences.map(ref => ({ ...ref })),
        updatedAt: Date.now(),
    };
}

function clearRefContainerImages(container, filenames = null, keepFilenames = null) {
    if (!container || typeof container !== 'object') return false;
    const refs = [container.charRef, container.userRef, ...(container.npcReferences || [])];
    let changed = false;
    for (const ref of refs) {
        if (!ref || typeof ref !== 'object') continue;
        const path = String(ref.imagePath || '');
        const filename = path.split('/').pop() || '';
        if (filenames && (!filename || !filenames.has(filename))) continue;
        if (keepFilenames?.has(filename)) continue;
        if (ref.imagePath || ref.imageBase64 || ref.imageData || ref.packAssetId) changed = true;
        ref.imagePath = '';
        ref.imageBase64 = '';
        ref.packAssetId = '';
        if ('imageData' in ref) ref.imageData = '';
    }
    return changed;
}

function reconcileRefContainerAfterFolderClear(container, clearedAt, exceptions = []) {
    const timestamp = Number(clearedAt) || 0;
    if (!timestamp || !container || Number(container.updatedAt) >= timestamp) return false;
    const changed = clearRefContainerImages(container, null, new Set(exceptions));
    container.updatedAt = timestamp;
    return changed;
}

function clearKnownRefContainers(settings, chatMetadata, filenames = null, clearedAt = 0, exceptions = []) {
    const timestamp = Number(clearedAt) || 0;
    let settingsChanged = clearRefContainerImages(settings, filenames);
    for (const container of Object.values(settings.characterRefs || {})) {
        const changed = clearRefContainerImages(container, filenames);
        settingsChanged = changed || settingsChanged;
        if (timestamp && container && typeof container === 'object') container.updatedAt = timestamp;
    }
    const chatContainer = chatMetadata?.iig_refs;
    const chatChanged = clearRefContainerImages(chatContainer, filenames);
    if (timestamp) {
        settings.refsFolderClearedAt = timestamp;
        settings.refsFolderClearExceptions = [...exceptions];
        settings.refsUpdatedAt = timestamp;
        if (chatContainer && typeof chatContainer === 'object') chatContainer.updatedAt = timestamp;
        settingsChanged = true;
    }
    return { settingsChanged, chatChanged };
}

function applyRefFolderClear(filenames = null, clearedAt = 0, exceptions = []) {
    const context = getContext();
    const result = clearKnownRefContainers(getSettings(), context?.chatMetadata, filenames, clearedAt, exceptions);
    clearAllRefB64Cache();
    if (result.settingsChanged) saveSettings({ sync: true });
    if (result.chatChanged) {
        try { persistIigMetadata(context); } catch (error) { iigLog('WARN', 'Reference metadata save failed:', error); }
    }
    renderRefSlots();
}

function normalizeRefScope(scope) {
    return ['global', 'per-character', 'per-chat'].includes(scope) ? scope : 'global';
}

function getCurrentRefOwner(context = getContext()) {
    if (!context) return null;
    const groupId = context.groupId;
    if (groupId !== undefined && groupId !== null && groupId !== '') {
        const group = context.groups?.find(candidate => String(candidate?.id) === String(groupId));
        return { key: `group:${String(groupId)}`, label: String(group?.name || `Group ${groupId}`) };
    }
    const character = context.characters?.[context.characterId];
    const avatar = String(character?.avatar || '');
    if (!avatar) return null;
    return { key: `character:${avatar}`, label: String(character?.name || avatar) };
}

function getLoadedRefChatId(context = getContext()) {
    const chatId = context?.chatId ?? context?.getCurrentChatId?.();
    return chatId === undefined || chatId === null || chatId === '' ? null : String(chatId);
}

function migrateCharacterRefOwner(settings, oldAvatar, newAvatar) {
    const oldKey = `character:${String(oldAvatar || '')}`;
    const newKey = `character:${String(newAvatar || '')}`;
    if (oldKey === newKey || !settings?.characterRefs?.[oldKey]) return false;
    settings.characterRefs[newKey] = settings.characterRefs[oldKey];
    delete settings.characterRefs[oldKey];
    return true;
}

function resolveRefScopeState(settings, context, { forWrite = false } = {}) {
    const requestedScope = normalizeRefScope(settings?.refScope);
    const globalRefs = ensureRefSlots(settings);
    const owner = getCurrentRefOwner(context);
    const ownerBucket = owner && settings.characterRefs[owner.key] && typeof settings.characterRefs[owner.key] === 'object'
        ? ensureRefSlots(settings.characterRefs[owner.key])
        : null;
    const globalState = () => ({
        requestedScope,
        storageScope: 'global',
        container: globalRefs,
        owner,
        ownerKey: owner?.key || null,
        chatId: getLoadedRefChatId(context),
        chatMetadata: context?.chatMetadata || null,
        sanitized: false,
    });
    const characterState = () => {
        if (!owner) return globalState();
        let bucket = ownerBucket;
        if (!bucket && forWrite) {
            bucket = cloneRefContainer(globalRefs);
            settings.characterRefs[owner.key] = bucket;
        }
        if (!bucket) return globalState();
        const sanitized = reconcileRefContainerAfterFolderClear(
            bucket,
            settings.refsFolderClearedAt,
            settings.refsFolderClearExceptions,
        );
        return {
            requestedScope,
            storageScope: 'per-character',
            container: bucket,
            owner,
            ownerKey: owner.key,
            chatId: getLoadedRefChatId(context),
            chatMetadata: context?.chatMetadata || null,
            sanitized,
        };
    };

    if (requestedScope === 'global') return globalState();
    if (requestedScope === 'per-character') return characterState();

    const chatId = getLoadedRefChatId(context);
    const metadata = context?.chatMetadata;
    if (!chatId || !metadata || typeof metadata !== 'object') return characterState();
    let chatBucket = metadata.iig_refs;
    if (!chatBucket || typeof chatBucket !== 'object' || Array.isArray(chatBucket)) {
        if (!forWrite) return characterState();
        chatBucket = cloneRefContainer(ownerBucket || globalRefs);
        metadata.iig_refs = chatBucket;
    }
    const chatSanitized = reconcileRefContainerAfterFolderClear(chatBucket, settings.refsFolderClearedAt, settings.refsFolderClearExceptions);
    return {
        requestedScope,
        storageScope: 'per-chat',
        container: ensureRefSlots(chatBucket),
        owner,
        ownerKey: owner?.key || null,
        chatId,
        chatMetadata: metadata,
        sanitized: chatSanitized,
    };
}

function isRefScopeStateCurrent(scopeState, settings = getSettings(), context = getContext()) {
    if (_iigDisposed || !scopeState || normalizeRefScope(settings?.refScope) !== scopeState.requestedScope) return false;
    if (Number.isInteger(scopeState.scopeRevision) && scopeState.scopeRevision !== _refScopeRevision) return false;
    if (scopeState.storageScope === 'global' && scopeState.container !== settings) return false;
    if (scopeState.storageScope === 'per-character'
        && settings.characterRefs?.[scopeState.ownerKey] !== scopeState.container) return false;
    if (scopeState.storageScope === 'per-chat'
        && scopeState.chatMetadata?.iig_refs !== scopeState.container) return false;
    if (scopeState.requestedScope === 'global') return true;
    const ownerKey = getCurrentRefOwner(context)?.key || null;
    if (ownerKey !== scopeState.ownerKey) return false;
    if (scopeState.requestedScope !== 'per-chat') return true;
    return getLoadedRefChatId(context) === scopeState.chatId && context?.chatMetadata === scopeState.chatMetadata;
}

let _refScopeRevision = 0;
let _refFolderClearInProgress = false;

function getActiveRefScope({ forWrite = false } = {}) {
    const state = resolveRefScopeState(getSettings(), getContext(), { forWrite });
    state.scopeRevision = _refScopeRevision;
    if (state.sanitized) {
        clearAllRefB64Cache();
        if (state.storageScope === 'per-chat') {
            try { persistIigMetadata(getContext()); } catch (error) { iigLog('WARN', 'Reference metadata save failed:', error); }
        } else if (state.storageScope === 'per-character') {
            saveSettings();
        }
    }
    return state;
}

function setRefMutationControlsDisabled(disabled) {
    if (_iigDisposed) return;
    document.querySelectorAll('.iig-ref-file-input, .iig-ref-delete-btn, .iig-ref-packs-btn, .iig-ref-name, #iig_ref_scope, #iig_refs_reset_scope')
        .forEach(element => { element.disabled = !!disabled; });
}

/** Active refs for reads. Missing scoped containers inherit without side effects. */
function getActiveRefs() {
    return getActiveRefScope().container;
}

function saveActiveRefs(scopeState) {
    if (!isRefScopeStateCurrent(scopeState)) return;
    if (scopeState.storageScope === 'per-chat') {
        try {
            const ctx = getContext();
            scopeState.container.updatedAt = Date.now();
            persistIigMetadata(ctx);
        } catch (e) {
            iigLog('WARN', `saveActiveRefs (per-chat) failed: ${e.message}`);
        }
    } else {
        if (scopeState.storageScope === 'per-character') scopeState.container.updatedAt = Date.now();
        saveSettings();
    }
    updateRefScopeUI();
}

// Escape a string for safe insertion into a RegExp.
function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace the first decoded text-node match without reparsing surrounding
 * model-authored HTML. Sanitized DOM, handlers and sibling state stay intact.
 */
function replaceFirstTextMatchWithElement(container, pattern, replacementNode) {
    if (!container) return null;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        // Fresh lastIndex per node; the caller's regex may carry the /g flag.
        pattern.lastIndex = 0;
        const match = pattern.exec(node.nodeValue);
        if (!match || !match[0]) continue;

        // splitText leaves `node` holding the text before the match, and
        // returns the remainder starting at it.
        const matchNode = match.index > 0 ? node.splitText(match.index) : node;
        if (matchNode.nodeValue.length > match[0].length) {
            matchNode.splitText(match[0].length); // trailing text stays put
        }
        matchNode.replaceWith(replacementNode);
        return replacementNode;
    }
    return null;
}

/**
 * Whole-word, case-insensitive name match against prompt text. The name field
 * may hold comma-separated aliases; any one matching (as a whole word/phrase)
 * succeeds. Boundaries mean "Ace" matches "Ace" but not "space".
 */
function nameMatchesPrompt(nameField, promptText) {
    if (!nameField || !promptText) return false;
    const aliases = String(nameField)
        .split(',')
        .map(a => a.trim())
        .filter(Boolean);
    if (aliases.length === 0) return false;

    for (const alias of aliases) {
        // Boundary-delimited pattern; multi-word aliases tolerate variable spacing.
        const words = alias.split(/\s+/).filter(Boolean).map(escapeRegExp);
        if (words.length === 0) continue;
        const pattern = `(?<![\\p{L}\\p{M}\\p{N}_])${words.join('\\s+')}(?![\\p{L}\\p{M}\\p{N}_])`;
        if (new RegExp(pattern, 'iu').test(promptText)) return true;
    }
    return false;
}

/** Match NPCs against prompt text (whole-word, comma-separated aliases). */
function matchNpcReferences(prompt, npcList) {
    if (!prompt || !npcList || npcList.length === 0) return [];

    const matched = [];

    for (const npc of npcList) {
        if (!npc || !npc.name || (!npc.imagePath && !npc.imageBase64 && !npc.imageData)) continue;
        if (nameMatchesPrompt(npc.name, prompt)) {
            matched.push({ name: npc.name, imageBase64: npc.imageBase64, imagePath: npc.imagePath, imageData: npc.imageData });
        }
    }

    return matched;
}

// Active ST character name, used as fallback when the char ref slot is unnamed.
function getStCharName() {
    try {
        const ctx = getContext();
        if (ctx && ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
            return ctx.characters[ctx.characterId].name || '';
        }
        return ctx?.name2 || '';
    } catch (_) {
        return '';
    }
}

function getStUserName() {
    try {
        const ctx = getContext();
        return ctx?.name1 || '';
    } catch (_) {
        return '';
    }
}

// True if a ref's name(s) or the ST fallback name appear in the prompt.
function refMatchesPrompt(ref, promptText, fallbackName) {
    if (!ref || !promptText) return false;
    const name = (ref.name || fallbackName || '').trim();
    if (!name) return false;
    return nameMatchesPrompt(name, promptText);
}

/**
 * Fetch models for the current apiType. openai -> /v1/models; gemini ->
 * /v1/models, then /v1beta/models, then /compatible/v1/models;
 * naistera -> dropdown (no list).
 * Auth is Bearer; x-goog-api-key only on *.googleapis.com.
 */
async function fetchModels(settings = { ...getSettings() }) {

    if (settings.apiType === 'naistera') {
        iigLog('INFO', 'fetchModels skipped for Naistera (uses dropdown)');
        return [];
    }

    const endpoint = getEffectiveEndpoint(settings);
    if (!endpoint) throw iigError('Set endpoint first', 'iig_ui_setEndpointFirst');
    if (!settings.apiKey) throw iigError('Set API key first', 'iig_ui_setApiKeyFirst');
    const endpointError = validateEndpointShape(endpoint);
    if (endpointError) throw iigError(endpointError, endpointError.startsWith('Use a base endpoint') ? 'iig_endpointBaseOnly' : 'iig_endpointInvalid', { endpoint });

    const sendGoogleHeader = (settings.apiType === 'gemini') && endpointNeedsGoogleHeader(endpoint);
    const headers = sendGoogleHeader
        ? { 'Authorization': `Bearer ${settings.apiKey}`, 'x-goog-api-key': settings.apiKey }
        : { 'Authorization': `Bearer ${settings.apiKey}` };

    // Try aggregator, Google-native, then /compatible model-list paths.
    const candidateUrls = [];
    if (settings.apiType === 'gemini') {
        candidateUrls.push(`${endpoint}/v1/models`);
        candidateUrls.push(`${endpoint}/v1beta/models`);
        if (!endpointHasCompatiblePrefix(endpoint)) {
            candidateUrls.push(`${endpoint}/compatible/v1/models`);
        }
    } else {
        candidateUrls.push(`${endpoint}/v1/models`);
    }

    let lastError = null;
    let receivedCatalog = false;
    for (const url of candidateUrls) {
        try {
            const response = await fetchWithTimeout(url, { method: 'GET', headers }, 30000);
            if (!response.ok) {
                response.iigDiscard?.();
                lastError = new Error(`HTTP ${response.status} at ${url}`);
                lastError.status = response.status;
                iigLog('WARN', `fetchModels: ${url} returned ${response.status}, trying next candidate`);
                continue;
            }

            const data = await response.json();
            receivedCatalog = true;
            // OpenAI shape: { data: [{id}] }. Gemini shape: { models: [{name:"models/..."}] }.
            let rawModels = [];
            if (Array.isArray(data.data)) {
                rawModels = data.data.map(m => m.id).filter(Boolean);
            } else if (Array.isArray(data.models)) {
                rawModels = data.models.map(m => {
                    const n = m.name || m.id || '';
                    return n.startsWith('models/') ? n.slice('models/'.length) : n;
                }).filter(Boolean);
            }

            iigLog('INFO', `Models fetched: ${rawModels.length} total from ${url} (apiType=${settings.apiType})`);

            if (rawModels.length === 0) {
                continue;
            }

            if (settings.showAllModels) return rawModels;
            const filtered = rawModels.filter(id => isImageModel(id));
            // Safety net: show everything if the filter matched nothing.
            if (filtered.length === 0) {
                iigLog('WARN', 'Keyword filter matched 0 models; returning unfiltered list as safety net');
                return rawModels;
            }
            return filtered;
        } catch (error) {
            lastError = redactSensitive(error, value => redactPromptModelGeminiError(value, settings.apiKey));
            iigLog('WARN', `fetchModels: ${url} threw — ${lastError.message}`);
        }
    }

    if (receivedCatalog) return [];
    iigLog('ERROR', 'Failed to fetch models: all candidate URLs failed', lastError?.message);
    throw lastError || new Error('No model catalog endpoint responded');
}

const MODEL_PICKER_LIMIT = 200;
const _modelCatalogs = new Map();

function invalidateImageModelCatalog() {
    const button = document.getElementById('iig_refresh_models');
    if (button) {
        button._iigCatalogRequest = Symbol();
        button.classList.remove('loading');
    }
    updateModelCatalog('iig_model', []);
}

function getModelPicker(inputId) {
    const input = document.getElementById(inputId);
    const root = input?.closest('.iig-model-picker');
    const toggle = root?.querySelector('.iig-model-toggle');
    const list = root?.querySelector('.iig-model-options');
    return input && root && toggle && list ? { input, root, toggle, list } : null;
}

function setModelPickerOpen(inputId, open) {
    const picker = getModelPicker(inputId);
    if (!picker) return;
    const { input, toggle, list } = picker;
    if (!open) {
        if (list.contains(document.activeElement)) input.focus();
        setModelPickerActiveOption(input, list, null);
    }
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('i')?.classList.toggle('fa-rotate-180', open);
}

function setModelPickerActiveOption(input, list, option) {
    list.querySelector('.iig-model-option-active')?.classList.remove('iig-model-option-active');
    input.removeAttribute('aria-activedescendant');
    if (!option) return;
    option.classList.add('iig-model-option-active');
    input.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
}

function renderModelPickerOptions(inputId, query = '') {
    if (_iigDisposed) return;
    const picker = getModelPicker(inputId);
    if (!picker) return;
    const { input, list } = picker;
    const catalog = _modelCatalogs.get(inputId) || [];
    if (list.contains(document.activeElement)) input.focus();
    input.removeAttribute('aria-activedescendant');
    list.replaceChildren();

    const tokens = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = catalog.filter(model => {
        const searchable = `${model.value} ${model.label}`.toLowerCase();
        return tokens.every(token => searchable.includes(token));
    });

    if (matches.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'iig-model-empty';
        empty.setAttribute('role', 'presentation');
        empty.textContent = iigT(catalog.length ? 'iig_noMatchingModels' : 'iig_loadModels');
        list.appendChild(empty);
        return;
    }

    const current = input.value.toLowerCase();
    for (const model of matches.slice(0, MODEL_PICKER_LIMIT)) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'iig-model-option';
        option.id = `${inputId}_option_${list.children.length}`;
        option.tabIndex = -1;
        option.dataset.model = model.value;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(model.value.toLowerCase() === current));
        option.textContent = model.label;
        list.appendChild(option);
    }

    if (matches.length > MODEL_PICKER_LIMIT) {
        const more = document.createElement('div');
        more.className = 'iig-model-empty';
        more.setAttribute('role', 'presentation');
        more.textContent = iigT('iig_modelsShowing', { limit: MODEL_PICKER_LIMIT, count: matches.length });
        list.appendChild(more);
    }
}

function updateModelCatalog(inputId, models, open = false, merge = false) {
    if (_iigDisposed) return;
    const catalog = new Map(merge ? (_modelCatalogs.get(inputId) || []).map(model => [model.value, model]) : []);
    for (const model of Array.isArray(models) ? models : []) {
        const value = String(model?.value ?? model?.id ?? model?.name ?? model ?? '').trim();
        if (!value || catalog.has(value)) continue;
        const label = String(model?.label ?? model?.name ?? model?.id ?? model ?? value).trim() || value;
        catalog.set(value, { value, label });
    }
    _modelCatalogs.set(inputId, [...catalog.values()]);
    renderModelPickerOptions(inputId);
    setModelPickerOpen(inputId, open);
}

function bindModelPicker(inputId) {
    if (_iigDisposed) return;
    const picker = getModelPicker(inputId);
    if (!picker) return;
    const { input, root, toggle, list } = picker;

    if (root.dataset.iigPickerBound) return;
    root.dataset.iigPickerBound = '1';
    bindIig(input, 'input', () => {
        if ((_modelCatalogs.get(inputId)?.length || 0) === 0) return;
        renderModelPickerOptions(inputId, input.value);
        setModelPickerOpen(inputId, true);
    });
    bindIig(input, 'keydown', event => {
        if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if (list.hidden) {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            renderModelPickerOptions(inputId, input.value);
            setModelPickerOpen(inputId, true);
        }
        const options = [...list.querySelectorAll('.iig-model-option')];
        const index = options.findIndex(option => option.id === input.getAttribute('aria-activedescendant'));
        if (event.key === 'Enter') {
            const option = options[index] || options[0];
            if (option) {
                event.preventDefault();
                option.click();
            }
            return;
        }
        let next;
        if (event.key === 'ArrowDown') next = Math.min(index + 1, options.length - 1);
        else if (event.key === 'ArrowUp') next = index < 0 ? options.length - 1 : Math.max(0, index - 1);
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = options.length - 1;
        else return;
        event.preventDefault();
        setModelPickerActiveOption(input, list, options[next]);
    });
    bindIig(toggle, 'click', () => {
        const willOpen = list.hidden;
        if (willOpen) renderModelPickerOptions(inputId);
        setModelPickerOpen(inputId, willOpen);
        if (willOpen) input.focus();
    });
    bindIig(list, 'pointerdown', event => {
        // Keep focus through selection; pointer cancellation still allows touch scrolling and click.
        if (event.button === 0 && event.target.closest('.iig-model-option')) event.preventDefault();
    });
    bindIig(list, 'click', event => {
        const option = event.target.closest('.iig-model-option');
        if (!option) return;
        input.value = option.dataset.model || '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setModelPickerOpen(inputId, false);
        input.focus();
    });
    bindIig(root, 'keydown', event => {
        if (event.key === 'Escape' && !event.isComposing && !list.hidden) {
            event.preventDefault();
            event.stopPropagation();
            setModelPickerOpen(inputId, false);
            input.focus();
        }
    });
    bindIig(root, 'focusout', event => {
        if (!root.contains(event.relatedTarget)) setModelPickerOpen(inputId, false);
    });
}

// One listener for every picker, so opening one closes the others.
function _closeModelPickersOnDocumentClick(event) {
    for (const root of document.querySelectorAll('.iig-model-picker')) {
        if (root.contains(event.target)) continue;
        const inputId = root.querySelector('input')?.id;
        if (inputId) setModelPickerOpen(inputId, false);
    }
}

// Sniff MIME from magic bytes (iOS Safari rejects mismatched data-URL MIME).
function detectImageMimeFromBase64(rawBase64) {
    if (!rawBase64 || typeof rawBase64 !== 'string') return 'image/jpeg';
    let head;
    try {
        head = atob(rawBase64.slice(0, 24));
    } catch (_) {
        return 'image/jpeg';
    }
    const b = (i) => head.charCodeAt(i);
    if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return 'image/png';
    if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'image/jpeg';
    if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return 'image/gif';
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
    if (b(0) === 0x42 && b(1) === 0x4D) return 'image/bmp';
    return 'image/jpeg';
}

// Resize + JPEG-compress refs for smaller payloads.
function compressBase64Image(rawBase64, maxDim = 768, quality = 0.8) {
    return new Promise((resolve, reject) => {
        throwIfSignalAborted();
        const mime = detectImageMimeFromBase64(rawBase64);
        const img = new Image();
        const release = () => {
            _iigLifetime.signal.removeEventListener('abort', abort);
            img.onload = img.onerror = null;
        };
        const abort = () => { release(); img.src = ''; reject(Object.assign(new Error('Image decode aborted'), { name: 'AbortError' })); };
        _iigLifetime.signal.addEventListener('abort', abort, { once: true });
        img.onload = () => {
            release();
            try {
                throwIfSignalAborted();
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
                iigLog('DEBUG:refs', `Compressed reference image (${mime}): ${img.width}x${img.height} -> ${w}x${h}, ~${Math.round(b64.length / 1024)}KB`);
                resolve(b64);
            } catch (error) { reject(error); }
        };
        img.onerror = () => { release(); reject(new Error(`Failed to load image for compression (detected MIME: ${mime})`)); };
        img.src = `data:${mime};base64,${rawBase64}`;
    });
}

/**
 * Validate a media URL before it reaches a DOM sink, a fetch, or persisted
 * message text. Allows https:, http:, data:image/* and same-origin relative
 * paths. Anything else raises a normal generation error.
 * Returns the URL so it can be used inline.
 */
function assertSafeMediaUrl(url, what = 'media') {
    const raw = String(url ?? '').trim();
    if (!raw) throw new Error(`Empty ${what} URL in provider response`);

    // Same-origin relative path — what /api/images/upload hands back.
    // Reject '//host' (protocol-relative) and '\\host' (backslash variant).
    if (raw.startsWith('/')) {
        if (raw.startsWith('//') || raw.startsWith('/\\')) {
            throw new Error(`Blocked protocol-relative ${what} URL`);
        }
        return raw;
    }

    let parsed;
    try {
        parsed = new URL(raw, window.location.href);
    } catch (_) {
        throw new Error(`Unusable ${what} URL in provider response`);
    }

    const scheme = parsed.protocol.toLowerCase();
    if (scheme === 'https:' || scheme === 'http:') return raw;
    if (scheme === 'data:') {
        if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(raw)) return raw;
        throw new Error(`Blocked ${what} data URL: unsupported media type`);
    }
    throw new Error(`Blocked ${what} URL scheme "${parsed.protocol}"`);
}

/** Non-throwing variant for DOM sinks, where one bad URL must not break render. */
function safeMediaUrlOrNull(url) {
    try {
        return assertSafeMediaUrl(url);
    } catch (_) {
        return null;
    }
}

/**
 * Mirror SillyTavern's folder-name sanitization for gallery compatibility.
 * Replace path separators and reserved names to prevent traversal.
 */
function sanitizeUploadFolderName(name) {
    let out = String(name ?? '')
        .replace(/[\/\\?<>:*|"]/g, '_')      // sanitize-filename's illegal set
        .replace(/[\x00-\x1f\x80-\x9f]/g, '_') // C0/C1 control codes
        .slice(0, 100)
        .replace(/[. ]+$/, '');              // Windows trailing dot/space
    if (/^\.+$/.test(out)) out = '';         // '.' and '..' are reserved
    return out.trim() || 'generated';
}

// POST to ST's /api/images/upload. Returns the public path to the saved file.
async function saveImageToFile(dataUrl, signal = null) {
    const context = getContext();
    throwIfSignalAborted(signal);
    if (/^https?:\/\//i.test(dataUrl)) dataUrl = await downloadGeneratedImageData(dataUrl, signal);
    throwIfSignalAborted(signal);

    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
        throw new Error('Invalid data URL format');
    }
    
    const format = match[1];
    const base64Data = match[2];
    
    // Character-card names are untrusted (imported from anywhere) and reach a
    // filesystem path here. Defense-in-depth: ST sanitizes server-side too.
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = sanitizeUploadFolderName(context.characters[context.characterId].name);
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `iig_${timestamp}`;
    
    const response = await fetchWithTimeout('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        signal,
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
    throwIfSignalAborted(signal);
    iigLog('INFO:image', 'Image saved to:', result.path);
    _emitMediaSaved(result.path, 'image');
    return result.path;
}

async function downloadGeneratedImageData(url, signal) {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || !safeMediaUrlOrNull(url) || parsed.username || parsed.password) throw iigError('Invalid image URL', 'iig_imageUrlInvalid');
    const response = await fetchWithTimeout(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' }, 120000);
    try {
        if (!response.ok) throw iigError(`Image request failed (${response.status})`, 'iig_imageRequestFailed', { status: response.status });
        const limit = 32 * 1024 * 1024;
        if (Number(response.headers.get('content-length')) > limit || !response.body?.getReader) throw iigError('Image download exceeds supported limits', 'iig_imageDownloadLimit');
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                throwIfSignalAborted(signal);
                if (done) break;
                bytes += value.byteLength;
                if (bytes > limit) throw iigError('Image download exceeds supported limits', 'iig_imageDownloadLimit');
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
        const blob = new Blob(chunks);
        const type = await sniffImageType(blob);
        throwIfSignalAborted(signal);
        if (!type) throw iigError('Unexpected download type: unknown', 'iig_downloadTypeInvalid', { type: 'unknown' });
        const encoded = await readIigBase64(new Blob(chunks, { type }));
        throwIfSignalAborted(signal);
        return `data:${type};base64,${encoded}`;
    } catch (error) {
        throwIfSignalAborted(signal);
        if (error?.name === 'AbortError') throw iigError('Image download timed out', 'iig_timeout');
        throw error;
    } finally { response.iigDiscard?.(); }
}

// Upload a ref image to ST and return its public path (we store the path, not
// base64, to keep settings.json small).
async function saveRefImageToFile(base64Data, label, filenameOverride = null) {
    const context = getContext();
    let filename;
    if (filenameOverride) {
        filename = filenameOverride;
    } else {
        const safeName = label.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
        filename = await pickUniqueRefFilename(safeName, '');
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

// Filesystem-safe slug for ref filenames (40 chars max). Uses only the first
// comma-separated alias, so "Elodie, Lodi" -> "elodie".
function sanitizeRefNameForFilename(name) {
    if (!name) return '';
    const firstAlias = String(name).split(',')[0];
    return firstAlias
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 40);
}

// Destructive/reporting callers use strict mode so failure is never called empty.
async function listIigRefsFolder({ strict = false } = {}) {
    try {
        const context = getContext();
        const response = await fetchWithTimeout('/api/images/list', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ folder: 'iig_refs' }),
        }, 10000);
        if (!response.ok) {
            response.iigDiscard?.();
            if (strict) throw new Error(`Reference folder list failed (${response.status})`);
            return [];
        }
        const result = await response.json();
        if (!Array.isArray(result)) {
            if (strict) throw new Error('Reference folder list returned an invalid response');
            return [];
        }
        return result.map(item => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') return item.name || item.filename || '';
            return '';
        }).filter(Boolean);
    } catch (e) {
        if (strict) throw e;
        iigLog('WARN', `listIigRefsFolder failed: ${e.message}`);
        return [];
    }
}

function formatRefStorageSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} ${iigT('iig_bytes')}`;
    const units = ['iig_kilobytes', 'iig_megabytes', 'iig_gigabytes'];
    let scaled = value / 1024;
    let unit = units[0];
    for (let index = 1; index < units.length && scaled >= 1024; index++) {
        scaled /= 1024;
        unit = units[index];
    }
    return `${scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)} ${iigT(unit)}`;
}

function getIigRefsPublicPrefix() {
    const settings = getSettings();
    const containers = [settings, ...Object.values(settings.characterRefs || {})];
    const chatRefs = getContext()?.chatMetadata?.iig_refs;
    if (chatRefs) containers.push(chatRefs);
    for (const container of containers) {
        const refs = [container?.charRef, container?.userRef, ...(container?.npcReferences || [])];
        for (const ref of refs) {
            const path = String(ref?.imagePath || '');
            try {
                const url = new URL(path, globalThis.location?.href || 'http://localhost/');
                if (globalThis.location?.origin && url.origin !== globalThis.location.origin) continue;
                const marker = url.pathname.indexOf('/iig_refs/');
                if (marker >= 0) return url.pathname.slice(0, marker + '/iig_refs/'.length);
            } catch (_) {}
        }
    }
    return '/user/images/iig_refs/';
}

async function measureIigRefsFolder(concurrency = 3) {
    const deadline = Date.now() + 45000;
    const files = (await listIigRefsFolder({ strict: true }))
        .filter(name => name && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..');
    if (files.length === 0) return { fileCount: 0, totalBytes: 0, measuredCount: 0 };
    const prefix = getIigRefsPublicPrefix();
    let cursor = 0;
    let totalBytes = 0;
    let measuredCount = 0;
    const worker = async () => {
        while (!_iigDisposed && cursor < files.length && Date.now() < deadline) {
            const filename = files[cursor++];
            try {
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                const response = await fetchWithTimeout(
                    `${prefix}${encodeURIComponent(filename)}`,
                    { method: 'HEAD' },
                    Math.min(10000, remaining),
                );
                if (!response.ok) continue;
                const lengthHeader = response.headers.get('content-length');
                if (lengthHeader === null) continue;
                const size = Number(lengthHeader);
                if (!Number.isFinite(size) || size < 0) continue;
                totalBytes += size;
                measuredCount++;
            } catch (_) {}
        }
    };
    const workerCount = Math.min(files.length, Math.max(1, Math.min(4, Number(concurrency) || 3)));
    await Promise.all(Array.from({ length: workerCount }, worker));
    return { fileCount: files.length, totalBytes, measuredCount };
}

function markRefStorageUsageStale() {
    if (_iigDisposed) return;
    const status = document.getElementById('iig_ref_storage_status');
    if (!status || !status.dataset.measured) return;
    status.textContent = iigT('iig_refStorageStale');
    delete status.dataset.measured;
}

// Directory listing cannot reserve a name against concurrent uploads.
async function pickUniqueRefFilename(refType, nameSlug) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const suffix = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const base = [refType, nameSlug].filter(Boolean).join('_').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `iig_ref_${base}_u${suffix}`;
}

// Delete a ref file on the ST server. Refuses paths outside /iig_refs/ (guards
// against deleting character/generated images). Best-effort: never throws.
async function deleteRefFileOnServer(pathOnServer) {
    if (!pathOnServer) return false;
    // Reject traversal and both POSIX and Windows path separators.
    if (!pathOnServer.includes('/iig_refs/') || pathOnServer.includes('..') || pathOnServer.includes('\\')) {
        iigLog('WARN', `deleteRefFileOnServer: refusing unsafe path outside iig_refs: ${pathOnServer}`);
        return false;
    }
    try {
        const context = getContext();
        const response = await fetchWithTimeout('/api/images/delete', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ path: pathOnServer }),
        }, 15000);
        response.iigDiscard?.();
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

// LRU base64 cache for ref images, keyed by path (FileReader is slow on mobile).
const _refB64Cache = new Map();
const _refB64InFlight = new Map();
// 16 full base64 images is heavy on mobile.
const REF_B64_CACHE_CAP = IS_MOBILE ? 8 : 16;

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
 * Load a ref image (server path -> base64). Cached by path; concurrent calls
 * for the same path coalesce on one in-flight promise.
 */
async function loadRefImageAsBase64(path) {
    if (!path) return null;

    const shortName = path.split('/').pop() || path;

    const cached = _refCacheTouch(path);
    if (cached !== undefined) {
        iigLog('DEBUG:refs', `ref cache hit: ${shortName}`);
        return cached;
    }

    const inFlight = _refB64InFlight.get(path);
    if (inFlight) {
        iigLog('DEBUG:refs', `ref cache coalesced: ${shortName}`);
        return inFlight;
    }

    const promise = (async () => {
        try {
            const response = await fetchWithTimeout(path, {}, 60000);
            if (!response.ok) { response.iigDiscard?.(); throw new Error(`HTTP ${response.status}`); }
            const blob = await response.blob();
            const b64 = await readIigBase64(blob);
            throwIfSignalAborted();

            if (_refB64Cache.size >= REF_B64_CACHE_CAP) {
                const oldest = _refB64Cache.keys().next().value;
                if (oldest !== undefined) _refB64Cache.delete(oldest);
            }
            _refB64Cache.set(path, b64);
            iigLog('DEBUG:refs', `ref cache miss → fetched ${shortName} (${b64.length} b64 chars)`);
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

// =========================================================================
// Shared helpers for the 3 generators
// =========================================================================

const VALID_ASPECT_RATIOS = Object.freeze(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
const VALID_IMAGE_SIZES = Object.freeze(['1K', '2K', '4K']);

// Strong ref-adherence prompt prepended when refs are attached.
const REF_PROMPT_INSTRUCTION = '[CRITICAL: The reference image(s) attached show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]';

function prefixRefInstruction(prompt, hasRefs) {
    if (!hasRefs) return prompt;
    return `${REF_PROMPT_INSTRUCTION}\n\n${prompt}`;
}

function applyStylePrefix(prompt, style) {
    return style ? `[Style: ${style}] ${prompt}` : prompt;
}

// Extract {mime, b64} from a data URL or bare base64 (sniffs MIME if bare).
function splitDataUrl(src) {
    const s = String(src || '');
    const m = s.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (m) return { mime: m[1], b64: m[2] };
    return { mime: detectImageMimeFromBase64(s), b64: s };
}

function imageExtensionForMime(mime) {
    if (mime === 'image/png') return 'png';
    if (mime === 'image/webp') return 'webp';
    if (mime === 'image/gif') return 'gif';
    if (mime === 'image/bmp') return 'bmp';
    return 'jpg';
}

function base64ToImageBlob(src) {
    const { mime, b64 } = splitDataUrl(src);
    const bytes = atob(b64);
    const data = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) data[i] = bytes.charCodeAt(i);
    return { blob: new Blob([data], { type: mime }), extension: imageExtensionForMime(mime) };
}

// =========================================================================
// OpenAI-compatible generator (apiType='openai')
// =========================================================================

// POST to an OpenAI-compatible image route. GPT Image edits use multipart files.
async function generateImageOpenAI(prompt, style, referenceImages = [], options = {}, settings = { ...getSettings() }) {
    const novelAiModel = isRoutMyNovelAiModel(settings.model);
    if (novelAiModel && referenceImages.length > 1) {
        throw new Error('NovelAI accepts exactly one reference image; adjust reference name matching or Always send settings');
    }
    const novelAiImg2Img = novelAiModel && referenceImages.length === 1;
    const requestModel = novelAiModel
        ? resolveRoutMyNovelAiModel(settings.model, options.aspectRatio)
        : settings.model;
    const requestReferences = novelAiModel ? [] : referenceImages;
    const modelIsGptImage = isGptImageModel(requestModel);
    const modelIsGptImage2 = isGptImage2Model(requestModel);
    // GPT Image + refs -> /v1/images/edits; otherwise /v1/images/generations.
    const useEditsEndpoint = modelIsGptImage && requestReferences.length > 0;
    const defaultSuffix = novelAiImg2Img
        ? '/v1/chat/completions'
        : (useEditsEndpoint ? '/v1/images/edits' : '/v1/images/generations');
    const openAISettings = {
        apiType: settings.apiType,
        endpoint: openAIBaseFromEndpoint(getEffectiveEndpoint(settings)),
        pathOverride: settings.pathOverride,
    };
    const url = buildApiUrl(openAISettings, defaultSuffix);
    const fullPrompt = prefixRefInstruction(
        applyStylePrefix(prompt, style),
        novelAiImg2Img || requestReferences.length > 0,
    );

    // Map aspect ratio to the fixed set of sizes OpenAI accepts.
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
    let size = settings.size;
    if (!novelAiModel) {
        const sizeFromTag = tagAr ? AR_TO_SIZE[tagAr] : null;
        size = sizeFromTag || settings.size;
        if (modelIsGptImage && !modelIsGptImage2) {
            const dimensions = String(size || '').match(/^(\d+)x(\d+)$/);
            if (dimensions) {
                const width = Number(dimensions[1]);
                const height = Number(dimensions[2]);
                size = width === height ? '1024x1024' : (width > height ? '1536x1024' : '1024x1536');
            }
        }
        if (tagAr) {
            iigLog('DEBUG:api', `aspect_ratio resolved: tag="${tagAr}" → size="${size}"${sizeFromTag ? '' : ' (unknown ratio, using settings.size)'}`);
        }
    }

    // Map 1K/2K/4K -> quality (gpt-image uses low/medium/high/auto; dall-e-3 standard/hd).
    const tagImageSize = options.imageSize || null;
    const modelLower = String(settings.model || '').toLowerCase();
    const modelIsDallE3 = /dall-e-3\b/.test(modelLower);
    let quality = options.quality || settings.quality;
    if (tagImageSize && !options.quality && !novelAiModel) {
        if (modelIsDallE3) {
            quality = (tagImageSize === '1K') ? 'standard' : 'hd';
        } else {
            quality = ({ '1K': 'medium', '2K': 'high', '4K': 'high' })[tagImageSize] || quality;
        }
        iigLog('DEBUG:api', `image_size "${tagImageSize}" → quality "${quality}" (model=${settings.model})`);
    }

    // GPT Image models reject the DALL-E quality values standard/hd.
    if (modelIsGptImage) {
        const GPT_IMAGE_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);
        if (!quality || !GPT_IMAGE_QUALITIES.has(quality)) {
            const original = quality;
            if (quality === 'standard') quality = 'medium';
            else if (quality === 'hd') quality = 'high';
            else quality = 'auto';
            iigLog('DEBUG:api', `GPT Image quality normalized: "${original}" → "${quality}"`);
        }
    }

    let body;
    if (novelAiImg2Img) {
        const { mime, b64 } = splitDataUrl(referenceImages[0]);
        body = {
            model: requestModel,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: fullPrompt },
                    { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
                ],
            }],
        };
    } else {
        body = {
            model: requestModel,
            prompt: fullPrompt,
            n: 1,
        };
    }
    if (!novelAiModel) {
        body.size = size;
        if (quality) body.quality = quality;
    }

    // Preserve the existing JSON reference shape for other OpenAI-compatible
    // models. GPT Image edits move to multipart below.
    if (!useEditsEndpoint && requestReferences.length > 0) {
        const asDataUrls = requestReferences.slice(0, 4).map(ref => {
            if (String(ref).startsWith('data:')) return ref;
            const mime = detectImageMimeFromBase64(ref);
            return `data:${mime};base64,${ref}`;
        });
        body.image = asDataUrls.length === 1 ? asDataUrls[0] : asDataUrls;
    }

    const sentRefCount = novelAiImg2Img ? 1 : Math.min(requestReferences.length, 4);
    const endpointLabel = novelAiImg2Img ? 'chat-completions' : (useEditsEndpoint ? 'edits' : 'generations');
    iigLog('INFO:api', `OpenAI request: model=${requestModel}, size=${novelAiModel ? 'model-id' : size}, quality=${novelAiModel ? 'model-id' : (quality || 'none')}, refs=${sentRefCount}, endpoint=${endpointLabel}, url=${url}`);

    let requestBody;
    const headers = { 'Authorization': `Bearer ${settings.apiKey}` };
    if (useEditsEndpoint) {
        const form = new FormData();
        form.append('model', body.model);
        form.append('prompt', body.prompt);
        form.append('n', String(body.n));
        if (body.size) form.append('size', body.size);
        if (body.quality) form.append('quality', body.quality);

        const refs = requestReferences.slice(0, 4);
        const fieldName = refs.length === 1 ? 'image' : 'image[]';
        refs.forEach((ref, index) => {
            const { blob, extension } = base64ToImageBlob(ref);
            form.append(fieldName, blob, `reference-${index}.${extension}`);
        });
        requestBody = form;
    } else {
        headers['Content-Type'] = 'application/json';
        requestBody = JSON.stringify(body);
    }

    const response = await robustFetch(url, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: options.signal,
    });

    if (!response.ok) {
        const text = await response.text();
        const e = new Error(`API Error (${response.status}): ${text}`);
        e.status = response.status;
        throw e;
    }

    const result = await response.json();
    if (novelAiImg2Img) {
        const images = result?.choices?.[0]?.message?.images;
        const imageUrl = Array.isArray(images)
            ? images.find(image => typeof image?.image_url?.url === 'string')?.image_url?.url
            : null;
        if (!imageUrl) throw new Error('No image data in NovelAI chat response');
        return assertSafeMediaUrl(imageUrl, 'image');
    }
    const imageObj = Array.isArray(result.data) ? result.data[0] : null;
    if (!imageObj) {
        if (result.url) return assertSafeMediaUrl(result.url, 'image');
        throw new Error('No image data in response');
    }
    if (imageObj.b64_json) return `data:image/png;base64,${imageObj.b64_json}`;
    return assertSafeMediaUrl(imageObj.url, 'image');
}

// =========================================================================
// Gemini-compatible generator (apiType='gemini')
// =========================================================================

// One log line per session; the memo handles the rest. Log only, no toast.
let _notedCompatiblePath = false;

function noteCompatiblePathOnce(base) {
    if (_notedCompatiblePath) return;
    _notedCompatiblePath = true;
    iigLog('DEBUG:api', `Gemini route resolved under /compatible for ${base}. Add it to the Endpoint URL to skip the probe on future sessions.`);
}

// POST to a Gemini-compatible generateContent endpoint. The user bakes any path
// prefix into their endpoint field. Auth: Bearer; x-goog-api-key for googleapis.com.
async function generateImageGemini(prompt, style, referenceImages = [], options = {}, settings = { ...getSettings() }) {
    const model = settings.model;
    const base = getEffectiveEndpoint(settings);

    // Advanced path override wins; otherwise the documented path. The model is
    // encoded per path segment so a '/' in a provider-prefixed id survives
    // untouched while '../' traversal throws.
    const modelForPath = encodeModelForPath(model);
    const override = (settings.pathOverride || '').trim();
    const geminiSuffix = `/v1beta/models/${modelForPath}:generateContent`;

    // Some aggregators serve the Gemini route under a /compatible prefix and
    // 404 the plain path. The prefix is never assumed — it is
    // learned from a 404 and remembered for the session, so a provider that
    // does not need it never sees a different request. Preconditions: no path
    // override, and the base does not already carry the prefix.
    const canProbeCompatible = !override && !endpointHasCompatiblePrefix(base);
    const quirks = getProviderQuirks(settings);
    const usingCompatible = canProbeCompatible && quirks.geminiPath === 'compatible';

    let url;
    if (override) {
        const path = override.startsWith('/') ? override : '/' + override;
        url = `${base}${path.replace('{model}', modelForPath)}`;
    } else if (usingCompatible) {
        // Memo hit: skip the attempt already known to 404.
        url = `${base}/compatible${geminiSuffix}`;
    } else {
        url = `${base}${geminiSuffix}`;
    }

    // Aspect ratio is tag-driven; tag-less generations default to 1:1.
    const arSource = options.aspectRatio ? 'tag' : 'default';
    let aspectRatio = options.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
        iigLog('WARN:api', `Invalid aspect_ratio "${aspectRatio}" from ${arSource}, falling back to 1:1`);
        aspectRatio = '1:1';
    }

    const sizeSource = options.imageSize ? 'tag' : (settings.imageSize ? 'settings' : 'default');
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) {
        iigLog('WARN:api', `Invalid image_size "${imageSize}" from ${sizeSource}, falling back`);
        imageSize = VALID_IMAGE_SIZES.includes(settings.imageSize) ? settings.imageSize : '1K';
    }

    iigLog('DEBUG:api', `Gemini params: aspect_ratio=${aspectRatio} (from ${arSource}), image_size=${imageSize} (from ${sizeSource})`);

    // gpt-image-2 via Gemini proxies ignores imageConfig and some aggregators
    // return an empty envelope if it's present, so strip it for this family.
    const isGptImg2 = isGptImage2Model(model);

    const buildParts = (refs) => {
        const p = [];
        for (const imgSrc of refs.slice(0, 4)) {
            const { mime, b64 } = splitDataUrl(imgSrc);
            p.push({ inlineData: { mimeType: mime, data: b64 } });
        }
        const fullPrompt = prefixRefInstruction(applyStylePrefix(prompt, style), refs.length > 0);
        p.push({ text: fullPrompt });
        return p;
    };

    const buildBody = (refs, { omitImageConfig = false } = {}) => {
        const genCfg = { responseModalities: ['TEXT', 'IMAGE'] };
        if (!omitImageConfig) genCfg.imageConfig = { aspectRatio, imageSize };
        return {
            contents: [{ role: 'user', parts: buildParts(refs) }],
            generationConfig: genCfg,
        };
    };

    const sendGoogleHeader = endpointNeedsGoogleHeader(base);
    const headers = sendGoogleHeader
        ? {
            'Authorization': `Bearer ${settings.apiKey}`,
            'x-goog-api-key': settings.apiKey,
            'Content-Type': 'application/json',
        }
        : {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json',
        };

    // First attempt: native-Gemini shape (gpt-image-2 has imageConfig stripped).
    let currentRefs = referenceImages;
    let omitImageConfig = isGptImg2;
    let attemptLabel = isGptImg2 ? 'attempt=1 (gpt-image-2: imageConfig omitted)' : 'attempt=1';

    const doPost = async () => {
        const body = buildBody(currentRefs, { omitImageConfig });
        const bodyStr = JSON.stringify(body);
        iigLog('INFO:api', `Gemini request [${attemptLabel}]: model=${model}, ar=${aspectRatio}, size=${imageSize}, refs=${currentRefs.length}, imageConfig=${omitImageConfig ? 'omitted' : 'sent'}, payload=${Math.round(bodyStr.length / 1024)}KB, url=${url}, googleHeader=${sendGoogleHeader}`);
        return robustFetch(url, {
            method: 'POST',
            headers,
            body: bodyStr,
            signal: options.signal,
        });
    };

    let response = await doPost();

    // Probe /compatible once after a plain-path 404 and memoize success.
    if (!response.ok && response.status === 404 && canProbeCompatible && !usingCompatible) {
        const firstText = await response.text();
        const originalError = new Error(`API Error (404): ${firstText}`);
        originalError.status = 404;

        iigLog('DEBUG:api', `Gemini plain path returned 404; retrying once under /compatible (url=${url})`);
        url = `${base}/compatible${geminiSuffix}`;
        attemptLabel = 'attempt=2 (/compatible path probe)';

        const probeResponse = await doPost();
        if (probeResponse.ok) {
            setProviderQuirk(settings, 'geminiPath', 'compatible');
            noteCompatiblePathOnce(base);
            response = probeResponse;
        } else {
            // Surface the ORIGINAL 404, not this one. The second failure is an
            // artifact of our own speculative retry, and reporting it would
            // point maybeSuggestFix at a path the user never configured.
            const probeText = await probeResponse.text().catch(() => '');
            iigLog('WARN:api', `/compatible probe also failed (${probeResponse.status}); reporting the original 404. Probe body: ${redactPromptModelGeminiError(probeText, settings.apiKey).slice(0, 200)}`);
            throw originalError;
        }
    }

    if (!response.ok) {
        const text = await response.text();
        const e = new Error(`API Error (${response.status}): ${text}`);
        e.status = response.status;
        throw e;
    }

    let result = await response.json();

    // Empty envelope ({candidates:null, 0 tokens}) = silent pre-inference reject.
    // Retry once with imageConfig and/or refs stripped, if anything can change.
    const isEmptyEnvelope = (r) => {
        if (!r || typeof r !== 'object') return false;
        if (r.error || r.promptFeedback || r.prompt_feedback) return false;
        if (Array.isArray(r.candidates) && r.candidates.length > 0) return false;
        const um = r.usageMetadata || r.usage_metadata;
        const zeroTokens = um && (um.promptTokenCount === 0 || um.prompt_token_count === 0);
        const nullCandidates = r.candidates === null || r.candidates === undefined;
        return !!(zeroTokens && nullCandidates);
    };

    if (isEmptyEnvelope(result)) {
        const canStripImageConfig = !omitImageConfig;
        const canDropRefs = currentRefs.length > 0;
        if (canStripImageConfig || canDropRefs) {
            iigLog('WARN:api', `Gemini empty-envelope detected (candidates:null, 0 tokens). Retrying: stripImageConfig=${canStripImageConfig}, dropRefs=${canDropRefs}`);
            if (canStripImageConfig) omitImageConfig = true;
            if (canDropRefs) currentRefs = [];
            attemptLabel = 'attempt=2 (empty-envelope recovery)';
            response = await doPost();
            if (!response.ok) {
                const text = await response.text();
                const e = new Error(`API Error on recovery retry (${response.status}): ${text}`);
                e.status = response.status;
                throw e;
            }
            result = await response.json();
            if (isEmptyEnvelope(result)) {
                const hint = isGptImg2
                    ? 'gpt-image-2 via this Gemini-compatible endpoint returned an empty envelope after recovery. Verify model access on this account.'
                    : 'Provider returned an empty envelope after recovery. Verify model access on this account.';
                throw new Error(hint);
            }
        } else {
            const hint = isGptImg2
                ? 'gpt-image-2 via this Gemini-compatible endpoint returned an empty envelope (0 tokens consumed) and recovery knobs were already minimal. Check model access on your provider account.'
                : 'Provider returned an empty envelope (0 tokens consumed) with no recovery options available.';
            throw new Error(hint);
        }
    }

    // Happy path: native Gemini envelope with an inline image part.
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    if (candidates.length > 0) {
        const responseParts = candidates[0].content?.parts || [];
        for (const part of responseParts) {
            if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
        }
    }

    // Fallbacks (order matters: rescue images before surfacing errors).

    // (A) OpenAI-shaped {data:[{b64_json|url}]} under a Gemini endpoint.
    const dataArr = Array.isArray(result.data) ? result.data : null;
    if (dataArr && dataArr.length > 0) {
        const d0 = dataArr[0] || {};
        if (d0.b64_json) {
            iigLog('WARN:api', 'Gemini endpoint returned OpenAI-shaped payload; using data[0].b64_json');
            return `data:image/png;base64,${d0.b64_json}`;
        }
        if (d0.url) {
            iigLog('WARN:api', 'Gemini endpoint returned OpenAI-shaped payload; using data[0].url');
            return assertSafeMediaUrl(d0.url, 'image');
        }
    }

    // (B) Provider error reported with HTTP 200.
    if (result.error && (result.error.message || result.error.code || result.error.status)) {
        const em = result.error.message || 'unspecified';
        const ec = result.error.code ?? result.error.status ?? 'n/a';
        const e = new Error(`Provider error: ${em} (code=${ec})`);
        e.status = typeof result.error.code === 'number' ? result.error.code : null;
        throw e;
    }

    // (C) Prompt-level safety block (promptFeedback.blockReason, no candidates).
    const pf = result.promptFeedback || result.prompt_feedback;
    if (pf && (pf.blockReason || pf.block_reason)) {
        const reason = pf.blockReason || pf.block_reason;
        const detail = pf.blockReasonMessage || pf.block_reason_message || '';
        throw new Error(`Blocked by provider safety filter (prompt): ${reason}${detail ? ` — ${detail}` : ''}`);
    }

    // (D) Candidate-level block (finishReason but no image).
    if (candidates.length > 0) {
        const fr = candidates[0].finishReason || candidates[0].finish_reason || null;
        const safetyLike = /^(IMAGE_SAFETY|SAFETY|PROHIBITED_CONTENT|RECITATION|BLOCKLIST|SPII)$/i;
        if (fr && safetyLike.test(fr)) {
            // Flagged for retry: the model drew this, so a replay can differ.
            const blocked = new Error(`Blocked by provider safety filter (image): ${fr}`);
            blocked.iigSafetyBlock = 'image';
            throw blocked;
        }
        if (fr) {
            throw new Error(`Generation stopped without image: finishReason=${fr}`);
        }
        throw new Error('No image found in Gemini response');
    }

    // (E) Unknown envelope — log keys and a truncated preview for diagnosis.
    const keysPreview = Object.keys(result || {}).slice(0, 8).join(',');
    let bodyPreview = '';
    try { bodyPreview = JSON.stringify(result); } catch (_) { bodyPreview = '<unserializable>'; }
    iigLog('WARN:api', redactPromptModelGeminiError(`Gemini response has no candidates/data/error/promptFeedback. keys=[${keysPreview}] preview=${bodyPreview} [shape-probe]`, settings.apiKey).slice(0, 700));
    throw new Error('No image in provider response (unknown shape). See logs for envelope keys.');
}

// =========================================================================
// Naistera generator (apiType='naistera')
// =========================================================================

async function generateImageNaistera(prompt, style, options = {}, settings = { ...getSettings() }) {
    // pathOverride is not honored here (OpenAI/Gemini only).
    const url = getNaisteraGenerationUrl(settings);

    const aspectRatio = options.aspectRatio || '1:1';
    const model = normalizeNaisteraModel(options.model || settings.naisteraModel || 'grok');
    const rawPreset = options.preset || settings.naisteraPreset || null;
    // Presets apply to Grok models; strip stale values on other models.
    const preset = (rawPreset && naisteraModelSupportsPreset(model)) ? rawPreset : null;
    const suppliedRefs = naisteraModelSupportsReferences(model) ? (options.referenceImages || []) : [];
    const referenceObjects = suppliedRefs.slice(0, 4).map(ref => ({
        image: String(ref?.image || '').trim(),
        description: String(ref?.description || '').trim(),
    })).filter(ref => ref.image);

    const fullPrompt = prefixRefInstruction(applyStylePrefix(prompt, style), referenceObjects.length > 0);

    const body = {
        prompt: fullPrompt,
        aspect_ratio: aspectRatio,
        model,
    };
    if (preset) body.preset = preset;
    const useLegacyRefs = getProviderQuirks(settings).naisteraRefs === 'images';
    if (referenceObjects.length > 0) {
        if (useLegacyRefs) body.reference_images = referenceObjects.map(ref => ref.image);
        else body.reference_objects = referenceObjects;
    }

    // Audit log (Export Logs): fields only, refs counted not dumped.
    const bodyAudit = {
        model: body.model,
        aspect_ratio: body.aspect_ratio,
        preset: body.preset ?? '(unset)',
        prompt_length: body.prompt?.length ?? 0,
        references: referenceObjects.length,
        reference_format: referenceObjects.length > 0 ? (useLegacyRefs ? 'images' : 'objects') : '(unset)',
    };
    iigLog('INFO:api', `Naistera request body (fields only): ${JSON.stringify(bodyAudit)}`);

    const post = () => robustFetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: options.signal,
    });

    let response;
    try {
        response = await post();
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        const pageOrigin = window.location.origin;
        let endpointOrigin = url;
        try { endpointOrigin = new URL(url, window.location.href).origin; } catch (_) {}
        throw new Error(
            `Network/CORS error requesting ${endpointOrigin} from ${pageOrigin}. `
            + `Original: ${error?.message || 'Failed to fetch'}`, { cause: error }
        );
    }

    let errorText = response.ok ? '' : await response.text();
    if (!response.ok && response.status === 400 && body.reference_objects
        && /\breference_objects\b/i.test(errorText)) {
        setProviderQuirk(settings, 'naisteraRefs', 'images');
        body.reference_images = referenceObjects.map(ref => ref.image);
        delete body.reference_objects;
        try {
            response = await post();
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            throw new Error(`Reference-shape retry failed: ${error?.message || 'Network error'}`);
        }
        errorText = response.ok ? '' : await response.text();
    }

    if (!response.ok) {

        // Auto-retry without refs if Grok temporarily can't handle them.
        let parsed = null;
        try { parsed = JSON.parse(errorText); } catch (_) {}
        if (parsed?.reason === 'grok_refs_temporarily_unavailable' && referenceObjects.length > 0) {
            iigLog('WARN:api', 'Grok refs temporarily unavailable — retrying without references');
            toastr.warning(sanitizeForHtml(iigT('iig_grokRefsUnavailable')), sanitizeForHtml(iigT('iig_title')), { timeOut: 4000, escapeHtml: false });

            delete body.reference_objects;
            delete body.reference_images;
            body.prompt = applyStylePrefix(prompt, style); // strip ref-instruction prefix

            let retryResponse;
            try {
                retryResponse = await post();
            } catch (retryError) {
                throw new Error(`Retry without refs also failed: ${retryError?.message || 'Network error'}`);
            }

            if (!retryResponse.ok) {
                const retryText = await retryResponse.text();
                const e = new Error(`API Error on retry without refs (${retryResponse.status}): ${retryText}`);
                e.status = retryResponse.status;
                throw e;
            }

            const retryResult = await retryResponse.json();
            if (!retryResult?.data_url) throw new Error('No data_url in retry response');
            return retryResult.data_url;
        }

        const e = new Error(`API Error (${response.status}): ${errorText}`);
        e.status = response.status;
        throw e;
    }

    const result = await response.json();
    if (!result?.data_url) throw new Error('No data_url in response');
    return result.data_url;
}

// =========================================================================
// Unified reference collection helpers
// =========================================================================

/** Select refs once with their descriptions. Priority: char, user, matched NPCs. */
async function collectReferenceEntriesAsBase64(promptText, maxRefs = 4, settings = { ...getSettings() }) {
    const active = getActiveRefs();
    const refs = structuredClone({ charRef: active.charRef, userRef: active.userRef, npcReferences: active.npcReferences });
    const charName = getStCharName(), userName = getStUserName();
    const out = [];

    const getB64 = async (ref) => {
        if (!ref) return null;
        if (ref.imagePath) {
            const b64 = await loadRefImageAsBase64(ref.imagePath);
            if (b64) return b64;
        }
        return ref.imageBase64 || ref.imageData || null;
    };

    // char/user: always-sent (per-slot toggle) or name-gated like NPCs.
    if (settings.charRefAlways || refMatchesPrompt(refs.charRef, promptText, charName)) {
        const charB64 = await getB64(refs.charRef);
        if (charB64) {
            out.push({ image: charB64, description: String(refs.charRef?.name || charName || '').trim() });
            iigLog('DEBUG:refs', `char ref sent (${settings.charRefAlways ? 'always' : 'name match'})`);
        }
    }
    if (out.length < maxRefs && (settings.userRefAlways || refMatchesPrompt(refs.userRef, promptText, userName))) {
        const userB64 = await getB64(refs.userRef);
        if (userB64) {
            out.push({ image: userB64, description: String(refs.userRef?.name || userName || '').trim() });
            iigLog('DEBUG:refs', `user ref sent (${settings.userRefAlways ? 'always' : 'name match'})`);
        }
    }

    const matchedNpcs = matchNpcReferences(promptText, refs.npcReferences || []);
    for (const npc of matchedNpcs) {
        if (out.length >= maxRefs) break;
        const b64 = await getB64(npc);
        if (b64) {
            out.push({ image: b64, description: String(npc.name || '').trim() });
            iigLog('DEBUG:refs', `NPC matched: ${npc.name}`);
        }
    }

    return out.slice(0, maxRefs);
}

/** Collect refs as raw base64 for OpenAI/Gemini. */
async function collectReferencesAsBase64(promptText, maxRefs = 4, settings) {
    const entries = await collectReferenceEntriesAsBase64(promptText, maxRefs, settings);
    return entries.map(ref => ref.image);
}

/** Collect structured data-URL references for Naistera. */
async function collectReferencesAsDataUrls(promptText, maxRefs = 4, settings) {
    const entries = await collectReferenceEntriesAsBase64(promptText, maxRefs, settings);
    return entries.map(ref => {
        const b64 = ref.image;
        const image = String(b64).startsWith('data:')
            ? b64
            : `data:${detectImageMimeFromBase64(b64)};base64,${b64}`;
        return { image, description: ref.description };
    });
}

/** Hint toast for known error patterns. Same suggestion suppressed 30s. Never throws. */
const _recentErrorSuggestions = new Map();
function maybeSuggestFix(error) {
    try {
        const settings = getSettings();
        const status = Number(error?.status) || null;
        const msg = String(error?.message || '').toLowerCase();
        const apiType = settings.apiType;

        let suggestion = null;

        if (status === 404 || /404|not found/.test(msg)) {
            if (apiType === 'openai') {
                suggestion = 'iig_hintOpenai404';
            } else if (apiType === 'gemini') {
                // /compatible is probed automatically, but only when there is
                // no path override and the base lacks the prefix.
                // Only claim it was tried when it actually was.
                const base = getEffectiveEndpoint(settings);
                const probed = !(settings.pathOverride || '').trim() && !endpointHasCompatiblePrefix(base);
                suggestion = probed
                    ? 'iig_hintGemini404Probed'
                    : 'iig_hintGemini404';
            }
        } else if (status === 401 || status === 403) {
            suggestion = 'iig_hintAuth';
        } else if (status === 400) {
            if (apiType === 'gemini' && isGptImageModel(settings.model)
                && /image model, not a language model|use the image generation api/.test(msg)) {
                suggestion = 'iig_hintGptImageApi';
            } else if (/generationconfig|contents\[/.test(msg)) {
                suggestion = 'iig_hintGeminiBody';
            } else if (apiType === 'openai' && isGptImageModel(settings.model)
                && /quality.*(?:low|medium|high|auto|hd|standard)|(?:low|medium|high|auto|hd|standard).*quality/.test(msg)) {
                suggestion = 'iig_hintGptQuality';
            } else if (/response_format|b64_json|quality/.test(msg)) {
                suggestion = 'iig_hintOpenaiField';
            }
        } else if (status === 502 || status === 503 || status === 504) {
            suggestion = 'iig_hintUpstream';
        } else if (/cors|network|failed to fetch/.test(msg) && !msg.includes('aborted')) {
            suggestion = 'iig_hintNetwork';
        } else if (/blocked by provider safety filter/.test(msg)) {
            suggestion = apiType === 'gemini' && /gpt-image-2/i.test(settings.model || '')
                ? 'iig_hintSafetyRequest'
                : 'iig_hintSafetyImage';
        } else if (/generation stopped without image/.test(msg)) {
            suggestion = 'iig_hintNoImage';
        } else if (/unknown shape/.test(msg)) {
            suggestion = 'iig_hintUnknownShape';
        } else if (/empty envelope/.test(msg)) {
            suggestion = apiType === 'gemini' && /gpt-image-2/i.test(settings.model || '')
                ? 'iig_hintGptAccess'
                : 'iig_hintEmptyEnvelope';
        } else if (/^provider error:/i.test(error?.message || '')) {
            suggestion = 'iig_hintErrorEnvelope';
        }

        if (!suggestion) return;

        const now = Date.now();
        const suggestionId = `${suggestion}:${status || ''}`;
        const lastShown = _recentErrorSuggestions.get(suggestionId) || 0;
        if (now - lastShown < 30000) return;
        _recentErrorSuggestions.set(suggestionId, now);

        toastr.info(sanitizeForHtml(iigT(suggestion, { status })), sanitizeForHtml(iigT('iig_hintTitle')), { timeOut: 9000, extendedTimeOut: 4000, escapeHtml: false });
    } catch (_) { /* swallow — hint is best-effort */ }
}

/** Validate settings before generation; throws with aggregated error list. */
function validateSettings() {
    const settings = getSettings();
    const errors = [];

    switch (settings.apiType) {
        case 'openai':
        case 'gemini': {
            // Validate the NORMALIZED endpoint — that is the value that
            // actually gets built into the request URL.
            const endpoint = getEffectiveEndpoint(settings);
            const endpointError = validateEndpointShape(endpoint);
            if (endpointError) {
                const protocol = endpointError.startsWith('Endpoint must use ')
                    ? endpointError.match(/\(got "([^"]+)"\)/)?.[1] : null;
                errors.push(iigError(endpointError, protocol ? 'iig_endpointProtocol'
                    : endpointError.startsWith('Use a base endpoint') ? 'iig_endpointBaseOnly'
                        : endpoint ? 'iig_endpointInvalid' : 'iig_endpointMissing',
                { endpoint, protocol }));
            }
            if (!settings.apiKey) errors.push(iigError('API key not configured', 'iig_apiKeyMissing'));
            if (!settings.model) errors.push(iigError('Model not selected', 'iig_modelMissing'));
            if (settings.apiType === 'openai' && isRoutMyNovelAiModel(settings.model)
                && !parseRoutMyNovelAiModel(settings.model)) {
                errors.push(iigError('NovelAI requires a full model ID ending in -WIDTHxHEIGHT-sSTEPS', 'iig_novelAiModelInvalid'));
            }
            break;
        }
        case 'naistera': {
            const endpoint = getEffectiveEndpoint(settings);
            const endpointError = validateEndpointShape(endpoint);
            if (endpointError) errors.push(iigError(endpointError, endpointError.startsWith('Use a base endpoint') ? 'iig_endpointBaseOnly' : 'iig_endpointInvalid', { endpoint }));
            if (!settings.apiKey) errors.push(iigError('API key not configured', 'iig_apiKeyMissing'));
            break;
        }
        default:
            errors.push(iigError(`Unknown apiType: ${settings.apiType}`, 'iig_unknownApiType', { apiType: settings.apiType }));
    }

    if (errors.length > 0) {
        throw iigError(`Settings error: ${errors.map(error => error.message).join(', ')}`, 'iig_settingsError',
            { errors: errors.map(error => iigErrorText(error)).join(', ') });
    }
}

/** HTML-escape text for safe insertion into element content OR quoted attributes. */
// Preescaped toastr calls use per-call escapeHtml: false to avoid host escaping twice.
function sanitizeForHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Escape for interpolation into a quoted HTML attribute of either style.
 * Covers & " ' < >. Use for every `src="${...}"` written into message text —
 * mes is persisted to the chat file and re-parsed as HTML on every reload.
 */
function escapeAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** Decode HTML entities in an instruction payload back to raw text. */
function normalizeInstructionPayload(text) {
    return String(text || '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#34;/g, '"')
        .replace(/&lt;|&#60;/g, '<')
        .replace(/&gt;|&#62;/g, '>')
        .replace(/&amp;/g, '&');
}

/** Decode common escape sequences in a relaxed JSON value string. */
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

/** Regex key/value fallback for instruction payloads JSON.parse rejects. */
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

/** Strict JSON.parse → relaxed regex parse fallback for instruction payloads. */
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
 * Escape for use inside single-quoted HTML attributes (data-iig-instruction).
 *
 * Deliberately does NOT escape `"`. parseImageTags brace-scans the raw text of
 * message.mes and uses a literal `"` to track string state; entity-encoding it
 * makes every brace inside a prompt read as structure, truncating payloads that
 * contain `}` and unterminating those that contain `{`. A `"` cannot close a
 * single-quoted attribute, so omitting it is not an escape hazard. Unifying
 * with escapeAttr() here requires making the scanner entity-aware first.
 */
function sanitizeForSingleQuotedAttribute(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** Build a minimal instruction-data object from a parsed tag. */
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

/** Get the data-iig-instruction attribute value from a tag. */
function getInstructionAttributeValue(tag) {
    if (tag.isNewFormat && tag.fullMatch) {
        const instructionMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instructionMatch) return instructionMatch[2];
    }
    return JSON.stringify(buildInstructionData(tag));
}

/** Parse image tags from narrative and rendered display sources. */
async function parseMessageImageTags(message, options = {}) {
    const sources = [
        ['mes', message?.mes || ''],
        ['display_text', message?.extra?.display_text || ''],
    ];
    const tags = [];
    const narrativeCounts = new Map();
    const displayCounts = new Map();
    const displayNarrativeCounts = new Map();
    const sidecarRange = findPromptModelSidecarRange(String(message?.extra?.display_text || ''));
    for (const [sourceKey, source] of sources) {
        if (!source) continue;
        const parsed = (await parseImageTags(source, options))
            .sort((a, b) => a.index - b.index);
        if (sources.some(([key, value]) => getMessageTagSource(message, key) !== value)) return [];
        for (let sourceOrdinal = 0; sourceOrdinal < parsed.length; sourceOrdinal++) {
            const tag = parsed[sourceOrdinal];
            const counts = sourceKey === 'mes' ? narrativeCounts : displayCounts;
            const occurrence = counts.get(tag.fullMatch) || 0;
            counts.set(tag.fullMatch, occurrence + 1);
            const inSidecar = sourceKey === 'display_text' && !!sidecarRange
                && tag.index >= sidecarRange.start && tag.index < sidecarRange.end;
            if (sourceKey === 'display_text' && !inSidecar) {
                const narrativeOccurrence = displayNarrativeCounts.get(tag.fullMatch) || 0;
                displayNarrativeCounts.set(tag.fullMatch, narrativeOccurrence + 1);
                if (narrativeOccurrence < (narrativeCounts.get(tag.fullMatch) || 0)) continue;
            }
            tags.push({ ...tag, sourceKey, sourceIndex: tag.index, sourceOrdinal, occurrence, inSidecar });
        }
    }
    return tags;
}

function getMessageTagSource(message, sourceKey) {
    return sourceKey === 'display_text'
        ? String(message?.extra?.display_text || '')
        : String(message?.mes || '');
}

async function resolveRenderedImageSource(imgElement) {
    if (_iigDisposed) return null;
    invalidateContextCache();
    const messageElement = imgElement?.closest?.('.mes[mesid]');
    const messageId = Number.parseInt(messageElement?.getAttribute('mesid') || '', 10);
    const message = Number.isInteger(messageId) ? getContext()?.chat?.[messageId] : null;
    if (!messageElement || !message) return null;

    const rendered = Array.from(messageElement.querySelectorAll('.mes_text img[data-iig-instruction]'));
    const renderedIndex = rendered.indexOf(imgElement);
    if (renderedIndex < 0) return null;
    const scope = buildProcessingKey(messageId);
    const chat = getContext()?.chat;
    const swipe = message.swipe_info?.[getMessageSwipeId(message)];
    const narrativeSource = getMessageTagSource(message, 'mes');
    const displaySource = getMessageTagSource(message, 'display_text');
    const isCurrent = () => {
        invalidateContextCache();
        const current = getContext();
        const images = Array.from(messageElement.querySelectorAll('.mes_text img[data-iig-instruction]'));
        return !_iigDisposed && imgElement.isConnected && current?.chat === chat
            && imgElement.closest('.mes[mesid]') === messageElement
            && Number.parseInt(messageElement.getAttribute('mesid'), 10) === messageId
            && current.chat[messageId] === message && buildProcessingKey(messageId) === scope
            && message.swipe_info?.[getMessageSwipeId(message)] === swipe
            && getMessageTagSource(message, 'mes') === narrativeSource
            && getMessageTagSource(message, 'display_text') === displaySource
            && images.length === rendered.length && images.every((image, index) => image === rendered[index]);
    };
    const tags = (await parseMessageImageTags(message, { forceAll: true }))
        .filter(tag => tag.mediaType === 'image' && tag.isNewFormat);
    if (!isCurrent()) return null;
    const renderedSourceKey = displaySource ? 'display_text' : 'mes';
    const renderedSource = displaySource || narrativeSource;
    const parsed = (await parseImageTags(renderedSource, { forceAll: true }))
        .sort((a, b) => a.index - b.index);
    if (!isCurrent()) return null;
    const sidecarRange = findPromptModelSidecarRange(displaySource);
    const occurrenceCounts = new Map();
    const narrativeCounts = new Map();
    const renderedTags = parsed.map((candidate, sourceOrdinal) => {
        const occurrence = occurrenceCounts.get(candidate.fullMatch) || 0;
        occurrenceCounts.set(candidate.fullMatch, occurrence + 1);
        const inSidecar = renderedSourceKey === 'display_text' && !!sidecarRange
            && candidate.index >= sidecarRange.start && candidate.index < sidecarRange.end;
        const narrativeOccurrence = narrativeCounts.get(candidate.fullMatch) || 0;
        if (!inSidecar) narrativeCounts.set(candidate.fullMatch, narrativeOccurrence + 1);
        return { ...candidate, sourceKey: renderedSourceKey, sourceIndex: candidate.index,
            sourceOrdinal, occurrence, narrativeOccurrence, inSidecar };
    }).filter(candidate => candidate.mediaType === 'image' && candidate.isNewFormat);
    if (renderedTags.length !== rendered.length) return null;
    let tag = renderedTags[renderedIndex];
    if (!tag) return null;

    // The rendered occurrence and its current attributes must agree before choosing a source.
    const template = document.createElement('template');
    template.innerHTML = tag.fullMatch;
    const sourceImage = template.content.querySelector('img[data-iig-instruction]');
    try {
        if (!sourceImage || (sourceImage.getAttribute('src') || '') !== (imgElement.getAttribute('src') || '')
            || JSON.stringify(parseInstructionObject(sourceImage.getAttribute('data-iig-instruction')))
                !== JSON.stringify(parseInstructionObject(imgElement.getAttribute('data-iig-instruction')))) return null;
    } catch (_) {
        return null;
    }
    if (tag.sourceKey === 'display_text' && !tag.inSidecar) {
        tag = tags.find(candidate => candidate.sourceKey === 'mes'
            && candidate.fullMatch === tag.fullMatch
            && candidate.occurrence === tag.narrativeOccurrence) || tag;
    }
    const source = getMessageTagSource(message, tag.sourceKey);
    if (source.slice(tag.sourceIndex, tag.sourceIndex + tag.fullMatch.length) !== tag.fullMatch) return null;
    return { messageId, message, tag, source, renderedIndex };
}

const _imageSourceSelections = new WeakMap();

function trackImageSourceSelection(message, tag) {
    const selection = { tag: { ...tag }, mes: getMessageTagSource(message, 'mes'),
        display_text: getMessageTagSource(message, 'display_text'), valid: true };
    let selections = _imageSourceSelections.get(message);
    if (!selections) _imageSourceSelections.set(message, selections = new Set());
    selections.add(selection);
    selection.release = () => {
        selections.delete(selection);
        if (!selections.size) _imageSourceSelections.delete(message);
    };
    return selection;
}

function isImageSourceSelectionCurrent(message, selection) {
    return selection.valid && ['mes', 'display_text'].every(key =>
        getMessageTagSource(message, key) === selection[key]);
}

// Only known exact splices can move another in-flight selection's offset.
function advanceImageSourceSelections(message, sourceKey, before, after, index, length, replacementLength) {
    for (const selection of _imageSourceSelections.get(message) || []) {
        if (selection[sourceKey] !== before) { selection.valid = false; continue; }
        selection[sourceKey] = after;
        if (selection.tag.sourceKey !== sourceKey) continue;
        const start = selection.tag.sourceIndex;
        if (start >= index + length) selection.tag.sourceIndex += replacementLength - length;
        else if (start + selection.tag.fullMatch.length > index) selection.valid = false;
    }
}

function replaceExactTagInMessageSource(message, tag, expectedSource, replacement) {
    if (!message || !tag || !Number.isInteger(tag.sourceIndex) || tag.sourceIndex < 0) return false;
    const currentSource = getMessageTagSource(message, tag.sourceKey);
    if (currentSource !== expectedSource) return false;
    const end = tag.sourceIndex + tag.fullMatch.length;
    if (currentSource.slice(tag.sourceIndex, end) !== tag.fullMatch) return false;
    const updated = currentSource.slice(0, tag.sourceIndex) + replacement + currentSource.slice(end);
    const swipeId = getMessageSwipeId(message);
    const mirror = message.swipe_info?.[swipeId]?.extra?.display_text;
    if (mirror !== undefined && mirror !== message.extra?.display_text) return false;
    if (tag.sourceKey !== 'display_text' && message.swipes?.[swipeId] !== undefined
        && message.swipes[swipeId] !== message.mes) return false;
    if (tag.sourceKey === 'display_text') {
        writePromptModelDisplayText(message, updated);
    } else {
        message.mes = updated;
        if (Array.isArray(message.swipes) && typeof message.swipes[swipeId] === 'string') {
            message.swipes[swipeId] = updated;
        }
        if (typeof message.extra?.display_text === 'string') {
            const display = message.extra.display_text;
            const displayIndex = findTagOccurrenceIndex(display, tag.fullMatch, tag.occurrence, findPromptModelSidecarRange(display));
            if (displayIndex >= 0) {
                const updatedDisplay = display.slice(0, displayIndex) + replacement + display.slice(displayIndex + tag.fullMatch.length);
                writePromptModelDisplayText(message, updatedDisplay);
                advanceImageSourceSelections(message, 'display_text', display, updatedDisplay, displayIndex, tag.fullMatch.length, replacement.length);
            }
        }
    }
    advanceImageSourceSelections(message, tag.sourceKey || 'mes', currentSource, updated, tag.sourceIndex, tag.fullMatch.length, replacement.length);
    return true;
}

function replaceSrcInTag(tagHtml, newSrc) {
    const source = String(tagHtml || '');
    const replaced = source.replace(/(\ssrc\s*=\s*)(['"])([\s\S]*?)\2/i,
        (_match, prefix, quote) => `${prefix}${quote}${newSrc}${quote}`);
    return replaced === source ? null : replaced;
}

function snapshotSingleImageSource(message, tag = null) {
    if (!message) return null;
    return {
        tag: tag ? { ...tag } : null,
        source: tag ? getMessageTagSource(message, tag.sourceKey) : null,
        mes: message.mes,
        hasDisplayText: Object.hasOwn(message.extra || {}, 'display_text'),
        displayText: message.extra?.display_text,
        extraOwner: message.extra,
        swipesOwner: message.swipes,
        swipes: Array.isArray(message.swipes) ? [...message.swipes] : null,
        swipeDisplays: Array.isArray(message.swipe_info)
            ? message.swipe_info.map(info => ({
                hasDisplayText: Object.hasOwn(info?.extra || {}, 'display_text'),
                displayText: info?.extra?.display_text,
                owner: info?.extra,
            }))
            : null,
    };
}

function applySingleImageSourceReplacement(message, snapshot, replacement) {
    if (!snapshot?.tag) return false;
    return replaceExactTagInMessageSource(message, snapshot.tag, snapshot.source, replacement);
}

function restoreSingleImageSource(message, snapshot, written) {
    if (!message || !snapshot || !written) return false;
    let restored = false;
    const restore = (owner, key, before, after, had = true) => {
        if (!owner || before === after || owner[key] !== after) return;
        if (had) owner[key] = before;
        else delete owner[key];
        restored = true;
    };
    restore(message, 'mes', snapshot.mes, written.mes);
    if (message.extra === written.extraOwner) {
        restore(message.extra, 'display_text', snapshot.displayText, written.displayText, snapshot.hasDisplayText);
    }
    if (snapshot.swipes && message.swipes === written.swipesOwner) {
        snapshot.swipes.forEach((value, index) => restore(message.swipes, index, value, written.swipes[index]));
    }
    if (snapshot.swipeDisplays && Array.isArray(message.swipe_info)) {
        snapshot.swipeDisplays.forEach((saved, index) => {
            const info = message.swipe_info[index];
            const after = written.swipeDisplays[index];
            if (!info?.extra || info.extra !== after?.owner) return;
            restore(info.extra, 'display_text', saved.displayText, after.displayText, saved.hasDisplayText);
        });
    }
    return restored;
}

const _singleImageCommitTails = new WeakMap();

async function queueSingleImageCommit(message, task) {
    const previous = _singleImageCommitTails.get(message) || Promise.resolve();
    let release;
    const turn = new Promise(resolve => { release = resolve; });
    _singleImageCommitTails.set(message, turn);
    try {
        await previous.catch(() => {});
        return await task();
    } finally {
        release();
        if (_singleImageCommitTails.get(message) === turn) {
            _singleImageCommitTails.delete(message);
        }
    }
}

async function commitSingleImageSource(message, snapshot, applyReplacement, saveChat, canRecover = () => !_iigDisposed) {
    throwIfSignalAborted();
    let sourceMutated = false;
    let written;
    try {
        if (!applyReplacement()) {
            const staleError = new Error('Selected image source changed during regeneration');
            staleError.code = 'IIG_STALE_SOURCE';
            throw staleError;
        }
        sourceMutated = true;
        written = snapshotSingleImageSource(message);
        await saveChat();
    } catch (error) {
        if (sourceMutated && canRecover() && restoreSingleImageSource(message, snapshot, written)) {
            try {
                await saveChat();
            } catch (rollbackError) {
                iigLog('ERROR', 'Single image rollback save failed:', rollbackError.message);
            }
        }
        error.iigPersistenceFailure = true;
        throw error;
    }
}

// =========================================================================
// Retry classification — pure, with no settings, DOM or network access.
// =========================================================================

// Transient per rout.my §16 ("Retry? Yes — 429, 500, 502, 503"). 504 is ours:
// a gateway timeout in front of any of those is the same condition observed
// one hop further out.
const RETRYABLE_STATUSES = Object.freeze([429, 500, 502, 503, 504]);

// Explicitly terminal. 499 is the one that matters — the client already
// disconnected, so retrying just burns another multi-minute generation. Listed
// rather than merely omitted, or a 499 whose body contains the word "network"
// would retry.
const NON_RETRYABLE_STATUSES = Object.freeze([400, 401, 403, 404, 405, 499]);

// Backoff bounds. The ceiling is rout.my's own figure (§16 caps its worked
// example at 30s); without it, retryDelay=10000 with maxRetries=5 produces a
// single 160-second sleep. Jitter is additive-only — shortening the first
// retry can land back inside the rate-limit window we are backing off from.
const RETRY_DELAY_CEILING_MS = 30000;
const RETRY_JITTER_MS = 500;

// The settings input clamps 0..5, but getSettings() does not re-clamp, so a
// hand-edited settings.json can carry any number into the loop bound.
const RETRY_ATTEMPTS_MIN = 0;
const RETRY_ATTEMPTS_MAX = 5;
const RETRY_ATTEMPTS_DEFAULT = 2;

/**
 * Classify retries in this order: abort, explicit status, then message fallback.
 * `isServerSide` gates forced retries; `isSafety` requires a structured
 * image-level flag so provider text cannot trigger it.
 */
function classifyRetryError(error) {
    const status = typeof error?.status === 'number' ? error.status : null;
    const rawMessage = String(error?.message || '');
    const msg = rawMessage.toLowerCase();

    const isAbort = error?.name === 'AbortError' || msg.includes('aborted');
    const isSafety = !isAbort && error?.iigSafetyBlock === 'image';

    // Recover a status from the message ONLY in the exact shape this file
    // writes it: `API Error (503): <provider text>` and its two "on <phase>"
    // variants. Scanning the whole message would let provider-controlled body
    // text mentioning those digits force a retry on a terminal error.
    let effectiveStatus = status;
    if (effectiveStatus === null) {
        const m = rawMessage.match(/^API Error\b[^(]*\((\d{3})\)/);
        if (m) effectiveStatus = Number(m[1]);
    }

    const isServerSide = !isAbort
        && effectiveStatus !== null
        && effectiveStatus >= 500 && effectiveStatus <= 599
        && RETRYABLE_STATUSES.includes(effectiveStatus);

    let isRetryable;
    let isTimeout = false;
    if (isAbort) {
        isRetryable = false;
    } else if (effectiveStatus !== null && NON_RETRYABLE_STATUSES.includes(effectiveStatus)) {
        isRetryable = false;
    } else if (effectiveStatus !== null && RETRYABLE_STATUSES.includes(effectiveStatus)) {
        isRetryable = true;
    } else if (effectiveStatus !== null) {
        // Unlisted status (507, 418, ...): treat 5xx as transient, rest as final.
        isRetryable = effectiveStatus >= 500;
    } else {
        // Match both timeout spellings emitted by the transport helpers.
        isTimeout = msg.includes('timeout') || msg.includes('timed out');
        isRetryable = isTimeout || msg.includes('network') || isSafety;
    }

    return { status: effectiveStatus, isAbort, isServerSide, isRetryable, isTimeout, isSafety };
}

/**
 * Exponential backoff with an absolute ceiling and additive jitter.
 *
 * The cap is applied BEFORE the jitter, so the ceiling is a real ceiling: the
 * largest possible sleep is RETRY_DELAY_CEILING_MS + RETRY_JITTER_MS - 1.
 *
 * `rand` optionally overrides Math.random.
 */
function computeRetryDelay(baseDelay, attempt, rand) {
    const base = Number.isFinite(Number(baseDelay)) && Number(baseDelay) > 0 ? Number(baseDelay) : 1000;
    const step = Number.isFinite(Number(attempt)) && Number(attempt) > 0 ? Math.floor(Number(attempt)) : 0;
    const capped = Math.min(RETRY_DELAY_CEILING_MS, base * Math.pow(2, step));
    const roll = typeof rand === 'function' ? rand() : Math.random();
    return Math.round(capped) + Math.floor(roll * RETRY_JITTER_MS);
}

/**
 * Clamp a configured maxRetries into the range the UI advertises.
 *
 * Infinity clamps to the maximum rather than falling back to the default —
 * only NaN and non-numeric values are "no usable setting". A user who wrote
 * something unbounded meant "as many as allowed", not "the default".
 */
function clampRetries(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return RETRY_ATTEMPTS_DEFAULT;
    if (n === Infinity) return RETRY_ATTEMPTS_MAX;
    if (n === -Infinity) return RETRY_ATTEMPTS_MIN;
    return Math.min(RETRY_ATTEMPTS_MAX, Math.max(RETRY_ATTEMPTS_MIN, Math.floor(n)));
}

/**
 * Generate an image with exponential-backoff retry, dispatched by apiType.
 * 5xx always gets >=1 retry regardless of maxRetries; AbortError propagates.
 */
async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();

    const settings = Object.freeze({ ...getSettings() });
    options = { ...options };
    // Clamped at READ, not just at the input handler — getSettings() replays
    // whatever is in settings.json verbatim.
    const configuredMax = clampRetries(settings.maxRetries);
    const baseDelay = settings.retryDelay;

    // Prompt-driven=off forces UI defaults; strip per-tag overrides.
    if (settings.promptDriven === false) {
        const stripped = Object.keys(options).filter(k => ['imageSize','quality','preset'].includes(k));
        if (stripped.length > 0) {
            iigLog('INFO', `Prompt-driven=off: ignoring tag overrides (${stripped.join(', ')})`);
            for (const k of stripped) delete options[k];
        }
    }

    // Ref gating by apiType: naistera = model + toggle; gemini = toggle; openai = always.
    let referenceImages = [];
    let referenceDataUrls = [];
    if (settings.apiType === 'naistera') {
        const modelOk = naisteraModelSupportsReferences(settings.naisteraModel);
        const userOk = settings.naisteraSendRefs !== false;
        if (modelOk && userOk) {
            referenceDataUrls = await collectReferencesAsDataUrls(prompt, 4, settings);
        } else {
            iigLog('INFO', `Naistera refs skipped: modelOk=${modelOk}, userOk=${userOk}`);
        }
    } else if (settings.apiType === 'gemini' && settings.geminiSendRefs === false) {
        iigLog('INFO', 'Gemini refs skipped: user toggle off');
    } else {
        const maxRefs = settings.apiType === 'openai' && isRoutMyNovelAiModel(settings.model) ? 2 : 4;
        referenceImages = await collectReferencesAsBase64(prompt, maxRefs, settings);
    }

    let lastError;

    // Shared by the loop bound and retry overrides.
    let effectiveMax = configuredMax;

    for (let attempt = 0; ; attempt++) {
        if (attempt > effectiveMax) break;
        if (options.signal?.aborted) {
            const abortErr = new Error('Generation aborted');
            abortErr.name = 'AbortError';
            abortErr.reason = options.signal.reason;
            throw abortErr;
        }

        try {
            // Kept short — this renders inside the loading placeholder, which
            // is narrow on mobile. "retry 1/0" would be nonsense on the forced
            // server-error attempt, so that case drops the denominator.
            onStatusUpdate?.(iigT(attempt === 0 ? 'iig_generating'
                : attempt > configuredMax ? 'iig_generatingRetry' : 'iig_generatingRetryCount',
            { attempt, count: configuredMax }));

            switch (settings.apiType) {
                case 'naistera':
                    return await generateImageNaistera(prompt, style, { ...options, referenceImages: referenceDataUrls }, settings);
                case 'gemini':
                    return await generateImageGemini(prompt, style, referenceImages, options, settings);
                case 'openai':
                default:
                    return await generateImageOpenAI(prompt, style, referenceImages, options, settings);
            }
        } catch (failure) {
            const error = redactSensitive(failure, value => redactPromptModelGeminiError(value, settings.apiKey));
            lastError = error;
            iigLog('ERROR:api', `Generation attempt ${attempt + 1} failed:`, error.message);

            // Status-first classification; the message is only consulted when
            // there is no usable status. See classifyRetryError.
            const { status, isAbort, isServerSide, isRetryable, isTimeout, isSafety } = classifyRetryError(error);

            // Guarantee one retry for listed server failures when retries are disabled.
            if (isServerSide && effectiveMax < 1) {
                effectiveMax = 1;
                iigLog('INFO', `Server-side ${status || '5xx'} with maxRetries=${configuredMax}: forcing one retry`);
            }

            // Timeouts retry once — the full ladder is ~15 min of spinner.
            // Lowers what the 5xx rule raises; the two cannot both apply.
            if (isTimeout && effectiveMax > 1) {
                effectiveMax = 1;
                iigLog('INFO', `Transport timeout with maxRetries=${configuredMax}: capping at one retry`);
            }

            // Capped, never floored: maxRetries=0 means no retries, safety or not.
            if (isSafety && effectiveMax > 2) {
                effectiveMax = 2;
                iigLog('INFO', `Safety block with maxRetries=${configuredMax}: capping at two retries`);
            }

            if (!isRetryable || attempt >= effectiveMax) {
                if (isAbort) break;
                if (isServerSide) {
                    const friendly = iigError(
                        `Provider upstream unavailable (${status || '5xx'}). Retry in a minute.`,
                        'iig_upstreamUnavailable', { status: status || '5xx' }
                    );
                    friendly.cause = error;
                    if (status) friendly.status = status;
                    throw friendly;
                }
                break;
            }

            const delay = computeRetryDelay(baseDelay, attempt);
            onStatusUpdate?.(iigT('iig_retryDelay', { seconds: Math.max(1, Math.round(delay / 1000)) }));
            // Abortable: a user Stop during backoff resolves immediately; the
            // loop's top-of-iteration aborted check then throws AbortError.
            await abortableDelay(delay, options.signal);
        }
    }

    throw lastError;
}

/**
 * HEAD cache for image paths. Hits live until tab close; misses expire after a
 * TTL so in-flight uploads aren't poisoned. LRU-capped.
 */
const _fileExistsCache = new Map(); // path -> { exists, ts }
const FILE_EXISTS_NEG_TTL_MS = 60 * 1000;
const FILE_EXISTS_CACHE_CAP = 500;

function _evictFileExistsCacheIfFull(incomingPath) {
    if (_fileExistsCache.size < FILE_EXISTS_CACHE_CAP) return;
    if (_fileExistsCache.has(incomingPath)) return;
    const oldest = _fileExistsCache.keys().next().value;
    if (oldest !== undefined) _fileExistsCache.delete(oldest);
}

async function checkFileExists(path) {
    if (!path) return false;
    const now = Date.now();
    const cached = _fileExistsCache.get(path);
    if (cached) {
        // LRU touch.
        _fileExistsCache.delete(path);
        _fileExistsCache.set(path, cached);
        if (cached.exists) return true;
        if (now - cached.ts < FILE_EXISTS_NEG_TTL_MS) return false;
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
 * Parse image tags from message text. Formats:
 *   <img data-iig-instruction='{...}' src="[IMG:GEN]">  and  [IMG:GEN:{...}]
 */
async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];

    if (!text || (!/data-iig-instruction/i.test(text) && !text.includes('[IMG:GEN:') && !text.includes('[IMG:✓:'))) {
        return tags;
    }

    const imgTagMarker = /\bdata-iig-instruction\s*=\s*/gi;
    let searchPos = 0;

    while (true) {
        imgTagMarker.lastIndex = searchPos;
        const marker = imgTagMarker.exec(text);
        if (!marker) break;
        const markerPos = marker.index;

        const imgStart = text.lastIndexOf('<', markerPos);
        if (imgStart === -1 || !/^<img\b/i.test(text.slice(imgStart, markerPos)) || markerPos - imgStart > 500) {
            searchPos = markerPos + 1;
            continue;
        }
        
        const afterMarker = markerPos + marker[0].length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) {
            searchPos = markerPos + 1;
            continue;
        }
        
        // Brace-count through the JSON payload, respecting quotes and escapes.
        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;

        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (char === '\\' && inString) { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (!inString) {
                if (char === '{') braceCount++;
                else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) { jsonEnd = i + 1; break; }
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
        const hasMarker = srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg');
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;

        // Error images regenerate only on explicit user action (force flag).
        if (hasErrorImage && !forceAll) {
            iigLog('DEBUG:tag', `Skipping error image (use regenerate button): ${srcValue.substring(0, 50)}`);
            searchPos = imgEnd;
            continue;
        }
        
        if (forceAll) {
            needsGeneration = true;
            iigLog('DEBUG:tag', `Force regeneration mode: including ${srcValue.substring(0, 30)}`);
        } else if (hasMarker || !srcValue) {
            needsGeneration = true;
        } else if (hasPath && checkExistence) {
            const exists = await checkFileExists(srcValue);
            if (!exists) {
                iigLog('WARN:tag', `Referenced file not found: ${srcValue}`);
                needsGeneration = true;
            } else {
                iigLog('DEBUG:tag', `Skipping existing image: ${srcValue.substring(0, 50)}`);
            }
        } else if (hasPath) {
            iigLog('DEBUG:tag', `Skipping path (no existence check): ${srcValue.substring(0, 50)}`);
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
                mediaType: 'image',
                style: data.style || '',
                prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: true,
                existingSrc: hasPath ? srcValue : null
            });

            iigLog('DEBUG:tag', `Found tag (img format): ${data.prompt?.substring(0, 50)}`);
        } catch (e) {
            iigLog('WARN', `Failed to parse instruction JSON: ${instructionJson.substring(0, 100)}`, e.message);
        }
        
        searchPos = imgEnd;
    }

    // [IMG:GEN:{...}] form. Same brace-count scanner as above.
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
            if (escapeNext) { escapeNext = false; continue; }
            if (char === '\\' && inString) { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (!inString) {
                if (char === '{') braceCount++;
                else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) { jsonEnd = i + 1; break; }
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
                mediaType: 'image',
                style: data.style || '',
                prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: false
            });

            iigLog('DEBUG:tag', `Found tag (legacy format): ${data.prompt?.substring(0, 50)}`);
        } catch (e) {
            iigLog('WARN', `Failed to parse legacy tag JSON: ${jsonStr.substring(0, 100)}`, e.message);
        }

        searchStart = jsonEnd + 1;
    }

    return tags;
}

// Resolved-once caches for the install folder and the error.svg path.
let _cachedAssetBase = null;
let _cachedErrorImagePath = null;

// Resolve our install-folder base URL (works regardless of folder name).
// import.meta.url is available because ST loads index.js as a module; falls
// back to DOM/href sniffing, then a hardcoded candidate.
function getAssetBasePath() {
    if (_cachedAssetBase) return _cachedAssetBase;

    // Preferred: resolve from the loaded module URL.
    try {
        const here = import.meta.url; // e.g. https://host/scripts/extensions/third-party/<folder>/index.js
        if (here) {
            const u = new URL(here);
            _cachedAssetBase = u.pathname.substring(0, u.pathname.lastIndexOf('/'));
            return _cachedAssetBase;
        }
    } catch (_) { /* not a module context; fall through */ }

    const scripts = document.querySelectorAll('script[src*="index.js"]');
    for (const script of scripts) {
        const src = script.getAttribute('src') || '';
        if (src.includes('inline_image_gen') || src.includes('sillyimages') || src.includes('notsosillynotsoimages')) {
            _cachedAssetBase = src.substring(0, src.lastIndexOf('/'));
            return _cachedAssetBase;
        }
    }

    const links = document.querySelectorAll('link[rel="stylesheet"][href*="style.css"]');
    for (const link of links) {
        const href = link.getAttribute('href') || '';
        if (href.includes('sillyimages') || href.includes('notsosillynotsoimages') || href.includes('inline_image_gen')) {
            _cachedAssetBase = href.substring(0, href.lastIndexOf('/'));
            return _cachedAssetBase;
        }
    }

    _cachedAssetBase = '/scripts/extensions/third-party/notsosillynotsoimages';
    return _cachedAssetBase;
}

function getErrorImagePath() {
    if (_cachedErrorImagePath) return _cachedErrorImagePath;

    // Preferred: use the resolved install-folder base.
    try {
        const base = getAssetBasePath();
        if (base) {
            _cachedErrorImagePath = `${base}/error.svg`;
            return _cachedErrorImagePath;
        }
    } catch (_) { /* fall through to alternate resolution methods */ }

    const scripts = document.querySelectorAll('script[src*="index.js"]');
    for (const script of scripts) {
        const src = script.getAttribute('src') || '';
        if (src.includes('inline_image_gen') || src.includes('sillyimages') || src.includes('notsosillynotsoimages')) {
            const basePath = src.substring(0, src.lastIndexOf('/'));
            _cachedErrorImagePath = `${basePath}/error.svg`;
            return _cachedErrorImagePath;
        }
    }

    const links = document.querySelectorAll('link[rel="stylesheet"][href*="style.css"]');
    for (const link of links) {
        const href = link.getAttribute('href') || '';
        if (href.includes('sillyimages') || href.includes('notsosillynotsoimages') || href.includes('inline_image_gen')) {
            const basePath = href.substring(0, href.lastIndexOf('/'));
            _cachedErrorImagePath = `${basePath}/error.svg`;
            return _cachedErrorImagePath;
        }
    }

    const settingsEl = document.querySelector('.iig-settings');
    if (settingsEl) {
        const anyImg = document.querySelector('img.iig-error-image[src], img.iig-ref-thumb[src]');
        if (anyImg?.src) {
            const basePath = anyImg.src.substring(0, anyImg.src.lastIndexOf('/'));
            _cachedErrorImagePath = `${basePath}/error.svg`;
            return _cachedErrorImagePath;
        }
    }

    // Covers both default and renamed install folders.
    const possiblePaths = [
        '/scripts/extensions/third-party/notsosillynotsoimages/error.svg',
        '/scripts/extensions/third-party/sillyimages/error.svg',
    ];
    _cachedErrorImagePath = possiblePaths[0];

    // Async HEAD to pick the real one; sync callers get the first candidate meanwhile.
    (async () => {
        for (const path of possiblePaths) {
            try {
                const resp = await fetchWithTimeout(path, { method: 'HEAD' }, 10000);
                if (resp.ok) {
                    _cachedErrorImagePath = path;
                    iigLog('DEBUG:image', `error.svg resolved to: ${path}`);
                    return;
                }
            } catch (e) { /* ignore */ }
        }
        iigLog('WARN', 'error.svg not found at any expected path');
    })();

    return _cachedErrorImagePath;
}

// Inline SVG icons for image action buttons (no external deps).
const SVG_ICON_REGENERATE = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
const SVG_ICON_PROMPT_REGENERATE = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4M3 5h4M19 17v4M17 19h4"/></svg>`;
const SVG_ICON_DOWNLOAD = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
// Stop = rounded filled square (no glyph/font dependency).
const SVG_ICON_STOP = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

let _tapAutoHideTimer = null;

function bindTapImageActions(wrapper) {
    if (_iigDisposed || !USE_TAP_IMAGE_ACTIONS || wrapper._iigTapActionsBound) return;
    wrapper._iigTapActionsBound = true;
    bindIig(wrapper, 'click', (event) => {
        if (event.target.closest('.iig-action-btn')) return;
        event.preventDefault();
        event.stopPropagation();

        const wasVisible = wrapper.classList.contains('iig-actions-visible');
        document.querySelectorAll('.iig-image-wrapper.iig-actions-visible').forEach(other => {
            if (other !== wrapper) other.classList.remove('iig-actions-visible');
        });
        clearIigTimeout(_tapAutoHideTimer);
        _tapAutoHideTimer = null;
        wrapper.classList.toggle('iig-actions-visible', !wasVisible);
        if (!wasVisible) {
            _tapAutoHideTimer = setIigTimeout(() => {
                _tapAutoHideTimer = null;
                wrapper.classList.remove('iig-actions-visible');
            }, 4000);
        }
    });
}

/**
 * Wrap <img> with overlay regen/download buttons. Desktop: hover + lightbox;
 * Touch/coarse pointer: tap toggles (4s auto-hide); mobile has no lightbox.
 */
function wrapImageWithActions(imgElement, failedImage = false) {
    if (_iigDisposed) return imgElement;

    let wrapper = imgElement.parentElement;
    if (!wrapper?.classList.contains('iig-image-wrapper')) {
        wrapper = document.createElement('div');
        wrapper.className = 'iig-image-wrapper';
        // Replace in-place if attached; otherwise just nest the detached img.
        if (imgElement.parentElement) imgElement.replaceWith(wrapper);
        wrapper.appendChild(imgElement);
    }
    if (failedImage && !wrapper.classList.contains('iig-placeholder-wrapper')) wrapper.classList.add('iig-placeholder-wrapper');

    if (!wrapper.querySelector('.iig-action-regen')) {
        const btnRegen = document.createElement('button');
        btnRegen.className = 'iig-action-btn iig-action-regen';
        btnRegen.innerHTML = SVG_ICON_REGENERATE;
        btnRegen.title = iigT(failedImage ? 'iig_retry' : 'iig_regenerate');
        btnRegen.setAttribute('aria-label', iigT(failedImage ? 'iig_retryImage' : 'iig_regenerateImage'));
        btnRegen.type = 'button';
        wrapper.appendChild(btnRegen);
        bindIig(btnRegen, 'click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            return regenerateSingleImage(imgElement);
        });
    }

    const existingPromptRegen = wrapper.querySelector('.iig-action-prompt-regen');
    if (!existingPromptRegen) {
        const btnPromptRegen = document.createElement('button');
        btnPromptRegen.className = 'iig-action-btn iig-action-prompt-regen';
        btnPromptRegen.dataset.iigPmReroll = '1';
        btnPromptRegen.innerHTML = SVG_ICON_PROMPT_REGENERATE;
        btnPromptRegen.title = pmT('reroll');
        btnPromptRegen.setAttribute('aria-label', pmT('reroll'));
        btnPromptRegen.type = 'button';
        wrapper.appendChild(btnPromptRegen);
    } else if (existingPromptRegen.hidden) {
        existingPromptRegen.hidden = false;
    }

    if (failedImage) {
        wrapper.querySelector('.iig-action-download')?.remove();
    } else if (!wrapper.querySelector('.iig-action-download')) {
        const btnDownload = document.createElement('button');
        btnDownload.className = 'iig-action-btn iig-action-download';
        btnDownload.innerHTML = SVG_ICON_DOWNLOAD;
        btnDownload.title = iigT(IS_MOBILE ? 'iig_openToSave' : 'iig_download');
        btnDownload.setAttribute('aria-label', btnDownload.title);
        btnDownload.type = 'button';
        wrapper.appendChild(btnDownload);
        bindIig(btnDownload, 'click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            return downloadGeneratedImage(imgElement);
        });
    }

    bindTapImageActions(wrapper);

    return wrapper;
}

/** Open the fullscreen lightbox for the given image element. */
function openLightbox(imgElement) {
    const overlay = document.getElementById('iig_lightbox');
    if (!overlay) return;
    const lbImg = overlay.querySelector('.iig-lightbox-img');
    const caption = overlay.querySelector('.iig-lightbox-caption');
    const regenBtn = overlay.querySelector('.iig-lb-regen');
    const safeSrc = safeMediaUrlOrNull(imgElement.src);
    if (!safeSrc) {
        iigLog('WARN', `Refusing to open lightbox for unsafe src: ${String(imgElement.src).slice(0, 60)}`);
        toastr.error(sanitizeForHtml(iigT('iig_unsafeImageUrl')), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
        return;
    }
    lbImg.src = safeSrc;
    caption.textContent = imgElement.alt || '';
    overlay._sourceImg = imgElement;
    if (regenBtn) {
        regenBtn.style.display = imgElement.hasAttribute('data-iig-instruction') ? '' : 'none';
    }
    overlay.classList.add('open');
}

/** Download a generated image. On mobile, opens in new tab (a.download broken on iOS). */
async function downloadGeneratedImage(imgElement) {
    // Gates both the mobile window.open and the desktop fetch below.
    const src = safeMediaUrlOrNull(imgElement.src);
    if (!src) {
        if (imgElement.src) {
            iigLog('WARN', `Refusing to download unsafe src: ${String(imgElement.src).slice(0, 60)}`);
            toastr.error(sanitizeForHtml(iigT('iig_unsafeDownloadUrl')), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
        }
        return;
    }

    try {
        toastr.info(sanitizeForHtml(iigT('iig_downloading')), sanitizeForHtml(iigT('iig_title')), { timeOut: 2000, escapeHtml: false });

        if (IS_MOBILE) {
            window.open(src, '_blank');
            toastr.success(sanitizeForHtml(iigT('iig_imageOpened')), sanitizeForHtml(iigT('iig_title')), { timeOut: 3000, escapeHtml: false });
            return;
        }

        const response = await fetchWithTimeout(src, {}, 60000);
        if (!response.ok) { response.iigDiscard?.(); throw iigError(`Image request failed (${response.status})`, 'iig_imageRequestFailed', { status: response.status }); }
        const blob = await response.blob();
        if (blob.type && !blob.type.startsWith('image/')) throw iigError(`Unexpected download type: ${blob.type}`, 'iig_downloadTypeInvalid', { type: blob.type });

        const bt = blob.type || '';
        const ext = bt.includes('png') ? 'png'
            : bt.includes('webp') ? 'webp'
            : 'jpg';
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

        toastr.success(sanitizeForHtml(iigT('iig_imageDownloaded')), sanitizeForHtml(iigT('iig_title')), { timeOut: 2000, escapeHtml: false });
    } catch (error) {
        iigLog('ERROR', 'Download failed:', error.message);
        toastr.error(sanitizeForHtml(iigT('iig_downloadFailed', { error: iigErrorText(error) })), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
    }
}

/** Regenerate a single image in place (per-image, not whole message). */
async function regenerateSingleImage(imgElement, preparedSource = null) {
    if (_iigDisposed) return;
    const instruction = preparedSource ? getInstructionAttributeValue(preparedSource.tag) : imgElement.getAttribute('data-iig-instruction');
    if (!instruction) {
        toastr.warning(sanitizeForHtml(iigT('iig_instructionMissing')), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
        return;
    }

    const mesElement = imgElement.closest('.mes[mesid]');
    if (!mesElement) {
        toastr.error(sanitizeForHtml(iigT('iig_parentMessageMissing')), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
        return;
    }
    const messageId = parseInt(mesElement.getAttribute('mesid'), 10);
    const context = getContext();
    const message = context.chat[messageId];
    if (!message) return;
    const resolvedSource = preparedSource || await resolveRenderedImageSource(imgElement);
    if (_iigDisposed) return;
    if (!resolvedSource || resolvedSource.message !== message) {
        toastr.warning(sanitizeForHtml(iigT('iig_sourceChanged')), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
        return;
    }

    let data;
    try {
        data = parseInstructionObject(instruction);
    } catch (e) {
        toastr.error(sanitizeForHtml(iigT('iig_instructionParseFailed')), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
        return;
    }

    // Keep the original occurrence until its source and replacement have both been saved.
    const prevSrc = imgElement.getAttribute('src') || '';
    const originalInstruction = imgElement.getAttribute('data-iig-instruction');
    const prevIsRealImage = !!prevSrc && !prevSrc.includes('error.svg') && !prevSrc.includes('[IMG:');
    const wrapper = imgElement.closest('.iig-image-wrapper')
        || (imgElement.classList.contains('iig-error-image') ? wrapPlaceholderWithRetry(imgElement) : wrapImageWithActions(imgElement));
    if (wrapper._iigRegenerateController || wrapper._iigRewriteController) return;
    const selection = trackImageSourceSelection(message, resolvedSource.tag);
    let sourceCommitted = false;
    const fresh = !prevIsRealImage && !prevSrc.includes('error.svg');
    const swipeInfo = message.swipe_info?.[getMessageSwipeId(message)];
    const wasHidden = wrapper.hidden;
    const focusedControl = wrapper.contains(document.activeElement) ? document.activeElement : null;
    const controls = Array.from(wrapper.querySelectorAll('button')).map(button => ({ button, disabled: button.disabled }));
    // Retain the source occurrence in the DOM while sibling images resolve their own targets.
    const requestScope = buildProcessingKey(messageId);
    const { controller, key } = beginGeneration(messageId, resolvedSource.tag);
    wrapper._iigRegenerateController = controller;
    const tagId = `iig-single-regen-${messageId}-${Date.now()}-${++_singleImageGenerationSerial}`;
    const loadingPlaceholder = createLoadingPlaceholder(tagId);
    tagAbortControllers.set(tagId, controller);
    wrapper.after(loadingPlaceholder);
    controls.forEach(({ button }) => { button.disabled = true; });
    wrapper.hidden = true;
    if (focusedControl) loadingPlaceholder.querySelector('.iig-stop-btn')?.focus({ preventScroll: true });
    const ownsUI = () => !_iigDisposed && wrapper._iigRegenerateController === controller
        && _inFlightGenerations.get(key) === controller && wrapper.isConnected && loadingPlaceholder.isConnected
        && imgElement.parentElement === wrapper && wrapper.closest('.mes[mesid]') === mesElement
        && imgElement.getAttribute('src') === prevSrc
        && imgElement.getAttribute('data-iig-instruction') === originalInstruction
        && mesElement.getAttribute('mesid') === String(messageId)
        && getContext()?.chat?.[messageId] === message && buildProcessingKey(messageId) === requestScope;
    const assertCurrent = (allowStopped = false) => {
        invalidateContextCache();
        if (!allowStopped || controller.signal.reason !== 'user-cancel') throwIfSignalAborted(controller.signal);
        assertMediaOperationCurrent(messageId, message, requestScope, key, controller);
        if (!ownsUI() || message.swipe_info?.[getMessageSwipeId(message)] !== swipeInfo
            || (!sourceCommitted && !isImageSourceSelectionCurrent(message, selection))
            || (sourceCommitted && ['mes', 'display_text'].some(sourceKey => getMessageTagSource(message, sourceKey) !== selection[sourceKey]))) {
            const error = new Error('Image regeneration target changed');
            error.name = 'AbortError';
            throw error;
        }
    };
    const replaceImage = replacement => {
        const focusReplacement = loadingPlaceholder.contains(document.activeElement);
        wrapper.replaceWith(replacement);
        if (focusReplacement) replacement.querySelector('button')?.focus({ preventScroll: true });
    };

    const statusEl = loadingPlaceholder.querySelector('.iig-status');
    const setStatus = (text) => {
        assertCurrent();
        if (statusEl && statusEl.isConnected) statusEl.textContent = text;
    };
    const restorePreviousImage = () => {
        if (ownsUI()) wrapper.hidden = wasHidden;
    };
    const lockStop = () => {
        const stop = loadingPlaceholder.querySelector('.iig-stop-btn');
        if (stop) stop.disabled = true;
        tagAbortControllers.delete(tagId);
    };
    const commitPath = async (imagePath, allowStopped = false) => {
        await queueSingleImageCommit(message, async () => {
            assertCurrent(allowStopped);
            const currentTag = { ...selection.tag };
            const source = getMessageTagSource(message, currentTag.sourceKey);
            currentTag.occurrence = source.slice(0, currentTag.sourceIndex).split(currentTag.fullMatch).length - 1;
            const commitSnapshot = snapshotSingleImageSource(message, currentTag);
            const replacement = currentTag.isNewFormat
                ? replaceSrcInTag(currentTag.fullMatch, escapeAttr(imagePath))
                : `<img data-iig-instruction='${sanitizeForSingleQuotedAttribute(JSON.stringify(buildInstructionData(currentTag)))}' src="${escapeAttr(imagePath)}">`;
            lockStop();
            await commitSingleImageSource(message, commitSnapshot,
                () => !!replacement && applySingleImageSourceReplacement(message, commitSnapshot, replacement),
                () => context.saveChat(), () => {
                    invalidateContextCache();
                    return ownsUI() && message.swipe_info?.[getMessageSwipeId(message)] === swipeInfo;
                });
            sourceCommitted = true;
        });
    };
    const showFreshFailure = async (text, allowStopped = false) => {
        await commitPath(getErrorImagePath(), allowStopped);
        assertCurrent(allowStopped);
        const errorImg = createErrorPlaceholder(tagId, text, resolvedSource.tag);
        errorImg.setAttribute('data-iig-instruction', instruction);
        replaceImage(wrapPlaceholderWithRetry(errorImg));
    };

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

        setStatus(iigT('iig_saving'));
        assertCurrent();
        const imagePath = await saveImageToFile(dataUrl, controller.signal);
        assertCurrent();

        await commitPath(imagePath);

        assertCurrent();
        const newImg = document.createElement('img');
        newImg.className = 'iig-generated-image';
        newImg.src = imagePath;
        newImg.alt = data.prompt || '';
        newImg.title = iigT('iig_imageDetails', { style: data.style || '', prompt: data.prompt || '' });
        newImg.setAttribute('data-iig-instruction', instruction);
        unregisterPlaceholderTick(loadingPlaceholder);
        replaceImage(wrapImageWithActions(newImg));

        sessionGenCount++;
        updateSessionStats();
        if (getSettings().enabled && context.chat[messageId] === message
            && buildProcessingKey(messageId) === requestScope && _inFlightGenerations.get(key) === controller) {
            playDesktopCompletionSound();
        }
        scheduleWrapPass(); // re-wrap after ST re-renders from mes
        toastr.success(sanitizeForHtml(preparedSource ? iigT('iig_imageReady', { index: preparedSource.index + 1, count: preparedSource.count }) : iigT('iig_imageRegenerated')), sanitizeForHtml(iigT('iig_title')), { timeOut: 2000, escapeHtml: false });
        return true;
    } catch (error) {
        const isAbort = error?.name === 'AbortError' || /aborted/i.test(error?.message || '');
        const isUserCancel = error === 'user-cancel' || error?.reason === 'user-cancel' || controller.signal.reason === 'user-cancel';
        invalidateContextCache();
        if (!ownsUI()) return;

        // Fresh pending tags need a persisted error image so Retry retains source identity.
        if (isUserCancel) {
            iigLog('INFO', 'Single image regeneration stopped by user');
            unregisterPlaceholderTick(loadingPlaceholder);
            restorePreviousImage();
            if (fresh && isImageSourceSelectionCurrent(message, selection)) {
                try { await showFreshFailure(iigT('iig_stoppedRetry'), true); }
                catch (_) { /* Keep the original pending source on a save conflict. */ }
            }
            if (_iigDisposed || !isMessageImageScopeCurrent(context, message, messageId, requestScope)) return;
            toastr.info(sanitizeForHtml(iigT('iig_generationStopped')), sanitizeForHtml(iigT('iig_title')), { timeOut: 2000, escapeHtml: false });
            return;
        }

        // Superseded by a newer request; silent cancel, no error UI.
        if (isAbort) {
            iigLog('INFO', 'Single image regeneration aborted (superseded by newer request)');
            unregisterPlaceholderTick(loadingPlaceholder);
            return;
        }
        if (error?.iigPersistenceFailure) {
            iigLog('ERROR', 'Single image persistence failed:', error.message);
            unregisterPlaceholderTick(loadingPlaceholder);
            restorePreviousImage();
            const text = iigT(error.code === 'IIG_STALE_SOURCE' ? 'iig_sourceChanged' : 'iig_chatSaveFailed');
            toastr.error(sanitizeForHtml(text), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
            return;
        }
        iigLog('ERROR', 'Single image regeneration failed:', error.message);

        restorePreviousImage();
        if (fresh && isImageSourceSelectionCurrent(message, selection)) {
            try {
                await showFreshFailure(iigErrorText(error));
            } catch (_) { /* Retain the pending source if saving its error state fails. */ }
        }
        if (_iigDisposed || !isMessageImageScopeCurrent(context, message, messageId, requestScope)) return;

        sessionErrorCount++;
        updateSessionStats();
        toastr.error(sanitizeForHtml(iigT(preparedSource ? 'iig_generationFailed' : 'iig_regenerationFailed', { error: iigErrorText(error) })), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
        maybeSuggestFix(error);
    } finally {
        const restoreFocus = loadingPlaceholder.contains(document.activeElement);
        invalidateContextCache();
        if (ownsUI()) {
            wrapper.hidden = wasHidden;
            controls.forEach(({ button, disabled }) => { button.disabled = disabled; });
            if (restoreFocus && focusedControl?.isConnected) focusedControl.focus({ preventScroll: true });
        }
        if (wrapper._iigRegenerateController === controller) delete wrapper._iigRegenerateController;
        unregisterPlaceholderTick(loadingPlaceholder);
        loadingPlaceholder.remove();
        tagAbortControllers.delete(tagId);
        endGeneration(key, controller);
        selection.release();
    }
}

/** Create a loading-placeholder element with spinner + elapsed timer. */
function createLoadingPlaceholder(tagId, timeoutMs = FETCH_TIMEOUT) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = `
        <div class="iig-spinner-wrap">
            <div class="iig-spinner"></div>
        </div>
        <div class="iig-status" role="status" aria-live="polite">${sanitizeForHtml(iigT('iig_generatingImage'))}</div>
        <div class="iig-timer"></div>
        <button type="button" class="iig-stop-btn" title="${sanitizeForHtml(iigT('iig_stopGeneration'))}" aria-label="${sanitizeForHtml(iigT('iig_stopGeneration'))}">
            ${SVG_ICON_STOP}<span class="iig-stop-label">${sanitizeForHtml(iigT('iig_stop'))}</span>
        </button>
    `;

    // Stop button: cancels only this placeholder's generation.
    const stopBtn = placeholder.querySelector('.iig-stop-btn');
    if (stopBtn) {
        stopBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            stopBtn.disabled = true;
            const lbl = stopBtn.querySelector('.iig-stop-label');
            if (lbl) lbl.textContent = iigT('iig_stopping');
            abortGenerationForTag(tagId);
        });
    }

    const timerEl = placeholder.querySelector('.iig-timer');
    const startTime = Date.now();
    const tSec = timeoutMs / 1000;
    // Detachment is handled by the shared ticker.
    registerPlaceholderTick(placeholder, () => {
        const el = Math.floor((Date.now() - startTime) / 1000);
        if (el >= tSec) { timerEl.textContent = iigT('iig_timeout'); unregisterPlaceholderTick(placeholder); return; }
        const m = Math.floor(el/60), s = el%60;
        timerEl.textContent = `${m}:${String(s).padStart(2,"0")} / ${Math.floor(tSec/60)}:00${IS_IOS ? " (iOS)" : ""}`;
    }, 1000);
    return placeholder;
}

/** Create an error placeholder <img> (error.svg + hover tooltip). */
function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = getErrorImagePath();
    img.alt = iigT('iig_generationError');
    img.title = iigT('iig_error', { error: errorMessage });
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
 * Wrap an error placeholder with retry and rewrite controls (no download).
 * Both actions need the preserved data-iig-instruction attribute.
 */
function wrapPlaceholderWithRetry(imgElement) {
    if (_iigDisposed) return imgElement;
    if (!imgElement.hasAttribute('data-iig-instruction')) return imgElement;
    return wrapImageWithActions(imgElement, true);
}

/** Process all image-gen tags in a message: parse, generate, replace in mes, save. */
async function processMessageTags(messageId, options = {}) {
    if (_iigDisposed) return false;
    invalidateContextCache();
    const context = getContext();
    const settings = getSettings();

    if (!settings.enabled) return false;

    const procKey = buildProcessingKey(messageId);

    if (processingMessages.has(procKey)) {
        iigLog('WARN', `Message ${procKey} is already being processed, skipping`);
        return false;
    }

    // Cooldown against the re-render loop that re-fires the event post-processing.
    const lastProcessed = recentlyProcessed.get(procKey);
    if (!options.force && lastProcessed && (Date.now() - lastProcessed) < REPROCESS_COOLDOWN_MS) {
        iigLog('DEBUG:chat', `Message ${procKey} was recently processed (${Date.now() - lastProcessed}ms ago), skipping re-trigger`);
        return false;
    }

    // Race guard: claim the slot before any await so a second render can't
    // pass the has() check and start a concurrent generation.
    processingMessages.add(procKey);
    const batchToken = Symbol(procKey);
    _regenBatchTokens.set(procKey, batchToken);

    try {
        const message = context.chat[messageId];
        if (!message || message.is_user) {
            // Cooldown-stamp so repeated renders on user/empty msgs don't re-enter.
            markRecentlyProcessed(procKey);
            return false;
        }

        const swipe = message.swipe_info?.[getMessageSwipeId(message)];
        const tags = await parseMessageImageTags(message, { checkExistence: true });
        if (!isMessageImageScopeCurrent(context, message, messageId, procKey)
            || message.swipe_info?.[getMessageSwipeId(message)] !== swipe) return false;
        iigLog('DEBUG:tag', `parseMessageImageTags returned: ${tags.length} tags`);
        if (tags.length > 0) {
            iigLog('DEBUG:tag', `First tag: ${JSON.stringify(tags[0]).substring(0, 200)}`);
        }
        if (tags.length === 0) {
            iigLog('DEBUG:tag', 'No tags found by parser');
            markRecentlyProcessed(procKey);
            return false;
        }

        iigLog('DEBUG:tag', `Found ${tags.length} image tag(s) in message ${procKey}`);
        toastr.info(sanitizeForHtml(iigT('iig_tagsFound', { count: tags.length })), sanitizeForHtml(iigT('iig_title')), { timeOut: 3000, escapeHtml: false });

        const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!messageElement) {
            iigLog('ERROR', 'Message element not found for ID:', messageId);
            toastr.error(sanitizeForHtml(iigT('iig_messageElementMissing')), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
            return false;
        }

        const mesTextEl = messageElement.querySelector('.mes_text');
        if (!mesTextEl) {
            return false;
        }

        await _processMessageTagsInner(context, message, messageId, procKey, tags, mesTextEl);
        return true;
    } finally {
        if (_regenBatchTokens.get(procKey) === batchToken) {
            _regenBatchTokens.delete(procKey);
            processingMessages.delete(procKey);
        }
    }
}

function isMessageImageScopeCurrent(context, message, messageId, scope) {
    invalidateContextCache();
    const current = getContext();
    return !_iigDisposed && current?.chat === context.chat && current.chat[messageId] === message
        && current.characterId === context.characterId && current.groupId === context.groupId
        && buildProcessingKey(messageId) === scope;
}

function findBatchImageTarget(message, tag, mesTextEl) {
    if (!tag.isNewFormat) return null;
    const display = getMessageTagSource(message, 'display_text');
    const source = display || getMessageTagSource(message, 'mes');
    const index = display && tag.sourceKey !== 'display_text'
        ? findTagOccurrenceIndex(display, tag.fullMatch, tag.occurrence, findPromptModelSidecarRange(display))
        : tag.sourceIndex;
    if (index < 0 || source.slice(index, index + tag.fullMatch.length) !== tag.fullMatch) return null;
    const template = document.createElement('template');
    template.innerHTML = source;
    const stored = Array.from(template.content.querySelectorAll('img[data-iig-instruction]'));
    const rendered = Array.from(mesTextEl.querySelectorAll('img[data-iig-instruction]'));
    if (stored.length !== rendered.length) return null;
    template.innerHTML = source.slice(0, index);
    const ordinal = template.content.querySelectorAll('img[data-iig-instruction]').length;
    const img = rendered[ordinal];
    try {
        if (!img || (img.getAttribute('src') || '') !== (stored[ordinal]?.getAttribute('src') || '')
            || JSON.stringify(parseInstructionObject(img.getAttribute('data-iig-instruction')))
                !== JSON.stringify(parseInstructionObject(stored[ordinal].getAttribute('data-iig-instruction')))) return null;
    } catch (_) { return null; }
    return img;
}

// Called synchronously by map: each target is retained and claimed before any request awaits.
async function regenerateBatchImage(message, messageId, tag, target, mesTextEl, index, count) {
    if (_iigDisposed || !mesTextEl.isConnected) return false;
    const context = getContext(), scope = buildProcessingKey(messageId);
    const source = getMessageTagSource(message, tag.sourceKey);
    if (!tag.isNewFormat) {
        target = document.createElement('img');
        target.src = '[IMG:GEN]';
        const escaped = tag.fullMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '(?:"|&quot;)');
        if (!replaceFirstTextMatchWithElement(mesTextEl, new RegExp(escaped), target)) return false;
    }
    if (!target || target.hasAttribute('data-iig-claimed')) return false;
    target.setAttribute('data-iig-claimed', '1');
    try {
        return await regenerateSingleImage(target, { messageId, message, tag, index, count });
    } finally {
        target.removeAttribute('data-iig-claimed');
        if (!tag.isNewFormat && target.isConnected && isMessageImageScopeCurrent(context, message, messageId, scope)
            && getMessageTagSource(message, tag.sourceKey) === source) {
            const wrapper = target.closest('.iig-image-wrapper');
            (wrapper || target).replaceWith(document.createTextNode(tag.fullMatch));
        }
    }
}

/** Inner processor; the caller guarantees processing-slot cleanup. */
async function _processMessageTagsInner(context, message, messageId, procKey, tags, mesTextEl) {
    const targets = tags.map(tag => findBatchImageTarget(message, tag, mesTextEl));
    const processTag = (tag, index) => regenerateBatchImage(message, messageId, tag, targets[index], mesTextEl, index, tags.length);
    await Promise.all(tags.map((tag, index) => processTag(tag, index)));
    if (isMessageImageScopeCurrent(context, message, messageId, procKey)) markRecentlyProcessed(procKey);
}

/** Regenerate every image in the active message source. */
async function regenerateMessageImages(messageId) {
    if (_iigDisposed) return;
    invalidateContextCache();
    const context = getContext();
    const message = context.chat[messageId];
    
    if (!message) {
        toastr.error(sanitizeForHtml(iigT('iig_messageMissing')), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
        return;
    }
    
    const regenKey = buildProcessingKey(messageId);
    if (processingMessages.has(regenKey)) return;
    processingMessages.add(regenKey);
    const batchToken = Symbol(regenKey);
    _regenBatchTokens.set(regenKey, batchToken);
    try {
        const swipe = message.swipe_info?.[getMessageSwipeId(message)];
        const tags = await parseMessageImageTags(message, { forceAll: true });
        if (!isMessageImageScopeCurrent(context, message, messageId, regenKey)
            || message.swipe_info?.[getMessageSwipeId(message)] !== swipe) return;

        if (tags.length === 0) {
            toastr.warning(sanitizeForHtml(iigT('iig_noTags')), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
            return;
        }

        iigLog('INFO', `Regenerating ${tags.length} images in message ${messageId}`);
        toastr.info(sanitizeForHtml(iigT('iig_regeneratingImages', { count: tags.length })), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });

        const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!messageElement) return;

        const mesTextEl = messageElement.querySelector('.mes_text');
        if (!mesTextEl) return;
        const targets = tags.map(tag => findBatchImageTarget(message, tag, mesTextEl));
        const regenTag = (tag, index) => regenerateBatchImage(message, messageId, tag, targets[index], mesTextEl, index, tags.length);

        // Regenerate all tags in PARALLEL (each owns its own placeholder/controller).
        await Promise.all(tags.map((tag, index) => regenTag(tag, index)));
        if (isMessageImageScopeCurrent(context, message, messageId, regenKey)) markRecentlyProcessed(regenKey);
    } finally {
        if (_regenBatchTokens.get(regenKey) === batchToken) {
            _regenBatchTokens.delete(regenKey);
            processingMessages.delete(regenKey);
        }
    }
}

/** Add a regenerate button to a message's .extraMesButtons menu. */
function addRegenerateButton(messageElement) {
    if (_iigDisposed) return;
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    
    const extraMesButtons = messageElement.querySelector('.extraMesButtons');
    if (!extraMesButtons) return;
    
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = iigT('iig_regenerateImages');
    btn.setAttribute('aria-label', iigT('iig_regenerateImages'));
    bindIig(btn, 'click', async (e) => {
        e.stopPropagation();
        if (!btn.isConnected) return;
        const id = Number.parseInt(btn.closest('.mes[mesid]')?.getAttribute('mesid') || '', 10);
        if (Number.isInteger(id)) await regenerateMessageImages(id);
    });
    
    extraMesButtons.appendChild(btn);
}

/** Wrap already-rendered generated images on chat load/change. */
function wrapExistingImages() {
    if (_iigDisposed) return;
    // Match both freshly-generated (class) and reloaded-from-mes (attribute) images.
    const images = document.querySelectorAll('#chat .iig-generated-image, #chat img[data-iig-instruction]');
    let count = 0;
    for (const img of images) {
        const src = img.getAttribute('src') || '';
        if (!src || src === '[IMG:GEN]') continue;
        // Error placeholders persist as plain <img data-iig-instruction
        // src=".../error.svg">. Retain retry/rewrite actions without download.
        if (src.includes('error.svg')) {
            if (!img.classList.contains('iig-error-image')) img.classList.add('iig-error-image');
            if (img.classList.contains('iig-generated-image')) img.classList.remove('iig-generated-image');
            wrapPlaceholderWithRetry(img);
            continue;
        }
        if (!img.classList.contains('iig-generated-image')) {
            img.classList.add('iig-generated-image');
        }
        wrapImageWithActions(img);
        count++;
    }
    if (count > 0) iigLog('DEBUG:image', `Wrapped ${count} existing images with action buttons`);
}

/** Watch #chat and debounce wrapping of lazy-rendered generated media. */
function initImageWrapObserver() {
    const chat = document.getElementById('chat');
    if (_iigDisposed || !chat || chat._iigObserver) return;

    const _pendingNodes = new Set();
    let _debounceTimer = null;

    const processPending = () => {
        _debounceTimer = null;
        const nodes = [..._pendingNodes];
        _pendingNodes.clear();
        if (_iigDisposed || !chat.isConnected) return;
        let wrapped = 0;
        // Single combined selector per node — one DOM traversal instead of two.
        const SEL = 'img.iig-generated-image, img[data-iig-instruction]';
        for (const node of nodes) {
            if (!node.isConnected || !chat.contains(node)) continue;

            const self = node.matches?.(SEL) ? [node] : [];
            const descendants = node.querySelectorAll?.(SEL) || [];
            const candidates = self.length ? [node, ...descendants] : descendants;

            for (const el of candidates) {
                // Generated / reloaded <img>.
                const src = el.getAttribute('src') || '';
                // Skip not-yet-generated images (still streaming / placeholder).
                if (!src || src === '[IMG:GEN]' || src.startsWith('data:') && src.length < 100) continue;
                // Failed images retain retry/rewrite actions without download.
                if (src.includes('error.svg')) {
                    if (!el.classList.contains('iig-error-image')) el.classList.add('iig-error-image');
                    if (el.classList.contains('iig-generated-image')) el.classList.remove('iig-generated-image');
                    wrapPlaceholderWithRetry(el);
                    continue;
                }
                if (!el.classList.contains('iig-generated-image')) {
                    el.classList.add('iig-generated-image');
                }
                wrapImageWithActions(el);
                wrapped++;
            }
        }
        if (wrapped > 0) iigLog('DEBUG:image', `Observer wrapped ${wrapped} media element(s)`);
    };

    const observer = new MutationObserver((mutations) => {
        if (_iigDisposed) return;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement) || !node.isConnected || !chat.contains(node)) continue;
                // One live message root covers all of its streaming mutations.
                _pendingNodes.add(node.closest('.mes') || node);
            }
        }
        // While streaming, just queue — skip the heavy pass until generation ends
        // (avoids running processPending ~10x/sec for the whole reply).
        if (_iigGenerating || !_pendingNodes.size) return;
        if (_debounceTimer === null) {
            _debounceTimer = setIigTimeout(processPending, _wrapDebounceMs());
        }
    });

    // Catch-up pass when generation ends: flush whatever queued during streaming.
    const flush = () => {
        if (_debounceTimer !== null) { clearIigTimeout(_debounceTimer); _debounceTimer = null; }
        if (_pendingNodes.size) processPending();
    };
    _iigFlushWrapQueue = flush;

    observer.observe(chat, { childList: true, subtree: true });
    chat._iigObserver = observer;
    addIigDisposer(() => {
        observer.disconnect();
        clearIigTimeout(_debounceTimer);
        _debounceTimer = null;
        _pendingNodes.clear();
        if (chat._iigObserver === observer) delete chat._iigObserver;
        if (_iigFlushWrapQueue === flush) _iigFlushWrapQueue = null;
    });
    iigLog('DEBUG:init', 'Image wrap MutationObserver initialized (debounced)');
}

/** Add regenerate buttons to all existing AI messages in the chat. */
function addButtonsToExistingMessages() {
    if (_iigDisposed) return;
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
            addRegenerateButton(messageElement);
            addedCount++;
        }
    }
    
    iigLog('DEBUG:image', `Added regenerate buttons to ${addedCount} existing messages`);
}

/** CHARACTER_MESSAGE_RENDERED handler. Depth-limited to block recursive re-entry. */
async function onMessageReceived(messageId) {
    // ST emits CHARACTER_MESSAGE_RENDERED from several paths; any can fire mid-
    // processing and stack-overflow without this depth guard.
    if (_eventHandlerDepth >= MAX_EVENT_HANDLER_DEPTH) {
        iigLog('WARN', `Blocked recursive onMessageReceived (depth=${_eventHandlerDepth}) for message ${messageId}`);
        return;
    }
    _eventHandlerDepth++;
    
    try {
        iigLog('DEBUG:chat', `onMessageReceived: ${messageId}`);
        
        const settings = getSettings();
        if (!settings.enabled) {
            iigLog('DEBUG:chat', 'Extension disabled, skipping');
            return;
        }
        
        const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!messageElement) return;
        
        addRegenerateButton(messageElement);
        
        await processMessageTags(messageId);
    } finally {
        _eventHandlerDepth--;
    }
}

/** Update reference scope controls and inherited-source status. */
function updateRefScopeUI() {
    if (_iigDisposed) return;
    const scope = normalizeRefScope(getSettings().refScope);
    const state = getActiveRefScope();
    const scopeSel = document.getElementById('iig_ref_scope');
    if (scopeSel) scopeSel.value = scope;

    const label = document.getElementById('iig_ref_scope_label');
    if (label) {
        const owner = state.owner?.label || iigT('iig_ui_thisCharacter');
        if (scope === 'global') label.textContent = iigT('iig_ui_usingGlobalRefs');
        else if (scope === 'per-character') {
            label.textContent = state.storageScope === 'per-character'
                ? iigT('iig_ui_usingOwnerRefs', { owner })
                : iigT('iig_ui_usingGlobalForOwner', { owner });
        } else if (!state.chatId) label.textContent = state.storageScope === 'per-character'
            ? iigT('iig_ui_noChatOwnerRefs', { owner })
            : iigT('iig_ui_noChatGlobalRefs');
        else if (state.storageScope === 'per-chat') label.textContent = iigT('iig_ui_usingChatRefs');
        else if (state.storageScope === 'per-character') label.textContent = iigT('iig_ui_chatInheritsOwner', { owner });
        else label.textContent = iigT('iig_ui_chatInheritsGlobal');
    }

    const resetRow = document.getElementById('iig_ref_scope_reset_row');
    if (resetRow) resetRow.classList.toggle('iig-hidden', scope === 'global');
    const reset = document.getElementById('iig_refs_reset_scope');
    if (reset) {
        const hasOwn = scope === 'per-character'
            ? state.storageScope === 'per-character'
            : scope === 'per-chat' && state.storageScope === 'per-chat';
        reset.disabled = !hasOwn;
        reset.innerHTML = `<i class="fa-solid fa-rotate-left"></i> <span>${sanitizeForHtml(iigT(scope === 'per-character'
            ? 'iig_ui_resetCharacter' : 'iig_ui_resetChat'))}</span>`;
        reset.title = scope === 'per-character'
            ? iigT('iig_ui_resetCharacterTitle')
            : iigT('iig_ui_resetChatTitle');
    }

    const hint = document.getElementById('iig_ref_scope_hint');
    if (hint) hint.textContent = scope === 'global'
        ? iigT('iig_ui_globalScopeHint')
        : iigT(scope === 'per-character' ? 'iig_ui_characterScopeHint' : 'iig_ui_chatScopeHint');
}

/** Render char/user/NPC reference slots in the settings panel (active scope). */
function renderRefSlots() {
    if (_iigDisposed) return;
    updateRefScopeUI();
    const settings = getActiveRefs();

    const setThumb = (slot, ref) => {
        clearPackedRefSlotAppearance(slot);
        const thumb = slot?.querySelector('.iig-ref-thumb');
        const wrap = slot?.querySelector('.iig-ref-thumb-wrap');
        if (!thumb) return;
        if (ref?.imagePath) { thumb.src = ref.imagePath; }
        else if (ref?.imageBase64) { thumb.src = 'data:image/jpeg;base64,' + ref.imageBase64; }
        else if (ref?.imageData) { thumb.src = 'data:image/jpeg;base64,' + ref.imageData; }
        else { thumb.src = ''; }
        if (wrap) wrap.classList.toggle('has-image', !!(ref?.imagePath || ref?.imageBase64 || ref?.imageData));
        if (ref?.packAssetId && (ref.imagePath || ref.imageBase64 || ref.imageData)) {
            setPackedRefSlotAppearance(slot, { id: ref.packAssetId });
        }
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

const IIG_UI_I18N = {
    en: {
        title: '⊹ INLINE IMAGE GENERATION ⊹',
        intro: 'Configure your provider, generation defaults and character references.',
        enabled: 'Enable image generation',
        promptDriven: 'Use generation settings from tags',
        promptDrivenHint: 'When enabled, tag values override UI defaults. Aspect ratio always comes from the tag.',
        apiConfiguration: 'API Configuration',
        loadPreset: 'Load a saved API preset',
        presets: '-- Presets --',
        savePresetTitle: 'Save current API settings as a new preset (or overwrite existing)',
        savePreset: 'Save API preset',
        deletePresetTitle: 'Delete the selected preset',
        deletePreset: 'Delete API preset',
        apiType: 'API Type',
        apiTypeInfo: 'API type info',
        openaiCompatible: 'OpenAI-compatible',
        geminiCompatible: 'Gemini-compatible',
        apiOpenaiHint: 'Uses /v1/images/generations, /v1/images/edits, and /v1/models for providers that speak the OpenAI REST schema.',
        apiGeminiHint: 'Appends /v1beta/models/{model}:generateContent and /v1beta/models. Use this for providers that speak the Google Gemini REST schema (including most Gemini proxies).',
        apiNaisteraHint: 'Appends /api/generate. If the URL is blank, defaults to naistera.org.',
        endpoint: 'Endpoint URL',
        endpointPlaceholder: 'https://your-provider.example (base URL only)',
        apiKey: 'API Key',
        toggleKey: 'Show or hide API key',
        naisteraHint: 'Paste your Naistera token. A blank endpoint uses',
        model: 'Model',
        toggleModels: 'Show or hide model list',
        refreshModels: 'Refresh models list',
        testConnectionTitle: 'Test API connection',
        testConnection: 'Test Connection',
        advanced: 'Advanced',
        pathOverride: 'Path override',
        pathPlaceholder: '/custom/path (optional)',
        pathHint: 'Replaces the default API path. Leave blank for automatic routing.',
        showAllModels: 'Show all models (disable keyword filter)',
        showAllModelsHint: "Enable when your provider's image models are missing from the list.",
        characterReferences: 'Character References',
        cropOnUpload: 'Crop uploads (references and packs)',
        referenceOptions: 'Reference Options',
        referenceOptionsSubtitle: 'Matching, scope and send rules',
        referenceHint: 'Up to 4 matching references are sent; NovelAI accepts exactly one. Names support comma-separated aliases.',
        alwaysChar: 'Always send Char',
        alwaysUser: 'Always send User',
        referenceSet: 'Reference set',
        global: 'Global',
        perCharacter: 'Per-character',
        perChat: 'Per-chat',
        resetScope: 'Reset scope',
        uploadPhoto: 'Upload photo',
        charAlt: 'Char',
        userAlt: 'User',
        npc: 'NPC',
        npcs: 'NPCs',
        charNames: 'Character reference names',
        userNames: 'User reference names',
        npcNames: 'NPC {number} reference names',
        namesPlaceholder: 'Name(s), comma-separated',
        removeReference: 'Remove reference',
        remove: 'Remove',
        thisCharacter: 'this character',
        usingGlobalRefs: 'Using Global references.',
        usingOwnerRefs: 'Using {owner} references.',
        usingGlobalForOwner: 'Using Global references for {owner} until this set is edited.',
        noChatOwnerRefs: 'No chat loaded — using {owner} references.',
        noChatGlobalRefs: 'No chat loaded — using Global references.',
        usingChatRefs: 'Using this chat’s references.',
        chatInheritsOwner: 'This chat inherits {owner} references until edited.',
        chatInheritsGlobal: 'This chat inherits Global references until edited.',
        resetCharacter: 'Reset character to Global',
        resetChat: 'Reset chat to inherited',
        resetCharacterTitle: 'Remove this character or group set and inherit Global references.',
        resetChatTitle: 'Remove this chat set and inherit character or Global references.',
        globalScopeHint: 'One set shared everywhere.',
        characterScopeHint: 'Character/group sets are created only when you edit a slot.',
        chatScopeHint: 'Chat sets are created only when you edit a slot.',
        generationSettings: 'Generation Settings',
        size: 'Size',
        sizeSquare: '1024x1024 (Square)',
        sizeLandscape: '1792x1024 (Landscape)',
        sizePortrait: '1024x1792 (Portrait)',
        sizeSmall: '512x512 (Small)',
        quality: 'Quality',
        qualityAuto: 'auto (gpt-image-*)',
        qualityLow: 'low (gpt-image-*)',
        qualityMedium: 'medium (gpt-image-*)',
        qualityHigh: 'high (gpt-image-*)',
        qualityStandard: 'standard (dall-e-3)',
        qualityHd: 'hd (dall-e-3)',
        qualityGptHint: ': auto–high.',
        qualityDalleHint: ': standard or hd.',
        preset: 'Preset',
        none: 'None',
        digital: 'Digital',
        realism: 'Realism',
        naisteraPresetHint: 'Style preset for Grok models.',
        naisteraSendRefs: 'Send reference images (Naistera)',
        naisteraRefsHint: 'Available for Grok and Nano Banana 2.',
        resolution: 'Resolution',
        resolutionDefault: '1K (default)',
        geminiSendRefs: 'Send reference images (Gemini)',
        geminiRefsHint: 'Disable references for text-only generation. Aspect ratio comes from each tag.',
        retrySettings: 'Retry Settings',
        maxRetries: 'Max Retries',
        retryDelay: 'Delay (ms)',
        retryHint: 'Retries temporary API errors with increasing delays, capped at 30 seconds.',
        performance: 'Performance',
        lowPower: 'Low-power mode',
        lowPowerHint: 'Reduces animation and background updates.',
        disableAnimations: 'Disable animations',
        slowUpdates: 'Slower background updates',
        lowPowerOptionsHint: 'These options apply only in low-power mode.',
        debug: 'Debug',
        verboseConsole: 'Verbose console',
        verboseConsoleHint: 'Print DEBUG entries to the browser console.',
        exportLogs: 'Export Logs',
        exportLogsHint: 'Export Logs always includes DEBUG entries.',
        checkStorageTitle: 'Count files and measure the iig_refs folder on demand.',
        checkStorageAria: 'Check reference storage',
        checkStorage: 'Check ref storage',
        storage: 'Storage',
        clearStorageTitle: 'Delete every file in the iig_refs folder on the SillyTavern server.',
        clearStorageAria: 'Clear reference storage folder',
        clearStorage: 'Clear refs folder',
        clear: 'Clear',
        storageNotChecked: 'Reference storage not checked.',
        openImageManagerTitle: 'Open the Image Manager extension to browse, sort, and clean up your generated images.',
        openImageManager: 'Open Image Manager',
        by: 'by',
        notificationTitle: 'Image Generation',
        promptModelTitle: 'Prompt Model',
        modelsFound: 'Found {count} model(s)',
        modelCatalogEmpty: 'Connected, but the model catalog is empty.',
        modelsLoadFailed: 'Failed to load models: {detail}',
        connectionFailed: 'Connection failed: {detail}',
        presetNamePrompt: 'Preset name:',
        presetOverwriteConfirm: 'Preset "{name}" exists. Overwrite?',
        presetNotFound: 'Preset "{name}" not found',
        presetLoaded: 'Preset "{name}" loaded',
        presetOverwritten: 'Preset "{name}" overwritten',
        presetSaved: 'Preset "{name}" saved',
        presetDeleted: 'Preset "{name}" deleted',
        selectPresetToDelete: 'Select a preset to delete first',
        deletePresetConfirm: 'Delete preset "{name}"?',
        geminiPresetDetached: 'Using edited Gemini settings. The saved preset is unchanged; save to update it.',
        geminiPresetMissing: 'The selected Gemini preset no longer exists.',
        geminiPresetInvalid: 'Could not save Gemini preset: {detail}',
        geminiPresetSaved: 'Gemini preset "{name}" saved.',
        geminiPresetDeleted: 'Gemini preset "{name}" deleted.',
        selectGeminiPresetToDelete: 'Select a Gemini preset to delete first.',
        deleteGeminiPresetConfirm: 'Delete Gemini preset "{name}"?',
        chatRefsReset: 'This chat now inherits its references',
        characterRefsReset: 'This character now inherits Global references',
        imageManagerUnavailable: 'Could not open Image Manager (slash command unavailable).',
        checkingStorage: 'Checking reference storage…',
        storageSummary: '{count} file(s) · {size}',
        storageSummaryEstimated: '{count} file(s) · ~{size} ({measured} measured)',
        storageMeasureFailed: 'Could not measure reference storage.',
        storageMeasureError: 'Could not measure reference storage: {detail}',
        clearStorageConfirm: 'Delete every file in the iig_refs folder on the SillyTavern server? Currently-used ref slots will have their underlying files removed and will need to be re-uploaded.',
        storageEmpty: '0 files · 0 B',
        storageAlreadyEmpty: 'iig_refs folder is already empty',
        storageDeleteFailed: '{count} file(s) could not be deleted',
        storageCleared: 'Cleared iig_refs: {deleted} deleted',
        storageClearedPartial: 'Cleared iig_refs: {deleted} deleted, {failed} failed',
        storageClearFailed: 'Clear failed: {detail}',
        setApiKeyFirst: 'Set API key first',
        setEndpointFirst: 'Set endpoint first',
        apiKeyRejected: 'API key rejected (HTTP {status})',
        generationEndpointMissing: 'Generation endpoint not found (HTTP 404)',
        endpointUnavailable: 'Endpoint unavailable (HTTP {status})',
        generationEndpointReached: 'Generation endpoint reached without creating an image.',
        probeReturnedStatus: 'Endpoint reached, but the non-generation probe returned HTTP {status}.',
        connectionModelsFound: 'Connection OK — {count} model(s) found',
        connectionNoModels: 'Connected, but no models were returned. Enable Advanced → Show all models, or check the endpoint.',
        unknownApiType: 'Unknown API type: {apiType}',
    },
    ru: {
        title: '⊹ ГЕНЕРАЦИЯ ИЗОБРАЖЕНИЙ В ЧАТЕ ⊹',
        intro: 'Настройте провайдера, параметры генерации по умолчанию и референсы персонажей.',
        enabled: 'Включить генерацию изображений',
        promptDriven: 'Использовать параметры генерации из тегов',
        promptDrivenHint: 'Если включено, значения тегов заменяют настройки интерфейса. Соотношение сторон всегда берётся из тега.',
        apiConfiguration: 'Настройки API',
        loadPreset: 'Загрузить сохранённый пресет API',
        presets: '-- Пресеты --',
        savePresetTitle: 'Сохранить текущие настройки API как новый пресет (или перезаписать существующий)',
        savePreset: 'Сохранить пресет API',
        deletePresetTitle: 'Удалить выбранный пресет',
        deletePreset: 'Удалить пресет API',
        apiType: 'Тип API',
        apiTypeInfo: 'Информация о типе API',
        openaiCompatible: 'Совместимый с OpenAI',
        geminiCompatible: 'Совместимый с Gemini',
        apiOpenaiHint: 'Использует /v1/images/generations, /v1/images/edits и /v1/models для провайдеров, поддерживающих схему OpenAI REST.',
        apiGeminiHint: 'Добавляет /v1beta/models/{model}:generateContent и /v1beta/models. Для провайдеров, поддерживающих схему Google Gemini REST (включая большинство прокси Gemini).',
        apiNaisteraHint: 'Добавляет /api/generate. Если URL пуст, используется naistera.org.',
        endpoint: 'URL API',
        endpointPlaceholder: 'https://your-provider.example (только базовый URL)',
        apiKey: 'Ключ API',
        toggleKey: 'Показать или скрыть ключ API',
        naisteraHint: 'Вставьте токен Naistera. Если адрес пуст, используется',
        model: 'Модель',
        toggleModels: 'Показать или скрыть список моделей',
        refreshModels: 'Обновить список моделей',
        testConnectionTitle: 'Проверить подключение к API',
        testConnection: 'Проверить подключение',
        advanced: 'Дополнительно',
        pathOverride: 'Свой путь API',
        pathPlaceholder: '/custom/path (необязательно)',
        pathHint: 'Заменяет стандартный путь API. Оставьте пустым для автоматического выбора маршрута.',
        showAllModels: 'Показывать все модели (отключить фильтр по ключевым словам)',
        showAllModelsHint: 'Включите, если модели изображений вашего провайдера отсутствуют в списке.',
        characterReferences: 'Референсы персонажей',
        cropOnUpload: 'Обрезать загрузки (референсы и наборы)',
        referenceOptions: 'Параметры референсов',
        referenceOptionsSubtitle: 'Сопоставление, область действия и правила отправки',
        referenceHint: 'Отправляется до 4 подходящих референсов; NovelAI принимает ровно один. Для имён можно указать псевдонимы через запятую.',
        alwaysChar: 'Всегда отправлять персонажа',
        alwaysUser: 'Всегда отправлять пользователя',
        referenceSet: 'Набор референсов',
        global: 'Глобальный',
        perCharacter: 'Для персонажа',
        perChat: 'Для чата',
        resetScope: 'Сбросить набор',
        uploadPhoto: 'Загрузить фото',
        charAlt: 'Персонаж',
        userAlt: 'Пользователь',
        npc: 'НПС',
        npcs: 'НПС',
        charNames: 'Имена для референса персонажа',
        userNames: 'Имена для референса пользователя',
        npcNames: 'Имена для референса НПС {number}',
        namesPlaceholder: 'Имена через запятую',
        removeReference: 'Удалить референс',
        remove: 'Удалить',
        thisCharacter: 'этот персонаж',
        usingGlobalRefs: 'Используется глобальный набор референсов.',
        usingOwnerRefs: 'Используется набор референсов: {owner}.',
        usingGlobalForOwner: 'Для {owner} используется глобальный набор референсов, пока этот набор не изменён.',
        noChatOwnerRefs: 'Чат не загружен — используется набор референсов: {owner}.',
        noChatGlobalRefs: 'Чат не загружен — используется глобальный набор референсов.',
        usingChatRefs: 'Используется набор референсов этого чата.',
        chatInheritsOwner: 'Этот чат наследует набор референсов {owner}, пока набор не изменён.',
        chatInheritsGlobal: 'Этот чат наследует глобальный набор референсов, пока набор не изменён.',
        resetCharacter: 'Вернуть глобальный набор для персонажа',
        resetChat: 'Вернуть наследуемый набор для чата',
        resetCharacterTitle: 'Удалить набор персонажа или группы и наследовать глобальные референсы.',
        resetChatTitle: 'Удалить набор чата и наследовать референсы персонажа или глобальные референсы.',
        globalScopeHint: 'Один общий набор для всех чатов и персонажей.',
        characterScopeHint: 'Наборы персонажей и групп создаются только при изменении слота.',
        chatScopeHint: 'Наборы чатов создаются только при изменении слота.',
        generationSettings: 'Параметры генерации',
        size: 'Размер',
        sizeSquare: '1024x1024 (квадрат)',
        sizeLandscape: '1792x1024 (альбомный)',
        sizePortrait: '1024x1792 (портретный)',
        sizeSmall: '512x512 (маленький)',
        quality: 'Качество',
        qualityAuto: 'авто (gpt-image-*)',
        qualityLow: 'низкое (gpt-image-*)',
        qualityMedium: 'среднее (gpt-image-*)',
        qualityHigh: 'высокое (gpt-image-*)',
        qualityStandard: 'стандартное (dall-e-3)',
        qualityHd: 'высокая чёткость (dall-e-3)',
        qualityGptHint: ': от авто до высокого.',
        qualityDalleHint: ': стандартное или высокая чёткость.',
        preset: 'Пресет',
        none: 'Нет',
        digital: 'Цифровой',
        realism: 'Реализм',
        naisteraPresetHint: 'Пресет стиля для моделей Grok.',
        naisteraSendRefs: 'Отправлять референсы (Naistera)',
        naisteraRefsHint: 'Доступно для Grok и Nano Banana 2.',
        resolution: 'Разрешение',
        resolutionDefault: '1K (по умолчанию)',
        geminiSendRefs: 'Отправлять референсы (Gemini)',
        geminiRefsHint: 'Отключите референсы для генерации только по тексту. Соотношение сторон берётся из каждого тега.',
        retrySettings: 'Повторные попытки',
        maxRetries: 'Максимум повторов',
        retryDelay: 'Задержка (мс)',
        retryHint: 'Повторяет запросы при временных ошибках API с увеличением задержки, но не более 30 секунд.',
        performance: 'Производительность',
        lowPower: 'Энергосберегающий режим',
        lowPowerHint: 'Сокращает анимации и фоновые обновления.',
        disableAnimations: 'Отключить анимации',
        slowUpdates: 'Реже обновлять в фоне',
        lowPowerOptionsHint: 'Эти параметры действуют только в энергосберегающем режиме.',
        debug: 'Отладка',
        verboseConsole: 'Подробный вывод в консоль',
        verboseConsoleHint: 'Выводить записи DEBUG в консоль браузера.',
        exportLogs: 'Экспортировать журнал',
        exportLogsHint: 'Экспорт журнала всегда включает записи DEBUG.',
        checkStorageTitle: 'Подсчитать файлы и размер папки iig_refs по запросу.',
        checkStorageAria: 'Проверить хранилище референсов',
        checkStorage: 'Проверить хранилище',
        storage: 'Хранилище',
        clearStorageTitle: 'Удалить все файлы из папки iig_refs на сервере SillyTavern.',
        clearStorageAria: 'Очистить папку референсов',
        clearStorage: 'Очистить папку референсов',
        clear: 'Очистить',
        storageNotChecked: 'Хранилище референсов не проверено.',
        openImageManagerTitle: 'Открыть расширение Image Manager для просмотра, сортировки и удаления созданных изображений.',
        openImageManager: 'Открыть Image Manager',
        by: 'автор:',
        notificationTitle: 'Генерация изображений',
        promptModelTitle: 'Модель промпта',
        modelsFound: 'Найдено моделей: {count}',
        modelCatalogEmpty: 'Подключение установлено, но каталог моделей пуст.',
        modelsLoadFailed: 'Не удалось загрузить модели: {detail}',
        connectionFailed: 'Ошибка подключения: {detail}',
        presetNamePrompt: 'Название пресета:',
        presetOverwriteConfirm: 'Пресет «{name}» уже существует. Перезаписать?',
        presetNotFound: 'Пресет «{name}» не найден',
        presetLoaded: 'Пресет «{name}» загружен',
        presetOverwritten: 'Пресет «{name}» перезаписан',
        presetSaved: 'Пресет «{name}» сохранён',
        presetDeleted: 'Пресет «{name}» удалён',
        selectPresetToDelete: 'Сначала выберите пресет для удаления',
        deletePresetConfirm: 'Удалить пресет «{name}»?',
        geminiPresetDetached: 'Используются изменённые настройки Gemini. Сохранённый пресет не изменён; сохраните настройки, чтобы обновить его.',
        geminiPresetMissing: 'Выбранный пресет Gemini больше не существует.',
        geminiPresetInvalid: 'Не удалось сохранить пресет Gemini: {detail}',
        geminiPresetSaved: 'Пресет Gemini «{name}» сохранён.',
        geminiPresetDeleted: 'Пресет Gemini «{name}» удалён.',
        selectGeminiPresetToDelete: 'Сначала выберите пресет Gemini для удаления.',
        deleteGeminiPresetConfirm: 'Удалить пресет Gemini «{name}»?',
        chatRefsReset: 'Этот чат теперь наследует референсы',
        characterRefsReset: 'Этот персонаж теперь наследует глобальные референсы',
        imageManagerUnavailable: 'Не удалось открыть Image Manager (слеш-команда недоступна).',
        checkingStorage: 'Проверка хранилища референсов…',
        storageSummary: 'Файлов: {count} · {size}',
        storageSummaryEstimated: 'Файлов: {count} · ~{size} (измерено: {measured})',
        storageMeasureFailed: 'Не удалось измерить хранилище референсов.',
        storageMeasureError: 'Не удалось измерить хранилище референсов: {detail}',
        clearStorageConfirm: 'Удалить все файлы из папки iig_refs на сервере SillyTavern? Файлы используемых слотов референсов будут удалены, и их потребуется загрузить заново.',
        storageEmpty: '0 файлов · 0 Б',
        storageAlreadyEmpty: 'Папка iig_refs уже пуста',
        storageDeleteFailed: 'Не удалось удалить файлов: {count}',
        storageCleared: 'Папка iig_refs очищена: удалено {deleted}',
        storageClearedPartial: 'Очистка iig_refs: удалено {deleted}, ошибок {failed}',
        storageClearFailed: 'Не удалось очистить: {detail}',
        setApiKeyFirst: 'Сначала укажите ключ API',
        setEndpointFirst: 'Сначала укажите адрес API',
        apiKeyRejected: 'Ключ API отклонён (HTTP {status})',
        generationEndpointMissing: 'Адрес генерации не найден (HTTP 404)',
        endpointUnavailable: 'Адрес API недоступен (HTTP {status})',
        generationEndpointReached: 'Адрес генерации доступен. Изображение не создавалось.',
        probeReturnedStatus: 'Адрес API доступен, но проверка без генерации вернула HTTP {status}.',
        connectionModelsFound: 'Подключение работает — найдено моделей: {count}',
        connectionNoModels: 'Подключение установлено, но модели не получены. Включите «Дополнительно → Показывать все модели» или проверьте адрес API.',
        unknownApiType: 'Неизвестный тип API: {apiType}',
    },
};

/** Build and inject the settings panel into #extensions_settings. */
function createSettingsUI() {
    if (_iigDisposed || document.getElementById('iig_model')) return;
    const settings = getSettings();
    const pm = promptModelSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) {
        iigLog('ERROR', 'Settings container not found');
        return;
    }

    let npcSlotsHtml = '';
    for (let i = 0; i < 4; i++) {
        npcSlotsHtml += `
            <div class="iig-ref-slot" data-ref-type="npc" data-npc-index="${i}">
                <div class="iig-ref-thumb-wrap">
                    <img src="" alt="NPC" data-i18n="[alt]iig_ui_npc" class="iig-ref-thumb">
                    <div class="iig-ref-empty-icon"><i class="fa-solid fa-user-plus"></i></div>
                    <label class="iig-ref-upload-overlay" title="Upload photo" data-i18n="[title]iig_ui_uploadPhoto">
                        <i class="fa-solid fa-camera"></i>
                        <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                    </label>
                </div>
                <div class="iig-ref-info">
                    <div class="iig-ref-label"><span data-i18n="iig_ui_npc">NPC</span> ${i + 1}</div>
                    <input type="text" class="text_pole iig-ref-name" aria-label="${escapeAttr(iigT('iig_ui_npcNames', { number: i + 1 }))}" placeholder="Name(s), comma-separated" data-i18n="[placeholder]iig_ui_namesPlaceholder" value="">
                </div>
                <div class="iig-ref-actions">
                    ${refPacksPillHtml()}
                    <button type="button" class="menu_button iig-ref-delete-btn" title="Remove reference" data-i18n="[title]iig_ui_removeReference"><i class="fa-solid fa-trash-can"></i><span data-i18n="iig_ui_remove">Remove</span></button>
                </div>
            </div>`;
    }

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-leaf"></i> <span data-i18n="iig_ui_title">⊹ INLINE IMAGE GENERATION ⊹</span></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <p class="iig-settings-intro" data-i18n="iig_ui_intro">Configure your provider, generation defaults and character references.</p>
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span data-i18n="iig_ui_enabled">Enable image generation</span>
                    </label>
                    <label class="checkbox_label" style="margin-top: 6px;">
                        <input type="checkbox" id="iig_prompt_driven" ${settings.promptDriven ? 'checked' : ''}>
                        <span data-i18n="iig_ui_promptDriven">Use generation settings from tags</span>
                    </label>
                    <p class="hint" data-i18n="iig_ui_promptDrivenHint">When enabled, tag values override UI defaults. Aspect ratio always comes from the tag.</p>
                    
                    <details class="iig-section iig-accordion iig-api-section">
                        <summary><h4><i class="fa-solid fa-plug"></i> <span data-i18n="iig_ui_apiConfiguration">API Configuration</span></h4></summary>

                        <div class="iig-api-config-body">
                        <!-- Preset save/load for quick provider swapping. -->
                        <div class="iig-presets-bar iig-control-group">
                            <select id="iig_preset_select" class="flex1" title="Load a saved API preset" aria-label="Load a saved API preset" data-i18n="[title]iig_ui_loadPreset;[aria-label]iig_ui_loadPreset">
                                <option value="" data-i18n="iig_ui_presets">-- Presets --</option>
                                ${(settings.presets || []).map(p => `<option value="${sanitizeForHtml(p.name)}" ${settings.activePresetName === p.name ? 'selected' : ''}>${sanitizeForHtml(p.name)}</option>`).join('')}
                            </select>
                            <button type="button" id="iig_preset_save" class="menu_button iig-preset-btn" title="Save current API settings as a new preset (or overwrite existing)" aria-label="Save API preset" data-i18n="[title]iig_ui_savePresetTitle;[aria-label]iig_ui_savePreset">
                                <i class="fa-solid fa-floppy-disk"></i>
                            </button>
                            <button type="button" id="iig_preset_delete" class="menu_button iig-preset-btn" title="Delete the selected preset" aria-label="Delete API preset" data-i18n="[title]iig_ui_deletePresetTitle;[aria-label]iig_ui_deletePreset">
                                <i class="fa-solid fa-trash-can"></i>
                            </button>
                        </div>
                        <div class="iig-api-fields">
                        <div class="flex-row iig-api-row">
                            <label for="iig_api_type"><span data-i18n="iig_ui_apiType">API Type</span>
                                <span class="iig-info" id="iig_api_type_info" tabindex="0" role="button" aria-label="API type info" data-i18n="[aria-label]iig_ui_apiTypeInfo" title="${escapeAttr(iigT({ openai: 'iig_ui_apiOpenaiHint', gemini: 'iig_ui_apiGeminiHint', naistera: 'iig_ui_apiNaisteraHint' }[settings.apiType] || 'iig_ui_apiOpenaiHint'))}">
                                    <i class="fa-solid fa-circle-question"></i>
                                </span>
                            </label>
                            <select id="iig_api_type" class="flex1">
                                <option value="openai" data-i18n="iig_ui_openaiCompatible" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-compatible</option>
                                <option value="gemini" data-i18n="iig_ui_geminiCompatible" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini-compatible</option>
                                <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>Naistera</option>
                            </select>
                        </div>

                        <div class="flex-row iig-api-row" id="iig_endpoint_row">
                            <label for="iig_endpoint" data-i18n="iig_ui_endpoint">Endpoint URL</label>
                            <input type="text" id="iig_endpoint" class="text_pole flex1"
                                   value="${sanitizeForHtml(settings.endpoint)}"
                                   placeholder="${settings.apiType === 'naistera' ? 'https://naistera.org' : escapeAttr(iigT('iig_ui_endpointPlaceholder'))}">
                        </div>
                        <div class="flex-row iig-api-row" id="iig_api_key_row">
                            <label for="iig_api_key" data-i18n="iig_ui_apiKey">API Key</label>
                            <div class="iig-control-group iig-theme-control">
                                <input type="password" id="iig_api_key" class="text_pole flex1"
                                       value="${sanitizeForHtml(settings.apiKey)}">
                                <button type="button" id="iig_key_toggle" class="menu_button iig-key-toggle" title="Show or hide API key" aria-label="Show or hide API key" data-i18n="[title]iig_ui_toggleKey;[aria-label]iig_ui_toggleKey">
                                    <i class="fa-solid fa-eye"></i>
                                </button>
                            </div>
                        </div>
                        <p id="iig_naistera_hint" class="hint ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}"><span data-i18n="iig_ui_naisteraHint">Paste your Naistera token. A blank endpoint uses</span> <code>naistera.org</code>.</p>

                        <div class="flex-row iig-api-row ${settings.apiType === 'naistera' ? 'iig-hidden' : ''}" id="iig_model_row">
                            <label for="iig_model" data-i18n="iig_ui_model">Model</label>
                            <div class="iig-model-actions iig-theme-control">
                                <div class="iig-model-picker">
                                    <input type="text" id="iig_model" class="text_pole flex1"
                                           value="${sanitizeForHtml(settings.model || '')}"
                                           autocomplete="off" spellcheck="false" role="combobox"
                                           aria-autocomplete="list" aria-controls="iig_model_options" aria-expanded="false">
                                    <button type="button" id="iig_model_toggle" class="menu_button iig-model-toggle"
                                            title="Show or hide model list" aria-label="Show or hide model list" data-i18n="[title]iig_ui_toggleModels;[aria-label]iig_ui_toggleModels"
                                            aria-controls="iig_model_options" aria-expanded="false">
                                        <i class="fa-solid fa-chevron-down"></i>
                                    </button>
                                    <div id="iig_model_options" class="iig-model-options" role="listbox" aria-label="Model" data-i18n="[aria-label]iig_ui_model" hidden></div>
                                </div>
                                <button type="button" id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Refresh models list" aria-label="Refresh models list" data-i18n="[title]iig_ui_refreshModels;[aria-label]iig_ui_refreshModels">
                                    <i class="fa-solid fa-sync"></i>
                                </button>
                            </div>
                        </div>

                        <button type="button" id="iig_test_connection" class="menu_button iig-test-connection ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" title="Test API connection" data-i18n="[title]iig_ui_testConnectionTitle">
                            <i class="fa-solid fa-wifi"></i> <span data-i18n="iig_ui_testConnection">Test Connection</span>
                        </button>
                        </div>

                        <!-- Advanced: escape hatches for non-standard providers. -->
                        <details class="iig-advanced" ${settings.pathOverride || settings.showAllModels ? 'open' : ''}>
                            <summary><i class="fa-solid fa-wrench"></i> <span data-i18n="iig_ui_advanced">Advanced</span></summary>
                            <div class="iig-advanced-body">
                                <div class="flex-row">
                                    <label for="iig_path_override" data-i18n="iig_ui_pathOverride">Path override</label>
                                    <input type="text" id="iig_path_override" class="text_pole flex1"
                                           value="${sanitizeForHtml(settings.pathOverride || '')}"
                                           placeholder="/custom/path (optional)" data-i18n="[placeholder]iig_ui_pathPlaceholder">
                                </div>
                                <p class="hint" data-i18n="iig_ui_pathHint">Replaces the default API path. Leave blank for automatic routing.</p>
                                <label class="checkbox_label">
                                    <input type="checkbox" id="iig_show_all_models" ${settings.showAllModels ? 'checked' : ''}>
                                    <span data-i18n="iig_ui_showAllModels">Show all models (disable keyword filter)</span>
                                </label>
                                <p class="hint" data-i18n="iig_ui_showAllModelsHint">Enable when your provider's image models are missing from the list.</p>
                            </div>
                        </details>
                        </div>
                    </details>

                    <!-- Reference images — available for all providers. -->
                    <details id="iig_refs_section" class="iig-section iig-refs iig-accordion" open>
                        <summary><h4><i class="fa-solid fa-user-group"></i> <span data-i18n="iig_ui_characterReferences">Character References</span></h4></summary>
                        <details class="iig-ref-options">
                            <summary>
                                <span class="iig-ref-options-title"><i class="fa-solid fa-sliders"></i> <span data-i18n="iig_ui_referenceOptions">Reference Options</span></span>
                                <span class="iig-ref-options-subtitle" data-i18n="iig_ui_referenceOptionsSubtitle">Matching, scope and send rules</span>
                            </summary>
                            <div class="iig-ref-options-body">
                                <p class="hint" data-i18n="iig_ui_referenceHint">Up to 4 matching references are sent; NovelAI accepts exactly one. Names support comma-separated aliases.</p>

                                <div class="iig-ref-controls">
                                    <div class="iig-ref-always-grid">
                                        <label class="checkbox_label">
                                            <input type="checkbox" id="iig_char_ref_always" ${settings.charRefAlways ? 'checked' : ''}>
                                            <span data-i18n="iig_ui_alwaysChar">Always send Char</span>
                                        </label>
                                        <label class="checkbox_label">
                                            <input type="checkbox" id="iig_user_ref_always" ${settings.userRefAlways ? 'checked' : ''}>
                                            <span data-i18n="iig_ui_alwaysUser">Always send User</span>
                                        </label>
                                    </div>

                                    <div class="flex-row iig-ref-scope-row">
                                        <label for="iig_ref_scope" data-i18n="iig_ui_referenceSet">Reference set</label>
                                        <select id="iig_ref_scope" class="flex1">
                                            <option value="global" data-i18n="iig_ui_global" ${normalizeRefScope(settings.refScope) === 'global' ? 'selected' : ''}>Global</option>
                                            <option value="per-character" data-i18n="iig_ui_perCharacter" ${settings.refScope === 'per-character' ? 'selected' : ''}>Per-character</option>
                                            <option value="per-chat" data-i18n="iig_ui_perChat" ${settings.refScope === 'per-chat' ? 'selected' : ''}>Per-chat</option>
                                        </select>
                                    </div>
                                    <label class="checkbox_label">
                                        <input type="checkbox" id="iig_crop_on_upload" ${settings.cropOnUpload ? 'checked' : ''}>
                                        <span data-i18n="iig_ui_cropOnUpload">Crop uploads (references and packs)</span>
                                    </label>
                                    <div>
                                        <p id="iig_ref_scope_label" class="hint"></p>
                                        <div id="iig_ref_scope_reset_row" class="iig-maintenance-row">
                                            <button type="button" id="iig_refs_reset_scope" class="menu_button iig-maint-btn">
                                                <i class="fa-solid fa-rotate-left"></i> <span data-i18n="iig_ui_resetScope">Reset scope</span>
                                            </button>
                                        </div>
                                    </div>
                                    <p id="iig_ref_scope_hint" class="hint iig-ref-scope-hint"></p>
                                </div>
                            </div>
                        </details>

                        <div class="iig-refs-grid">
                            <div class="iig-refs-row iig-refs-main">
                                <div class="iig-ref-slot" data-ref-type="char">
                                    <div class="iig-ref-thumb-wrap">
                                        <img src="" alt="Char" data-i18n="[alt]iig_ui_charAlt" class="iig-ref-thumb">
                                        <div class="iig-ref-empty-icon"><i class="fa-solid fa-user"></i></div>
                                        <label class="iig-ref-upload-overlay" title="Upload photo" data-i18n="[title]iig_ui_uploadPhoto">
                                            <i class="fa-solid fa-camera"></i>
                                            <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                                        </label>
                                    </div>
                                    <div class="iig-ref-info">
                                         <div class="iig-ref-label">{{char}}</div>
                                         <input type="text" class="text_pole iig-ref-name" aria-label="Character reference names" placeholder="Name(s), comma-separated" data-i18n="[aria-label]iig_ui_charNames;[placeholder]iig_ui_namesPlaceholder" value="">
                                     </div>
                                     <div class="iig-ref-actions">
                                         ${refPacksPillHtml()}
                                         <button type="button" class="menu_button iig-ref-delete-btn" title="Remove reference" data-i18n="[title]iig_ui_removeReference"><i class="fa-solid fa-trash-can"></i><span data-i18n="iig_ui_remove">Remove</span></button>
                                     </div>
                                </div>

                                <!-- User slot -->
                                <div class="iig-ref-slot" data-ref-type="user">
                                    <div class="iig-ref-thumb-wrap">
                                        <img src="" alt="User" data-i18n="[alt]iig_ui_userAlt" class="iig-ref-thumb">
                                        <div class="iig-ref-empty-icon"><i class="fa-solid fa-user"></i></div>
                                        <label class="iig-ref-upload-overlay" title="Upload photo" data-i18n="[title]iig_ui_uploadPhoto">
                                            <i class="fa-solid fa-camera"></i>
                                            <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                                        </label>
                                    </div>
                                    <div class="iig-ref-info">
                                         <div class="iig-ref-label">{{user}}</div>
                                         <input type="text" class="text_pole iig-ref-name" aria-label="User reference names" placeholder="Name(s), comma-separated" data-i18n="[aria-label]iig_ui_userNames;[placeholder]iig_ui_namesPlaceholder" value="">
                                     </div>
                                     <div class="iig-ref-actions">
                                         ${refPacksPillHtml()}
                                         <button type="button" class="menu_button iig-ref-delete-btn" title="Remove reference" data-i18n="[title]iig_ui_removeReference"><i class="fa-solid fa-trash-can"></i><span data-i18n="iig_ui_remove">Remove</span></button>
                                     </div>
                                </div>
                            </div>

                            <div class="iig-refs-divider"><span data-i18n="iig_ui_npcs">NPCs</span></div>

                            <div class="iig-refs-row iig-refs-npcs">
                                ${npcSlotsHtml}
                            </div>
                        </div>
                    </details>

                    <details class="iig-section iig-accordion iig-pm-section">
                        <summary><h4><i class="fa-solid fa-wand-magic-sparkles"></i> <span>${sanitizeForHtml(pmT('title'))}</span></h4></summary>
                        <label class="checkbox_label iig-pm-toggle-row">
                            <input type="checkbox" id="iig_pm_enabled" ${pm.enabled && isPromptModelAvailable() ? 'checked' : ''} ${isPromptModelAvailable() ? '' : 'disabled'}>
                            <span>${sanitizeForHtml(pmT('enabled'))}</span>
                        </label>
                        <p class="hint">${sanitizeForHtml(pmT('offHint'))}</p>
                        <p id="iig_pm_unavailable" class="hint iig-pm-warning ${isPromptModelAvailable() ? 'iig-hidden' : ''}">${sanitizeForHtml(pmT('notChatCompletion'))}</p>

                        <div id="iig_pm_controls" class="iig-pm-controls ${isPromptModelAvailable() ? '' : 'iig-pm-disabled'}">
                            <div class="flex-row iig-pm-row">
                                <label for="iig_pm_connection">${sanitizeForHtml(pmT('connection'))}</label>
                                <select id="iig_pm_connection" class="flex1">
                                    <option value="default" ${pm.connection === 'default' ? 'selected' : ''}>${sanitizeForHtml(pmT('defaultConnection'))}</option>
                                    <option value="gemini" ${pm.connection === 'gemini' ? 'selected' : ''}>${sanitizeForHtml(pmT('geminiConnection'))}</option>
                                </select>
                            </div>
                            <p id="iig_pm_status" class="hint iig-pm-status"></p>
                            <p class="hint iig-pm-guidance-location"><span class="iig-pm-guidance-hint-label" aria-hidden="true">OOC</span><span>${sanitizeForHtml(pmT('guidanceLocationHint'))}</span></p>
                            <div id="iig_pm_default_connection" class="${pm.connection === 'default' ? '' : 'iig-hidden'}">
                                <div class="flex-row iig-pm-row">
                                    <label for="iig_pm_model">${sanitizeForHtml(pmT('model'))}</label>
                                    <div class="iig-model-actions iig-theme-control">
                                        <div class="iig-model-picker">
                                            <input type="text" id="iig_pm_model" class="text_pole flex1" value="${sanitizeForHtml(pm.model)}"
                                                   autocomplete="off" spellcheck="false" role="combobox"
                                                   aria-autocomplete="list" aria-controls="iig_pm_model_options" aria-expanded="false">
                                            <button type="button" id="iig_pm_model_toggle" class="menu_button iig-model-toggle"
                                                    title="${sanitizeForHtml(pmT('showModels'))}" aria-label="${sanitizeForHtml(pmT('showModels'))}"
                                                    aria-controls="iig_pm_model_options" aria-expanded="false">
                                                <i class="fa-solid fa-chevron-down"></i>
                                            </button>
                                            <div id="iig_pm_model_options" class="iig-model-options" role="listbox" aria-label="${sanitizeForHtml(pmT('model'))}" hidden></div>
                                        </div>
                                        <button type="button" id="iig_pm_refresh_models" class="menu_button iig-refresh-btn" title="${sanitizeForHtml(pmT('refreshModels'))}" aria-label="${sanitizeForHtml(pmT('refreshModels'))}">
                                            <i class="fa-solid fa-rotate"></i>
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div id="iig_pm_gemini_connection" class="iig-pm-gemini ${pm.connection === 'gemini' ? '' : 'iig-hidden'}">
                                <p class="hint">${sanitizeForHtml(pmT('geminiHint'))}</p>
                                <div class="iig-presets-bar iig-pm-gemini-presets iig-control-group">
                                    <select id="iig_pm_gemini_preset" class="flex1" aria-label="${sanitizeForHtml(pmT('geminiPresets'))}">
                                        <option value="">${sanitizeForHtml(pmT('geminiPresets'))}</option>
                                        ${(pm.gemini.presets || []).filter(preset => preset?.name).map(preset => `<option value="${sanitizeForHtml(preset.name)}" ${pm.gemini.activePresetName === preset.name ? 'selected' : ''}>${sanitizeForHtml(preset.name)}</option>`).join('')}
                                    </select>
                                    <button type="button" id="iig_pm_gemini_save" class="menu_button iig-preset-btn" title="${sanitizeForHtml(pmT('saveGeminiPreset'))}" aria-label="${sanitizeForHtml(pmT('saveGeminiPreset'))}"><i class="fa-solid fa-floppy-disk"></i></button>
                                    <button type="button" id="iig_pm_gemini_delete" class="menu_button iig-preset-btn" title="${sanitizeForHtml(pmT('deleteGeminiPreset'))}" aria-label="${sanitizeForHtml(pmT('deleteGeminiPreset'))}"><i class="fa-solid fa-trash-can"></i></button>
                                </div>
                                <div class="flex-row iig-pm-row">
                                    <label for="iig_pm_gemini_endpoint">${sanitizeForHtml(pmT('geminiEndpoint'))}</label>
                                    <input type="url" id="iig_pm_gemini_endpoint" class="text_pole flex1" value="${sanitizeForHtml(pm.gemini.endpoint)}" placeholder="${sanitizeForHtml(pmT('geminiEndpointPlaceholder'))}" autocomplete="url">
                                </div>
                                <div class="flex-row iig-pm-row">
                                    <label for="iig_pm_gemini_key">${sanitizeForHtml(pmT('geminiApiKey'))}</label>
                                    <div class="iig-control-group iig-theme-control">
                                        <input type="password" id="iig_pm_gemini_key" class="text_pole flex1" value="${sanitizeForHtml(pm.gemini.apiKey)}" autocomplete="off">
                                        <button type="button" id="iig_pm_gemini_key_toggle" class="menu_button iig-key-toggle" title="${sanitizeForHtml(iigT('iig_ui_toggleKey'))}" aria-label="${sanitizeForHtml(iigT('iig_ui_toggleKey'))}" data-i18n="[title]iig_ui_toggleKey;[aria-label]iig_ui_toggleKey" aria-controls="iig_pm_gemini_key" aria-pressed="false">
                                            <i class="fa-solid fa-eye" aria-hidden="true"></i>
                                        </button>
                                    </div>
                                </div>
                                <div class="flex-row iig-pm-row">
                                    <label for="iig_pm_gemini_model">${sanitizeForHtml(pmT('geminiModel'))}</label>
                                    <div class="iig-model-actions iig-theme-control">
                                        <div class="iig-model-picker">
                                            <input type="text" id="iig_pm_gemini_model" class="text_pole flex1" value="${sanitizeForHtml(pm.gemini.model)}"
                                                   autocomplete="off" spellcheck="false" role="combobox"
                                                   aria-autocomplete="list" aria-controls="iig_pm_gemini_model_options" aria-expanded="false">
                                            <button type="button" id="iig_pm_gemini_model_toggle" class="menu_button iig-model-toggle"
                                                    title="${sanitizeForHtml(pmT('showModels'))}" aria-label="${sanitizeForHtml(pmT('showModels'))}"
                                                    aria-controls="iig_pm_gemini_model_options" aria-expanded="false">
                                                <i class="fa-solid fa-chevron-down"></i>
                                            </button>
                                            <div id="iig_pm_gemini_model_options" class="iig-model-options" role="listbox" aria-label="${sanitizeForHtml(pmT('geminiModel'))}" hidden></div>
                                        </div>
                                        <button type="button" id="iig_pm_gemini_refresh_models" class="menu_button iig-refresh-btn" title="${sanitizeForHtml(pmT('refreshModels'))}" aria-label="${sanitizeForHtml(pmT('refreshModels'))}">
                                            <i class="fa-solid fa-rotate"></i>
                                        </button>
                                    </div>
                                </div>
                                <button type="button" id="iig_pm_gemini_test" class="menu_button iig-test-connection" title="${sanitizeForHtml(pmT('testConnection'))}">
                                    <i class="fa-solid fa-wifi"></i> ${sanitizeForHtml(pmT('testConnection'))}
                                </button>
                            </div>
                            <div class="flex-row iig-pm-row">
                                <label for="iig_pm_tag">${sanitizeForHtml(pmT('promptTag'))}</label>
                                <div class="iig-control-group">
                                    <input type="text" id="iig_pm_tag" class="text_pole flex1" value="${sanitizeForHtml(pm.tag)}">
                                    <button type="button" id="iig_pm_tag_reset" class="menu_button iig-pm-reset">${sanitizeForHtml(pmT('reset'))}</button>
                                </div>
                            </div>
                            <button type="button" id="iig_pm_import" class="menu_button iig-pm-import">
                                <i class="fa-solid fa-file-import"></i> ${sanitizeForHtml(pmT('import'))}
                            </button>
                            <p id="iig_pm_snapshot_status" class="hint iig-pm-snapshot"></p>
                            <details class="iig-pm-preview-details">
                                <summary>${sanitizeForHtml(pmT('preview'))}</summary>
                                <textarea id="iig_pm_preview" class="text_pole monospace iig-pm-preview" readonly>${sanitizeForHtml(pm.snapshot.content || '')}</textarea>
                            </details>
                        </div>
                    </details>

                    <details class="iig-section iig-accordion">
                        <summary><h4><i class="fa-solid fa-sliders"></i> <span data-i18n="iig_ui_generationSettings">Generation Settings</span></h4></summary>

                        <!-- OpenAI params -->
                        <div class="flex-row ${settings.apiType !== 'openai' ? 'iig-hidden' : ''}" id="iig_size_row">
                            <label for="iig_size" data-i18n="iig_ui_size">Size</label>
                            <select id="iig_size" class="flex1">
                                <option value="1024x1024" data-i18n="iig_ui_sizeSquare" ${settings.size === '1024x1024' ? 'selected' : ''}>1024x1024 (Square)</option>
                                <option value="1792x1024" data-i18n="iig_ui_sizeLandscape" ${settings.size === '1792x1024' ? 'selected' : ''}>1792x1024 (Landscape)</option>
                                <option value="1024x1792" data-i18n="iig_ui_sizePortrait" ${settings.size === '1024x1792' ? 'selected' : ''}>1024x1792 (Portrait)</option>
                                <option value="512x512" data-i18n="iig_ui_sizeSmall" ${settings.size === '512x512' ? 'selected' : ''}>512x512 (Small)</option>
                            </select>
                        </div>
                        
                        <div class="flex-row ${settings.apiType !== 'openai' ? 'iig-hidden' : ''}" id="iig_quality_row">
                            <label for="iig_quality" data-i18n="iig_ui_quality">Quality</label>
                            <select id="iig_quality" class="flex1">
                                <option value="auto" data-i18n="iig_ui_qualityAuto" ${settings.quality === 'auto' ? 'selected' : ''}>auto (gpt-image-*)</option>
                                <option value="low" data-i18n="iig_ui_qualityLow" ${settings.quality === 'low' ? 'selected' : ''}>low (gpt-image-*)</option>
                                <option value="medium" data-i18n="iig_ui_qualityMedium" ${settings.quality === 'medium' ? 'selected' : ''}>medium (gpt-image-*)</option>
                                <option value="high" data-i18n="iig_ui_qualityHigh" ${settings.quality === 'high' ? 'selected' : ''}>high (gpt-image-*)</option>
                                <option value="standard" data-i18n="iig_ui_qualityStandard" ${settings.quality === 'standard' ? 'selected' : ''}>standard (dall-e-3)</option>
                                <option value="hd" data-i18n="iig_ui_qualityHd" ${settings.quality === 'hd' ? 'selected' : ''}>hd (dall-e-3)</option>
                            </select>
                        </div>
                        <p class="hint ${settings.apiType !== 'openai' ? 'iig-hidden' : ''}" id="iig_quality_hint"><code>gpt-image-*</code><span data-i18n="iig_ui_qualityGptHint">: auto–high.</span> <code>dall-e-3</code><span data-i18n="iig_ui_qualityDalleHint">: standard or hd.</span></p>

                        <!-- Naistera params -->
                        <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_model_row">
                            <label for="iig_naistera_model" data-i18n="iig_ui_model">Model</label>
                            <select id="iig_naistera_model" class="flex1">
                                ${NAISTERA_MODELS.map(m => `<option value="${sanitizeForHtml(m)}" ${normalizeNaisteraModel(settings.naisteraModel) === m ? 'selected' : ''}>${sanitizeForHtml(naisteraModelDisplayLabel(m))}</option>`).join('')}
                            </select>
                        </div>

                        <div class="flex-row ${settings.apiType === 'naistera' && naisteraModelSupportsPreset(settings.naisteraModel) ? '' : 'iig-hidden'}" id="iig_naistera_preset_row">
                            <label for="iig_naistera_preset" data-i18n="iig_ui_preset">Preset</label>
                            <select id="iig_naistera_preset" class="flex1">
                                <option value="" data-i18n="iig_ui_none" ${!settings.naisteraPreset ? 'selected' : ''}>None</option>
                                <option value="digital" data-i18n="iig_ui_digital" ${settings.naisteraPreset === 'digital' ? 'selected' : ''}>Digital</option>
                                <option value="realism" data-i18n="iig_ui_realism" ${settings.naisteraPreset === 'realism' ? 'selected' : ''}>Realism</option>
                            </select>
                        </div>
                        <p class="hint ${settings.apiType === 'naistera' && naisteraModelSupportsPreset(settings.naisteraModel) ? '' : 'iig-hidden'}" id="iig_naistera_preset_hint" data-i18n="iig_ui_naisteraPresetHint">Style preset for Grok models.</p>
                        <label class="checkbox_label ${settings.apiType === 'naistera' && naisteraModelSupportsReferences(settings.naisteraModel) ? '' : 'iig-hidden'}" id="iig_naistera_refs_row" style="margin-top: 6px;">
                            <input type="checkbox" id="iig_naistera_send_refs" ${settings.naisteraSendRefs !== false ? 'checked' : ''}>
                            <span data-i18n="iig_ui_naisteraSendRefs">Send reference images (Naistera)</span>
                        </label>
                        <p class="hint ${settings.apiType === 'naistera' && naisteraModelSupportsReferences(settings.naisteraModel) ? '' : 'iig-hidden'}" id="iig_naistera_refs_hint" data-i18n="iig_ui_naisteraRefsHint">Available for Grok and Nano Banana 2.</p>

                        <!-- Gemini params. Aspect ratio is tag-driven; only resolution is UI. -->
                        <div id="iig_gemini_params" class="${settings.apiType !== 'gemini' ? 'iig-hidden' : ''}">
                            <div class="flex-row">
                                <label for="iig_image_size" data-i18n="iig_ui_resolution">Resolution</label>
                                <select id="iig_image_size" class="flex1">
                                    <option value="1K" data-i18n="iig_ui_resolutionDefault" ${settings.imageSize === '1K' ? 'selected' : ''}>1K (default)</option>
                                    <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K</option>
                                    <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K</option>
                                </select>
                            </div>
                            <label class="checkbox_label" style="margin-top: 6px;">
                                <input type="checkbox" id="iig_gemini_send_refs" ${settings.geminiSendRefs !== false ? 'checked' : ''}>
                                <span data-i18n="iig_ui_geminiSendRefs">Send reference images (Gemini)</span>
                            </label>
                            <p class="hint" data-i18n="iig_ui_geminiRefsHint">Disable references for text-only generation. Aspect ratio comes from each tag.</p>
                        </div>
                    </details>

                    <details class="iig-section iig-accordion">
                        <summary><h4><i class="fa-solid fa-rotate"></i> <span data-i18n="iig_ui_retrySettings">Retry Settings</span></h4></summary>
                        
                        <div class="flex-row">
                            <label for="iig_max_retries" data-i18n="iig_ui_maxRetries">Max Retries</label>
                            <input type="number" id="iig_max_retries" class="text_pole flex1" 
                                   value="${sanitizeForHtml(settings.maxRetries)}" min="0" max="5">
                        </div>
                        
                        <div class="flex-row">
                            <label for="iig_retry_delay" data-i18n="iig_ui_retryDelay">Delay (ms)</label>
                            <input type="number" id="iig_retry_delay" class="text_pole flex1" 
                                   value="${sanitizeForHtml(settings.retryDelay)}" min="500" max="10000" step="500">
                        </div>
                        <p class="hint" data-i18n="iig_ui_retryHint">Retries temporary API errors with increasing delays, capped at 30 seconds.</p>
                    </details>

                    <details class="iig-section iig-accordion">
                        <summary><h4><i class="fa-solid fa-bolt"></i> <span data-i18n="iig_ui_performance">Performance</span></h4></summary>
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_low_power" ${settings.lowPowerMode ? 'checked' : ''}>
                            <span data-i18n="iig_ui_lowPower">Low-power mode</span>
                        </label>
                        <p class="hint" data-i18n="iig_ui_lowPowerHint">Reduces animation and background updates.</p>
                        <label class="checkbox_label" style="margin-top:6px;">
                            <input type="checkbox" id="iig_lp_anim" ${settings.lpDisableAnimations !== false ? 'checked' : ''} ${settings.lowPowerMode ? '' : 'disabled'}>
                            <span data-i18n="iig_ui_disableAnimations">Disable animations</span>
                        </label>
                        <label class="checkbox_label" style="margin-top:6px;">
                            <input type="checkbox" id="iig_lp_slow" ${settings.lpSlowUpdates !== false ? 'checked' : ''} ${settings.lowPowerMode ? '' : 'disabled'}>
                            <span data-i18n="iig_ui_slowUpdates">Slower background updates</span>
                        </label>
                        <p class="hint" data-i18n="iig_ui_lowPowerOptionsHint">These options apply only in low-power mode.</p>
                    </details>

                    <details class="iig-section iig-accordion">
                        <summary><h4><i class="fa-solid fa-bug"></i> <span data-i18n="iig_ui_debug">Debug</span></h4></summary>
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_verbose_logging" ${settings.verboseLogging ? 'checked' : ''}>
                            <span data-i18n="iig_ui_verboseConsole">Verbose console</span>
                        </label>
                        <p class="hint" data-i18n="iig_ui_verboseConsoleHint">Print DEBUG entries to the browser console.</p>
                        <button type="button" id="iig_export_logs" class="menu_button iig-export-logs-btn">
                            <i class="fa-solid fa-download"></i> <span data-i18n="iig_ui_exportLogs">Export Logs</span>
                        </button>
                        <p class="hint" data-i18n="iig_ui_exportLogsHint">Export Logs always includes DEBUG entries.</p>
                    </details>
                    
                    <div class="iig-maintenance-row iig-maintenance-row--primary">
                        <button type="button" id="iig_check_ref_storage" class="menu_button iig-maint-btn" title="Count files and measure the iig_refs folder on demand." aria-label="Check reference storage" data-i18n="[title]iig_ui_checkStorageTitle;[aria-label]iig_ui_checkStorageAria">
                            <i class="fa-solid fa-hard-drive"></i><span class="iig-maint-label-full" data-i18n="iig_ui_checkStorage">Check ref storage</span><span class="iig-maint-label-short" aria-hidden="true" data-i18n="iig_ui_storage">Storage</span>
                        </button>
                        <button type="button" id="iig_clear_refs_folder" class="menu_button iig-maint-btn iig-maint-danger" title="Delete every file in the iig_refs folder on the SillyTavern server." aria-label="Clear reference storage folder" data-i18n="[title]iig_ui_clearStorageTitle;[aria-label]iig_ui_clearStorageAria">
                            <i class="fa-solid fa-broom"></i><span class="iig-maint-label-full" data-i18n="iig_ui_clearStorage">Clear refs folder</span><span class="iig-maint-label-short" aria-hidden="true" data-i18n="iig_ui_clear">Clear</span>
                        </button>
                    </div>
                    <p id="iig_ref_storage_status" class="hint" role="status" aria-live="polite" style="text-align:center;font-size:0.85em;">${sanitizeForHtml(iigT('iig_ui_storageNotChecked'))}</p>

                    <!-- Shown only if ST-ImageManager is installed (feature-detected at render). -->
                    <button type="button" id="iig_open_image_manager" class="menu_button iig-open-im-btn iig-hidden" title="Open the Image Manager extension to browse, sort, and clean up your generated images." data-i18n="[title]iig_ui_openImageManagerTitle">
                        <i class="fa-solid fa-images"></i> <span data-i18n="iig_ui_openImageManager">Open Image Manager</span>
                    </button>

                    <p class="hint" style="text-align:center;opacity:0.5;margin-top:4px;">
                        v${IIG_VERSION} <span data-i18n="iig_ui_by">by</span> <a href="https://github.com/aceeenvw/notsosillynotsoimages" target="_blank" style="color:inherit;text-decoration:underline;">aceenvw</a>
                    </p>
                    <p id="iig_session_stats" class="hint" style="text-align:center;opacity:0.35;margin-top:2px;font-size:0.8em;"></p>
                </div>
            </div>
        </div>
    `;
    
    container.insertAdjacentHTML('beforeend', html);
    
    bindSettingsEvents();
    renderRefSlots();
    applyLowPowerMode();
}

// =========================================================================
// Image Packs — local reference library
// =========================================================================
//
// Thumbnails are written once at import, so the grid never decodes a
// full-size blob; only the chosen image is read in full.

const PACKS_DB_NAME = `iig-packs-${_BUILD_HASH.seed}`;
const PACKS_DB_VERSION = 2;
const PACKS_STORE = 'packs';
const ASSETS_STORE = 'assets';
const PACK_ADDED_AT_INDEX = 'packAddedAt';
const PACK_NAME_INDEX = 'packName';
const PACKS_PAGE_SIZE = 12;
const PACK_MAX_BYTES = 12 * 1024 * 1024;
const PACK_IMAGE_DIM = 768;
const PACK_IMAGE_QUALITY = 0.8;
const PACK_THUMB_DIM = 512;
const PACK_THUMB_QUALITY = 0.86;
const PACK_THUMB_VERSION = 2;
const PACK_ENCODE_TIMEOUT_MS = 20000;
const PACK_NAME_MAX = 60;
const PACK_ASSET_NAME_MAX = 120;
const PACK_SORT_CONFIG = Object.freeze({
    newest: { index: PACK_ADDED_AT_INDEX, direction: 'prev' },
    oldest: { index: PACK_ADDED_AT_INDEX, direction: 'next' },
    nameAsc: { index: PACK_NAME_INDEX, direction: 'next' },
    nameDesc: { index: PACK_NAME_INDEX, direction: 'prev' },
});

let _packsDbPromise = null;
let _packsDb = null;
let _packsSort = 'newest';

function openPacksDb() {
    if (_iigDisposed) return Promise.reject(Object.assign(new Error('Pack storage closed'), { name: 'AbortError' }));
    if (_packsDbPromise) return _packsDbPromise;
    let failed = false;
    const pending = new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
            reject(new Error('IndexedDB is unavailable'));
            return;
        }
        const request = globalThis.indexedDB.open(PACKS_DB_NAME, PACKS_DB_VERSION);
        const forget = addIigDisposer(() => {
            failed = true;
            reject(Object.assign(new Error('Pack storage closed'), { name: 'AbortError' }));
        });
        request.onupgradeneeded = event => {
            if (_iigDisposed) { request.transaction.abort(); return; }
            const db = request.result;
            if (!db.objectStoreNames.contains(PACKS_STORE)) {
                db.createObjectStore(PACKS_STORE, { keyPath: 'id' });
            }
            let assets;
            if (!db.objectStoreNames.contains(ASSETS_STORE)) {
                assets = db.createObjectStore(ASSETS_STORE, { keyPath: 'id' });
                assets.createIndex('packId', 'packId', { unique: false });
            } else {
                assets = request.transaction.objectStore(ASSETS_STORE);
                if (event.oldVersion < 2) {
                    const cursorRequest = assets.openCursor();
                    cursorRequest.onsuccess = () => {
                        const cursor = cursorRequest.result;
                        if (!cursor) return;
                        const record = cursor.value;
                        if (!Number.isFinite(record.addedAt) || typeof record.name !== 'string') {
                            if (!Number.isFinite(record.addedAt)) record.addedAt = 0;
                            if (typeof record.name !== 'string') record.name = String(record.id);
                            cursor.update(record);
                        }
                        cursor.continue();
                    };
                }
            }
            if (!assets.indexNames.contains(PACK_ADDED_AT_INDEX)) {
                assets.createIndex(PACK_ADDED_AT_INDEX, ['packId', 'addedAt'], { unique: false });
            }
            if (!assets.indexNames.contains(PACK_NAME_INDEX)) {
                assets.createIndex(PACK_NAME_INDEX, ['packId', 'name'], { unique: false });
            }
        };
        request.onsuccess = () => {
            forget();
            const db = request.result;
            if (failed || _iigDisposed) { db.close(); return; }
            _packsDb = db;
            const invalidate = () => {
                if (_packsDbPromise === pending) _packsDbPromise = null;
                if (_packsDb === db) _packsDb = null;
            };
            db.onclose = invalidate;
            db.onversionchange = () => { db.close(); invalidate(); };
            resolve(db);
        };
        request.onerror = () => { forget(); reject(request.error || new Error('Failed to open pack storage')); };
        request.onblocked = () => {
            forget();
            failed = true;
            reject(new Error('Pack storage is blocked by another tab'));
        };
    });
    _packsDbPromise = pending;
    // A failed open must not poison every later attempt.
    pending.catch(() => {
        if (_packsDbPromise === pending) _packsDbPromise = null;
    });
    return pending;
}

function packsRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Pack storage request failed'));
    });
}

/** Resolves once the transaction commits, not when `work` returns. */
async function packsTransaction(storeNames, mode, work) {
    const db = await openPacksDb();
    throwIfSignalAborted();
    return new Promise((resolve, reject) => {
        let result;
        let transaction;
        try {
            transaction = db.transaction(storeNames, mode);
        } catch (error) {
            reject(error);
            return;
        }
        const forget = addIigDisposer(() => { try { transaction.abort(); } catch (_) {} });
        transaction.oncomplete = () => { forget(); resolve(result); };
        transaction.onabort = () => { forget(); reject(transaction.error || new Error('Pack storage transaction aborted')); };
        transaction.onerror = () => { forget(); reject(transaction.error || new Error('Pack storage transaction failed')); };
        Promise.resolve(work(transaction))
            .then(value => { result = value; })
            .catch(error => {
                try { transaction.abort(); } catch (_) {}
                reject(error);
            });
    });
}

function packsNewId() {
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch (_) {}
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizePackName(name) {
    return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, PACK_NAME_MAX);
}

function sanitizePackAssetName(name) {
    return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, PACK_ASSET_NAME_MAX);
}

function normalizePackSort(value) {
    return Object.hasOwn(PACK_SORT_CONFIG, value) ? value : 'newest';
}

/** Newest first. */
async function listPacks() {
    const packs = await packsTransaction([PACKS_STORE], 'readonly', tx =>
        packsRequest(tx.objectStore(PACKS_STORE).getAll()));
    return (packs || []).sort((a, b) => (b?.createdAt || 0) - (a?.createdAt || 0));
}

async function createPack(name) {
    const clean = sanitizePackName(name);
    if (!clean) throw new Error('Pack name is required');
    const pack = { id: packsNewId(), name: clean, createdAt: Date.now() };
    await packsTransaction([PACKS_STORE], 'readwrite', tx =>
        packsRequest(tx.objectStore(PACKS_STORE).add(pack)));
    return pack;
}

async function renamePack(packId, name) {
    const clean = sanitizePackName(name);
    if (!clean) throw new Error('Pack name is required');
    return packsTransaction([PACKS_STORE], 'readwrite', async tx => {
        const store = tx.objectStore(PACKS_STORE);
        const pack = await packsRequest(store.get(packId));
        if (!pack) throw new Error('Pack no longer exists');
        const updated = { ...pack, name: clean };
        await packsRequest(store.put(updated));
        return updated;
    });
}

/** Pack and assets go in one transaction, so a failure orphans nothing. */
async function deletePack(packId) {
    await packsTransaction([PACKS_STORE, ASSETS_STORE], 'readwrite', async tx => {
        const keys = await packsRequest(tx.objectStore(ASSETS_STORE).index('packId').getAllKeys(packId));
        for (const key of keys || []) tx.objectStore(ASSETS_STORE).delete(key);
        tx.objectStore(PACKS_STORE).delete(packId);
    });
}

function readPackCursorPage(index, range, direction, offset, limit) {
    if (limit <= 0) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
        const items = [];
        const request = index.openCursor(range, direction);
        let positioned = offset === 0;
        request.onerror = () => reject(request.error || new Error('Pack page read failed'));
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve(items);
                return;
            }
            if (!positioned) {
                positioned = true;
                cursor.advance(offset);
                return;
            }
            const record = cursor.value;
            items.push({
                id: record.id,
                name: record.name,
                thumb: record.thumb,
                thumbVersion: record.thumbVersion || 0,
            });
            if (items.length >= limit) resolve(items);
            else cursor.continue();
        };
    });
}

/** One globally sorted page without materializing full-size blobs. */
async function listPackPage(packId, page, sort = _packsSort) {
    return packsTransaction([ASSETS_STORE], 'readonly', async tx => {
        const config = PACK_SORT_CONFIG[normalizePackSort(sort)];
        const index = tx.objectStore(ASSETS_STORE).index(config.index);
        const range = globalThis.IDBKeyRange.bound([packId], [packId, []]);
        const total = await packsRequest(index.count(range));
        const pages = Math.max(1, Math.ceil(total / PACKS_PAGE_SIZE));
        const current = Math.min(Math.max(0, page), pages - 1);
        const items = total === 0 ? [] : await readPackCursorPage(
            index,
            range,
            config.direction,
            current * PACKS_PAGE_SIZE,
            PACKS_PAGE_SIZE,
        );
        return { items, total, page: current, pages };
    });
}

async function listPacksWithCounts() {
    const packs = await listPacks();
    return packsTransaction([ASSETS_STORE], 'readonly', tx => {
        const index = tx.objectStore(ASSETS_STORE).index('packId');
        return Promise.all(packs.map(pack => packsRequest(index.count(pack.id))
            .then(count => ({ ...pack, count }))));
    });
}

async function measurePacksStorage() {
    return packsTransaction([PACKS_STORE, ASSETS_STORE], 'readonly', async tx => {
        const packCount = await packsRequest(tx.objectStore(PACKS_STORE).count());
        const store = tx.objectStore(ASSETS_STORE);
        return new Promise((resolve, reject) => {
            let imageCount = 0;
            let totalBytes = 0;
            const request = store.openCursor();
            request.onerror = () => reject(request.error || new Error('Pack storage measurement failed'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve({ packCount, imageCount, totalBytes });
                    return;
                }
                imageCount++;
                // The cursor still clones records; bytes only caches the payload total.
                const record = cursor.value;
                totalBytes += Number.isSafeInteger(record.bytes) && record.bytes >= 0
                    ? record.bytes
                    : [record.blob?.size, record.thumb?.size].reduce((sum, size) =>
                        sum + (Number.isSafeInteger(size) && size >= 0 ? size : 0), 0);
                cursor.continue();
            };
        });
    });
}

/** Read only when an image is chosen; the grid uses thumbnails. */
async function getPackAssetBlob(assetId) {
    const record = await packsTransaction([ASSETS_STORE], 'readonly', tx =>
        packsRequest(tx.objectStore(ASSETS_STORE).get(assetId)));
    if (!record?.blob) throw new Error('Image is no longer in storage');
    return { blob: record.blob, name: record.name, type: record.type };
}

async function upgradePackAssetThumbnail(assetId, expectedPackId) {
    const asset = await packsTransaction([ASSETS_STORE], 'readonly', tx =>
        packsRequest(tx.objectStore(ASSETS_STORE).get(assetId)));
    if (!asset || asset.packId !== expectedPackId || asset.thumbVersion >= PACK_THUMB_VERSION) return null;

    const built = await buildPackThumbnail(asset.blob);
    return packsTransaction([ASSETS_STORE], 'readwrite', async tx => {
        const store = tx.objectStore(ASSETS_STORE);
        const current = await packsRequest(store.get(assetId));
        if (!current || current.packId !== expectedPackId || current.thumbVersion >= PACK_THUMB_VERSION) return null;
        const bytes = (Number.isSafeInteger(current.blob?.size) && current.blob.size >= 0 ? current.blob.size : 0) + built.thumb.size;
        await packsRequest(store.put({ ...current, thumb: built.thumb, thumbVersion: PACK_THUMB_VERSION, bytes }));
        return built.thumb;
    });
}

async function renamePackAsset(assetId, expectedPackId, name) {
    const clean = sanitizePackAssetName(name);
    if (!clean) throw new Error('Image name is required');
    await packsTransaction([ASSETS_STORE], 'readwrite', async tx => {
        const store = tx.objectStore(ASSETS_STORE);
        const asset = await packsRequest(store.get(assetId));
        if (!asset || asset.packId !== expectedPackId) throw new Error('Image no longer belongs to this pack');
        await packsRequest(store.put({ ...asset, name: clean }));
    });
}

async function deletePackAsset(assetId, expectedPackId) {
    await packsTransaction([ASSETS_STORE], 'readwrite', async tx => {
        const store = tx.objectStore(ASSETS_STORE);
        const asset = await packsRequest(store.get(assetId));
        if (!asset || asset.packId !== expectedPackId) throw new Error('Image no longer belongs to this pack');
        await packsRequest(store.delete(assetId));
    });
}

async function movePackAsset(assetId, expectedPackId, destinationPackId) {
    if (!destinationPackId || destinationPackId === expectedPackId) throw new Error('Choose another pack');
    await packsTransaction([PACKS_STORE, ASSETS_STORE], 'readwrite', async tx => {
        const packsStore = tx.objectStore(PACKS_STORE);
        const assetsStore = tx.objectStore(ASSETS_STORE);
        const [destination, asset] = await Promise.all([
            packsRequest(packsStore.get(destinationPackId)),
            packsRequest(assetsStore.get(assetId)),
        ]);
        if (!destination) throw new Error('Destination pack no longer exists');
        if (!asset || asset.packId !== expectedPackId) throw new Error('Image no longer belongs to this pack');
        await packsRequest(assetsStore.put({ ...asset, packId: destinationPackId }));
    });
}

async function createPackAndMoveAsset(assetId, expectedPackId, name) {
    const clean = sanitizePackName(name);
    if (!clean) throw new Error('Pack name is required');
    const pack = { id: packsNewId(), name: clean, createdAt: Date.now() };
    await packsTransaction([PACKS_STORE, ASSETS_STORE], 'readwrite', async tx => {
        const packsStore = tx.objectStore(PACKS_STORE);
        const assetsStore = tx.objectStore(ASSETS_STORE);
        const asset = await packsRequest(assetsStore.get(assetId));
        if (!asset || asset.packId !== expectedPackId) throw new Error('Image no longer belongs to this pack');
        await packsRequest(packsStore.add(pack));
        await packsRequest(assetsStore.put({ ...asset, packId: pack.id }));
    });
    return pack;
}

async function addPackAsset(packId, record) {
    await packsTransaction([PACKS_STORE, ASSETS_STORE], 'readwrite', async tx => {
        const pack = await packsRequest(tx.objectStore(PACKS_STORE).get(packId));
        if (!pack) throw new Error('Pack no longer exists');
        await packsRequest(tx.objectStore(ASSETS_STORE).add({ ...record, id: packsNewId(), packId }));
    });
}

const PACK_TYPE_BY_EXTENSION = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    jfif: 'image/jpeg', jpe: 'image/jpeg', jif: 'image/jpeg', webp: 'image/webp',
};
const PACK_ACCEPT_TYPES = [...new Set(Object.values(PACK_TYPE_BY_EXTENSION)), ...Object.keys(PACK_TYPE_BY_EXTENSION).map(ext => `.${ext}`)];

/**
 * Identify a file by its leading bytes. The declared MIME type comes from the
 * OS and is not evidence: a renamed GIF or SVG arrives claiming to be a PNG.
 */
async function sniffImageType(file) {
    const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const at = i => header[i];
    if (header.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4E && at(3) === 0x47
        && at(4) === 0x0D && at(5) === 0x0A && at(6) === 0x1A && at(7) === 0x0A) return 'image/png';
    if (header.length >= 3 && at(0) === 0xFF && at(1) === 0xD8 && at(2) === 0xFF) return 'image/jpeg';
    if (header.length >= 12
        && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
        && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp';
    return '';
}

function packFileExtension(name) {
    const match = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return match ? match[1].toLowerCase() : '';
}

/** The decode doubles as the final gate: undecodable files never store. */
async function buildPackThumbnail(file, compress = false) {
    throwIfSignalAborted();
    let bitmap = null;
    let canvas;
    let timer;
    try {
        await waitIig(createImageBitmap(file).then(value => {
            if (_iigDisposed) { value.close?.(); throwIfSignalAborted(); }
            bitmap = value;
        }));
        throwIfSignalAborted();
        const { width, height } = bitmap;
        if (!width || !height) throw new Error('decode');
        canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('decode');
        const built = {};
        // New imports share one decode; upgrades only replace the thumbnail.
        for (const key of compress ? ['blob', 'thumb'] : ['thumb']) {
            throwIfSignalAborted();
            const scale = Math.min(1, (key === 'blob' ? PACK_IMAGE_DIM : PACK_THUMB_DIM) / Math.max(width, height));
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            // A stalled encoder would otherwise hold the popup busy with no way out.
            const blob = await waitIig(new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('decode')), PACK_ENCODE_TIMEOUT_MS);
                canvas.toBlob(resolve, 'image/jpeg', key === 'blob' ? PACK_IMAGE_QUALITY : PACK_THUMB_QUALITY);
            }));
            clearTimeout(timer);
            throwIfSignalAborted();
            if (!blob?.size || blob.type !== 'image/jpeg') throw new Error('decode');
            built[key] = blob;
        }
        return built;
    } catch (_) {
        throwIfSignalAborted();
        throw new Error('decode');
    } finally {
        clearTimeout(timer);
        bitmap?.close?.();
        if (canvas) canvas.width = canvas.height = 0;
    }
}

/** Returns a rejection reason, so a mixed selection reports a per-file tally. */
async function importPackFile(packId, file, crop = null) {
    throwIfSignalAborted();
    if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) return 'type';
    if (file.size > PACK_MAX_BYTES) return 'size';

    // Ignore OS MIME claims; the filename and byte signature must agree.
    const declared = PACK_TYPE_BY_EXTENSION[packFileExtension(file.name)];
    if (!declared) return 'type';

    let sniffed;
    try {
        sniffed = await waitIig(sniffImageType(file));
    } catch (_) {
        throwIfSignalAborted();
        return 'type';
    }
    if (sniffed !== declared) return 'type';

    let built;
    try {
        let source = file;
        if (crop) {
            const cropped = await crop(file);
            throwIfSignalAborted();
            if (cropped === null) return 'cancelled';
            source = base64ToImageBlob(`data:image/jpeg;base64,${cropped}`).blob;
        }
        built = await buildPackThumbnail(source, true);
    } catch (_) {
        throwIfSignalAborted();
        return 'decode';
    }

    throwIfSignalAborted();
    await addPackAsset(packId, {
        name: sanitizePackAssetName(file.name),
        type: built.blob.type,
        blob: built.blob,
        thumb: built.thumb,
        thumbVersion: PACK_THUMB_VERSION,
        bytes: built.blob.size + built.thumb.size,
        addedAt: Date.now(),
    });
    return '';
}

function packNode(tag, className, text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
}

/** `labelHidden` is for buttons whose text CSS hides; they need a name. */
function packIconButton(className, icon, label, { labelHidden = false } = {}) {
    const button = packNode('button', `menu_button ${className}`);
    button.type = 'button';
    button.title = label;
    if (labelHidden) button.setAttribute('aria-label', label);
    const glyph = packNode('i', `fa-solid ${icon}`);
    glyph.setAttribute('aria-hidden', 'true');
    button.append(glyph, packNode('span', 'iig-packs-btn-label', label));
    return button;
}

/** Sits left of Remove in all six slots. */
function refPacksPillHtml() {
    return `<button type="button" class="menu_button iig-ref-packs-btn" title="${sanitizeForHtml(packT('pillTitle'))}" aria-label="${sanitizeForHtml(packT('pillTitle'))}"><i class="fa-solid fa-images" aria-hidden="true"></i><span>${sanitizeForHtml(packT('pill'))}</span></button>`;
}

function clearPackedRefSlotAppearance(slot) {
    if (!slot) return;
    slot.classList.remove('iig-ref-from-pack');
    delete slot.dataset.iigPackSource;
    slot.querySelector('.iig-ref-pack-badge')?.remove();
}

function setPackedRefSlotAppearance(slot, item) {
    clearPackedRefSlotAppearance(slot);
    const wrap = slot?.querySelector('.iig-ref-thumb-wrap');
    if (!slot || !wrap) return;
    slot.classList.add('iig-ref-from-pack');
    slot.dataset.iigPackSource = String(item?.id || '');
    const badge = packNode('span', 'iig-ref-pack-badge', packT('sourceBadge'));
    badge.title = item?.name ? `${packT('sourceBadge')}: ${item.name}` : packT('sourceBadge');
    wrap.appendChild(badge);
}

let _packsPopupOpen = false;

/** `onPick` must resolve truthy to close; a failed upload keeps this open. */
async function openImagePacksPopup(onPick) {
    if (_iigDisposed || _packsPopupOpen) return;
    const ctx = getContext();
    if (!ctx?.Popup) return;

    const root = packNode('div', 'iig-packs-popup');
    const heading = packNode('h3', 'iig-packs-heading', packT('title'));
    heading.id = 'iig_packs_popup_title';
    heading.tabIndex = -1;
    root.append(heading, packNode('p', 'iig-packs-intro', packT('intro')));

    const controls = packNode('div', 'iig-packs-controls');
    root.appendChild(controls);
    const toolbar = packNode('div', 'iig-packs-toolbar');
    const packSelect = packNode('select', 'text_pole iig-packs-select');
    packSelect.setAttribute('aria-label', packT('packs'));
    const newButton = packIconButton('iig-packs-new', 'fa-plus', packT('newPack'), { labelHidden: true });
    const renameButton = packIconButton('iig-packs-rename', 'fa-pen', packT('renamePack'), { labelHidden: true });
    const addButton = packIconButton('iig-packs-add', 'fa-file-import', packT('addImages'), { labelHidden: true });
    const deleteButton = packIconButton('iig-packs-delete', 'fa-trash-can', packT('deletePack'), { labelHidden: true });
    toolbar.append(packSelect, newButton, renameButton, addButton, deleteButton);
    controls.appendChild(toolbar);

    const utilities = packNode('div', 'iig-packs-utilities');
    const sortSelect = packNode('select', 'text_pole iig-packs-sort');
    sortSelect.setAttribute('aria-label', packT('sort'));
    for (const [value, labelKey] of [
        ['newest', 'sortNewest'],
        ['oldest', 'sortOldest'],
        ['nameAsc', 'sortNameAsc'],
        ['nameDesc', 'sortNameDesc'],
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = packT(labelKey);
        sortSelect.appendChild(option);
    }
    sortSelect.value = normalizePackSort(_packsSort);
    const storageButton = packIconButton('iig-packs-storage', 'fa-hard-drive', packT('checkStorage'));
    utilities.append(sortSelect, storageButton);
    controls.appendChild(utilities);

    const fileInput = packNode('input', 'iig-hidden');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.accept = PACK_ACCEPT_TYPES.join(',');
    root.appendChild(fileInput);

    const status = packNode('div', 'iig-packs-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    root.appendChild(status);

    const busyNotice = packNode('div', 'iig-packs-status');
    busyNotice.id = 'iig_packs_busy_notice';
    busyNotice.setAttribute('role', 'status');
    root.appendChild(busyNotice);

    const usageStatus = packNode('div', 'iig-packs-usage');
    usageStatus.setAttribute('role', 'status');
    usageStatus.setAttribute('aria-live', 'polite');
    root.appendChild(usageStatus);

    const grid = packNode('div', 'iig-packs-grid');
    root.appendChild(grid);

    const pager = packNode('div', 'iig-packs-pager');
    const prevButton = packIconButton('iig-packs-prev', 'fa-chevron-left', packT('prev'), { labelHidden: true });
    const pageLabel = packNode('span', 'iig-packs-page');
    const nextButton = packIconButton('iig-packs-next', 'fa-chevron-right', packT('next'), { labelHidden: true });
    pager.append(prevButton, pageLabel, nextButton);
    root.appendChild(pager);

    let packs = [];
    let activePackId = '';
    let page = 0;
    let pages = 1;
    let busy = false;
    let disposed = false;
    let objectUrls = [];
    let gridRevision = 0;
    let packsRevision = 0;
    let usageMeasured = false;
    let gridLoading = false;
    let pendingFocus = null;
    let nestedDepth = 0;
    let photoMenu = null;
    const closePhotoActions = (returnFocus = true) => photoMenu?.close('', returnFocus);
    const failedThumbnailUpgrades = new Set();

    const parkFocus = () => {
        const element = document.activeElement;
        if (!root.contains(element) || element === heading) return;
        const item = element.closest('.iig-packs-item');
        pendingFocus = {
            element,
            id: item?.dataset.assetId,
            index: item ? [...grid.children].indexOf(item) : -1,
            actions: element.classList.contains('iig-packs-item-actions'),
        };
        // Also gives the host Popup a connected, enabled lastFocus for nested dialogs.
        heading.focus({ preventScroll: true });
    };
    const restoreFocus = () => {
        if (!pendingFocus || busy || gridLoading || nestedDepth || disposed) return;
        const saved = pendingFocus;
        pendingFocus = null;
        if (document.activeElement !== heading || !root.isConnected) return;
        let target = saved.element;
        if (saved.index >= 0) {
            const items = [...grid.querySelectorAll('.iig-packs-item')];
            const item = items.find(entry => entry.dataset.assetId === saved.id)
                || items[Math.min(saved.index, items.length - 1)];
            target = item?.querySelector(saved.actions ? '.iig-packs-item-actions' : '.iig-packs-tile');
        }
        if (!target?.isConnected || target.disabled || (pager.contains(target) && pager.hidden)) {
            target = !pager.hidden && !prevButton.disabled ? prevButton
                : !pager.hidden && !nextButton.disabled ? nextButton
                    : grid.querySelector('.iig-packs-tile') || (!addButton.disabled ? addButton : newButton);
        }
        target.focus({ preventScroll: true });
    };
    const setDisabled = (control, value) => {
        if (value && document.activeElement === control) parkFocus();
        control.disabled = value;
    };
    const showNested = async show => {
        parkFocus();
        nestedDepth++;
        try { return await show(); }
        finally {
            nestedDepth--;
            restoreFocus();
        }
    };

    const releaseObjectUrls = () => {
        for (const url of objectUrls) URL.revokeObjectURL(url);
        for (const image of grid.querySelectorAll('img[data-iig-object-url]')) delete image.dataset.iigObjectUrl;
        objectUrls = [];
    };

    const setThumbnailUrl = (image, blob) => {
        const previous = image.dataset.iigObjectUrl;
        if (previous) {
            URL.revokeObjectURL(previous);
            objectUrls = objectUrls.filter(url => url !== previous);
        }
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        image.dataset.iigObjectUrl = url;
        image.src = url;
    };

    const setStatus = message => { if (!disposed) status.textContent = message || ''; };
    const reportFailure = error => {
        iigLog('ERROR', 'Image Packs: action failed', error);
        if (!disposed) setStatus(packT('storageFailed'));
    };
    const handleAction = action => iigHandler(async event => {
        if (disposed) return;
        try { await action(event); }
        catch (error) { reportFailure(error); }
    });
    const markUsageStale = () => {
        if (!usageMeasured) return;
        usageMeasured = false;
        usageStatus.textContent = packT('storageChanged');
    };

    const upgradeVisibleThumbnails = async (targets, revision, packId) => {
        let changed = false;
        for (const { item, image } of targets) {
            if (disposed || _iigDisposed) return;
            if (failedThumbnailUpgrades.has(item.id)) continue;
            try {
                const thumb = await upgradePackAssetThumbnail(item.id, packId);
                if (!thumb) continue;
                changed = true;
                if (disposed || revision !== gridRevision || packId !== activePackId || !image.isConnected) {
                    if (!disposed) markUsageStale();
                    return;
                }
                setThumbnailUrl(image, thumb);
            } catch (_) {
                failedThumbnailUpgrades.add(item.id);
            }
        }
        if (changed && !disposed) markUsageStale();
    };

    // Restore control states from the current pack and page.
    const setBusy = value => {
        closePhotoActions();
        busy = value;
        root.classList.toggle('iig-packs-popup--busy', value);
        // Live statuses are siblings, not descendants of an aria-busy region.
        for (const region of [toolbar, utilities, grid, pager]) {
            region.setAttribute('aria-busy', String(value || (gridLoading && (region === grid || region === pager))));
        }
        busyNotice.textContent = value ? packT('busyClose') : '';
        for (const control of root.querySelectorAll('button, select, input')) {
            setDisabled(control, value);
        }
        if (value) return;
        setDisabled(packSelect, packs.length === 0);
        for (const control of [renameButton, addButton, deleteButton, sortSelect]) setDisabled(control, !activePackId);
        setDisabled(prevButton, page === 0);
        setDisabled(nextButton, page >= pages - 1);
        restoreFocus();
    };

    const renderGrid = async () => {
        closePhotoActions();
        const revision = ++gridRevision;
        const requestedPackId = activePackId;
        const requestedPage = page;
        gridLoading = true;
        grid.setAttribute('aria-busy', 'true');
        pager.setAttribute('aria-busy', 'true');
        const finishGrid = () => {
            gridLoading = false;
            if (pages <= 1 && pager.contains(document.activeElement)) parkFocus();
            pager.hidden = pages <= 1;
            pageLabel.textContent = packT('page', { page: page + 1, pages });
            setBusy(busy);
        };
        try {
            let result;
            try {
                result = requestedPackId ? await listPackPage(requestedPackId, requestedPage, _packsSort)
                    : { page: 0, pages: 1, total: 0, items: [] };
            } catch (error) {
                if (disposed || revision !== gridRevision || requestedPackId !== activePackId) return;
                iigLog('ERROR', 'Image Packs: page read failed', error.message);
            }
            if (disposed || revision !== gridRevision || requestedPackId !== activePackId) return;
            if (grid.contains(document.activeElement)) parkFocus();
            releaseObjectUrls();
            grid.replaceChildren();
            if (!result) {
                page = 0;
                pages = 1;
                grid.appendChild(packNode('p', 'iig-packs-empty', packT('storageFailed')));
                return;
            }
            page = result.page;
            pages = result.pages;
            if (result.total === 0) {
                grid.appendChild(packNode('p', 'iig-packs-empty', packT(requestedPackId ? 'emptyPack' : 'noPacks')));
                return;
            }
            const upgradeTargets = [];
            for (const item of result.items) {
                const itemRoot = packNode('div', 'iig-packs-item');
                itemRoot.dataset.assetId = item.id;
                const imageWrap = packNode('div', 'iig-packs-image-wrap');
                const tile = packNode('button', 'iig-packs-tile');
                tile.type = 'button';
                tile.disabled = busy;
                tile.title = item.name;
                tile.setAttribute('aria-label', packT('usePhoto', { name: item.name }));
                const image = packNode('img', 'iig-packs-thumb');
                image.loading = 'lazy';
                image.decoding = 'async';
                image.alt = '';
                setThumbnailUrl(image, item.thumb);
                tile.appendChild(image);
                tile.addEventListener('click', handleAction(() => choose(item)));
                const actionsButton = packIconButton(
                    'iig-packs-item-actions',
                    'fa-ellipsis',
                    packT('photoActionsFor', { name: item.name }),
                    { labelHidden: true },
                );
                actionsButton.disabled = busy;
                actionsButton.setAttribute('aria-haspopup', 'menu');
                actionsButton.setAttribute('aria-expanded', 'false');
                actionsButton.addEventListener('click', handleAction(() => manage(item, actionsButton)));
                actionsButton.addEventListener('keydown', handleAction(event => {
                    // Native buttons must not also trigger the host's Enter-to-click shortcut.
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.stopPropagation();
                        return;
                    }
                    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                    event.preventDefault();
                    return manage(item, actionsButton, event.key === 'ArrowUp');
                }));
                const itemName = packNode('span', 'iig-packs-item-name', item.name);
                itemName.title = item.name;
                imageWrap.append(tile, actionsButton);
                itemRoot.append(imageWrap, itemName);
                grid.appendChild(itemRoot);
                if (item.thumbVersion < PACK_THUMB_VERSION) upgradeTargets.push({ item, image });
            }
            if (upgradeTargets.length > 0) {
                trackIigTask(upgradeVisibleThumbnails(upgradeTargets, revision, requestedPackId)).catch(reportFailure);
            }
        } finally {
            if (!disposed && revision === gridRevision && requestedPackId === activePackId) finishGrid();
        }
    };

    const renderPacks = async () => {
        closePhotoActions();
        const revision = ++packsRevision;
        gridRevision++;
        gridLoading = true;
        let listed;
        try {
            listed = await listPacksWithCounts();
        } catch (error) {
            if (disposed || revision !== packsRevision) return;
            iigLog('ERROR', 'Image Packs: pack list failed', error.message);
            setStatus(packT('storageFailed'));
            listed = [];
        }
        if (disposed || revision !== packsRevision) return;
        packs = listed;
        packSelect.replaceChildren();
        for (const pack of packs) {
            const option = document.createElement('option');
            option.value = pack.id;
            option.textContent = packT('packOption', { name: pack.name, count: pack.count || 0 });
            packSelect.appendChild(option);
        }
        if (!packs.some(pack => pack.id === activePackId)) {
            activePackId = packs[0]?.id || '';
            page = 0;
        }
        packSelect.value = activePackId;
        await renderGrid();
    };

    const choose = async item => {
        if (busy || gridLoading) return;
        setBusy(true);
        setStatus(packT('applying'));
        let ok = false;
        try {
            const asset = await getPackAssetBlob(item.id);
            if (disposed || _iigDisposed) return;
            const file = new File([asset.blob], asset.name || 'reference', { type: asset.type });
            ok = await onPick(file, item);
        } catch (error) {
            iigLog('ERROR', 'Image Packs: selection failed', error.message);
        }
        if (disposed) return;
        setBusy(false);
        if (ok) {
            setStatus(packT('applied'));
            await popup.complete(ctx.POPUP_RESULT.AFFIRMATIVE);
            return;
        }
        setStatus(packT('applyFailed'));
    };

    const openPhotoActions = async (item, trigger, last = false) => {
        const toggling = photoMenu?.trigger === trigger;
        closePhotoActions(toggling);
        const dlg = popup.dlg;
        if (toggling || !trigger.isConnected || !dlg?.open || dlg.hasAttribute('closing')) return '';

        const menu = packNode('div', 'iig-packs-actions-menu');
        menu.id = 'iig_packs_actions_menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', packT('photoActionsFor', { name: item.name }));
        const choices = [
            ['rename', 'fa-pen', packT('renamePhoto')],
            ['move', 'fa-arrow-right-arrow-left', packT('movePhoto')],
            ['delete', 'fa-trash-can', packT('deletePhoto')],
        ];
        const buttons = choices.map(([action, icon, label]) => {
            const button = packIconButton(`iig-packs-action-${action}`, icon, label);
            button.setAttribute('role', 'menuitem');
            button.tabIndex = -1;
            if (action === 'delete') button.classList.add('iig-packs-action-danger');
            menu.appendChild(button);
            return button;
        });

        const viewport = window.visualViewport;
        const rect = dlg.getBoundingClientRect();
        const originX = rect.left + dlg.clientLeft;
        const originY = rect.top + dlg.clientTop;
        const left = Math.max(originX, viewport?.offsetLeft ?? 0) + 8;
        const top = Math.max(originY, viewport?.offsetTop ?? 0) + 8;
        const right = Math.min(originX + dlg.clientWidth,
            viewport ? viewport.offsetLeft + viewport.width : document.documentElement.clientWidth) - 8;
        const bottom = Math.min(originY + dlg.clientHeight,
            viewport ? viewport.offsetTop + viewport.height : document.documentElement.clientHeight) - 8;
        if (right - left <= 16 || bottom - top <= 16) return '';
        menu.style.maxWidth = `${right - left}px`;
        menu.style.maxHeight = `${bottom - top}px`;
        menu.style.left = `${left - originX + dlg.scrollLeft}px`;
        menu.style.top = `${top - originY + dlg.scrollTop}px`;
        // Stay in the modal top layer, outside the clipped body and scrolling grid.
        dlg.appendChild(menu);
        const anchor = trigger.getBoundingClientRect();
        const size = menu.getBoundingClientRect();
        const x = Math.max(left, Math.min(anchor.right - size.width, right - size.width));
        const y = Math.max(top, Math.min(
            anchor.bottom + 4 + size.height <= bottom ? anchor.bottom + 4 : anchor.top - size.height - 4,
            bottom - size.height,
        ));
        menu.style.left = `${x - originX + dlg.scrollLeft}px`;
        menu.style.top = `${y - originY + dlg.scrollTop}px`;

        return new Promise(resolve => {
            const scope = new AbortController();
            const options = { signal: scope.signal };
            const capture = { ...options, capture: true };
            const close = (action = '', returnFocus = true) => {
                if (scope.signal.aborted) return;
                scope.abort();
                photoMenu = null;
                trigger.setAttribute('aria-expanded', 'false');
                trigger.removeAttribute('aria-controls');
                if (menu.contains(popup.lastFocus)) popup.lastFocus = trigger.isConnected ? trigger : heading;
                menu.remove();
                resolve(action);
                if (returnFocus && trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
            };
            photoMenu = { trigger, close };
            trigger.setAttribute('aria-expanded', 'true');
            trigger.setAttribute('aria-controls', menu.id);
            buttons.forEach((button, index) => {
                button.addEventListener('click', () => close(choices[index][0]), options);
            });
            dlg.addEventListener('keydown', event => {
                if (!menu.contains(event.target) && event.target !== trigger) return;
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    close();
                } else if (event.key === 'Enter' || event.key === ' ') {
                    event.stopPropagation();
                } else if (event.key === 'Tab') {
                    event.preventDefault();
                    event.stopPropagation();
                    // Continue from the tile's trigger, not the menu appended after the dialog controls.
                    const controls = [...dlg.querySelectorAll('button, select, input, textarea, a[href], [tabindex]')]
                        .filter(control => control.tabIndex >= 0 && !control.matches(':disabled')
                            && !menu.contains(control) && !control.closest('[inert]')
                            && control.getClientRects().length && getComputedStyle(control).visibility !== 'hidden');
                    const index = controls.indexOf(trigger);
                    const target = controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length];
                    close('', false);
                    (target || trigger).focus({ preventScroll: true });
                } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    const index = buttons.indexOf(document.activeElement);
                    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                        : index < 0 ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0)
                            : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
                    buttons[next].focus();
                }
            }, capture);
            // Intercept the host's cancel listener before it completes the parent Popup.
            dlg.addEventListener('cancel', event => {
                event.preventDefault();
                event.stopImmediatePropagation();
                close();
            }, capture);
            document.addEventListener('pointerdown', event => {
                if (!menu.contains(event.target) && !trigger.contains(event.target)) close('', false);
            }, capture);
            dlg.addEventListener('mousedown', event => {
                // Keep focus until click, including on hosts where pointer clicks do not focus buttons.
                if (event.button === 0 && (trigger.contains(event.target)
                    || (menu.contains(event.target) && event.target.closest('button')))) event.preventDefault();
            }, capture);
            dlg.addEventListener('focusout', event => {
                if ((menu.contains(event.target) || event.target === trigger)
                    && !menu.contains(event.relatedTarget) && event.relatedTarget !== trigger) close('', false);
            }, options);
            const onScroll = event => {
                if (!(event.target instanceof Node) || !menu.contains(event.target)) close();
            };
            window.addEventListener('scroll', onScroll, capture);
            window.addEventListener('resize', () => close(), options);
            viewport?.addEventListener('scroll', onScroll, options);
            viewport?.addEventListener('resize', () => close(), options);
            buttons[last ? buttons.length - 1 : 0].focus();
        });
    };

    const chooseMoveDestination = async sourcePackId => {
        const moveRoot = packNode('div', 'iig-packs-move-popup');
        const moveHeading = packNode('h3', 'iig-packs-actions-heading', packT('movePhoto'));
        moveHeading.id = 'iig_packs_move_title';
        const moveLabel = packNode('label', 'iig-packs-move-label', packT('movePhotoTo'));
        const moveSelect = packNode('select', 'text_pole iig-packs-move-select');
        moveSelect.id = 'iig_packs_move_destination';
        moveLabel.htmlFor = moveSelect.id;
        for (const pack of packs) {
            if (pack.id === sourcePackId) continue;
            const option = document.createElement('option');
            option.value = pack.id;
            option.textContent = packT('packOption', { name: pack.name, count: pack.count || 0 });
            moveSelect.appendChild(option);
        }
        const newOption = document.createElement('option');
        newOption.value = '__iig_new_pack__';
        newOption.textContent = packT('newDestination');
        moveSelect.appendChild(newOption);
        moveRoot.append(moveHeading, moveLabel, moveSelect);

        const movePopup = new ctx.Popup(moveRoot, ctx.POPUP_TYPE.TEXT, '', {
            okButton: packT('movePhoto'),
            cancelButton: packT('cancel'),
        });
        movePopup.dlg?.setAttribute('aria-labelledby', moveHeading.id);
        const result = await showNested(() => showIigPopup(movePopup));
        return result === ctx.POPUP_RESULT.AFFIRMATIVE ? moveSelect.value : '';
    };

    const runAssetMutation = async (work, successMessage, refreshPacks, changesStorage = false) => {
        setBusy(true);
        try {
            await work();
            if (disposed) return;
            if (changesStorage) markUsageStale();
            setStatus(successMessage);
            if (refreshPacks) await renderPacks();
            else await renderGrid();
        } catch (error) {
            iigLog('ERROR', 'Image Packs: image update failed', error.message);
            if (!disposed) setStatus(packT('updateFailed'));
        } finally {
            if (!disposed) setBusy(false);
        }
    };

    const manage = async (item, trigger, last = false) => {
        if (busy || gridLoading || !activePackId) return;
        const sourcePackId = activePackId;
        const revision = gridRevision;
        const packRevision = packsRevision;
        const action = await openPhotoActions(item, trigger, last);
        if (!action || disposed || _iigDisposed || busy || gridLoading || activePackId !== sourcePackId
            || revision !== gridRevision || packRevision !== packsRevision || !trigger.isConnected
            || !popup.dlg?.open || popup.dlg.hasAttribute('closing')) return;

        if (action === 'rename') {
            const name = await showNested(() => showIigInput(sanitizeForHtml(packT('renamePhoto')), sanitizeForHtml(packT('renamePhotoPrompt')), item.name));
            if (name === null || name === undefined || disposed) return;
            const clean = sanitizePackAssetName(name);
            if (!clean) {
                setStatus(packT('photoNameRequired'));
                return;
            }
            await runAssetMutation(
                () => renamePackAsset(item.id, sourcePackId, clean),
                packT('photoRenamed'),
                false,
            );
            return;
        }

        if (action === 'delete') {
            const confirmed = await showNested(() => showIigConfirm(
                sanitizeForHtml(packT('deletePhoto')),
                sanitizeForHtml(packT('deletePhotoConfirm', { name: item.name })),
            ));
            if (!confirmed || disposed) return;
            await runAssetMutation(
                () => deletePackAsset(item.id, sourcePackId),
                packT('photoDeleted'),
                true,
                true,
            );
            return;
        }

        const destinationId = await chooseMoveDestination(sourcePackId);
        if (!destinationId || disposed) return;
        if (destinationId === '__iig_new_pack__') {
            const name = await showNested(() => showIigInput(sanitizeForHtml(packT('newPack')), sanitizeForHtml(packT('newPackPrompt')), ''));
            if (name === null || name === undefined || disposed) return;
            const clean = sanitizePackName(name);
            if (!clean) {
                setStatus(packT('nameRequired'));
                return;
            }
            await runAssetMutation(
                () => createPackAndMoveAsset(item.id, sourcePackId, clean),
                packT('photoMoved', { name: clean }),
                true,
                true,
            );
            return;
        }

        const destination = packs.find(pack => pack.id === destinationId);
        if (!destination) {
            setStatus(packT('updateFailed'));
            return;
        }
        await runAssetMutation(
            () => movePackAsset(item.id, sourcePackId, destination.id),
            packT('photoMoved', { name: destination.name }),
            true,
        );
    };

    newButton.addEventListener('click', handleAction(async () => {
        if (busy) return;
        const name = await showNested(() => showIigInput(sanitizeForHtml(packT('newPack')), sanitizeForHtml(packT('newPackPrompt')), ''));
        if (name === null || name === undefined || disposed) return;
        if (!sanitizePackName(name)) {
            setStatus(packT('nameRequired'));
            return;
        }
        setBusy(true);
        try {
            const pack = await createPack(name);
            activePackId = pack.id;
            page = 0;
            markUsageStale();
            setStatus('');
            if (!disposed) await renderPacks();
        } catch (error) {
            iigLog('ERROR', 'Image Packs: create failed', error.message);
            if (!disposed) setStatus(packT('storageFailed'));
        } finally {
            if (!disposed) setBusy(false);
        }
    }));

    renameButton.addEventListener('click', handleAction(async () => {
        if (busy || !activePackId) return;
        const pack = packs.find(entry => entry.id === activePackId);
        if (!pack) return;
        const name = await showNested(() => showIigInput(sanitizeForHtml(packT('renamePack')), sanitizeForHtml(packT('renamePackPrompt')), pack.name));
        if (name === null || name === undefined || disposed) return;
        const clean = sanitizePackName(name);
        if (!clean) {
            setStatus(packT('nameRequired'));
            return;
        }
        setBusy(true);
        try {
            await renamePack(pack.id, clean);
            if (!disposed) {
                setStatus(packT('packRenamed'));
                await renderPacks();
            }
        } catch (error) {
            iigLog('ERROR', 'Image Packs: rename failed', error.message);
            if (!disposed) setStatus(packT('storageFailed'));
        } finally {
            if (!disposed) setBusy(false);
        }
    }));

    deleteButton.addEventListener('click', handleAction(async () => {
        if (busy || !activePackId) return;
        const pack = packs.find(entry => entry.id === activePackId);
        if (!pack) return;
        const count = pack.count || 0;
        const confirmed = await showNested(() => showIigConfirm(
            sanitizeForHtml(packT('deletePack')),
            sanitizeForHtml(packT('deletePackConfirm', { name: pack.name, count })),
        ));
        if (!confirmed || disposed) return;
        setBusy(true);
        try {
            await deletePack(pack.id);
            if (activePackId === pack.id) activePackId = '';
            page = 0;
            markUsageStale();
            setStatus('');
            if (!disposed) await renderPacks();
        } catch (error) {
            iigLog('ERROR', 'Image Packs: delete failed', error.message);
            if (!disposed) setStatus(packT('storageFailed'));
        } finally {
            if (!disposed) setBusy(false);
        }
    }));

    addButton.addEventListener('click', () => {
        if (busy || !activePackId) return;
        fileInput.click();
    });

    fileInput.addEventListener('change', handleAction(async event => {
        const files = [...(event.target.files || [])];
        event.target.value = '';
        if (busy || !files.length || !activePackId) return;
        const packId = activePackId;
        const crop = getSettings().cropOnUpload ? file => showNested(async () => {
            const result = await cropRefUpload(file);
            return disposed || activePackId !== packId ? null : result;
        }) : null;
        setBusy(true);
        setStatus(packT('importing', { done: 0, total: files.length }));
        try {
            let added = 0;
            let done = 0;
            const reasons = new Set();
            for (const file of files) {
                if (disposed || _iigDisposed || activePackId !== packId) return;
                let reason;
                try {
                    reason = await importPackFile(packId, file, crop);
                } catch (error) {
                    if (disposed || _iigDisposed) return;
                    iigLog('ERROR', 'Image Packs: import failed', error.message);
                    reason = error?.name === 'QuotaExceededError' ? 'quota' : 'store';
                }
                if (reason) reasons.add(reason);
                else added++;
                if (disposed) return;
                setStatus(packT('importing', { done: ++done, total: files.length }));
            }
            if (disposed) return;
            if (added > 0) markUsageStale();
            const skipped = files.length - added;
            if (skipped === 0) setStatus(packT('imported', { count: added }));
            else if (added === 0) setStatus(packT('importedNone', { skipped }));
            else setStatus(packT('importedSome', { count: added, skipped }));
            if (reasons.has('quota')) {
                toastr.error(sanitizeForHtml(packT('quotaExceeded')), sanitizeForHtml(packT('title')), { escapeHtml: false });
            } else if (reasons.has('store')) {
                toastr.error(sanitizeForHtml(packT('storageFailed')), sanitizeForHtml(packT('title')), { escapeHtml: false });
            } else if (reasons.has('size')) {
                toastr.warning(sanitizeForHtml(packT('rejectedSize', { max: formatRefStorageSize(PACK_MAX_BYTES) })), sanitizeForHtml(packT('title')), { escapeHtml: false });
            } else if (reasons.has('type') || reasons.has('decode')) {
                toastr.warning(sanitizeForHtml(packT('rejectedType')), sanitizeForHtml(packT('title')), { escapeHtml: false });
            }
            await renderPacks();
        } catch (error) {
            iigLog('ERROR', 'Image Packs: import batch failed', error.message);
            if (!disposed) setStatus(packT('storageFailed'));
        } finally {
            if (!disposed) setBusy(false);
        }
    }));

    packSelect.addEventListener('change', handleAction(async () => {
        activePackId = packSelect.value;
        page = 0;
        setStatus('');
        await renderGrid();
    }));

    sortSelect.addEventListener('change', handleAction(async () => {
        _packsSort = normalizePackSort(sortSelect.value);
        page = 0;
        await renderGrid();
    }));

    storageButton.addEventListener('click', handleAction(async () => {
        if (busy) return;
        setBusy(true);
        usageStatus.textContent = packT('checkingStorage');
        try {
            const usage = await measurePacksStorage();
            if (disposed) return;
            usageMeasured = true;
            usageStatus.textContent = packT('storageSummary', {
                packs: usage.packCount,
                images: usage.imageCount,
                size: formatRefStorageSize(usage.totalBytes),
            });
        } catch (error) {
            iigLog('ERROR', 'Image Packs: storage measurement failed', error.message);
            if (!disposed) {
                usageMeasured = false;
                usageStatus.textContent = packT('storageMeasureFailed');
            }
        } finally {
            if (!disposed) setBusy(false);
        }
    }));

    prevButton.addEventListener('click', handleAction(async () => {
        if (busy || gridLoading || page === 0) return;
        page--;
        await renderGrid();
    }));

    nextButton.addEventListener('click', handleAction(async () => {
        if (busy || gridLoading || page >= pages - 1) return;
        page++;
        await renderGrid();
    }));

    const popup = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        okButton: packT('close'),
        cancelButton: false,
        onClosing: () => {
            closePhotoActions();
            if (!busy) return true;
            busyNotice.textContent = packT('busyClose');
            return false;
        },
    });
    popup.dlg?.setAttribute('aria-labelledby', heading.id);
    popup.okButton?.setAttribute('aria-describedby', busyNotice.id);

    _packsPopupOpen = true;
    try {
        await showIigPopup(popup, renderPacks, () => {
            disposed = true;
            closePhotoActions(false);
            releaseObjectUrls();
        });
    } finally {
        disposed = true;
        closePhotoActions(false);
        releaseObjectUrls();
        _packsPopupOpen = false;
    }
}

async function cropRefUpload(file) {
    const rawBase64 = await readIigBase64(file);
    // Crop an upright, reference-resolution preview, not the full-size camera image.
    const preview = await compressBase64Image(rawBase64, 768, 0.8);
    throwIfSignalAborted();
    const ctx = getContext();
    const popup = new ctx.Popup(sanitizeForHtml(iigT('iig_cropTitle')), ctx.POPUP_TYPE.CROP, '', {
        cropImage: `data:image/jpeg;base64,${preview}`,
        cropAspect: NaN,
    });
    const cropper = $(popup.cropImage).data('cropper');
    const image = cropper?.image;
    let sizingImage;
    let finished = false;
    let fail;
    const failure = new Promise(resolve => {
        fail = () => {
            if (finished) return;
            finished = true;
            popup.okButton.setAttribute('aria-disabled', 'true');
            resolve(iigError('Could not crop the image', 'iig_cropFailed'));
        };
    });
    const show = popup.show;
    popup.show = () => Promise.race([show.call(popup), failure.then(error => { throw error; })]);
    const complete = popup.complete;
    // Host exports before onClosing, and its div controls do not honor disabled.
    popup.complete = async result => {
        if (finished || (result >= ctx.POPUP_RESULT.AFFIRMATIVE && (!cropper?.ready || _iigDisposed))) return;
        try {
            const closing = complete.call(popup, result);
            finished = true;
            return await closing;
        } catch (_) {
            finished = false;
            fail();
        }
    };
    const onReady = () => {
        if (!finished) popup.okButton.setAttribute('aria-disabled', String(!cropper?.ready));
    };
    const onLoad = () => {
        sizingImage?.removeEventListener('error', fail);
        sizingImage = cropper?.sizingImage;
        sizingImage?.addEventListener('error', fail);
    };
    popup.cropImage.addEventListener('ready', onReady);
    popup.dlg.addEventListener('error', fail, true);
    image?.addEventListener('load', onLoad);
    onReady();
    onLoad();
    try {
        const result = await showIigPopup(popup);
        if (result == null || _iigDisposed) return null;
        const cropped = typeof result === 'string' && result.match(/^data:image\/jpeg;base64,(.+)$/);
        if (!cropped) throw iigError('Could not crop the image', 'iig_cropFailed');
        return cropped[1];
    } finally {
        finished = true;
        popup.cropImage.removeEventListener('ready', onReady);
        popup.dlg.removeEventListener('error', fail, true);
        image?.removeEventListener('load', onLoad);
        sizingImage?.removeEventListener('error', fail);
        // The host removes the dialog but leaves Cropper's document listeners alive.
        cropper?.destroy();
    }
}

/** Returns the saved path, or null on crop cancellation/staleness. Other failures throw. */
async function uploadRefFileToSlot(slot, refType, npcIndex, file, { crop = false, packAssetId = '' } = {}) {
    throwIfSignalAborted();
    if (!slot || !file) throw iigError('No file provided', 'iig_noFile');
    if (_refFolderClearInProgress) throw iigError('Reference folder is being cleared', 'iig_refFolderClearing');

    const scopeSettings = getSettings();
    const scopeContext = getContext();
    const scopeHandle = getActiveRefScope();
    const mutation = slot._iigRefMutation = Symbol();
    const originalRef = refType === 'npc' ? scopeHandle.container.npcReferences[npcIndex]
        : scopeHandle.container[`${refType}Ref`];
    const originalState = originalRef && [originalRef.name, originalRef.imagePath, originalRef.imageBase64, originalRef.imageData, originalRef.packAssetId];
    const isCurrent = () => {
        if (_iigDisposed || slot._iigRefMutation !== mutation || _refFolderClearInProgress || slot.isConnected === false || !isRefScopeStateCurrent(scopeHandle)) return false;
        if (resolveRefScopeState(getSettings(), getContext()).container !== scopeHandle.container) return false;
        const ref = refType === 'npc' ? scopeHandle.container.npcReferences[npcIndex]
            : scopeHandle.container[`${refType}Ref`];
        return ref === originalRef && (!ref || [ref.name, ref.imagePath, ref.imageBase64, ref.imageData, ref.packAssetId]
            .every((value, index) => value === originalState[index]));
    };
    const rawBase64 = crop ? await cropRefUpload(file) : await readIigBase64(file);
    if (rawBase64 === null || !isCurrent()) return null;
    const compressed = await compressBase64Image(rawBase64, 768, 0.8);
    const label = refType === 'npc' ? `npc${npcIndex}` : refType;
    const currentTypedName = slot.querySelector('.iig-ref-name')?.value?.trim() || '';
    const nameSlug = sanitizeRefNameForFilename(currentTypedName);
    const customFilename = nameSlug ? await pickUniqueRefFilename(refType, nameSlug) : null;
    if (!isCurrent()) return null;
    const savedPath = await saveRefImageToFile(compressed, label, customFilename);
    if (!isCurrent()) {
        if (!_iigDisposed) await deleteRefFileOnServer(savedPath);
        return null;
    }
    Object.assign(scopeHandle, resolveRefScopeState(scopeSettings, scopeContext, { forWrite: true }));

    const refs = scopeHandle.container;
    let prevPath = '';
    if (refType === 'char') {
        prevPath = refs.charRef.imagePath || '';
        refs.charRef.imageBase64 = '';
        refs.charRef.imagePath = savedPath;
    } else if (refType === 'user') {
        prevPath = refs.userRef.imagePath || '';
        refs.userRef.imageBase64 = '';
        refs.userRef.imagePath = savedPath;
    } else if (refType === 'npc') {
        if (!refs.npcReferences[npcIndex]) refs.npcReferences[npcIndex] = { name: '', imageBase64: '', imagePath: '' };
        prevPath = refs.npcReferences[npcIndex].imagePath || '';
        refs.npcReferences[npcIndex].imageBase64 = '';
        refs.npcReferences[npcIndex].imagePath = savedPath;
    }
    const assignedRef = refType === 'npc' ? refs.npcReferences[npcIndex] : refs[`${refType}Ref`];
    assignedRef.packAssetId = typeof packAssetId === 'string' ? packAssetId : '';
    if ('imageData' in assignedRef) assignedRef.imageData = '';
    if (prevPath && prevPath !== savedPath) invalidateRefB64Cache(prevPath);
    invalidateRefB64Cache(savedPath);
    saveActiveRefs(scopeHandle);

    const thumb = slot.querySelector('.iig-ref-thumb');
    if (thumb) thumb.src = savedPath;
    const thumbWrap = slot.querySelector('.iig-ref-thumb-wrap');
    if (thumbWrap) thumbWrap.classList.add('has-image');
    markRefStorageUsageStale();
    return savedPath;
}

/** Wire name/upload/delete handlers for all 6 ref slots (char, user, 4 NPCs). */
function bindRefSlotEvents() {
    const allSlots = document.querySelectorAll('.iig-ref-slot');

    for (const slot of allSlots) {
        const refType = slot.dataset.refType;
        const npcIndex = parseInt(slot.dataset.npcIndex, 10);

        const nameInput = slot.querySelector('.iig-ref-name');
        let nameEditScope = null;
        bindIig(nameInput, 'input', (e) => {
            const current = getActiveRefScope().container;
            const ref = refType === 'npc' ? current.npcReferences[npcIndex] : current[`${refType}Ref`];
            if ((ref?.name || '') === e.target.value) return;
            slot._iigRefMutation = Symbol();
            const scopeHandle = getActiveRefScope({ forWrite: true });
            nameEditScope = scopeHandle;
            const s = scopeHandle.container;
            if (refType === 'char') {
                s.charRef.name = e.target.value;
            } else if (refType === 'user') {
                s.userRef.name = e.target.value;
            } else if (refType === 'npc') {
                if (!s.npcReferences[npcIndex]) s.npcReferences[npcIndex] = { name: '', imageBase64: '', imagePath: '', packAssetId: '' };
                s.npcReferences[npcIndex].name = e.target.value;
            }
            saveActiveRefs(scopeHandle);
        });

        // Rename-on-blur: download and re-upload under the matching slug.
        // Skipped if filename already matches iig_ref_<refType>_<slug>(_N)?.jpeg.
        // Failures are silent (log-only); the old file keeps working.
        let _renameInProgress = false;
        bindIig(nameInput, 'blur', async () => {
            if (_renameInProgress || _refFolderClearInProgress) return;
            const scopeHandle = nameEditScope;
            nameEditScope = null;
            if (!scopeHandle || !isRefScopeStateCurrent(scopeHandle)) return;
            const s = scopeHandle.container;
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

            // Recognize both older collision suffixes and unique upload names.
            const expectedPrefix = `iig_ref_${refType}_${nameSlug}`;
            if (currentFilename === `${expectedPrefix}.jpeg`) return;
            const escapedPrefix = expectedPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const collisionForm = new RegExp(`^${escapedPrefix}_(?:\\d+|u[0-9a-f]{32})\\.jpeg$`);
            if (collisionForm.test(currentFilename)) return;

            _renameInProgress = true;
            const mutation = slot._iigRefMutation = Symbol();
            const isCurrent = () => !_iigDisposed && slot.isConnected !== false
                && slot._iigRefMutation === mutation && isRefScopeStateCurrent(scopeHandle)
                && (refType === 'npc' ? scopeHandle.container.npcReferences[npcIndex] : scopeHandle.container[`${refType}Ref`]) === slotRef
                && slotRef.imagePath === currentPath && slotRef.name.trim() === currentName;
            iigLog('INFO', `Renaming ref file to match name "${currentName}": ${currentFilename} → iig_ref_${refType}_${nameSlug}_u….jpeg`);

            try {
                const newFilename = await pickUniqueRefFilename(refType, nameSlug);

                const currentB64 = await loadRefImageAsBase64(currentPath);
                if (!currentB64) {
                    iigLog('WARN', 'Rename aborted: could not load current file');
                    return;
                }

                const label = refType === 'npc' ? `npc${npcIndex}` : refType;
                if (!isCurrent()) return;
                const newPath = await saveRefImageToFile(currentB64, label, newFilename);

                if (!isCurrent()) {
                    if (!_iigDisposed) await deleteRefFileOnServer(newPath);
                    return;
                }

                slotRef.imagePath = newPath;
                invalidateRefB64Cache(currentPath);
                invalidateRefB64Cache(newPath);
                saveActiveRefs(scopeHandle);

                const thumb = slot.querySelector('.iig-ref-thumb');
                if (thumb) thumb.src = newPath;
                markRefStorageUsageStale();

                iigLog('INFO', `Rename complete: ${newPath}`);
            } catch (e) {
                iigLog('ERROR', `Rename failed: ${e.message}`);
            } finally {
                _renameInProgress = false;
            }
        });

        const fileInput = slot.querySelector('.iig-ref-file-input');
        const fileHandler = async (e) => {
            const file = e.target.files?.[0];
            if (!file || _refFolderClearInProgress) return;
            const label = refType === 'npc' ? `npc${npcIndex}` : refType;
            try {
                const savedPath = await uploadRefFileToSlot(slot, refType, npcIndex, file, { crop: getSettings().cropOnUpload });
                if (savedPath === null || _iigDisposed) return;
                clearPackedRefSlotAppearance(slot);
                iigLog('INFO', `Ref slot ${label}: saved to ${savedPath}`);
                toastr.success(sanitizeForHtml(iigT('iig_photoSaved')), sanitizeForHtml(iigT('iig_title')), { timeOut: 2000, escapeHtml: false });
            } catch (err) {
                if (_iigDisposed || err?.name === 'AbortError') return;
                iigLog('ERROR', `Ref slot ${label}: upload failed`, err.message);
                toastr.error(sanitizeForHtml(iigT('iig_photoUploadFailed', { error: iigErrorText(err) })), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
            } finally {
                e.target.value = '';
            }
        };
        bindIig(fileInput, 'change', fileHandler);

        const packsBtn = slot.querySelector('.iig-ref-packs-btn');
        bindIig(packsBtn, 'click', () => {
            if (_refFolderClearInProgress) return;
            const label = refType === 'npc' ? `npc${npcIndex}` : refType;
            return openImagePacksPopup(async (file, item) => {
                try {
                    const savedPath = await uploadRefFileToSlot(slot, refType, npcIndex, file, { packAssetId: item.id });
                    if (!savedPath || _iigDisposed) return false;
                    setPackedRefSlotAppearance(slot, item);
                    toastr.success(sanitizeForHtml(iigT('iig_photoSaved')), sanitizeForHtml(iigT('iig_title')), { timeOut: 2000, escapeHtml: false });
                    return true;
                } catch (err) {
                    iigLog('ERROR', `Ref slot ${label}: pack upload failed`, err.message);
                    return false;
                }
            }).catch(error => {
                iigLog('ERROR', 'Image Packs: popup failed', error);
                toastr.error(sanitizeForHtml(packT('storageFailed')), sanitizeForHtml(packT('title')), { escapeHtml: false });
            });
        });

        const deleteBtn = slot.querySelector('.iig-ref-delete-btn');
        bindIig(deleteBtn, 'click', () => {
            if (_refFolderClearInProgress) return;
            slot._iigRefMutation = Symbol();
            nameEditScope = null;
            const scopeHandle = getActiveRefScope({ forWrite: true });
            const s = scopeHandle.container;
            let prevPath = '';
            if (refType === 'char') {
                prevPath = s.charRef?.imagePath || '';
                s.charRef = { name: '', imageBase64: '', imagePath: '', packAssetId: '' };
            } else if (refType === 'user') {
                prevPath = s.userRef?.imagePath || '';
                s.userRef = { name: '', imageBase64: '', imagePath: '', packAssetId: '' };
            } else if (refType === 'npc') {
                prevPath = s.npcReferences[npcIndex]?.imagePath || '';
                s.npcReferences[npcIndex] = { name: '', imageBase64: '', imagePath: '', packAssetId: '' };
            }
            if (prevPath) invalidateRefB64Cache(prevPath);
            saveActiveRefs(scopeHandle);

            const thumb = slot.querySelector('.iig-ref-thumb');
            if (thumb) thumb.src = '';
            const thumbWrap = slot.querySelector('.iig-ref-thumb-wrap');
            if (thumbWrap) thumbWrap.classList.remove('has-image');
            clearPackedRefSlotAppearance(slot);
            const nameEl = slot.querySelector('.iig-ref-name');
            if (nameEl) nameEl.value = '';

            const label = refType === 'npc' ? `NPC ${npcIndex + 1}` : refType;
            iigLog('INFO', `Ref slot ${label}: cleared`);
            toastr.info(sanitizeForHtml(iigT('iig_slotCleared')), sanitizeForHtml(iigT('iig_title')), { timeOut: 2000, escapeHtml: false });

        });
    }
}

/**
 * Detect whether the ST-ImageManager extension is installed, so we can show
 * an optional launcher. Two independent signals; either is sufficient.
 */
function isImageManagerInstalled() {
    try {
        if (document.getElementById('im_wand_button')) return true;
        const ctx = getContext();
        const cmds = ctx?.SlashCommandParser?.commands;
        if (cmds && (cmds['image-manager'] || cmds['im'])) return true;
    } catch (_) {}
    return false;
}

/** Run a slash command defensively across ST API variants (no-op if unavailable). */
function runSlashCommand(text) {
    try {
        const ctx = getContext();
        if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
            ctx.executeSlashCommandsWithOptions(text);
            return true;
        }
        if (typeof ctx.executeSlashCommands === 'function') {
            ctx.executeSlashCommands(text);
            return true;
        }
    } catch (e) {
        iigLog('WARN', `runSlashCommand failed: ${e.message}`);
    }
    return false;
}

/** Wire up all settings-panel event handlers and visibility toggles. */
function bindSettingsEvents() {
    const settings = getSettings();

    const updateVisibility = () => {
        const apiType = settings.apiType;
        const isNaistera = apiType === 'naistera';
        const isGemini = apiType === 'gemini';
        const isOpenAI = apiType === 'openai';

        document.getElementById('iig_naistera_hint')?.classList.toggle('iig-hidden', !isNaistera);

        // Model row hidden for Naistera — it uses its own dropdown below.
        document.getElementById('iig_model_row')?.classList.toggle('iig-hidden', isNaistera);
        document.getElementById('iig_test_connection')?.classList.toggle('iig-hidden', !isNaistera);

        const novelAiModel = isOpenAI && isRoutMyNovelAiModel(settings.model);
        document.getElementById('iig_size_row')?.classList.toggle('iig-hidden', !isOpenAI || novelAiModel);
        document.getElementById('iig_quality_row')?.classList.toggle('iig-hidden', !isOpenAI || novelAiModel);
        document.getElementById('iig_quality_hint')?.classList.toggle('iig-hidden', !isOpenAI || novelAiModel);

        document.getElementById('iig_naistera_model_row')?.classList.toggle('iig-hidden', !isNaistera);
        // Presets apply to the Grok family; other Naistera upstreams ignore the field.
        const presetAllowed = isNaistera && naisteraModelSupportsPreset(settings.naisteraModel);
        document.getElementById('iig_naistera_preset_row')?.classList.toggle('iig-hidden', !presetAllowed);
        document.getElementById('iig_naistera_preset_hint')?.classList.toggle('iig-hidden', !presetAllowed);
        const refsAllowed = isNaistera && naisteraModelSupportsReferences(settings.naisteraModel);
        document.getElementById('iig_naistera_refs_row')?.classList.toggle('iig-hidden', !refsAllowed);
        document.getElementById('iig_naistera_refs_hint')?.classList.toggle('iig-hidden', !refsAllowed);

        document.getElementById('iig_gemini_params')?.classList.toggle('iig-hidden', !isGemini);

        const endpointInput = document.getElementById('iig_endpoint');
        if (endpointInput) {
            if (isOpenAI || isGemini) {
                endpointInput.dataset.i18n = '[placeholder]iig_ui_endpointPlaceholder';
                endpointInput.placeholder = iigT('iig_ui_endpointPlaceholder');
            } else {
                // The host observer cannot handle removal of data-i18n.
                endpointInput.dataset.i18n = '';
                endpointInput.placeholder = isNaistera ? 'https://naistera.org' : 'https://your-provider.example';
            }
        }

        const infoEl = document.getElementById('iig_api_type_info');
        if (infoEl) {
            const hintKey = { openai: 'iig_ui_apiOpenaiHint', gemini: 'iig_ui_apiGeminiHint', naistera: 'iig_ui_apiNaisteraHint' }[apiType];
            infoEl.dataset.i18n = `[aria-label]iig_ui_apiTypeInfo${hintKey ? `;[title]${hintKey}` : ''}`;
            infoEl.setAttribute('title', hintKey ? iigT(hintKey) : '');
        }

        document.getElementById('iig_refs_section')?.classList.remove('iig-hidden');
    };

    bindIig(document.getElementById('iig_pm_connection'), 'change', event => {
        const pm = promptModelSettings();
        const next = event.currentTarget.value === 'gemini' ? 'gemini' : 'default';
        if (pm.connection !== next) {
            abortAllPromptModelRequests('connection-changed');
            clearProviderQuirks('prompt-connection-changed');
        }
        pm.connection = next;
        saveSettings();
        refreshPromptModelUI();
    });

    const bindGeminiField = (id, field) => {
        bindIig(document.getElementById(id), 'input', event => {
            const config = promptModelGeminiSettings();
            if (config[field] !== event.currentTarget.value) {
                clearProviderQuirks('prompt-gemini-field-changed');
                if (field !== 'model') updateModelCatalog('iig_pm_gemini_model', []);
            }
            config[field] = event.currentTarget.value;
            if (config.activePresetName) {
                config.activePresetName = '';
                refreshPromptModelGeminiPresetSelect();
                toastr.info(sanitizeForHtml(iigT('iig_ui_geminiPresetDetached')), sanitizeForHtml(iigT('iig_ui_promptModelTitle')), { escapeHtml: false });
            }
            saveSettings();
            if (field === 'model') refreshPromptModelStatus();
        });
    };
    bindGeminiField('iig_pm_gemini_endpoint', 'endpoint');
    bindGeminiField('iig_pm_gemini_key', 'apiKey');
    bindGeminiField('iig_pm_gemini_model', 'model');

    bindIig(document.getElementById('iig_pm_gemini_key_toggle'), 'click', event => {
        const input = document.getElementById('iig_pm_gemini_key');
        if (!input) return;
        const visible = input.type === 'password';
        input.type = visible ? 'text' : 'password';
        event.currentTarget.setAttribute('aria-pressed', String(visible));
        const icon = event.currentTarget.querySelector('i');
        icon?.classList.toggle('fa-eye', !visible);
        icon?.classList.toggle('fa-eye-slash', visible);
    });

    bindIig(document.getElementById('iig_pm_gemini_refresh_models'), 'click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.classList.add('loading');
        try {
            const models = await refreshPromptModelGeminiCatalog();
            if (!models.length) toastr.warning(sanitizeForHtml(iigT('iig_ui_modelCatalogEmpty')), sanitizeForHtml(iigT('iig_ui_promptModelTitle')), { escapeHtml: false });
        } catch (error) {
            toastr.warning(sanitizeForHtml(iigT('iig_ui_modelsLoadFailed', { detail: iigErrorText(error) })), sanitizeForHtml(iigT('iig_ui_promptModelTitle')), { escapeHtml: false });
        } finally {
            button.disabled = false;
            button.classList.remove('loading');
        }
    });

    bindIig(document.getElementById('iig_pm_gemini_test'), 'click', async event => {
        const button = event.currentTarget;
        if (button.classList.contains('testing')) return;
        const icon = button.querySelector('i');
        const originalIcon = icon.className;
        button.disabled = true;
        button.classList.add('testing');
        icon.className = 'fa-solid fa-spinner';
        try {
            const result = await testPromptModelGeminiConnection();
            toastr.success(sanitizeForHtml(pmT(result?.caveat || 'connectionOk')), sanitizeForHtml(iigT('iig_ui_promptModelTitle')), { escapeHtml: false });
            button.classList.add('test-success');
            setIigTimeout(() => button.classList.remove('test-success'), 700);
        } catch (error) {
            toastr.error(sanitizeForHtml(iigT('iig_ui_connectionFailed', { detail: iigErrorText(error) })), sanitizeForHtml(iigT('iig_ui_promptModelTitle')), { escapeHtml: false });
            button.classList.add('test-fail');
            setIigTimeout(() => button.classList.remove('test-fail'), 700);
        } finally {
            button.classList.remove('testing');
            button.disabled = false;
            icon.className = originalIcon;
        }
    });

    bindIig(document.getElementById('iig_pm_gemini_preset'), 'change', event => {
        const config = promptModelGeminiSettings();
        const name = event.currentTarget.value;
        if (!name) {
            config.activePresetName = '';
            saveSettings();
            return;
        }
        const preset = findPromptModelGeminiPreset(config, name);
        if (!preset) {
            toastr.error(sanitizeForHtml(iigT('iig_ui_geminiPresetMissing')), sanitizeForHtml(iigT('iig_ui_promptModelTitle')), { escapeHtml: false });
            refreshPromptModelGeminiPresetSelect();
            return;
        }
        abortAllPromptModelRequests('connection-changed');
        clearProviderQuirks('prompt-gemini-preset-changed');
        const sameConnection = config.endpoint === preset.endpoint && config.apiKey === preset.apiKey;
        applyPromptModelGeminiPreset(config, preset);
        config.activePresetName = preset.name;
        updateModelCatalog('iig_pm_gemini_model', config.model ? [config.model] : [], false, sameConnection);
        saveSettings();
        refreshPromptModelUI();
    });

    bindIig(document.getElementById('iig_pm_gemini_save'), 'click', () => {
        const config = promptModelGeminiSettings();
        try {
            resolvePromptModelGeminiConfig();
        } catch (error) {
            toastr.warning(sanitizeForHtml(iigT('iig_ui_geminiPresetInvalid', { detail: iigErrorText(error) })), sanitizeForHtml(iigT('iig_ui_promptModelTitle')), { escapeHtml: false });
            return;
        }
        let name = (window.prompt(iigT('iig_ui_presetNamePrompt'), config.activePresetName || '') || '').trim();
        if (!name) return;
        // Preserve legacy names and exact-case duplicates when updating a saved entry.
        const existing = findPromptModelGeminiPreset(config, name) || findPromptModelGeminiPreset(config, name.slice(0, 64));
        name = existing?.name || name.slice(0, 64).trim();
        const snapshot = { name, ...snapshotPromptModelGeminiConfig(config) };
        if (existing) {
            if (!window.confirm(iigT('iig_ui_presetOverwriteConfirm', { name }))) return;
            config.presets[config.presets.indexOf(existing)] = snapshot;
        } else {
            if (config.presets.length >= 20) {
                toastr.warning(sanitizeForHtml(pmT('presetLimit')), sanitizeForHtml(pmT('title')), { escapeHtml: false });
                return;
            }
            config.presets.push(snapshot);
        }
        config.activePresetName = name;
        saveSettings({ sync: true });
        refreshPromptModelGeminiPresetSelect();
        toastr.success(sanitizeForHtml(iigT('iig_ui_geminiPresetSaved', { name })), sanitizeForHtml(iigT('iig_ui_promptModelTitle')), { escapeHtml: false });
    });

    bindIig(document.getElementById('iig_pm_gemini_delete'), 'click', () => {
        const config = promptModelGeminiSettings();
        const preset = findPromptModelGeminiPreset(config, document.getElementById('iig_pm_gemini_preset')?.value);
        if (!preset) {
            toastr.info(sanitizeForHtml(iigT('iig_ui_selectGeminiPresetToDelete')), sanitizeForHtml(iigT('iig_ui_promptModelTitle')), { escapeHtml: false });
            return;
        }
        const name = preset.name;
        if (!window.confirm(iigT('iig_ui_deleteGeminiPresetConfirm', { name }))) return;
        if (findPromptModelGeminiPreset(config, config.activePresetName) === preset) config.activePresetName = '';
        config.presets.splice(config.presets.indexOf(preset), 1);
        saveSettings({ sync: true });
        refreshPromptModelGeminiPresetSelect();
        toastr.info(sanitizeForHtml(iigT('iig_ui_geminiPresetDeleted', { name })), sanitizeForHtml(iigT('iig_ui_promptModelTitle')), { escapeHtml: false });
    });

    bindIig(document.getElementById('iig_pm_enabled'), 'change', async (event) => {
        const toggle = event.currentTarget;
        toggle.disabled = true;
        try {
            await setPromptModelEnabled(toggle.checked);
        } finally {
            toggle.disabled = !isPromptModelAvailable();
            toggle.checked = promptModelSettings().enabled && isPromptModelAvailable();
        }
    });

    bindIig(document.getElementById('iig_pm_model'), 'input', event => {
        promptModelSettings().model = event.currentTarget.value;
        saveSettings();
    });

    bindIig(document.getElementById('iig_pm_refresh_models'), 'click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try { await refreshPromptModelCatalog(); }
        finally { button.disabled = false; }
    });

    const commitPromptTag = event => {
        const pm = promptModelSettings();
        pm.tag = normalizePromptTag(event.currentTarget.value);
        event.currentTarget.value = pm.tag;
        saveSettings();
        refreshPromptModelUI();
    };
    bindIig(document.getElementById('iig_pm_tag'), 'change', commitPromptTag);
    bindIig(document.getElementById('iig_pm_tag'), 'blur', commitPromptTag);
    bindIig(document.getElementById('iig_pm_tag_reset'), 'click', () => {
        const input = document.getElementById('iig_pm_tag');
        promptModelSettings().tag = PROMPT_MODEL_TAG_DEFAULT;
        if (input) input.value = PROMPT_MODEL_TAG_DEFAULT;
        saveSettings();
        refreshPromptModelUI();
    });

    bindIig(document.getElementById('iig_pm_import'), 'click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.classList.add('busy');
        try { await openPromptModelImportPopup(); }
        finally {
            button.disabled = false;
            button.classList.remove('busy');
        }
    });
    
    bindIig(document.getElementById('iig_enabled'), 'change', (e) => {
        settings.enabled = e.target.checked;
        if (!settings.enabled) abortAllPromptModelRequests('extension-disabled');
        saveSettings();
        updateHeaderStatusDot();
    });

    bindIig(document.getElementById('iig_prompt_driven'), 'change', (e) => {
        settings.promptDriven = e.target.checked;
        saveSettings();
    });

    // Low-power toggles. Master greys out the subs when off.
    bindIig(document.getElementById('iig_low_power'), 'change', (e) => {
        settings.lowPowerMode = e.target.checked;
        const animEl = document.getElementById('iig_lp_anim');
        const slowEl = document.getElementById('iig_lp_slow');
        if (animEl) animEl.disabled = !e.target.checked;
        if (slowEl) slowEl.disabled = !e.target.checked;
        saveSettings();
        applyLowPowerMode();
    });
    bindIig(document.getElementById('iig_lp_anim'), 'change', (e) => {
        settings.lpDisableAnimations = e.target.checked;
        saveSettings();
        applyLowPowerMode();
    });
    bindIig(document.getElementById('iig_lp_slow'), 'change', (e) => {
        settings.lpSlowUpdates = e.target.checked;
        saveSettings();
    });
    
    bindIig(document.getElementById('iig_api_type'), 'change', (e) => {
        const nextApiType = e.target.value;
        const endpointInput = document.getElementById('iig_endpoint');

        // Auto-swap endpoint when switching to Naistera from an incompatible URL.
        if (shouldReplaceEndpointForApiType(nextApiType, settings.endpoint)) {
            settings.endpoint = normalizeConfiguredEndpoint(nextApiType, '');
            if (endpointInput) endpointInput.value = settings.endpoint;
        } else if (nextApiType === 'naistera') {
            settings.endpoint = normalizeConfiguredEndpoint(nextApiType, settings.endpoint);
            if (endpointInput) endpointInput.value = settings.endpoint;
        }

        settings.apiType = nextApiType;
        invalidateImageModelCatalog();
        clearProviderQuirks('apiType changed');
        saveSettings();
        updateVisibility();
    });
    
    bindIig(document.getElementById('iig_endpoint'), 'input', (e) => {
        settings.endpoint = normalizeConfiguredEndpoint(settings.apiType, e.target.value);
        invalidateImageModelCatalog();
        // Fires per keystroke; Map.clear() on an empty map is a no-op and
        // clearProviderQuirks returns early, so this is free while typing.
        clearProviderQuirks('endpoint changed');
        // Debounced reflect of the normalized value (avoids cursor jumping).
        clearIigTimeout(e.target._normalizeTimer);
        e.target._normalizeTimer = setIigTimeout(() => {
            if (e.target.value !== settings.endpoint) {
                e.target.value = settings.endpoint;
            }
        }, 1500);
        saveSettings();
    });
    
    bindIig(document.getElementById('iig_api_key'), 'input', (e) => {
        settings.apiKey = e.target.value;
        invalidateImageModelCatalog();
        saveSettings();
    });
    
    bindIig(document.getElementById('iig_key_toggle'), 'click', () => {
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
    
    bindIig(document.getElementById('iig_model'), 'input', (e) => {
        settings.model = e.target.value;
        saveSettings();
        updateVisibility();
    });
    bindModelPicker('iig_model');
    bindModelPicker('iig_pm_model');
    bindModelPicker('iig_pm_gemini_model');
    updateModelCatalog('iig_pm_gemini_model', promptModelGeminiSettings().model ? [promptModelGeminiSettings().model] : []);
    
    bindIig(document.getElementById('iig_refresh_models'), 'click', async (e) => {
        const btn = e.currentTarget;
        const request = btn._iigCatalogRequest = Symbol();
        const captured = { ...getSettings() };
        const isCurrent = () => !_iigDisposed && btn.isConnected && btn._iigCatalogRequest === request
            && ['apiType', 'endpoint', 'apiKey', 'showAllModels'].every(key => getSettings()[key] === captured[key]);
        btn.classList.add('loading');
        
        try {
            const models = await fetchModels(captured);
            if (!isCurrent()) return;
            updateModelCatalog('iig_model', models, models.length > 0);
            
            if (models.length > 0) toastr.success(sanitizeForHtml(iigT('iig_ui_modelsFound', { count: models.length })), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { escapeHtml: false });
            else toastr.warning(sanitizeForHtml(iigT('iig_ui_modelCatalogEmpty')), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { escapeHtml: false });
        } catch (error) {
            if (!isCurrent()) return;
            toastr.error(sanitizeForHtml(iigT('iig_ui_modelsLoadFailed', { detail: iigErrorText(error) })), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { escapeHtml: false });
        } finally {
            if (!_iigDisposed && btn._iigCatalogRequest === request) btn.classList.remove('loading');
        }
    });
    
    bindIig(document.getElementById('iig_size'), 'change', (e) => {
        settings.size = e.target.value;
        saveSettings();
    });
    
    bindIig(document.getElementById('iig_quality'), 'change', (e) => {
        settings.quality = e.target.value;
        saveSettings();
    });
    
    bindIig(document.getElementById('iig_image_size'), 'change', (e) => {
        settings.imageSize = e.target.value;
        saveSettings();
    });

    bindIig(document.getElementById('iig_naistera_model'), 'change', (e) => {
        settings.naisteraModel = normalizeNaisteraModel(e.target.value);
        updateVisibility(); // preset and ref rows depend on model capabilities.
        saveSettings();
    });

    bindIig(document.getElementById('iig_naistera_preset'), 'change', (e) => {
        settings.naisteraPreset = e.target.value;
        saveSettings();
    });

    bindIig(document.getElementById('iig_naistera_send_refs'), 'change', (e) => {
        settings.naisteraSendRefs = !!e.target.checked;
        saveSettings();
    });

    bindIig(document.getElementById('iig_gemini_send_refs'), 'change', (e) => {
        settings.geminiSendRefs = !!e.target.checked;
        saveSettings();
    });

    bindIig(document.getElementById('iig_char_ref_always'), 'change', (e) => {
        settings.charRefAlways = !!e.target.checked;
        saveSettings();
    });

    bindIig(document.getElementById('iig_user_ref_always'), 'change', (e) => {
        settings.userRefAlways = !!e.target.checked;
        saveSettings();
    });

    bindIig(document.getElementById('iig_crop_on_upload'), 'change', (e) => {
        settings.cropOnUpload = !!e.target.checked;
        saveSettings();
    });

    bindIig(document.getElementById('iig_ref_scope'), 'change', (e) => {
        _refScopeRevision++;
        settings.refScope = normalizeRefScope(e.target.value);
        saveSettings();
        renderRefSlots();
    });

    bindIig(document.getElementById('iig_refs_reset_scope'), 'click', () => {
        const scope = normalizeRefScope(settings.refScope);
        const ctx = getContext();
        _refScopeRevision++;
        if (scope === 'per-chat' && ctx?.chatMetadata?.iig_refs) {
            delete ctx.chatMetadata.iig_refs;
            try { persistIigMetadata(ctx); } catch (error) { iigLog('WARN', 'Reference metadata save failed:', error); }
        } else if (scope === 'per-character') {
            const owner = getCurrentRefOwner(ctx);
            if (owner && settings.characterRefs?.[owner.key]) {
                delete settings.characterRefs[owner.key];
                saveSettings();
            }
        }
        clearAllRefB64Cache();
        renderRefSlots();
        toastr.info(sanitizeForHtml(iigT(scope === 'per-chat'
            ? 'iig_ui_chatRefsReset'
            : 'iig_ui_characterRefsReset')), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { timeOut: 2500, escapeHtml: false });
    });

    // Advanced handlers
    bindIig(document.getElementById('iig_path_override'), 'input', (e) => {
        settings.pathOverride = e.target.value.trim();
        saveSettings();
    });
    bindIig(document.getElementById('iig_show_all_models'), 'change', (e) => {
        settings.showAllModels = e.target.checked;
        invalidateImageModelCatalog();
        saveSettings();
    });

    const refreshPresetDropdown = () => {
        const sel = document.getElementById('iig_preset_select');
        if (!sel) return;
        const presets = Array.isArray(settings.presets) ? settings.presets : [];
        const currentValue = settings.activePresetName || '';
        sel.innerHTML = `<option value="" data-i18n="iig_ui_presets">${sanitizeForHtml(iigT('iig_ui_presets'))}</option>`
            + presets.map(p => {
                const name = sanitizeForHtml(p.name);
                const selected = p.name === currentValue ? ' selected' : '';
                return `<option value="${name}"${selected}>${name}</option>`;
            }).join('');
    };

    bindIig(document.getElementById('iig_preset_select'), 'change', (e) => {
        const name = e.target.value;
        if (!name) {
            settings.activePresetName = '';
            saveSettings();
            return;
        }
        const preset = findPreset(settings, name);
        if (!preset) {
            toastr.error(sanitizeForHtml(iigT('iig_ui_presetNotFound', { name })), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { escapeHtml: false });
            refreshPresetDropdown();
            return;
        }
        applyPresetToSettings(settings, preset);
        invalidateImageModelCatalog();
        settings.activePresetName = preset.name;
        saveSettings();

        // Reflect loaded values into the live UI (best-effort).
        const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
        setVal('iig_api_type', settings.apiType);
        setVal('iig_endpoint', settings.endpoint);
        setVal('iig_api_key', settings.apiKey);
        setVal('iig_model', settings.model);
        setVal('iig_path_override', settings.pathOverride);
        setVal('iig_naistera_model', settings.naisteraModel);
        const showAll = document.getElementById('iig_show_all_models');
        if (showAll) showAll.checked = !!settings.showAllModels;
        const sendRefs = document.getElementById('iig_naistera_send_refs');
        if (sendRefs) sendRefs.checked = settings.naisteraSendRefs !== false;
        const gSendRefs = document.getElementById('iig_gemini_send_refs');
        if (gSendRefs) gSendRefs.checked = settings.geminiSendRefs !== false;
        updateVisibility();
        toastr.success(sanitizeForHtml(iigT('iig_ui_presetLoaded', { name: preset.name })), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { timeOut: 2500, escapeHtml: false });
    });

    bindIig(document.getElementById('iig_preset_save'), 'click', () => {
        // Pre-fill with active preset name so "save over existing" is one-click.
        const suggested = settings.activePresetName || '';
        const name = (window.prompt(iigT('iig_ui_presetNamePrompt'), suggested) || '').trim();
        if (!name) return;

        if (!Array.isArray(settings.presets)) settings.presets = [];
        const snap = snapshotApiConfig(settings);
        snap.name = name;

        const idx = settings.presets.findIndex(p => p && p.name === name);
        if (idx >= 0) {
            if (!window.confirm(iigT('iig_ui_presetOverwriteConfirm', { name }))) return;
            settings.presets[idx] = snap;
            toastr.success(sanitizeForHtml(iigT('iig_ui_presetOverwritten', { name })), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { timeOut: 2500, escapeHtml: false });
        } else {
            settings.presets.push(snap);
            toastr.success(sanitizeForHtml(iigT('iig_ui_presetSaved', { name })), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { timeOut: 2500, escapeHtml: false });
        }
        settings.activePresetName = name;
        saveSettings({ sync: true });
        refreshPresetDropdown();
    });

    bindIig(document.getElementById('iig_preset_delete'), 'click', () => {
        const sel = document.getElementById('iig_preset_select');
        const name = sel?.value;
        if (!name) {
            toastr.info(sanitizeForHtml(iigT('iig_ui_selectPresetToDelete')), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { timeOut: 2500, escapeHtml: false });
            return;
        }
        if (!window.confirm(iigT('iig_ui_deletePresetConfirm', { name }))) return;
        settings.presets = (settings.presets || []).filter(p => p && p.name !== name);
        if (settings.activePresetName === name) settings.activePresetName = '';
        saveSettings({ sync: true });
        refreshPresetDropdown();
        toastr.info(sanitizeForHtml(iigT('iig_ui_presetDeleted', { name })), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { timeOut: 2500, escapeHtml: false });
    });
    
    bindIig(document.getElementById('iig_max_retries'), 'input', (e) => {
        const val = parseInt(e.target.value, 10);
        settings.maxRetries = Number.isNaN(val) ? 0 : Math.max(0, Math.min(5, val));
        saveSettings();
    });
    
    bindIig(document.getElementById('iig_retry_delay'), 'input', (e) => {
        const val = parseInt(e.target.value, 10);
        settings.retryDelay = Number.isNaN(val) ? 1000 : Math.max(500, val);
        saveSettings();
    });
    
    bindIig(document.getElementById('iig_verbose_logging'), 'change', (e) => {
        settings.verboseLogging = e.target.checked;
        setVerboseLogging(settings.verboseLogging);
        saveSettings();
    });

    bindIig(document.getElementById('iig_export_logs'), 'click', () => {
        exportLogs();
    });

    // Optional launcher: only reveal + wire if ST-ImageManager is present.
    const openImBtn = document.getElementById('iig_open_image_manager');
    if (openImBtn && isImageManagerInstalled()) {
        openImBtn.classList.remove('iig-hidden');
        bindIig(openImBtn, 'click', () => {
            if (!runSlashCommand('/image-manager')) {
                toastr.warning(sanitizeForHtml(iigT('iig_ui_imageManagerUnavailable')), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { escapeHtml: false });
            }
        });
    }

    bindIig(document.getElementById('iig_check_ref_storage'), 'click', async (e) => {
        const btn = e.currentTarget;
        const status = document.getElementById('iig_ref_storage_status');
        btn.disabled = true;
        if (status) {
            status.textContent = iigT('iig_ui_checkingStorage');
        }
        try {
            const usage = await measureIigRefsFolder();
            const measured = usage.measuredCount === usage.fileCount;
            if (status) {
                status.textContent = iigT(measured ? 'iig_ui_storageSummary' : 'iig_ui_storageSummaryEstimated', {
                    count: usage.fileCount, size: formatRefStorageSize(usage.totalBytes), measured: usage.measuredCount,
                });
                status.dataset.measured = '1';
            }
        } catch (error) {
            if (status) {
                status.textContent = iigT('iig_ui_storageMeasureFailed');
            }
            toastr.error(sanitizeForHtml(iigT('iig_ui_storageMeasureError', { detail: iigErrorText(error) })), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { escapeHtml: false });
        } finally {
            btn.disabled = false;
        }
    });

    /**
     * Clear refs folder: wipe every file in /iig_refs on the ST server.
     * A successful full clear also removes persisted image paths while keeping
     * slot names. Older unloaded chat buckets are sanitized when next opened.
     */
    bindIig(document.getElementById('iig_clear_refs_folder'), 'click', async (e) => {
        const btn = e.currentTarget;
        if (_refFolderClearInProgress) return;
        if (!window.confirm(iigT('iig_ui_clearStorageConfirm'))) return;
        _refFolderClearInProgress = true;
        _refScopeRevision++;
        setRefMutationControlsDisabled(true);
        btn.disabled = true;
        btn.style.opacity = '0.6';
        try {
            const files = await listIigRefsFolder({ strict: true });
            if (_iigDisposed) return;
            if (files.length === 0) {
                applyRefFolderClear(null, Date.now());
                const status = document.getElementById('iig_ref_storage_status');
                if (status) {
                    status.textContent = iigT('iig_ui_storageEmpty');
                    status.dataset.measured = '1';
                }
                toastr.info(sanitizeForHtml(iigT('iig_ui_storageAlreadyEmpty')), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { timeOut: 2500, escapeHtml: false });
                return;
            }

            const folderPrefix = getIigRefsPublicPrefix();
            let deleted = 0;
            let failed = 0;
            const deletedNames = new Set();
            const failedNames = [];
            for (const name of files) {
                const path = `${folderPrefix}${name}`;
                const ok = !_iigDisposed && await deleteRefFileOnServer(path);
                if (ok) { deleted++; deletedNames.add(name); }
                else { failed++; failedNames.push(name); }
            }
            applyRefFolderClear(failed === 0 ? null : deletedNames, Date.now(), failedNames);
            const status = document.getElementById('iig_ref_storage_status');
            if (status) {
                status.textContent = failed === 0 ? iigT('iig_ui_storageEmpty') : iigT('iig_ui_storageDeleteFailed', { count: failed });
                if (failed === 0) status.dataset.measured = '1';
                else delete status.dataset.measured;
            }
            toastr.success(sanitizeForHtml(iigT(failed ? 'iig_ui_storageClearedPartial' : 'iig_ui_storageCleared', { deleted, failed })), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { timeOut: 3500, escapeHtml: false });
            iigLog('INFO', `Clear refs folder: deleted=${deleted}, failed=${failed}, prefix=${folderPrefix}`);
        } catch (err) {
            iigLog('ERROR', 'Clear refs folder failed:', err.message);
            toastr.error(sanitizeForHtml(iigT('iig_ui_storageClearFailed', { detail: iigErrorText(err) })), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { escapeHtml: false });
        } finally {
            _refFolderClearInProgress = false;
            setRefMutationControlsDisabled(false);
            updateRefScopeUI();
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    });

    // Test connection: per-apiType probe with distinct error diagnostics.
    bindIig(document.getElementById('iig_test_connection'), 'click', async (e) => {
        const btn = e.currentTarget;
        if (btn.classList.contains('testing')) return;
        btn.classList.add('testing');
        const icon = btn.querySelector('i');
        const origClass = icon.className;
        icon.className = 'fa-solid fa-spinner';

        try {
            const s = getSettings();
            let flashSuccess = true;
            iigLog('INFO', `Test connection: apiType=${s.apiType}, endpoint=${s.endpoint}, apiKey=${s.apiKey ? 'set' : 'empty'}`);

            switch (s.apiType) {
                case 'naistera': {
                    if (!s.apiKey) throw iigError('Set API key first', 'iig_ui_setApiKeyFirst');
                    const testUrl = getNaisteraGenerationUrl(s);
                    const resp = await fetchWithTimeout(testUrl, {
                        method: 'OPTIONS',
                        headers: { 'Authorization': `Bearer ${s.apiKey}` },
                    }, 20000);
                    resp.iigDiscard?.();
                    if (resp.status === 401 || resp.status === 403) throw iigError(`API key rejected (HTTP ${resp.status})`, 'iig_ui_apiKeyRejected', { status: resp.status });
                    if (resp.status === 404) throw iigError('Generation endpoint not found (HTTP 404)', 'iig_ui_generationEndpointMissing');
                    if (resp.status >= 500) throw iigError(`Endpoint unavailable (HTTP ${resp.status})`, 'iig_ui_endpointUnavailable', { status: resp.status });
                    if (resp.ok) {
                        toastr.success(sanitizeForHtml(iigT('iig_ui_generationEndpointReached')), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { escapeHtml: false });
                    } else {
                        flashSuccess = false;
                        toastr.warning(sanitizeForHtml(iigT('iig_ui_probeReturnedStatus', { status: resp.status })), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { escapeHtml: false });
                    }
                    break;
                }
                case 'openai':
                case 'gemini': {
                    if (!s.endpoint) throw iigError('Set endpoint first', 'iig_ui_setEndpointFirst');
                    if (!s.apiKey) throw iigError('Set API key first', 'iig_ui_setApiKeyFirst');
                    const models = await fetchModels();
                    updateModelCatalog('iig_model', models);
                    if (models.length > 0) {
                        toastr.success(sanitizeForHtml(iigT('iig_ui_connectionModelsFound', { count: models.length })), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { escapeHtml: false });
                    } else {
                        toastr.warning(sanitizeForHtml(iigT('iig_ui_connectionNoModels')), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { escapeHtml: false });
                    }
                    break;
                }
                default:
                    throw iigError(`Unknown API type: ${s.apiType}`, 'iig_ui_unknownApiType', { apiType: s.apiType });
            }

            if (flashSuccess) {
                btn.classList.add('test-success');
                setIigTimeout(() => btn.classList.remove('test-success'), 700);
            }
        } catch (error) {
            toastr.error(sanitizeForHtml(iigT('iig_ui_connectionFailed', { detail: iigErrorText(error) })), sanitizeForHtml(iigT('iig_ui_notificationTitle')), { escapeHtml: false });
            btn.classList.add('test-fail');
            setIigTimeout(() => btn.classList.remove('test-fail'), 700);
        } finally {
            btn.classList.remove('testing');
            icon.className = origClass;
        }
    });

    bindRefSlotEvents();
    updateVisibility();
    populatePromptModelSelect();
    refreshPromptModelUI();
}

/** Fullscreen image lightbox. Click image to open; Escape or backdrop to close. */
function initLightbox() {
    if (_iigDisposed || IS_MOBILE || document.getElementById('iig_lightbox')) return;

    const overlay = document.createElement('div');
    overlay.id = 'iig_lightbox';
    overlay.className = 'iig-lightbox';
    overlay.innerHTML = `
        <div class="iig-lightbox-backdrop"></div>
        <div class="iig-lightbox-content">
            <img class="iig-lightbox-img" src="" alt="${sanitizeForHtml(iigT('iig_fullSizePreview'))}">
            <div class="iig-lightbox-actions">
                <button type="button" class="iig-lightbox-action-btn iig-lb-download" title="${sanitizeForHtml(iigT('iig_download'))}" aria-label="${sanitizeForHtml(iigT('iig_downloadImage'))}">${SVG_ICON_DOWNLOAD}</button>
                <button type="button" class="iig-lightbox-action-btn iig-lb-regen" title="${sanitizeForHtml(iigT('iig_regenerate'))}" aria-label="${sanitizeForHtml(iigT('iig_regenerateImage'))}">${SVG_ICON_REGENERATE}</button>
            </div>
            <div class="iig-lightbox-caption"></div>
            <button type="button" class="iig-lightbox-close" title="${sanitizeForHtml(iigT('iig_close'))}" aria-label="${sanitizeForHtml(iigT('iig_closeViewer'))}"><i class="fa-solid fa-xmark"></i></button>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay._sourceImg = null;

    const close = () => { overlay.classList.remove('open'); overlay._sourceImg = null; };
    overlay.querySelector('.iig-lightbox-backdrop').addEventListener('click', close);
    overlay.querySelector('.iig-lightbox-close').addEventListener('click', close);

    bindIig(overlay.querySelector('.iig-lb-download'), 'click', (e) => {
        e.stopPropagation();
        if (overlay._sourceImg) return downloadGeneratedImage(overlay._sourceImg);
    });
    bindIig(overlay.querySelector('.iig-lb-regen'), 'click', (e) => {
        e.stopPropagation();
        if (overlay._sourceImg) {
            const image = overlay._sourceImg;
            close();
            return regenerateSingleImage(image);
        }
    });
    listenIig(document, 'keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('open')) close();
    });

    // Desktop only: click a generated image to open lightbox. Mobile uses action buttons instead.
    listenIig(document.getElementById('chat'), 'click', (e) => {
        if (e.target.closest('.iig-action-btn')) return;

        const img = e.target.closest('.iig-generated-image');
        if (!img) return;

        e.preventDefault();
        e.stopPropagation();
        openLightbox(img);
    });

    iigLog('DEBUG:init', 'Lightbox initialized');
}

/** Toggle the drawer-header status dot based on settings.enabled. */
function updateHeaderStatusDot() {
    const settings = getSettings();
    const header = document.querySelector('.inline-drawer:has(.iig-settings) > .inline-drawer-header');
    if (!header) return;

    let dot = header.querySelector('.iig-header-dot');
    if (!dot) {
        dot = document.createElement('span');
        dot.className = 'iig-header-dot';
        const chevron = header.querySelector('.inline-drawer-icon');
        if (chevron) {
            header.insertBefore(dot, chevron);
        } else {
            header.appendChild(dot);
        }
    }

    dot.classList.toggle('active', settings.enabled);
    dot.title = iigT(settings.enabled ? 'iig_generationEnabled' : 'iig_generationDisabled');
}

/** One line at APP_READY, reporting the active provider and model. */
function logStartupBanner() {
    const s = getSettings();
    const model = (s.apiType === 'naistera' ? s.naisteraModel : s.model) || 'unset';
    iigLog('INFO:init', [
        `v${IIG_VERSION} ready`,
        IS_IOS ? 'ios' : IS_MOBILE ? 'mobile' : 'desktop',
        `timeout=${FETCH_TIMEOUT / 1000}s`,
        s.apiType,
        model,
    ].join(' · '));
}

const IIG_STRINGS = {};
const IIG_LOCALES = { 'ru-ru': {} };
for (const [prefix, table] of Object.entries({
    iig_: IIG_MESSAGES_I18N,
    iig_ui_: IIG_UI_I18N,
    iig_pm_: PROMPT_MODEL_I18N,
    iig_pack_: IMAGE_PACKS_I18N,
})) {
    for (const [key, text] of Object.entries(table.en)) IIG_STRINGS[prefix + key] = text;
    for (const [key, text] of Object.entries(table.ru)) IIG_LOCALES['ru-ru'][prefix + key] = text;
}

function cleanupIig() {
    if (_iigCleanupPromise) return _iigCleanupPromise;
    if (!_iigDisposed) {
        for (const editor of document.querySelectorAll('#chat #curEditTextarea[data-iig-prompt-model-edit="1"]')) {
            if (!(editor instanceof HTMLTextAreaElement) || !editor.isConnected) continue;
            const id = Number.parseInt(editor.closest('.mes[mesid]')?.getAttribute('mesid') || '', 10);
            if (!_promptModelEditSessions.has(getContext()?.chat?.[id])) continue;
            const error = iigError(iigT('iig_cleanupEditActive'), 'iig_cleanupEditActive');
            toastr.warning(sanitizeForHtml(iigT('iig_cleanupEditActive')), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
            return Promise.reject(error);
        }
    }
    _iigDisposed = true;
    _iigCleanupWork ??= Promise.resolve().then(async () => {
        const context = getContext();
        const interrupted = new Map();
        for (const placeholder of document.querySelectorAll('#chat .iig-loading-placeholder, #chat .iig-pm-composing')) {
            const element = placeholder.closest('.mes[mesid]');
            const id = Number(element?.getAttribute('mesid'));
            if (element && context?.chat?.[id]) interrupted.set(id, context.chat[id]);
        }
        if (_iigRefsRestored) flushPendingRefsPersist();
        _iigLifetime.abort('cleanup');
        abortAllPromptModelRequests('cleanup');
        abortAllMediaGenerations('cleanup');
        _promptModelEditObserver?.disconnect();
        _promptModelEditObserver = null;
        const chat = document.getElementById('chat');
        chat?._iigObserver?.disconnect();
        if (chat) delete chat._iigObserver;
        _iigFlushWrapQueue = null;
        _iigGenerating = false;
        for (const timer of _iigTimers) clearTimeout(timer);
        _iigTimers.clear();
        _wrapPassTimer = _persistRefsTimer = null;
        if (_placeholderTickerId !== null) clearInterval(_placeholderTickerId);
        _placeholderTickerId = null;
        _placeholderTicks.clear();

        const disposing = [];
        for (const dispose of [..._iigDisposers].reverse()) {
            try { disposing.push(Promise.resolve(dispose())); }
            catch (error) { disposing.push(Promise.reject(error)); }
        }
        _iigDisposers.clear();
        _packsDb?.close();
        _packsDb = null;
        _packsDbPromise = null;

        document.querySelectorAll('.inline-drawer:has(.iig-settings), #iig_lightbox, #iig_pm_guidance_button, .iig-header-dot, #chat .iig-regenerate-btn, #chat .iig-loading-placeholder, #chat .iig-pm-composing, #chat [data-iig-pm-retry], #chat [data-iig-pm-reroll]')
            .forEach(element => element.remove());
        for (const wrapper of document.querySelectorAll('#chat .iig-image-wrapper')) {
            const image = wrapper.querySelector('img');
            if (image) wrapper.replaceWith(image);
            else wrapper.remove();
        }
        document.body.classList.remove('iig-low-power');

        const failures = (await Promise.allSettled(disposing)).filter(result => result.status === 'rejected');
        // Do not skip in-progress commits or compensating saves after disposal.
        while (_iigTasks.size) await Promise.allSettled([..._iigTasks]);
        if (_iigRefsRestored) flushPendingRefsPersist();
        for (const [id, message] of interrupted) {
            const element = document.querySelector(`#chat .mes[mesid="${id}"]`);
            if (context?.chat?.[id] === message && getContext()?.chat?.[id] === message && !element?.querySelector('#curEditTextarea')) {
                try { context.updateMessageBlock?.(id, message); }
                catch (error) { failures.push({ reason: error }); }
            }
        }
        document.querySelectorAll('#chat [data-iig-pm-retry], #chat [data-iig-pm-reroll]').forEach(element => element.remove());
        _promptModelEditSessions.clear();
        _promptModelCaptures.clear();
        _promptModelCaptureCache.clear();
        _promptModelGeneration = null;
        clearProcessingStateForChatChange();
        clearAllRefB64Cache();
        _fileExistsCache.clear();
        _modelCatalogs.clear();
        _providerQuirks.clear();
        _recentErrorSuggestions.clear();
        _lastGenerated = null;
        _cachedContext = null;
        logBuffer.length = 0;
        if (failures.length) {
            iigLog('ERROR', 'Lifecycle disposal failed:', failures[0].reason);
            throw failures[0].reason;
        }
    });
    // A timeout bounds the caller's wait, never the persistence/rollback work itself.
    let timer;
    const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            const error = iigError(iigT('iig_cleanupTimedOut'), 'iig_cleanupTimedOut');
            reject(error);
            toastr.error(sanitizeForHtml(iigT('iig_cleanupTimedOut')), sanitizeForHtml(iigT('iig_title')), { escapeHtml: false });
        }, IIG_CLEANUP_TIMEOUT_MS);
    });
    _iigCleanupPromise = Promise.race([_iigCleanupWork, deadline]).then(value => {
        clearTimeout(timer);
        return value;
    }, error => {
        clearTimeout(timer);
        if (error?.i18n === 'iig_cleanupTimedOut') _iigCleanupPromise = null;
        throw error;
    });
    return _iigCleanupPromise;
}

// Extension init. Runs once at module load.
(function init() {
    // Publish teardown before APP_READY can replay or setup can fail.
    window.IIG = {
        version: IIG_VERSION,
        cleanup: cleanupIig,
        openSettings() {
            if (_iigDisposed) return false;
            try {
                const drawer = document.querySelector('.inline-drawer:has(.iig-settings)');
                if (!drawer) return false;
                const content = drawer.querySelector('.inline-drawer-content');
                const header = drawer.querySelector('.inline-drawer-toggle');
                if (content && getComputedStyle(content).display === 'none') header?.click();
                drawer.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return true;
            } catch (_) { return false; }
        },
        getLastGenerated() {
            return _lastGenerated ? { ..._lastGenerated } : null;
        },
    };
    // Primer: populate context cache for the rest of the module.
    const context = getContext();

    // Some hosts expose an optional immediate settings-save hook.
    if (!_stSaveSettingsCaptured) {
        const candidate = window.saveSettings;
        if (typeof candidate === 'function' && candidate !== saveSettings) {
            _stSaveSettings = candidate;
        }
        _stSaveSettingsCaptured = true;
    }

    getSettings();
    
    let ready = false;
    subscribeIig(context.eventSource, context.event_types.APP_READY, () => {
        if (ready) return;
        ready = true;
        restoreRefsFromLocalStorage();
        _iigRefsRestored = true;
        // One-shot base64 migration, fire-and-forget.
        trackIigTask(migrateBase64Refs()).catch(e => iigLog('ERROR', `migrateBase64Refs crashed: ${e.message}`));

        registerIigLocale();
        listenIig(document, 'click', _closeModelPickersOnDocumentClick);
        createSettingsUI();
        addButtonsToExistingMessages();
        wrapExistingImages();
        initLightbox();
        updateHeaderStatusDot();
        initMobileSaveListeners();
        initImageWrapObserver();
        initPromptModelEditBridge();
        initPromptModelGuidanceButton();
        listenIig(document.getElementById('chat'), 'click', event => {
            const reroll = event.target.closest('[data-iig-pm-reroll="1"]');
            if (reroll) {
                event.preventDefault();
                event.stopPropagation();
                if (reroll.disabled) return;
                const messageElement = reroll.closest('.mes[mesid]');
                const messageId = Number.parseInt(messageElement?.getAttribute('mesid') || '', 10);
                if (!Number.isInteger(messageId)) return;
                reroll.disabled = true;
                const img = reroll.closest('.iig-image-wrapper')?.querySelector('img[data-iig-instruction]');
                return (async () => {
                    const resolved = await resolveRenderedImageSource(img);
                    if (_iigDisposed) return;
                    if (!resolved) throw iigError('Could not identify the selected image source', 'iig_imageSourceMissing');
                    return rerollSelectedMessageImage(img, resolved);
                })().catch(() => {
                    if (_iigDisposed) return;
                    iigLog('ERROR', 'Prompt reroll selection failed');
                    toastr.error(sanitizeForHtml(iigT('iig_imageSourceMissing')), sanitizeForHtml(pmT('title')), { escapeHtml: false });
                }).finally(() => { if (!_iigDisposed && reroll.isConnected) reroll.disabled = false; });
            }
            const retry = event.target.closest('[data-iig-pm-retry="1"]');
            if (!retry) return;
            event.preventDefault();
            event.stopPropagation();
            const messageElement = retry.closest('.mes[mesid]');
            const messageId = Number.parseInt(messageElement?.getAttribute('mesid') || '', 10);
            if (!Number.isInteger(messageId)) return;
            retry.disabled = true;
            return retryPromptModelSidecar(messageId).finally(() => { if (!_iigDisposed && retry.isConnected) retry.disabled = false; });
        });
        logStartupBanner();
    });
    
    // Coalesced CHAT_CHANGED handler. Single guarded timer; MutationObserver covers late-rendered images.
    let _chatChangedTimer = null;
    subscribeIig(context.eventSource, context.event_types.CHAT_CHANGED, () => {
        iigLog('DEBUG:chat', 'CHAT_CHANGED event');
        releaseStreamingGate();
        abortAllPromptModelRequests();
        _promptModelCaptureCache.clear();
        abortAllMediaGenerations();
        _promptModelEditSessions.clear();
        _promptModelEditObserver?.disconnect();
        _promptModelEditObserver = null;
        invalidateContextCache();
        // Clear per-chat processing state so a same-index message in the new chat isn't skipped.
        clearProcessingStateForChatChange();
        clearAllRefB64Cache();

        if (_chatChangedTimer) clearIigTimeout(_chatChangedTimer);
        _chatChangedTimer = setIigTimeout(() => {
            _chatChangedTimer = null;
            restoreRefsFromLocalStorage();
            addButtonsToExistingMessages();
            wrapExistingImages();
            renderRefSlots();
            refreshPromptModelGuidanceButton();
        }, 300);
    });

    if (context.event_types.CHARACTER_RENAMED) {
        subscribeIig(context.eventSource, context.event_types.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
            if (!migrateCharacterRefOwner(getSettings(), oldAvatar, newAvatar)) return;
            _refScopeRevision++;
            clearAllRefB64Cache();
            saveSettings({ sync: true });
        });
    }

    // Pause the image-wrap observer's heavy DOM pass while ST streams a reply
    // (per-token CPU saver), then flush its queue when streaming ends. The gate
    // only covers streaming text; a guaranteed wrap pass after our own media
    // generation (scheduleWrapPass) is what restores action buttons live.
    if (context.event_types.GENERATION_STARTED) {
        subscribeIig(context.eventSource, context.event_types.GENERATION_STARTED, async (type, options, dryRun) => {
            if (dryRun) return;
            await adoptActivePromptModelPrompt(false);
            if (_iigDisposed) return;
            beginPromptModelCapture(type, false);
        });
    }
    if (context.event_types.GENERATION_AFTER_COMMANDS) {
        subscribeIig(context.eventSource, context.event_types.GENERATION_AFTER_COMMANDS, (type, options, dryRun) => {
            if (dryRun) return;
            _iigGenerating = true;
        });
    }
    if (context.event_types.CHAT_COMPLETION_PROMPT_READY) {
        subscribeIig(context.eventSource, context.event_types.CHAT_COMPLETION_PROMPT_READY, capturePromptModelContext);
    }
    if (context.event_types.OAI_PRESET_CHANGED_AFTER) {
        subscribeIig(context.eventSource, context.event_types.OAI_PRESET_CHANGED_AFTER, () => {
            populatePromptModelSelect();
            refreshPromptModelUI();
        });
    }
    if (context.event_types.CHATCOMPLETION_MODEL_CHANGED) {
        subscribeIig(context.eventSource, context.event_types.CHATCOMPLETION_MODEL_CHANGED, () => {
            abortAllPromptModelRequests('model-changed');
            populatePromptModelSelect();
            refreshPromptModelUI();
        });
    }
    if (context.event_types.CHATCOMPLETION_SOURCE_CHANGED) {
        subscribeIig(context.eventSource, context.event_types.CHATCOMPLETION_SOURCE_CHANGED, () => {
            abortAllPromptModelRequests('source-changed');
            populatePromptModelSelect();
            refreshPromptModelUI();
        });
    }
    if (context.event_types.MAIN_API_CHANGED) {
        subscribeIig(context.eventSource, context.event_types.MAIN_API_CHANGED, () => {
            abortAllPromptModelRequests('api-changed');
            invalidateContextCache();
            populatePromptModelSelect();
            refreshPromptModelUI();
        });
    }
    if (context.event_types.GENERATION_ENDED) {
        subscribeIig(context.eventSource, context.event_types.GENERATION_ENDED, releaseStreamingGate);
    }
    if (context.event_types.GENERATION_STOPPED) {
        subscribeIig(context.eventSource, context.event_types.GENERATION_STOPPED, releaseStreamingGate);
    }

    const handleMessage = async (messageId, type) => {
        iigLog('DEBUG:chat', `Event triggered for message: ${messageId}`);
        // Streaming is done — clear the gate and flush any queued wraps.
        releaseStreamingGate();
        if (['continue', 'append', 'appendFinal', 'regenerate', 'swipe'].includes(type) && promptModelSettings().enabled) {
            const message = getContext()?.chat?.[messageId];
            if (message && removePromptModelArtifacts(message)) getContext()?.updateMessageBlock?.(messageId, message);
        }
        schedulePromptModelSidecar(messageId, type);
        await onMessageReceived(messageId);
        // Our media generation is async; after it lands ST re-renders the
        // message into a bare <img>. Re-wrap so the action buttons reappear
        // without needing a page reload.
        scheduleWrapPass();
    };

    // Render handler. Swipe-back only re-wraps buttons (never regenerates).
    subscribeIig(context.eventSource, context.event_types.CHARACTER_MESSAGE_RENDERED, handleMessage, true);

    if (context.event_types.MESSAGE_SWIPED) {
        subscribeIig(context.eventSource, context.event_types.MESSAGE_SWIPED, () => {
            scheduleWrapPass();
        });
    }

})();
