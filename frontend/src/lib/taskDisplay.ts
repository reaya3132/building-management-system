/** Display helpers for a task, shared by the calendar page and the task detail
 * panel. Kept out of pages/TaskCalendar so the detail panel (also shown inside the
 * notification center) does not load the calendar page and FullCalendar with it. */
import type { EventType, RecurrenceRule, Task } from '../pages/TaskCalendar'

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  meeting: 'פגישה',
  task: 'משימה',
}

export const RECURRENCE_LABELS: Record<RecurrenceRule, string> = {
  '': 'ללא חזרות',
  daily: 'כל יום',
  weekly: 'כל שבוע',
  monthly: 'כל חודש',
  yearly: 'כל שנה',
}

/** Hebrew weekday names indexed by JS getDay() (0=Sunday .. 6=Saturday). */
export const WEEKDAY_LABELS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

/** Parse a "0,2,4" weekday string into a sorted unique number[] (0–6). */
export function parseWeekdays(value: string | null | undefined): number[] {
  if (!value) return []
  return Array.from(
    new Set(
      String(value)
        .split(',')
        .map((part) => parseInt(part.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    )
  ).sort((a, b) => a - b)
}

/** Ordinal (1st..5th / last) of a date within its month, by weekday. */
export function weekdayOrdinalInMonth(date: Date): number {
  return Math.floor((date.getDate() - 1) / 7) + 1
}

/** Human Hebrew summary of a task's recurrence settings (for the detail view). */
export function describeRecurrence(task: Task): string {
  const rule = (task.recurrence_rule || '') as RecurrenceRule
  if (!rule) return RECURRENCE_LABELS['']
  const interval = task.recurrence_interval && task.recurrence_interval > 1 ? task.recurrence_interval : 1
  const unitMap: Record<Exclude<RecurrenceRule, ''>, [string, string]> = {
    daily: ['כל יום', 'ימים'],
    weekly: ['כל שבוע', 'שבועות'],
    monthly: ['כל חודש', 'חודשים'],
    yearly: ['כל שנה', 'שנים'],
  }
  const [single, plural] = unitMap[rule as Exclude<RecurrenceRule, ''>]
  let text = interval === 1 ? single : `כל ${interval} ${plural}`
  if (rule === 'weekly') {
    const days = parseWeekdays(task.recurrence_weekdays)
    if (days.length > 0) text += ` (${days.map((d) => WEEKDAY_LABELS[d]).join(', ')})`
  }
  if (rule === 'monthly' && task.recurrence_monthly_mode === 'day_of_week' && task.start_time) {
    const start = new Date(task.start_time)
    text += ` (יום ${WEEKDAY_LABELS[start.getDay()]} ה-${weekdayOrdinalInMonth(start)} בחודש)`
  }
  if (task.recurrence_count && task.recurrence_count > 0) {
    text += ` · ${task.recurrence_count} פעמים`
  } else if (task.recurrence_end_date) {
    text += ` · עד ${task.recurrence_end_date}`
  }
  return text
}

/** True if the task spans a whole day (00:00–23:59) — i.e. a date-only task with no time range chosen. */
export function isAllDayTask(task: Pick<Task, 'start_time' | 'end_time'>): boolean {
  if (!task.start_time || !task.end_time) return false
  const start = new Date(task.start_time)
  const end = new Date(task.end_time)
  return (
    start.getHours() === 0 &&
    start.getMinutes() === 0 &&
    end.getHours() === 23 &&
    end.getMinutes() === 59
  )
}
