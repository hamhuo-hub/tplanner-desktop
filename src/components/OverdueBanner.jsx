import { useState } from 'react';
import { AlertCircle, Clock, ChevronDown, ChevronUp } from 'lucide-react';
import { formatInTimeZone } from 'date-fns-tz';
import { differenceInCalendarDays, differenceInHours, addDays, endOfDay } from 'date-fns';
import { useTranslation } from 'react-i18next';
/**
 * Deadline of a record: DUE when it exists, otherwise DTSTART. Rows are the canonical jCal
 * projection, so a record with no time at all has no deadline and is never listed here.
 */
function deadline(row) {
    return row.due ?? row.start;
}

function daysLabel(ev, now, t) {
    const d = deadline(ev);
    const days = differenceInCalendarDays(d, now);
    const hours = differenceInHours(d, now);
    if (days === 0) return hours <= 0 ? t('task.dueNow') : t('task.dueToday');
    if (days === 1) return t('task.dueTomorrow');
    return t('task.dueInDays', { count: days });
}

export default function OverdueBanner({ events, onHighlight, travelTimezone }) {
    const { t } = useTranslation();
    const [overdueExpanded, setOverdueExpanded] = useState(false);
    const [upcomingExpanded, setUpcomingExpanded] = useState(false);

    const now = new Date();
    const tz = travelTimezone || 'Asia/Shanghai';
    const pendingEvents = events.filter(row => row.kind === 'task' && deadline(row) !== null);

    // Overdue: an unfinished task whose deadline has passed.
    const overdueTasks = pendingEvents
        .filter(e => !e.completed && deadline(e) < now)
        .sort((a, b) => deadline(a) - deadline(b));

    // Upcoming: 只看今明两天（今天剩余 + 明天），不把所有未来事项都列进来。
    const upcomingCutoff = endOfDay(addDays(now, 1));
    const upcomingTasks = pendingEvents
        .filter(e => {
            const d = deadline(e);
            if (d > upcomingCutoff) return false;
            return !e.completed && d >= now;
        })
        .sort((a, b) => deadline(a) - deadline(b))
        .slice(0, 20);

    if (overdueTasks.length === 0 && upcomingTasks.length === 0) return null;

    const displayOverdue = overdueExpanded ? overdueTasks : overdueTasks.slice(0, 3);
    const displayUpcoming = upcomingExpanded ? upcomingTasks : upcomingTasks.slice(0, 3);

    return (
        <>
            {/* ── Overdue section ── */}
            {overdueTasks.length > 0 && (
                <div className="banner banner--overdue overdue-banner">
                    <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 2, color: 'var(--clr-gold)' }} />
                    <div style={{ flex: 1 }}>
                        <p className="banner-title">{t('task.overdueDetected')}</p>
                        <ul style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3, listStyle: 'none' }}>
                            {displayOverdue.map(task => (
                                <li key={task.id}>
                                    <button
                                        onClick={() => onHighlight({ type: 'overdue', start: new Date(task.start), end: new Date(task.end) })}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, padding: 0, fontFamily: 'var(--font-body)', fontSize: 'var(--tp-profile-meta-font-size)', color: 'var(--clr-text)', textAlign: 'left' }}
                                    >
                                        <strong style={{ color: 'var(--clr-gold)' }}>{task.title}</strong>
                                        <span className="banner-tag">
                                            {`${formatInTimeZone(task.end, tz, 'MMM d HH:mm')}`}
                                        </span>
                                        <span className="banner-tag" style={{ color: 'var(--clr-red)' }}>
                                            {t('task.overdue')}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {overdueTasks.length > 3 && (
                            <button onClick={() => setOverdueExpanded(!overdueExpanded)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, fontFamily: 'var(--font-display)', fontSize: 'var(--tp-profile-meta-font-size)', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--clr-gold-dim)' }}
                            >
                                {overdueExpanded
                                    ? <><ChevronUp size={12} /> {t('actions.showLess')}</>
                                    : <><ChevronDown size={12} /> {t('actions.showAll', { count: overdueTasks.length })}</>
                                }
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* ── Upcoming countdown section ── */}
            {upcomingTasks.length > 0 && (
                <div className="banner banner--upcoming upcoming-banner">
                    <Clock size={15} style={{ flexShrink: 0, marginTop: 2, color: 'var(--clr-teal)' }} />
                    <div style={{ flex: 1 }}>
                        <p className="banner-title">{t('task.upcoming')}</p>
                        <ul style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3, listStyle: 'none' }}>
                            {displayUpcoming.map(task => (
                                <li key={task.id}>
                                    <button
                                        onClick={() => onHighlight({ type: 'overdue', start: new Date(task.start), end: new Date(task.end) })}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, padding: 0, fontFamily: 'var(--font-body)', fontSize: 'var(--tp-profile-meta-font-size)', color: 'var(--clr-text)', textAlign: 'left' }}
                                    >
                                        <strong style={{ color: 'var(--clr-teal)' }}>{task.title}</strong>
                                        <span className="banner-tag">
                                            {formatInTimeZone(deadline(task), tz, 'MMM d HH:mm')}
                                        </span>
                                        <span className="banner-tag" style={{ background: 'var(--tp-semantic-color-info-background)', color: 'var(--clr-teal)', border: '1px solid var(--tp-semantic-color-info-background)' }}>
                                            {daysLabel(task, now, t)}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {upcomingTasks.length > 3 && (
                            <button onClick={() => setUpcomingExpanded(!upcomingExpanded)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, fontFamily: 'var(--font-display)', fontSize: 'var(--tp-profile-meta-font-size)', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--clr-teal)' }}
                            >
                                {upcomingExpanded
                                    ? <><ChevronUp size={12} /> {t('actions.showLess')}</>
                                    : <><ChevronDown size={12} /> {t('actions.showAll', { count: upcomingTasks.length })}</>
                                }
                            </button>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
