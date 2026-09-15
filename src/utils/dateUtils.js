import { startOfDay, addDays, areIntervalsOverlapping } from 'date-fns';

/**
 * Timeline range helpers.
 *
 * Rows are the read-only jCal projection from `src/syncV5/document.js`: the only instant
 * facts are `start` and `end`, and a record with no time has neither.
 */

/**
 * View range for the timeline: the earliest scheduled row (or today) plus 60 days.
 * Unscheduled records are ignored — they have no place on a time axis.
 *
 * @param {Array<{start: Date|null}>} rows
 * @param {Date|null} referenceDate
 * @returns {{startDate: Date, endDate: Date}}
 */
export const calculateTimelineRange = (rows, referenceDate = null) => {
    const today = startOfDay(new Date());
    let earliest = today;

    if (referenceDate) {
        earliest = startOfDay(referenceDate);
    } else {
        const scheduled = rows.filter(row => row.start instanceof Date && !Number.isNaN(row.start.getTime()));
        if (scheduled.length > 0) {
            const sorted = [...scheduled].sort((a, b) => a.start - b.start);
            earliest = startOfDay(sorted[0].start);
        }
    }

    return { startDate: earliest, endDate: addDays(earliest, 60) };
};

/**
 * Detects overlaps between unfinished tasks that actually occupy time.
 *
 * @param {Array<{id: string, completed: boolean, start: Date|null, end: Date|null}>} rows
 * @returns {Array<{eventId: string, clashWithId: string, overlapMinutes: number, start: Date, end: Date}>}
 */
export const checkForClashes = (rows) => {
    const clashes = [];
    // A record enters clash detection only when it has a real interval: two zero-length or
    // absent schedules cannot overlap, and a completed task no longer competes for time.
    const candidates = rows.filter(row => !row.completed
        && row.start instanceof Date && !Number.isNaN(row.start.getTime())
        && row.end instanceof Date && !Number.isNaN(row.end.getTime())
        && row.end > row.start);

    for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
            const a = candidates[i];
            const b = candidates[j];
            if (!areIntervalsOverlapping({ start: a.start, end: a.end }, { start: b.start, end: b.end })) continue;

            const overlapStart = new Date(Math.max(a.start, b.start));
            const overlapEnd = new Date(Math.min(a.end, b.end));
            const overlapMinutes = (overlapEnd - overlapStart) / (1000 * 60);

            clashes.push({ eventId: a.id, clashWithId: b.id, overlapMinutes, start: overlapStart, end: overlapEnd });
            clashes.push({ eventId: b.id, clashWithId: a.id, overlapMinutes, start: overlapStart, end: overlapEnd });
        }
    }

    return clashes;
};
