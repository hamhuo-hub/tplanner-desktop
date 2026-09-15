import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Wifi, RefreshCw, Server, AlertTriangle, RotateCcw, Trash2 } from 'lucide-react';
import { JcalDocument } from '../../sync-v5/jcal.mjs';
import { DEFAULT_SERVER_URL } from '../syncV5/session.js';

function conflictTitle(calendar) {
    try {
        return new JcalDocument(calendar).title || '—';
    } catch {
        return '—';
    }
}

const STATUS_COLOR = {
    idle: 'var(--clr-text-dim)',
    syncing: 'var(--clr-gold)',
    uploading: 'var(--clr-gold)',
    downloading: 'var(--clr-gold)',
    error: 'var(--clr-red)',
};

/**
 * Sync status, server address and conflict surface.
 *
 * Sync V5 has exactly ONE transport, so there is no separate LAN peer protocol to configure:
 * this is the LAN/remote address surface for the same HTTP API, which is why the original
 * component name is kept. The token is entered at sign-in; the address is shown here.
 *
 * The contract keeps `conflict`/`rejected` receipts together with their local jCal document,
 * so each entry offers exactly two actions: discard the local claim, or reapply it against
 * the current record revision. A serverId change, a revision regression or a device-sequence
 * mismatch becomes an explicit reset choice and is never a silent overwrite.
 */
export default function LanSync({ sync, onOpenRecord }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const { status } = sync;

    const act = async (operation) => {
        setBusy(true);
        setMessage('');
        try {
            await operation();
        } catch (error) {
            setMessage(error?.message || String(error));
        } finally {
            setBusy(false);
        }
    };

    const color = STATUS_COLOR[status.phase] ?? 'var(--clr-text-dim)';
    const conflicts = status.conflicts ?? [];
    const resetReason = status.needsReset?.reason;

    return (
        <div style={{ position: 'relative' }}>
            <button
                className="btn btn--ghost"
                onClick={() => setOpen((value) => !value)}
                title={t('sync.title')}
                style={{ color: status.phase === 'error' || conflicts.length > 0 ? 'var(--clr-red)' : undefined }}
            >
                <Wifi size={13} />
                {conflicts.length > 0 && <span className="sync-badge">{conflicts.length}</span>}
            </button>

            {open && (
                <div className="tp-popover" style={{ position: 'absolute', top: '100%', right: 0, zIndex: 300, width: 360, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--tp-profile-meta-font-size)', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--clr-text-dim)' }}>
                        {t('sync.title')}
                    </span>

                    <div className="sync-row">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <Server size={11} /> {sync.serverUrl || DEFAULT_SERVER_URL}
                        </span>
                    </div>
                    <div className="sync-row">
                        <span style={{ color }}>{t(`sync.phase.${status.phase}`, status.phase)}</span>
                        <span>{status.serverId ? t('sync.revision', { revision: status.revision }) : t('sync.neverSynced')}</span>
                    </div>
                    <div className="sync-row">
                        <span>{t('sync.pending', { count: status.pending })}</span>
                        <span className="sync-device">{status.deviceId ?? '—'}</span>
                    </div>

                    {status.needsReset && (
                        <div className="sync-warning">
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <AlertTriangle size={13} />
                                <span>
                                    {resetReason === 'server-changed' && t('sync.serverChanged')}
                                    {resetReason === 'revision-regressed' && t('sync.revisionRegressed')}
                                    {resetReason === 'sequence-mismatch' && t('sync.sequenceMismatch')}
                                </span>
                            </div>
                            <p className="sync-warning__detail">
                                {String(status.needsReset.current)} → {String(status.needsReset.incoming)}
                            </p>
                            <button className="btn btn--danger" disabled={busy} onClick={() => act(() => sync.resetConnection())}>
                                <RotateCcw size={12} /> {t('sync.reset')}
                            </button>
                            <p className="sync-warning__detail">{t('sync.resetHint')}</p>
                        </div>
                    )}

                    {conflicts.length > 0 && (
                        <div className="sync-conflicts">
                            <span className="sync-conflicts__title">{t('sync.conflicts', { count: conflicts.length })}</span>
                            {conflicts.map((conflict) => (
                                <div key={conflict.commandId} className="sync-conflict">
                                    <button
                                        type="button"
                                        className="sync-conflict__title"
                                        onClick={() => onOpenRecord?.(conflict.uid)}
                                        title={conflict.uid}
                                    >
                                        {conflict.calendar ? conflictTitle(conflict.calendar) : conflict.uid}
                                    </button>
                                    <span className="sync-conflict__code">
                                        {conflict.kind}{conflict.code ? ` · ${conflict.code}` : ''} · v{conflict.revision}
                                    </span>
                                    <div className="sync-conflict__actions">
                                        <button className="btn btn--danger" disabled={busy || !conflict.calendar}
                                            onClick={() => act(() => sync.resolveConflict(conflict.commandId, 'discard'))}>
                                            <Trash2 size={11} /> {t('sync.discard')}
                                        </button>
                                        <button className="btn" disabled={busy || !conflict.calendar}
                                            onClick={() => act(() => sync.resolveConflict(conflict.commandId, 'reapply'))}>
                                            <RefreshCw size={11} /> {t('sync.reapply')}
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {message && <span style={{ color: 'var(--clr-red)', fontSize: 'var(--tp-profile-meta-font-size)' }}>{message}</span>}
                    {status.lastSyncAt > 0 && (
                        <span className="sync-device">{t('sync.lastSync', { time: new Date(status.lastSyncAt).toLocaleTimeString() })}</span>
                    )}

                    <button className="btn btn--primary" disabled={busy || status.phase === 'syncing'} onClick={() => act(() => sync.syncNow())}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
                        <RefreshCw size={12} /> {t('actions.syncNow')}
                    </button>
                </div>
            )}
        </div>
    );
}
