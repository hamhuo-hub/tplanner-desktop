/**
 * Sync V5 engine (docs/sync-v5.md "Client durability and conflicts").
 *
 * One transport, one packet, one authority. This module owns the whole client protocol:
 *
 *   save  -> persist the jCal document AND its outgoing command, then resolve
 *   flush -> send and retry the SINGLE immutable in-flight command
 *   pull  -> fetch the latest full snapshot and install it atomically
 *
 * Durability rules implemented here, one by one:
 *   1. A save never reports done before document + operation are durable. `store.enqueue`
 *      is a synchronous IndexedDB transaction; every mutating method awaits it first.
 *   2. Exactly one in-flight command, whose commandId/sequence/bytes are frozen. A retry
 *      re-sends the identical command, so the server's idempotency rule applies.
 *   3. Unsent edits to one UID coalesce in the outbox (`store.enqueue` replaces the row).
 *   4. A local successor's baseRevision advances only from its own predecessor's applied
 *      receipt, never from a mirror another device moved.
 *   5. Snapshots install in a single transaction; an applied command is released only
 *      once a snapshot covering its receipt revision has been installed.
 *   6. A different serverId or an older revision never overwrites state: it becomes an
 *      explicit `needsReset` choice. `reset()` is user-triggered and clears everything.
 *   7. Conflicts/rejections keep their local document until the user discards or reapplies.
 *   8. Refresh is a bounded periodic + foreground full-snapshot pull. No delta codec,
 *      no long polling, no notification channel.
 */
import { createStore } from './store.js';
import { createTransport } from './transport.js';
import { JcalDocument } from '../../sync-v5/jcal.mjs';

/** Bounded automatic refresh; the manual/foreground refresh is independent of it. */
export const PERIODIC_REFRESH_MS = 60_000;
/** A single flush retries the same command; this only bounds pathological server loops. */
const MAX_STEPS_PER_FLUSH = 512;

function createEmitter() {
    const listeners = new Set();
    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        emit(payload) {
            for (const listener of [...listeners]) {
                try {
                    listener(payload);
                } catch (error) {
                    console.error('[syncV5] listener failed', error);
                }
            }
        },
    };
}

