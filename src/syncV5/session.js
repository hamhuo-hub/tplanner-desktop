/**
 * Sync V5 session: server address + access token + the single engine instance.
 *
 * There is no separate "protocol" object here. The token is whatever the server's
 * `Authorization: Bearer <token>` expects, and the engine is the only client-side writer.
 * Verification is an explicit `GET /tplanner/v5/health` call, so a wrong address or token
 * is reported before the app claims to be connected.
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
        if (typeof parsed?.serverUrl !== 'string' || typeof parsed?.token !== 'string') return null;
        if (!parsed.token) return null;
        return { serverUrl: parsed.serverUrl, token: parsed.token, remember: parsed.remember !== false };
    } catch {
        return null;
    }
}

export function saveSession({ serverUrl, token, remember = true }) {
    const payload = JSON.stringify({ serverUrl, token, remember });
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
        return parsed?.token ? { serverUrl: parsed.serverUrl, token: parsed.token } : null;
    } catch {
        return null;
    }
}

let engine = null;
let engineKey = '';

/**
 * Returns the process-wide engine for this address/token pair, rebuilding it when the
 * configuration changes so an old token can never keep uploading to a new server.
 */
export function getEngine({ serverUrl, token } = {}) {
    const baseUrl = normalizeBaseUrl(serverUrl);
    if (!baseUrl) throw new TransportError('请先配置同步服务器地址');
    if (!token) throw new TransportError('请先填写访问令牌');
    const key = `${baseUrl}\u0000${token}`;
    if (engine && engineKey === key) return engine;
    engine?.stop();
    engineKey = key;
    engine = createSyncEngine({ serverUrl: baseUrl, token });
    return engine;
}

export function hasEngine() {
    return engine !== null;
}

export function currentEngine() {
    return engine;
}

/** Verifies a candidate configuration without persisting it. */
export async function verifySession({ serverUrl, token }) {
    const baseUrl = normalizeBaseUrl(serverUrl);
    const transport = createTransport({ baseUrl, token });
    const health = await transport.health();
    return { ...health, baseUrl };
}

export function saveSessionConfig(config) {
    saveSession(config);
}
