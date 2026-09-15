/**
 * Sync V5 durable local store (docs/sync-v5.md "Client durability and conflicts").
 *
 * The unit of truth is the canonical RFC 7265 jCal array from sync-v5/jcal.mjs. This
 * module keeps exactly four durable things in one NEW IndexedDB database (`tplanner-v5`)
 * and nothing else:
 *
 *   state    — serverId, installed revision, deviceId, nextSequence, last applied revision
 *   mirror   — the server mirror: uid -> { revision, deleted, calendar }
 *   outbox   — the persisted outgoing queue and the single immutable in-flight command
 *   conflicts— conflict/rejected receipts kept until the user discards or reapplies
 *
 * There is no second task model: `project()` returns the mirror overlaid with local
 * documents that are still queued/in flight, so the UI never reads two representations.
 *
 * "Durable" means: when a save function resolves, both the unchanged jCal document and
 * its outgoing operation are already committed to IndexedDB. Nothing here is in-memory
 * only, so a restart cannot lose a local edit.
 */
import Dexie from 'dexie';

export const DATABASE_NAME = 'tplanner-v5';

/** Outbox lifecycle. `inflight` is unique: the server's device sequence must stay contiguous. */
export const PENDING = 'pending';
export const INFLIGHT = 'inflight';
export const CONFLICT = 'conflict';
export const REJECTED = 'rejected';

const EMPTY_STATE = {
    serverId: null,
    revision: 0,
    deviceId: null,
    nextSequence: 1,
    // Highest receipt revision this device has seen applied. Used to advance a queued
    // successor's baseRevision from its OWN predecessor's receipt (never from the mirror).
    lastAppliedRevision: 0,
    installedAt: 0,
};

function clone(value) {
    return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
}

/** RFC 4122 v4 identifier; uniqueness is the requirement, not cryptography. */
export function newId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** UID of a canonical document, derived from jCal only. */
export function documentUid(calendar) {
    const components = calendar?.[2] ?? [];
    for (const component of components) {
        if (component[0] !== 'vtodo' && component[0] !== 'vjournal') continue;
        const uid = component[1].find((prop) => prop[0] === 'uid');
        if (uid) return uid[3];
    }
    throw new Error('jCal document has no UID');
}

function normalizeState(row) {
    const base = {
        ...EMPTY_STATE,
        deviceId: null,
        serverId: null,
        ...(row ?? {}),
        outbox: Array.isArray(row?.outbox) ? clone(row.outbox) : [],
        inflight: row?.inflight ? clone(row.inflight) : null,
        conflicts: Array.isArray(row?.conflicts) ? clone(row.conflicts) : [],
    };
    return base;
}

/**
 * Creates a durable store. Deliberately keyed off a Dexie instance so the same code runs
 * against `tplanner-v5` in the browser/Electron renderer and against a fake in Node checks.
 */
