/**
 * Sync V5 session: server address + the single engine instance.
 *
 * There is no separate "protocol" object here and nothing secret to configure: the access
 * password is a constant in transport.js. Checking the address is an explicit
 * `GET /tplanner/v5/health` call, so a wrong address is reported before the app claims to be
 * connected.
 */
import { createSyncEngine } from './sync.js';
import { createTransport, normalizeBaseUrl, TransportError } from './transport.js';

export const SESSION_KEY = 'tplanner_v5_session';
export const DEFAULT_SERVER_URL = 'https://sync.hamhuo.top';

export function loadSession() {
    try {
        const raw = globalThis.localStorage?.getItem(SESSION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed?.serverUrl !== 'string' || !parsed.serverUrl) return null;
        return { serverUrl: parsed.serverUrl, remember: parsed.remember !== false };
    } catch {
        return null;
    }
}

export function saveSession({ serverUrl, remember = true }) {
    const payload = JSON.stringify({ serverUrl, remember });
    if (remember) globalThis.localStorage?.setItem(SESSION_KEY, payload);
    else globalThis.sessionStorage?.setItem(SESSION_KEY, payload);
}

export function clearSession() {
    globalThis.localStorage?.removeItem(SESSION_KEY);
    globalThis.sessionStorage?.removeItem(SESSION_KEY);
}

export function storedSession() {
    try {
        const raw = globalThis.localStorage?.getItem(SESSION_KEY)
            ?? globalThis.sessionStorage?.getItem(SESSION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed?.serverUrl ? { serverUrl: parsed.serverUrl } : null;
    } catch {
        return null;
    }
}

let engine = null;
let engineKey = '';

/**
 * Returns the process-wide engine for this address, rebuilding it when the address changes
 * so a previous server can never keep receiving this client's commands.
 */
export function getEngine({ serverUrl } = {}) {
    const baseUrl = normalizeBaseUrl(serverUrl);
    if (!baseUrl) throw new TransportError('请先配置同步服务器地址');
    const key = baseUrl;
    if (engine && engineKey === key) return engine;
    engine?.stop();
    engineKey = key;
    engine = createSyncEngine({ serverUrl: baseUrl });
    return engine;
}

export function hasEngine() {
    return engine !== null;
}

export function currentEngine() {
    return engine;
}

/** Verifies a candidate configuration without persisting it. */
export async function verifySession({ serverUrl }) {
    const baseUrl = normalizeBaseUrl(serverUrl);
    const transport = createTransport({ baseUrl });
    const health = await transport.health();
    return { ...health, baseUrl };
}

export function saveSessionConfig(config) {
    saveSession(config);
}
