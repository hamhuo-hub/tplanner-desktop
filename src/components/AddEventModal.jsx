import { useState, useEffect, useRef } from 'react';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { MAX_LENGTH_TITLE, TIMEZONES } from '../utils/constants';
import { categoryTokens } from '../design-system';
import { createTask } from '../syncV5/document.js';

import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    TextField,
    Button,
    ToggleButton,
    ToggleButtonGroup,
    Stack,
    Box,
    Typography,
    IconButton,
    FormControlLabel,
    Switch,
    Alert,
} from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { TimePicker } from '@mui/x-date-pickers/TimePicker';
import { PlusCircle, MinusCircle, Check } from 'lucide-react';
import NoteEditor from './NoteEditor';

/**
 * Create/edit ONE canonical VTODO document.
 *
 * There is deliberately no event/task/status type chooser: every record this editor writes
 * is a task. Recurrence is a single RRULE on the same document, and a record with no
 * schedule stays unscheduled instead of receiving an invented date.
 */
/** Wall clock in `zone` -> UTC instant to persist. */
function wallClockToInstant(wallClock, zone) {
    if (!wallClock) return Number.NaN;
    if (!zone) return wallClock.getTime();
    return fromZonedTime(format(wallClock, "yyyy-MM-dd'T'HH:mm:ss"), zone).getTime();
}

/** YYYY-MM-DD day key of a wall clock in `zone`, for DATE (date-only) values. */
function formatDateInZone(wallClock, zone) {
    return zone ? formatInTimeZone(wallClock, zone, 'yyyy-MM-dd') : format(wallClock, 'yyyy-MM-dd');
}

/** The editor's RRULE subset; an unsupported existing rule is preserved untouched. */
function ruleFrom(frequency, count) {
    if (!frequency || frequency === 'none') return null;
    const rule = { freq: frequency.toUpperCase() };
    if (count > 0) rule.count = count;
    return rule;
}