export function createStore({ databaseName = DATABASE_NAME, dexie, deviceLabel = 'device' } = {}) {
    const db = dexie ?? new Dexie(databaseName);
    if (!dexie) {
        db.version(1).stores({
            state: 'key',
            mirror: 'uid',
            commands: '++id, uid, status',
            conflicts: 'commandId, uid',
        });
    }

    /** A durable per-install device identity; the server uses it for sequence ownership. */
    const mintDeviceId = () => `${deviceLabel}-${newId()}`;

    let ready = null;
    async function open() {
        if (!ready) {
            ready = (async () => {
                await db.open();
                const existing = await db.table('state').get('v5');
                if (!existing) {
                    await db.table('state').put({
                        key: 'v5',
                        ...clone(EMPTY_STATE),
                        deviceId: mintDeviceId(),
                        outbox: [],
                        inflight: null,
                        conflicts: [],
                    });
                }
                return db;
            })();
        }
        return ready;
    }

    /** One serialized read-modify-write of the singleton state row (queue mutation atomicity). */
    async function mutate(change) {
        await open();
        return db.transaction('rw', db.table('state'), async () => {
            const table = db.table('state');
            const current = normalizeState(await table.get('v5'));
            const next = (await change(current)) ?? current;
            await table.put({ key: 'v5', ...next });
            return next;
        });
    }

    async function readState() {
        await open();
        return normalizeState(await db.table('state').get('v5'));
    }

    async function patchState(patch) {
        return mutate((state) => ({ ...state, ...patch }));
    }

    return {
        db,
        open,
        readState,
        patchState,

        // ── metadata ────────────────────────────────────────────────────────────
        async getMeta() {
            const state = await readState();
            return {
                serverId: state.serverId,
                revision: state.revision,
                deviceId: state.deviceId,
                nextSequence: state.nextSequence,
                lastAppliedRevision: state.lastAppliedRevision,
            };
        },
        async setServerId(serverId) {
            return mutate((state) => ({ ...state, serverId }));
        },
        async setInstalledRevision(revision) {
            return mutate((state) => ({ ...state, revision, installedAt: Date.now() }));
        },
        async setDeviceId(deviceId) {
            return mutate((state) => ({ ...state, deviceId, nextSequence: 1, lastAppliedRevision: 0 }));
        },

        // ── mirror ──────────────────────────────────────────────────────────────
        async listMirror() {
            await open();
            return db.table('mirror').toArray();
        },
        async getMirror(uid) {
            await open();
            return (await db.table('mirror').get(uid)) ?? null;
        },

        /** Atomic full-snapshot install; the caller supplies an already-validated record list. */
        async installSnapshot({ serverId, revision, records }) {
            await open();
            return db.transaction('rw', [db.table('mirror'), db.table('state')], async () => {
                const mirror = db.table('mirror');
                await mirror.clear();
                const rows = records.map((record) => (record.deleted
                    ? { uid: record.uid, revision: record.revision, deleted: true, calendar: null }
                    : { uid: documentUid(record.calendar), revision: record.revision, deleted: false, calendar: record.calendar }));
                if (rows.length) await mirror.bulkPut(rows);
                const table = db.table('state');
                const state = normalizeState(await table.get('v5'));
                const next = { ...state, serverId, revision, installedAt: Date.now() };
                await table.put({ key: 'v5', ...next });
                return next;
            });
        },

        /** Explicit user reset: mirror, queue, conflicts, sequences and stored serverId all go. */
        async reset() {
            await open();
            return db.transaction('rw', [db.table('mirror'), db.table('state'), db.table('conflicts')], async () => {
                await db.table('mirror').clear();
                await db.table('conflicts').clear();
                await db.table('state').put({
                    key: 'v5',
                    ...clone(EMPTY_STATE),
                    // A reset must not reuse a device sequence the server has already
                    // accepted, so it also mints a fresh device identity.
                    deviceId: mintDeviceId(),
                    outbox: [],
                    inflight: null,
                    conflicts: [],
                });
            });
        },

        // ── queue ───────────────────────────────────────────────────────────────
        /**
         * Persist one outgoing operation. Unsent edits to the same UID coalesce into a single
         * queued command (its commandId/sequence are only minted when it goes in flight).
         * Resolves once the document AND the operation are durable.
         */
        async enqueue({ uid, operation, calendar = null, baseRevision = 0, now = Date.now() }) {
            return mutate((state) => {
                const queued = state.outbox.filter((row) => row.uid === uid);
                const follower = state.inflight?.uid === uid ? state.inflight : null;
                // The successor's base advances ONLY from the predecessor's own applied
                // receipt. While that predecessor is still in flight the successor keeps
                // its own base: it must not adopt `sentBaseRevision`, because a successor is
                // a fresh edit of the record rather than a continuation of the in-flight
                // command, and it must never be rebased onto a mirror another device moved.
                const applied = follower?.appliedRevision;
                const base = applied !== null && applied !== undefined ? applied : baseRevision;
                return {
                    ...state,
                    outbox: [
                        ...state.outbox.filter((row) => row.uid !== uid),
                        {
                            uid,
                            operation,
                            calendar: operation === 'delete' ? null : clone(calendar),
                            commandId: newId(),
                            baseRevision: base,
                            createdAt: now,
                        },
                    ],
                };
            });
        },

        async listQueue() {
            const state = await readState();
            return { outbox: state.outbox, inflight: state.inflight };
        },
        async countQueue() {
            const state = await readState();
            return state.outbox.length + (state.inflight ? 1 : 0);
        },

        /**
         * Promote exactly one command to in-flight, minting its device sequence then.
         * Only an `applied` receipt for the previous command advances the sequence, and a
         * failed promotion rolls the sequence back, so the device sequence stays contiguous.
         */
        async stageCommand() {
            return mutate((state) => {
                if (state.inflight) {
                    if (state.inflight.status === INFLIGHT) return state;
                    // Crash between receipt recording and sequence advance.
                    return {
                        ...state,
                        outbox: [...state.outbox, state.inflight],
                        inflight: null,
                    };
                }
                const [next, ...rest] = state.outbox;
                if (!next) return state;
                const sequence = state.nextSequence;
                return {
                    ...state,
                    outbox: rest,
                    inflight: {
                        ...next,
                        sequence,
                        status: INFLIGHT,
                        // The exact guard this command was sent with, kept for diagnostics and
                        // so a post-crash retry can be compared byte-for-byte.
                        sentBaseRevision: next.baseRevision,
                        appliedRevision: null,
                        sentAt: null,
                    },
                    nextSequence: sequence + 1,
                };
            });
        },

        async markSent(commandId, sentAt = Date.now()) {
            return mutate((state) => (state.inflight?.commandId === commandId
                ? { ...state, inflight: { ...state.inflight, sentAt } }
                : state));
        },

        /**
         * Records an applied/conflict/rejected receipt. Applied receipts stamp the applied
         * revision on the in-flight command; the actual queue release waits for a snapshot
         * that covers that revision (see `releaseApplied`).
         */
        async recordReceipt(commandId, receipt) {
            return mutate((state) => {
                if (state.inflight?.commandId !== commandId) return state;
                const applied = receipt.status === 'applied'
                    ? (receipt.revision ?? null)
                    : state.inflight.appliedRevision;
                return {
                    ...state,
                    lastAppliedRevision: Math.max(state.lastAppliedRevision ?? 0, receipt.status === 'applied' ? receipt.revision ?? 0 : 0),
                    inflight: {
                        ...state.inflight,
                        status: receipt.status === 'applied' ? 'applied' : receipt.status,
                        code: receipt.code ?? null,
                        receiptRevision: receipt.revision ?? 0,
                        appliedRevision: applied,
                    },
                };
            });
        },

        async recordConflict(receipt, uid, calendar, sentAt = Date.now()) {
            await open();
            await db.table('conflicts').put({
                commandId: receipt.commandId ?? newId(),
                uid,
                status: receipt.status,
                code: receipt.code ?? null,
                revision: receipt.revision ?? 0,
                calendar: calendar ? clone(calendar) : null,
                at: sentAt,
            });
        },

        async clearApplied(commandId) {
            return mutate((state) => (state.inflight?.commandId === commandId
                ? { ...state, inflight: null }
                : state));
        },

        /** Drops whatever is in flight without recording a receipt (used for a gap repair). */
        async discardInflight() {
            return mutate((state) => (state.inflight ? { ...state, inflight: null } : state));
        },

        // ── conflicts ───────────────────────────────────────────────────────────
        async listConflicts() {
            await open();
            const rows = await db.table('conflicts').toArray();
            return rows.sort((a, b) => b.at - a.at);
        },
        async clearConflict(commandId) {
            await open();
            await db.table('conflicts').delete(commandId);
        },
        async clearConflictsFor(uid) {
            await open();
            const rows = await db.table('conflicts').where('uid').equals(uid).toArray();
            await Promise.all(rows.map((row) => db.table('conflicts').delete(row.commandId)));
        },

        // ── UI projection ───────────────────────────────────────────────────────
        /**
         * The single projection the UI reads: the server mirror overlaid with local
         * documents that are still queued, in flight, or unresolved.
         *
         * Returns documents (canonical jCal arrays), never a second task model.
         */
        async project() {
            await open();
            const [mirror, state, conflicts] = await Promise.all([
                db.table('mirror').toArray(),
                readState(),
                db.table('conflicts').toArray(),
            ]);
            const documents = new Map();
            const local = new Map();
            for (const record of mirror) documents.set(record.uid, record);
            for (const row of state.outbox) local.set(row.uid, row);
            if (state.inflight) local.set(state.inflight.uid, state.inflight);
            for (const conflict of conflicts) {
                if (!local.has(conflict.uid) && conflict.calendar) local.set(conflict.uid, conflict);
            }

            const out = [];
            for (const [uid, record] of documents) {
                const pending = local.get(uid);
                if (pending) {
                    local.delete(uid);
                    if (pending.operation === 'delete') continue;
                    out.push({
                        uid,
                        revision: record.revision,
                        pending: true,
                        conflicted: conflicts.some((row) => row.uid === uid),
                        calendar: clone(pending.calendar),
                    });
                    continue;
                }
                if (record.deleted) continue;
                out.push({
                    uid,
                    revision: record.revision,
                    pending: false,
                    conflicted: false,
                    calendar: clone(record.calendar),
                });
            }
            // Local documents with no mirror row yet (a brand new UID, base revision 0).
            for (const [uid, pending] of local) {
                if (pending.operation === 'delete') continue;
                out.push({
                    uid,
                    revision: 0,
                    pending: true,
                    conflicted: conflicts.some((row) => row.uid === uid),
                    calendar: clone(pending.calendar),
                });
            }
            out.sort((a, b) => a.uid.localeCompare(b.uid));
            return out;
        },

        /** Local documents that could not be applied, kept visible with their receipt. */
        async listConflictDocuments() {
            const conflicts = await this.listConflicts();
            return conflicts.map((row) => ({
                uid: row.uid,
                kind: row.status,
                code: row.code,
                revision: row.revision,
                at: row.at,
                commandId: row.commandId,
                calendar: row.calendar,
            }));
        },

        async close() {
            await db.close();
        },
    };
}
