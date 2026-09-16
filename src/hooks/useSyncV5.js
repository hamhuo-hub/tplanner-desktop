/**
 * React binding for the single V5 engine.
 *
 * The projection is delivered by `engine.store.project()` (mirror overlaid with local
 * documents that are still queued/in flight), so components never keep their own model and
 * never merge anything themselves.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { currentEngine, getEngine } from '../syncV5/session.js';

const IDLE_STATUS = {
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
    lastSyncAt: 0,
    error: null,
};

export default function useSyncV5(config) {
    const { serverUrl } = config ?? {};
    const [status, setStatus] = useState(() => currentEngine()?.getStatus() ?? IDLE_STATUS);
    const [documents, setDocuments] = useState([]);
    const engineRef = useRef(null);

    useEffect(() => {
        if (!serverUrl) {
            setStatus(IDLE_STATUS);
            setDocuments([]);
            return undefined;
        }
        let disposed = false;
        const instance = getEngine({ serverUrl });
        engineRef.current = instance;
        setStatus({ ...instance.getStatus() });

        const reads = async (snapshot) => {
            if (disposed) return;
            setStatus({ ...snapshot });
            const projected = await instance.store.project();
            if (!disposed) setDocuments(projected);
        };
        const unsubscribe = instance.subscribe(reads);
        instance.start();
        // The first status may already be published before this listener attached.
        reads(instance.getStatus()).catch(() => {});

        return () => {
            disposed = true;
            unsubscribe();
        };
    }, [serverUrl]);

    const syncNow = useCallback(async () => {
        const instance = engineRef.current;
        if (!instance) return null;
        return instance.syncNow();
    }, []);

    const resolveConflict = useCallback(async (commandId, action) => {
        const instance = engineRef.current;
        if (!instance) return null;
        return instance.resolveConflict(commandId, action);
    }, []);

    const resetConnection = useCallback(async () => {
        const instance = engineRef.current;
        if (!instance) return null;
        return instance.reset();
    }, []);

    /** Persist one canonical document (or delete) and refresh the projection. */
    const persist = useCallback(async (calendar) => {
        const instance = engineRef.current;
        if (!instance) throw new Error('同步引擎未就绪');
        await instance.save(calendar);
    }, []);

    const removeDocument = useCallback(async (uid) => {
        const instance = engineRef.current;
        if (!instance) throw new Error('同步引擎未就绪');
        await instance.remove(uid);
    }, []);

    const refreshProjection = useCallback(async () => {
        const instance = engineRef.current;
        if (!instance) return;
        setDocuments(await instance.store.project());
    }, []);

    // A stable handle: effects in the app depend on this object, and it must not change
    // identity on every render just because the hook re-ran.
    return useMemo(() => ({
        ready: Boolean(engineRef.current),
        status,
        serverUrl,
        documents,
        syncNow,
        resolveConflict,
        resetConnection,
        persist,
        removeDocument,
        refreshProjection,
    }), [status, serverUrl, documents, syncNow, resolveConflict, resetConnection, persist, removeDocument, refreshProjection]);
}
