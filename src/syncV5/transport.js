/**
 * Sync V5 transport: exactly two HTTP calls (docs/sync-v5.md "Transport and central authority").
 *
 *   GET  {base}/tplanner/v5/health    -> {"protocolVersion","serverId","revision"}
 *   GET  {base}/tplanner/v5/snapshot  -> full logical snapshot
 *   POST {base}/tplanner/v5/batch     -> at most one command, receipts back
 *
 * Hardening is part of the contract rather than the engine:
 *   - HTTPS is required except for loopback development hosts, and the URL must be
 *     absolute (no protocol-relative `//host` form, which would silently escape the check).
 *   - every request has an explicit timeout and `redirect: 'error'`, so an Authorization
 *     header can never be replayed to another origin by a 3xx.
 *   - responses are size-capped and decoded with a streaming reader, so a hostile or
 *     broken server cannot exhaust memory before validation runs.
 *   - the whole envelope is validated before any of it is trusted; a shape mismatch is a
 *     hard error, never a partially applied snapshot.
 */
import { documentUid } from './store.js';

export const SNAPSHOT_PATH = '/tplanner/v5/snapshot';
export const BATCH_PATH = '/tplanner/v5/batch';
export const HEALTH_PATH = '/tplanner/v5/health';
export const PROTOCOL_VERSION = 5;

export const DEFAULT_TIMEOUT_MS = 15_000;
/** A 100-command batch of 1 MiB calendars is already far past this; the guard is generous. */
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
export const MAX_COMMAND_SEQUENCE = Number.MAX_SAFE_INTEGER;

export class TransportError extends Error {
    constructor(message, { status = 0, code = null, body = null } = {}) {
        super(message);
        this.name = 'TransportError';
        this.status = status;
        this.code = code;
        this.body = body;
    }
}

/** URL normalisation shared by the UI, the engine and the transport. */
export function normalizeBaseUrl(raw) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return '';
    // `//host/path` is protocol-relative and must not be mistaken for a bare host.
    const textual = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, '')}`;
    let url;
    try {
        url = new URL(textual);
    } catch {
        throw new TransportError(`服务器地址无效：${raw}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new TransportError(`服务器地址必须使用 HTTPS：${raw}`);
    }
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
}

function isLoopback(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/** HTTPS outside local development; loopback addresses are the only plain-HTTP exception. */
export function assertSecureBaseUrl(baseUrl) {
    let url;
    try {
        url = new URL(baseUrl);
    } catch {
        throw new TransportError(`服务器地址无效：${baseUrl}`);
    }
    if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
        throw new TransportError('非本机服务器必须使用 HTTPS');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new TransportError(`不支持的协议：${url.protocol}`);
    }
    return url;
}

async function readBody(response, maxBytes) {
    const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new TransportError(`响应过大（${declared} 字节）`, { status: response.status });
    }
    const body = response.body;
    if (!body?.getReader) {
        const text = await response.text();
        if (new TextEncoder().encode(text).length > maxBytes) {
            throw new TransportError('响应过大', { status: response.status });
        }
        return text;
    }
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new TransportError('响应过大', { status: response.status });
        }
        chunks.push(value);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
}

function assertInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TransportError(`响应字段无效：${name}`);
    return value;
}

/** Shape validation for the snapshot envelope (the JSON schema is the normative form). */
export function validateSnapshot(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TransportError('快照不是 JSON 对象');
    }
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
        throw new TransportError(`协议版本不匹配：需要 ${PROTOCOL_VERSION}`);
    }
    if (typeof payload.serverId !== 'string' || !payload.serverId) {
        throw new TransportError('快照缺少 serverId');
    }
    assertInteger(payload.revision, 'revision');
    if (!Array.isArray(payload.records)) throw new TransportError('快照缺少 records');
    const records = payload.records.map((record) => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw new TransportError('快照记录无效');
        }
        assertInteger(record.revision, 'records[].revision');
        if (record.revision < 1) throw new TransportError('快照记录 revision 必须 >= 1');
        if (record.deleted === true) {
            if (typeof record.uid !== 'string' || !record.uid) throw new TransportError('墓碑缺少 uid');
            return { revision: record.revision, deleted: true, uid: record.uid };
        }
        if (record.deleted !== false) throw new TransportError('快照记录缺少 deleted 标记');
        const calendar = record.calendar;
        if (!Array.isArray(calendar) || calendar.length !== 3 || calendar[0] !== 'vcalendar') {
            throw new TransportError('快照记录不是 VCALENDAR');
        }
        // Deriving the UID here means the store never has to trust a transport field for it.
        return { revision: record.revision, deleted: false, uid: documentUid(calendar), calendar };
    });
    return { protocolVersion: PROTOCOL_VERSION, serverId: payload.serverId, revision: payload.revision, records };
}

