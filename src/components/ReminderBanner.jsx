import { useState } from 'react';
import { Bell, ChevronDown, ChevronUp } from 'lucide-react';
import { formatInTimeZone } from 'date-fns-tz';
import { useTranslation } from 'react-i18next';
/**
 * "Starting soon / ongoing" banner.
 *
 * Purely a read of DTSTART/DUE of scheduled records — the client has no custom alarm
 * scheduler and this banner never fires anything (docs/sync-v5.md).
 */
export default function ReminderBanner({ events, onHighlight, travelTimezone }) {
    const { t } = useTranslation();
    const [isExpanded, setIsExpanded] = useState(false);

    const now = new Date();
    const windowMs = 90 * 60 * 1000; // 90 min ahead (3× lead time)

    const scheduled = events.filter(e => e.kind === 'task' && e.start instanceof Date
        && !Number.isNaN(e.start.getTime()));

    const upcoming = scheduled.filter(e =>
        !e.completed &&
        e.start > now &&
        e.start.getTime() - now.getTime() <= windowMs
    ).sort((a, b) => a.start - b.start);

    const ongoing = scheduled.filter(e =>
        !e.completed &&
        e.start <= now &&
        e.end > now
    ).sort((a, b) => a.start - b.start);

    const reminders = [...ongoing, ...upcoming];

    if (reminders.length === 0) return null;

    const tz = travelTimezone || 'Asia/Shanghai';
    const display = isExpanded ? reminders : reminders.slice(0, 3);
    const hasMore = reminders.length > 3;

    return (
        <div className="banner banner--reminder reminder-banner">
            <Bell size={15} style={{ flexShrink: 0, marginTop: 2, color: 'var(--clr-blue)' }} />
            <div style={{ flex: 1 }}>
                <p className="banner-title">{t('reminder.upcoming')}</p>
                <ul style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3, listStyle: 'none' }}>
                    {display.map(ev => {
                        const isNow = ev.start <= now;
                        return (
                            <li key={ev.id}>
                                <button
                                    onClick={() => onHighlight({ type: 'reminder', start: ev.start, end: ev.end })}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, padding: 0, fontFamily: 'var(--font-body)', fontSize: 'var(--tp-profile-meta-font-size)', color: 'var(--clr-text)', textAlign: 'left' }}
                                >
                                    <strong style={{ color: 'var(--clr-blue)' }}>{ev.title}</strong>
                                    <span className="banner-tag">
                                        {`${formatInTimeZone(ev.start, tz, 'HH:mm')}–${formatInTimeZone(ev.end, tz, 'HH:mm')}`}
                                    </span>
                                    {isNow && (
                                        <span className="banner-tag" style={{ background: 'var(--tp-semantic-color-info-background)', color: 'var(--tp-semantic-color-info)' }}>
                                            {t('reminder.ongoing')}
                                        </span>
                                    )}
                                </button>
                            </li>
                        );
                    })}
                </ul>
                {hasMore && (
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, fontFamily: 'var(--font-display)', fontSize: 'var(--tp-profile-meta-font-size)', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--clr-blue)' }}
                    >
                        {isExpanded
                            ? <><ChevronUp size={12} /> {t('actions.showLess')}</>
                            : <><ChevronDown size={12} /> {t('actions.showAll', { count: reminders.length })}</>
                        }
                    </button>
                )}
            </div>
        </div>
    );
}