export function createSyncEngine({
    serverUrl,
    token,
    store = createStore(),
    transport = null,
    fetchFn,
    periodicMs = PERIODIC_REFRESH_MS,
    now = () => Date.now(),
} = {}) {
    const emitter = createEmitter();
    const client = transport ?? createTransport({ baseUrl: serverUrl, token, ...(fetchFn ? { fetchFn } : {}) });

    const status = {
        phase: 'idle',
        message: '',
        serverId: null,
        revision: 0,
        deviceId: null,
        nextSequence: 1,
        pending: 0,
        inFlight: false,
        conflicts: [],
        documents: [],
        needsReset: null,
        // Device-sequence mismatch the client must not paper over. Populated with the
        // server's expectedSequence; only an explicit reset/reconnect resolves it.
        sequenceMismatch: null,
        lastSyncAt: 0,
        error: null,
    };

    // Two serialization chains, never nested:
    //   queueChain — protocol order (one command in flight, one sequence at a time);
    //   storeChain — local durability (a save/flush is a Dexie transaction).
    // They stay separate so a retrying upload can never block a local save, and both are
    // explicit so `reset()` cannot deadlock itself.
    let queueChain = Promise.resolve();
    let storeChain = Promise.resolve();
    let timer = null;
    let running = false;
    let foreground = null;
    let online = null;
    let projectChain = Promise.resolve();

    const enqueue = (kind, operation) => {
        const chain = kind === 'queue' ? queueChain : storeChain;
        const result = chain.then(operation);
        const settled = result.then(() => undefined, () => undefined);
        if (kind === 'queue') queueChain = settled;
        else storeChain = settled;
        return result;
    };
    const serializeQueue = (operation) => enqueue('queue', operation);
    const serializeStore = (operation) => enqueue('store', operation);

    async function refreshProjection() {
        projectChain = projectChain.then(async () => {
            const [documents, conflicts, queue, meta] = await Promise.all([
                store.project(),
                store.listConflictDocuments(),
                store.listQueue(),
                store.getMeta(),
            ]);
            Object.assign(status, {
                documents,
                conflicts,
                pending: queue.outbox.length + (queue.inflight ? 1 : 0),
                inFlight: Boolean(queue.inflight),
                serverId: meta.serverId,
                revision: meta.revision,
                deviceId: meta.deviceId,
                nextSequence: meta.nextSequence,
            });
            emitter.emit(status);
        }).catch((error) => {
            console.error('[syncV5] projection failed', error);
        });
        return projectChain;
    }

    /**
     * Sends the one in-flight command, records its receipt and advances the queue.
     * Never mints a new sequence while a command is in flight: `store.stageCommand`
     * skips staging until the previous command is released, and a transport failure
     * leaves the same command (same commandId, same sequence) in place for the retry.
     */
    async function runFlush() {
        let steps = 0;
        for (;;) {
            if (status.sequenceMismatch) return; // an explicit reset is required first
            if (steps >= MAX_STEPS_PER_FLUSH) {
                throw new Error('同步循环超过上限，请稍后重试');
            }
            steps += 1;

            const state = await store.listQueue();
            if (state.inflight && state.inflight.status !== 'inflight') {
                // Crash between recording a receipt and releasing the command. A snapshot
                // that covers the receipt revision releases it; otherwise retry it, which
                // is idempotent on the server because commandId + sequence + bytes match.
                const inflight = state.inflight;
                if (inflight.appliedRevision !== null && inflight.appliedRevision !== undefined) {
                    const mirror = await store.getMirror(inflight.uid);
                    if (mirror && mirror.revision >= inflight.appliedRevision) {
                        await store.clearApplied(inflight.commandId);
                        continue;
                    }
                }
                await store.stageCommand();
            } else if (!state.inflight) {
                const staged = await store.stageCommand();
                if (!staged.inflight) return; // queue drained
            }

            const current = (await store.listQueue()).inflight;
            if (!current) return;
            const command = {
                commandId: current.commandId,
                sequence: current.sequence,
                operation: current.operation,
                baseRevision: current.baseRevision,
                ...(current.operation === 'delete'
                    ? { uid: current.uid }
                    : { calendar: current.calendar }),
            };

            status.phase = 'uploading';
            emitter.emit(status);

            let response;
            try {
                response = await client.sendBatch({ deviceId: status.deviceId, commands: [command] });
            } catch (error) {
                // RETRY SEMANTICS (agreed with the server):
                //   sequence == expected -> NEW command, the normal path.
                //   sequence <  expected -> REPLAY. The server answers from the stored
                //     receipt when commandId + deviceId + sequence + content fingerprint all
                //     match, which is exactly what re-sending an unchanged in-flight command
                //     is; it only returns SEQUENCE_GAP when no such receipt exists.
                //   sequence >  expected -> a genuine gap; SEQUENCE_GAP, nothing accepted.
                // A SEQUENCE_GAP therefore means this command identity is unknown to the
                // server and retrying can never make it durable. Dropping it would silently
                // lose a local edit and re-using the sequence could duplicate a record, so we
                // stop uploading and surface an explicit reset/reconnect choice instead.
                if (error?.code === 'SEQUENCE_GAP') {
                    status.sequenceMismatch = {
                        expectedSequence: error.body?.expectedSequence ?? null,
                        deviceId: status.deviceId,
                        sequence: current.sequence,
                        commandId: current.commandId,
                    };
                    status.message = '设备序号与服务器不一致，需要重置连接后重新同步';
                    status.phase = 'error';
                    emitter.emit(status);
                    const mismatch = new Error(status.message);
                    mismatch.code = 'SEQUENCE_GAP';
                    throw mismatch;
                }
                throw error;
            }

            const receipt = response.receipts.find((row) => row.commandId === current.commandId)
                ?? { commandId: current.commandId, sequence: current.sequence, status: 'rejected', revision: 0, code: 'MISSING_RECEIPT' };

            if (receipt.status === 'applied') {
                await store.recordReceipt(current.commandId, receipt);
                await releaseApplied(current);
                continue;
            }

            // conflict / rejected: the local document stays visible with its receipt until
            // the user discards it or reapplies it against the current record revision.
            await store.recordConflict(receipt, current.uid, current.calendar);
            await store.clearApplied(current.commandId);
        }
    }

    /**
     * Releases an applied command once the mirror shows its record at/after the receipt
     * revision. `installedRevision` (the newest snapshot the server returned alongside
     * the receipt) is the normal path; the mirror check covers a restart.
     */
    async function releaseApplied(current) {
        const appliedRevision = (await store.listQueue()).inflight?.appliedRevision ?? null;
        const meta = await store.getMeta();
        const mirror = await store.getMirror(current.uid);
        const covered = (appliedRevision !== null && meta.revision >= appliedRevision)
            || (mirror !== null && appliedRevision !== null && mirror.revision >= appliedRevision);
        if (covered) await store.clearApplied(current.commandId);
    }

    /** Atomically installs a snapshot unless it would silently replace a different server. */
    async function installSnapshot(snapshot) {
        if (status.sequenceMismatch) {
            // Uploading is blocked, so installing a snapshot could still hide the mismatch.
            status.needsReset = {
                reason: 'sequence-mismatch',
                current: status.deviceId,
                incoming: status.sequenceMismatch.expectedSequence,
            };
            return { installed: false, reason: 'sequence-mismatch' };
        }
        const meta = await store.getMeta();
        if (meta.serverId && meta.serverId !== snapshot.serverId) {
            status.needsReset = {
                reason: 'server-changed',
                current: meta.serverId,
                incoming: snapshot.serverId,
            };
            status.message = '同步服务器已更换，需要重置连接';
            emitter.emit(status);
            return { installed: false, reason: 'server-changed' };
        }
        if (!meta.serverId && snapshot.serverId) await store.setServerId(snapshot.serverId);
        if (snapshot.revision < meta.revision) {
            status.needsReset = {
                reason: 'revision-regressed',
                current: meta.revision,
                incoming: snapshot.revision,
            };
            status.message = `服务器修订号回退（本机 v${meta.revision} → 服务器 v${snapshot.revision}），需要重置连接`;
            emitter.emit(status);
            return { installed: false, reason: 'revision-regressed' };
        }

        await store.installSnapshot({
            serverId: snapshot.serverId,
            revision: snapshot.revision,
            records: snapshot.records,
        });

        // A snapshot also settles any conflict whose server revision is now visible, but
        // the local document stays until the user acts: only the receipt is retired here.
        const conflictUids = new Set(snapshot.records.map((record) => record.uid));
        for (const conflict of await store.listConflicts()) {
            if (!conflictUids.has(conflict.uid)) continue;
            const record = snapshot.records.find((row) => row.uid === conflict.uid);
            if (record && record.revision > conflict.revision) await store.clearConflict(conflict.commandId);
        }

        // Release an applied command whose receipt revision this snapshot now covers.
        const inflight = (await store.listQueue()).inflight;
        if (inflight && inflight.appliedRevision !== null && inflight.appliedRevision !== undefined
            && snapshot.revision >= inflight.appliedRevision) {
            await store.clearApplied(inflight.commandId);
        }
        status.needsReset = null;
        status.sequenceMismatch = null;
        await refreshProjection();
        return { installed: true, reason: 'installed', revision: snapshot.revision };
    }

    async function engine_flush() {
        const queue = await store.countQueue();
        if (queue === 0) return { sent: 0 };
        status.phase = 'syncing';
        status.error = null;
        emitter.emit(status);
        await runFlush();
        await refreshProjection();
        return { sent: queue };
    }

    async function pull() {
        status.phase = 'downloading';
        emitter.emit(status);
        const snapshot = await client.fetchSnapshot();
        const result = await installSnapshot(snapshot);
        status.lastSyncAt = now();
        return result;
    }

    /** The durable local write: document + outgoing operation, then the projection. */
    async function writeDocument(calendar, { operation = 'put', baseRevision = null } = {}) {
        const document = calendar instanceof JcalDocument ? calendar : new JcalDocument(calendar);
        const uid = document.uid;
        let base = baseRevision;
        if (base === null) {
            const mirror = await store.getMirror(uid);
            base = mirror ? mirror.revision : 0;
        }
        await store.enqueue({ uid, operation, calendar: document.calendar, baseRevision: base });
        await refreshProjection();
        return { uid, baseRevision: base };
    }

    return {
        store,
        transport: client,
        subscribe: emitter.subscribe,
        getStatus: () => status,

        /**
         * Persist one locally edited canonical document. Resolves only after the document
         * and its outgoing command are both durable. `baseRevision` comes from the mirror
         * unless the caller (a successor of an in-flight save) already knows better.
         */
        save(calendar, options = {}) {
            return serializeStore(() => writeDocument(calendar, options));
        },

        /** Local delete. A tombstone needs the current record revision as its guard. */
        remove(uid) {
            return serializeStore(async () => {
                const mirror = await store.getMirror(uid);
                await store.enqueue({ uid, operation: 'delete', baseRevision: mirror ? mirror.revision : 0 });
                await refreshProjection();
            });
        },

        /** Manual/foreground refresh: drain the queue, then pull the latest snapshot. */
        syncNow() {
            return serializeQueue(async () => {
                try {
                    await engine_flush();
                    const result = await pull();
                    status.phase = 'idle';
                    status.message = '';
                    status.error = null;
                    emitter.emit(status);
                    return result;
                } catch (error) {
                    status.phase = 'error';
                    status.error = error?.message || String(error);
                    status.message = status.error;
                    emitter.emit(status);
                    throw error;
                }
            });
        },

        flush() {
            return serializeQueue(() => engine_flush());
        },

        pull() {
            return serializeQueue(() => pull());
        },

        /** `discard` drops the local document's claim; `reapply` re-queues it as a fresh edit. */
        resolveConflict(commandId, action) {
            return serializeStore(async () => {
                const conflicts = await store.listConflicts();
                const conflict = conflicts.find((row) => row.commandId === commandId);
                if (!conflict) return null;
                if (action === 'discard') {
                    await store.clearConflict(commandId);
                } else if (action === 'reapply') {
                    if (!conflict.calendar) throw new Error('冲突项没有本地文档可重新提交');
                    const mirror = await store.getMirror(conflict.uid);
                    await store.clearConflict(commandId);
                    await store.enqueue({
                        uid: conflict.uid,
                        operation: 'put',
                        calendar: conflict.calendar,
                        baseRevision: mirror ? mirror.revision : 0,
                    });
                } else {
                    throw new Error(`未知的冲突处理动作：${action}`);
                }
                await refreshProjection();
                return action;
            });
        },

        /**
         * Explicit user action only. Clears mirror, queue, conflicts, sequences and the
         * stored serverId, then resynchronizes from the server's full snapshot.
         */
        reset() {
            return serializeQueue(async () => {
                await store.reset();
                status.needsReset = null;
                status.sequenceMismatch = null;
                await refreshProjection();
                const result = await pull();
                status.phase = 'idle';
                status.message = '';
                emitter.emit(status);
                return result;
            });
        },

        /** Bounded periodic + foreground refresh. Never long-polls, never streams deltas. */
        start() {
            if (running) return;
            running = true;
            const tick = () => {
                serializeQueue(async () => {
                    try {
                        await engine_flush();
                        await pull();
                        status.phase = 'idle';
                        status.message = '';
                        status.error = null;
                    } catch (error) {
                        status.phase = 'error';
                        status.error = error?.message || String(error);
                        status.message = status.error;
                    }
                    emitter.emit(status);
                }).catch(() => { /* the status above already reports it */ });
            };
            timer = setInterval(tick, periodicMs);
            if (typeof document !== 'undefined' && document.addEventListener) {
                foreground = () => { tick(); };
                document.addEventListener('visibilitychange', foreground);
            }
            if (typeof window !== 'undefined' && window.addEventListener) {
                online = () => { tick(); };
                window.addEventListener('online', online);
            }
            tick();
        },

        stop() {
            running = false;
            if (timer) clearInterval(timer);
            timer = null;
            if (typeof document !== 'undefined' && document.removeEventListener && foreground) {
                document.removeEventListener('visibilitychange', foreground);
            }
            if (typeof window !== 'undefined' && window.removeEventListener && online) {
                window.removeEventListener('online', online);
            }
        },

        close() {
            this.stop();
            return store.close();
        },
    };
}