export function validateReceipts(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TransportError('批处理响应不是 JSON 对象');
    }
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
        throw new TransportError(`协议版本不匹配：需要 ${PROTOCOL_VERSION}`);
    }
    if (typeof payload.serverId !== 'string' || !payload.serverId) {
        throw new TransportError('批处理响应缺少 serverId');
    }
    assertInteger(payload.revision, 'revision');
    if (!Array.isArray(payload.receipts) || payload.receipts.length === 0) {
        throw new TransportError('批处理响应缺少 receipts');
    }
    const statuses = new Set(['applied', 'conflict', 'rejected']);
    const receipts = payload.receipts.map((receipt) => {
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
            throw new TransportError('回执无效');
        }
        if (typeof receipt.commandId !== 'string' || !receipt.commandId) {
            throw new TransportError('回执缺少 commandId');
        }
        if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) {
            throw new TransportError('回执 sequence 无效');
        }
        if (!statuses.has(receipt.status)) throw new TransportError('回执 status 无效');
        assertInteger(receipt.revision, 'receipts[].revision');
        return {
            commandId: receipt.commandId,
            sequence: receipt.sequence,
            status: receipt.status,
            revision: receipt.revision,
            code: typeof receipt.code === 'string' ? receipt.code : null,
        };
    });
    return { protocolVersion: PROTOCOL_VERSION, serverId: payload.serverId, revision: payload.revision, receipts };
}

export function validateHealth(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TransportError('健康检查响应不是 JSON 对象');
    }
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
        throw new TransportError(`协议版本不匹配：需要 ${PROTOCOL_VERSION}`);
    }
    if (typeof payload.serverId !== 'string' || !payload.serverId) {
        throw new TransportError('健康检查响应缺少 serverId');
    }
    assertInteger(payload.revision, 'revision');
    return { protocolVersion: PROTOCOL_VERSION, serverId: payload.serverId, revision: payload.revision };
}

/**
 * @param {object} options
 * @param {string} options.baseUrl          server root, e.g. https://sync.hamhuo.top
 * @param {string} options.token            sent verbatim as `Authorization`
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {typeof fetch} [options.fetchFn]
 */
export function createTransport({
    baseUrl,
    token,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    fetchFn = (...args) => fetch(...args),
} = {}) {
    const base = normalizeBaseUrl(baseUrl);
    assertSecureBaseUrl(base);
    if (!token) throw new TransportError('缺少访问令牌');

    async function request(path, { method = 'GET', body = null } = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            const headers = { Authorization: token, Accept: 'application/json' };
            if (body !== null) headers['Content-Type'] = 'application/json';
            response = await fetchFn(`${base}${path}`, {
                method,
                headers,
                body: body === null ? undefined : JSON.stringify(body),
                signal: controller.signal,
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
            });
        } catch (error) {
            if (error?.name === 'AbortError') throw new TransportError('请求超时');
            throw new TransportError(`无法连接同步服务：${error?.message || error}`);
        } finally {
            clearTimeout(timer);
        }

        const text = await readBody(response, maxBytes);
        let payload = null;
        if (text) {
            try {
                payload = JSON.parse(text);
            } catch {
                throw new TransportError(`响应不是合法 JSON（HTTP ${response.status}）`, { status: response.status });
            }
        }
        if (!response.ok) {
            const code = payload?.code ?? null;
            // A sequence-gap body is a normal, recoverable protocol answer.
            if (response.status === 409 || code) {
                throw new TransportError(
                    `同步服务拒绝请求（HTTP ${response.status}${code ? ` ${code}` : ''}）`,
                    { status: response.status, code, body: payload },
                );
            }
            if (response.status === 401 || response.status === 403) {
                throw new TransportError('访问令牌无效或已过期', { status: response.status, body: payload });
            }
            throw new TransportError(`同步服务错误（HTTP ${response.status}）`, { status: response.status, body: payload });
        }
        return payload;
    }

    return {
        baseUrl: base,
        /** Latest full snapshot. Full state only: no delta codec, no long polling. */
        async fetchSnapshot() {
            return validateSnapshot(await request(SNAPSHOT_PATH));
        },
        /** One command. `HTTP 200` means the receipt is durable, not that it applied. */
        async sendBatch({ deviceId, commands }) {
            if (!Array.isArray(commands) || commands.length === 0) {
                throw new TransportError('批处理至少需要一条命令');
            }
            if (commands.length > 100) throw new TransportError('批处理最多 100 条命令');
            const payload = await request(BATCH_PATH, {
                method: 'POST',
                body: { protocolVersion: PROTOCOL_VERSION, deviceId, commands },
            });
            return validateReceipts(payload);
        },
        async health() {
            return validateHealth(await request(HEALTH_PATH));
        },
    };
}
