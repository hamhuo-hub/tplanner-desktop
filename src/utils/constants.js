/**
 * Shared UI constants for the V5 Task UI.
 *
 * Deliberately tiny: the record's own facts (kind, schedule, completion, category) live in
 * the canonical jCal document, so nothing here may describe a task.
 */
export const MAX_LENGTH_TITLE = 50;

/** Display timezones offered by the date/time pickers and the view timezone selector. */
export const TIMEZONES = [
    { value: '', label: 'Beijing Time (Default)' },
    { value: 'America/Los_Angeles', label: 'Los Angeles (PT)' },
    { value: 'America/New_York', label: 'New York (ET)' },
    { value: 'Europe/London', label: 'London (GMT)' },
    { value: 'Europe/Paris', label: 'Paris (CET)' },
    { value: 'Asia/Dubai', label: 'Dubai (GST)' },
    { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
    { value: 'Australia/Sydney', label: 'Sydney (AET)' },
    { value: 'Pacific/Auckland', label: 'Auckland (NZST/NZDT)' },
];