export default function AddEventModal({ isOpen, onClose, onSave, defaultDate, initialEvent, events = [] }) {
    const { t } = useTranslation();
    void events;

    const [title, setTitle] = useState('');
    const [startDate, setStartDate] = useState(null);
    const [endDate, setEndDate] = useState(null);
    const [eventTimezone, setEventTimezone] = useState(''); // Empty string means local time
    const [note, setNote] = useState('');
    const [checklist, setChecklist] = useState([]);
    const [colorId, setColorId] = useState(0);

    // Recurrence state. The editor offers a subset of RRULE; anything else stays intact.
    const [recurrenceType, setRecurrenceType] = useState('none');
    const [recurrenceCount, setRecurrenceCount] = useState(0);
    const [scheduled, setScheduled] = useState(true);

    const [allDay, setAllDay] = useState(false);
    const [scheduleDirty, setScheduleDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');
    const editSessionRef = useRef(0);

    useEffect(() => {
        editSessionRef.current += 1;
        if (!isOpen) return;
        setSaving(false);
        setScheduleDirty(false);
        setSaveError('');
        const savedZone = localStorage.getItem('tplanner_travel_timezone') || 'Asia/Shanghai';
        setEventTimezone(savedZone);

        if (initialEvent) {
            // Edit mode: everything comes from the canonical row/document.
            const hasSchedule = initialEvent.start !== null && initialEvent.start !== undefined;
            const dateOnly = hasSchedule && initialEvent.document?.date !== null && initialEvent.document?.date !== undefined;
            const zone = initialEvent.timeZone || savedZone;
            setTitle(initialEvent.title || '');
            setScheduled(hasSchedule);
            setAllDay(dateOnly);
            setStartDate(hasSchedule
                ? (dateOnly ? new Date(`${initialEvent.document.date}T00:00:00`) : new Date(initialEvent.start))
                : null);
            setEndDate(initialEvent.due !== null && initialEvent.due !== undefined ? new Date(initialEvent.due) : null);
            setNote(initialEvent.note || '');
            setChecklist(initialEvent.checklist || []);
            setColorId(initialEvent.colorId ?? 0);
            const rule = initialEvent.recurrence;
            setRecurrenceType(rule ? String(rule.freq || 'none').toLowerCase() : 'none');
            setRecurrenceCount(Number(rule?.count ?? 0) || 0);
            return;
        }

        // Create mode: an unscheduled task unless the caller pointed at a specific instant.
        const now = defaultDate || new Date();
        const start = new Date(now);
        if (!defaultDate) {
            start.setMinutes(0, 0, 0);
            start.setHours(start.getHours() + 1);
        }
        setTitle('');
        setScheduled(Boolean(defaultDate));
        setStartDate(start);
        setEndDate(new Date(start.getTime() + 60 * 60 * 1000));
        setAllDay(false);
        setNote('');
        setChecklist([]);
        setColorId(0);
        setRecurrenceType('none');
        setRecurrenceCount(0);
    }, [isOpen, defaultDate, initialEvent]);

    const handleSave = async () => {
        if (saving || !title.trim()) return;
        const session = editSessionRef.current;
        setSaving(true);
        setSaveError('');
        try {
            let document = initialEvent ? initialEvent.document : createTask({ title });
            document = document.withTitle(title.trim());
            document = document.withDescription(note);
            document = document.withColorId(colorId);
            document = document.withChecklist((checklist || []).filter(item => String(item.text || '').trim() !== ''));

            if (!scheduled) {
                // No invented date: a record with no time simply has no DTSTART/DUE, and a
                // repeating record cannot be anchored without one.
                document = document.withSchedule(null, null);
                document = document.withRecurrence(null);
            } else {
                if (!startDate || !endDate) throw new Error(t('event.invalidDates', '请选择开始和结束时间'));
                if (allDay) {
                    const day = `${formatDateInZone(startDate, eventTimezone)}`;
                    document = document.withDate(day);
                    if (scheduleDirty) document = document.withRecurrence(null);
                    const rule = allDay ? ruleFrom(recurrenceType, recurrenceCount) : null;
                    if (rule) document = document.withRecurrence(rule);
                } else {
                    const startMs = wallClockToInstant(startDate, eventTimezone);
                    let endMs = wallClockToInstant(endDate, eventTimezone);
                    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
                        throw new Error(t('event.invalidDates', '结束时间不能早于开始时间'));
                    }
                    if (endMs <= startMs) endMs = startMs + 60 * 60 * 1000;
                    document = document.withSchedule(startMs, endMs);
                    const rule = ruleFrom(recurrenceType, recurrenceCount);
                    document = document.withRecurrence(rule);
                }
            }

            await onSave(document);
            if (session === editSessionRef.current) onClose();
        } catch (error) {
            if (session === editSessionRef.current) setSaveError(error?.message || t('messages.saveError', '保存失败，请重试'));
        } finally {
            if (session === editSessionRef.current) setSaving(false);
        }
    };

    return (
        <>
            <Dialog open={isOpen} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth
                disableScrollLock
                closeAfterTransition={false}
            >
                <DialogTitle>
                    {initialEvent ? t('actions.edit') : t('actions.addEvent')}
                </DialogTitle>
                <DialogContent component="fieldset" disabled={saving} sx={{ border: 0, minWidth: 0, m: 0 }}>
                    <Stack spacing={3} sx={{ mt: 1 }}>
                        {saveError && <Alert severity="error">{saveError}</Alert>}
                        {initialEvent && recurrenceType !== 'none' && !['daily', 'weekly', 'monthly'].includes(recurrenceType) && <Alert severity="info">
                            {t('recurrence.unsupportedRule', '此任务使用较新版本的重复规则。普通编辑会保留原规则；可选择不重复或其他规则来更改。')}
                        </Alert>}

                        {/* Scheduling: an absent time stays absent */}
                        <Box>
                            <FormControlLabel
                                control={<Switch checked={scheduled} onChange={(event) => { setScheduleDirty(true); setScheduled(event.target.checked); }} size="small" />}
                                label={<Typography variant="body2" color="text.secondary">{t('event.scheduled')}</Typography>}
                            />
                            {!scheduled && (
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                    {t('event.noTimeHint')}
                                </Typography>
                            )}
                        </Box>

                        {scheduled && (
                        <Box sx={{ border: '1px solid', borderColor: 'divider', p: 1, borderRadius: 'var(--tp-semantic-radius-control)' }}>
                            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between">
                                <Typography variant="body2" color="text.secondary">
                                    {t('event.recurrence', 'Repeat')}
                                </Typography>
                                <ToggleButtonGroup
                                    value={recurrenceType}
                                    exclusive
                                    onChange={(e, val) => { if (val === null) return; setScheduleDirty(true); setRecurrenceType(val); if (val !== 'none' && recurrenceCount < 1) setRecurrenceCount(0); }}
                                    size="small"
                                >
                                    <ToggleButton value="none">{t('recurrence.none')}</ToggleButton>
                                    <ToggleButton value="daily">{t('recurrence.daily')}</ToggleButton>
                                    <ToggleButton value="weekly">{t('recurrence.weekly')}</ToggleButton>
                                    <ToggleButton value="monthly">{t('recurrence.monthly')}</ToggleButton>
                                </ToggleButtonGroup>
                            </Stack>
                            {recurrenceType !== 'none' && (
                                <Stack direction="row" spacing={2} sx={{ mt: 2 }} alignItems="center">
                                    <TextField
                                        label={t('recurrence.count')}
                                        type="number"
                                        size="small"
                                        value={recurrenceCount}
                                        onChange={(e) => setRecurrenceCount(Math.max(0, parseInt(e.target.value, 10) || 0))}
                                        inputProps={{ min: 0, max: 365 }}
                                        sx={{ width: 120 }}
                                    />
                                    <Typography variant="caption" color="text.secondary">
                                        {t('recurrence.countHint')}
                                    </Typography>
                                </Stack>
                            )}
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                                {t('recurrence.unsupportedPreserved')}
                            </Typography>
                        </Box>
                        )}

                        {/* Title */}
                        <TextField
                            autoFocus
                            label={t('event.title')}
                            fullWidth
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            inputProps={{ maxLength: MAX_LENGTH_TITLE }}
                            required
                        />

                        {/* Date & Time Pickers */}
                        {scheduled && (
                        <Stack spacing={2}>
                            {/* Date-only toggle: DATE values stay date-only */}
                            {(
                                <FormControlLabel
                                    control={
                                        <Switch
                                            checked={allDay}
                                            onChange={(e) => {
                                                setScheduleDirty(true);
                                                setAllDay(e.target.checked);
                                            }}
                                            size="small"
                                        />
                                    }
                                    label={
                                        <Typography variant="body2" color="text.secondary">
                                            {t('event.allDay')}
                                        </Typography>
                                    }
                                />
                            )}

                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="stretch">
                                <DatePicker
                                    label={t('event.startDate', 'Start Date')}
                                    value={startDate}
                                    onChange={(newValue) => { setScheduleDirty(true); setStartDate(newValue); }}
                                    slotProps={{ textField: { fullWidth: true } }}
                                />
                                {!allDay && (
                                    <TimePicker
                                        label={t('event.startTime', 'Start Time')}
                                        value={startDate}
                                        onChange={(newValue) => {
                                            setScheduleDirty(true);
                                            if (startDate && newValue) {
                                                const newDate = new Date(startDate);
                                                newDate.setHours(newValue.getHours());
                                                newDate.setMinutes(newValue.getMinutes());
                                                setStartDate(newDate);
                                            } else {
                                                setStartDate(newValue);
                                            }
                                        }}
                                        ampm={false}
                                        slotProps={{ textField: { fullWidth: true } }}
                                    />
                                )}
                            </Stack>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="stretch">
                                <DatePicker
                                    label={t('event.endDate', 'End Date')}
                                    value={endDate}
                                    onChange={(newValue) => { setScheduleDirty(true); setEndDate(newValue); }}
                                    slotProps={{ textField: { fullWidth: true } }}
                                />
                                {!allDay && (
                                    <TimePicker
                                        label={t('event.endTime', 'End Time')}
                                        value={endDate}
                                        onChange={(newValue) => {
                                            setScheduleDirty(true);
                                            if (endDate && newValue) {
                                                const newDate = new Date(endDate);
                                                newDate.setHours(newValue.getHours());
                                                newDate.setMinutes(newValue.getMinutes());
                                                setEndDate(newDate);
                                            } else {
                                                setEndDate(newValue);
                                            }
                                        }}
                                        ampm={false}
                                        slotProps={{ textField: { fullWidth: true } }}
                                    />
                                )}
                            </Stack>
                            <TextField
                                select
                                label={t('event.timezone', 'Timezone')}
                                value={eventTimezone}
                                onChange={(e) => { setScheduleDirty(true); setEventTimezone(e.target.value); }}
                                SelectProps={{
                                    native: true,
                                }}
                                size="small"
                                fullWidth
                            >
                                {TIMEZONES.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {t(`timezones.${option.value ? option.value.replace('/', '_') : 'default'}`, option.label)}
                                    </option>
                                ))}
                            </TextField>
                        </Stack>
                        )}

                        {/* Note */}
                        <Box>
                            <Typography variant="caption" color="text.secondary"
                                sx={{ display: 'block', mb: 0.5 }}
                            >
                                {t('event.note')}
                            </Typography>
                            <NoteEditor value={note} onChange={setNote} />
                        </Box>

                        {/* Checklist: one x-tplanner-checklist TEXT property on this record */}
                        {(
                            <Box>
                                <Typography variant="body2" color="text.secondary" gutterBottom>
                                    {t('event.checklist', 'Checklist')}
                                </Typography>
                                <Stack spacing={1}>
                                    {checklist.map((item, index) => (
                                        <Stack key={item.id || index} direction="row" spacing={1} alignItems="center">
                                            <TextField
                                                fullWidth
                                                size="small"
                                                value={item.text}
                                                onChange={(e) => {
                                                    const val = e.target.value;
                                                    setChecklist(checklist.map((it, i) =>
                                                        i === index ? { ...it, text: val } : it
                                                    ));
                                                }}
                                                placeholder={t('event.checklistItem', 'Item...')}
                                            />
                                            <IconButton
                                                size="small"
                                                color="error"
                                                aria-label={`${t('actions.delete')} ${item.text || t('event.checklistItem', 'Item...')}`}
                                                onClick={() => {
                                                    const newChecklist = checklist.filter((_, i) => i !== index);
                                                    setChecklist(newChecklist);
                                                }}
                                            >
                                                <MinusCircle size={20} />
                                            </IconButton>
                                        </Stack>
                                    ))}
                                    <Button
                                        startIcon={<PlusCircle size={16} />}
                                        size="small"
                                        onClick={() => setChecklist([...checklist, { id: crypto.randomUUID(), text: '', completed: false }])}
                                        sx={{ alignSelf: 'flex-start' }}
                                    >
                                        {t('actions.addItem', 'Add Item')}
                                    </Button>
                                </Stack>
                            </Box>
                        )}

                        {/* Color Picker */}
                        <Box>
                            <Typography variant="body2" color="text.secondary" gutterBottom>
                                {t('event.color')}
                            </Typography>
                            <div className="event-category-picker" role="group" aria-label={t('event.color')}>
                                {categoryTokens.map((category) => (
                                    <button
                                        type="button"
                                        key={category.id}
                                        className="event-category-option"
                                        aria-label={`${t('event.color')} ${category.id + 1}`}
                                        aria-pressed={colorId === category.id}
                                        title={`${t('event.color')} ${category.id + 1}`}
                                        style={{ backgroundColor: category.background, color: category.foreground, borderColor: category.border }}
                                        onClick={() => setColorId(category.id)}
                                    >
                                        <span className="event-category-option__swatch" style={{ backgroundColor: category.accent }} />
                                        {colorId === category.id && <Check size={16} aria-hidden="true" />}
                                    </button>
                                ))}
                            </div>
                        </Box>

                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={onClose} color="inherit" disabled={saving}>
                        {t('actions.cancel')}
                    </Button>
                    <Button onClick={handleSave} variant="contained" color="primary" disabled={saving}>
                        {t('actions.save')}
                    </Button>
                </DialogActions>
            </Dialog>

        </>
    );
}
