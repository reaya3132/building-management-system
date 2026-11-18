import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import type { RootState } from '../store'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import listPlugin from '@fullcalendar/list'
import interactionPlugin from '@fullcalendar/interaction'
import type { EventChangeArg, DatesSetArg, EventClickArg, DateSelectArg } from '@fullcalendar/core'
import type { EventDragStartArg } from '@fullcalendar/interaction'
import api from '../lib/api'
import { getToken } from '../lib/authCache'
import { Calendar, User, Plus, CalendarSync, Link2, Unlink, X, Send, Archive, Search } from 'lucide-react'
import Modal from '../components/Modal'
import ToastNotification, { useToast } from '../components/ToastNotification'
import { cn } from '../lib/utils'
import { formatTaskCode } from '../lib/taskCode'
import { updateUser } from '../store/slices/authSlice'
import { formatCalendarDay, getCalendarDayBothParts, getHebrewMonthRange, getHebrewMonthYearHeader, getJewishHolidays, getIslamicHolidays, getNextHebrewMonthStart, getPrevHebrewMonthStart, type CalendarDateDisplay } from '../lib/calendarUtils'
import './TaskCalendar.css'
import { PermissionGuard } from '../components/ui/PermissionGuard'
import OutlookMobileCalendar, { type MobileCalendarView } from '../components/task-management/OutlookMobileCalendar'
import BacklogPanel from '../components/task-management/BacklogPanel'
import CreateTaskModal, { type CreateTaskDefaults } from '../components/task-management/CreateTaskModal'
import TaskEditModal from '../components/task-management/TaskEditModal'
import TaskDetailModal from '../components/task-management/TaskDetailModal'
import {
  EVENT_TYPE_LABELS, RECURRENCE_LABELS, WEEKDAY_LABELS, describeRecurrence, isAllDayTask, parseWeekdays,
  weekdayOrdinalInMonth,
} from '../lib/taskDisplay'
// Re-exported: existing importers keep importing them from this module.
export { EVENT_TYPE_LABELS, describeRecurrence, isAllDayTask }

export interface UserForTask {
  id: number
  full_name: string
  calendar_color?: string | null
  avatar_url?: string | null
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'pending_closure'

export type EventType = 'meeting' | 'task'

export interface TaskLabelType {
  id: number
  name: string
  color: string
}

export type RecurrenceRule = '' | 'daily' | 'weekly' | 'monthly' | 'yearly'

export type MonthlyMode = 'day_of_month' | 'day_of_week'

/** How a recurring series ends: never, on a date, or after N occurrences. */
export type RecurrenceEndMode = 'never' | 'date' | 'count'

export interface Task {
  id: number
  title: string
  start_time: string | null
  end_time: string | null
  description: string | null
  status: TaskStatus
  event_type?: EventType
  assigned_to_user_id: number
  unique_tag: string
  /** משימה מחזורית: '' | 'daily' | 'weekly' | 'monthly' | 'yearly' */
  recurrence_rule?: RecurrenceRule
  /** תאריך סיום סדרת החזרות (אופציונלי) */
  recurrence_end_date?: string | null
  /** מרווח חזרה: כל N ימים/שבועות/חודשים/שנים */
  recurrence_interval?: number | null
  /** שבועי: ימי שבוע נבחרים, מספרים מופרדים בפסיק (0=ראשון .. 6=שבת) */
  recurrence_weekdays?: string | null
  /** חודשי: 'day_of_month' (לפי תאריך) או 'day_of_week' (לפי יום בשבוע) */
  recurrence_monthly_mode?: MonthlyMode | null
  /** סיום אחרי N מופעים (חלופי ל-recurrence_end_date) */
  recurrence_count?: number | null
  assigned_user_name?: string | null
  /** צבע לוח שנה של המשתמש המוקצה (מוגדר בהגדרות עובד) */
  assigned_user_color?: string | null
  /** תמונת פרופיל של המשתמש המוקצה */
  assigned_user_avatar?: string | null
  /** קבוצת המוקצים המלאה (המוקצה הראשי + נוספים), המזהה הראשי ראשון */
  assigned_to_user_ids?: number[]
  /** פרטי כל המוקצים לתצוגה (שם, אווטאר, צבע) */
  assignees?: TaskAssigneeType[]
  labels?: TaskLabelType[]
  participants?: TaskParticipantType[]
  attachments?: TaskAttachmentType[]
  /** תאריך שבו הלקוח/המשתמש המוקצה אישר קבלת המשימה */
  assignee_acknowledged_at?: string | null
  assignee_viewed_at?: string | null
  is_archived?: boolean
  archived_at?: string | null
  completed_at?: string | null
  requires_closure_approval?: boolean
  is_super_task?: boolean
  is_backlog?: boolean
  /** דירה משויכת (מודול דלפק הבניין) */
  apartment_id?: number | null
  /** בניין משויך (מודול דלפק הבניין) */
  building_id?: number | null
  /** יש תגובות/הודעות צ'אט חדשות שלא נקראו על ידי המשתמש הנוכחי (נקודה אדומה בסגנון וואטסאפ) */
  has_unread_messages?: boolean
  /** מספר הודעות הצ'אט שהמשתמש הנוכחי עדיין לא קרא (תג עם מספר בסגנון וואטסאפ) */
  unread_messages_count?: number
}

export interface TaskAttachmentType {
  id: number
  file_name: string
  file_url: string
}

/** A single co-owner assignee of a task (part of the full assignee set). */
export interface TaskAssigneeType {
  user_id: number
  full_name: string
  avatar_url?: string | null
  color?: string | null
}

export type ParticipantResponseStatus = 'pending' | 'accepted' | 'declined'

export interface TaskParticipantType {
  user_id: number
  full_name: string
  response_status: ParticipantResponseStatus
  avatar_url?: string | null
}

export interface TaskMessageType {
  id: number
  task_id: number
  user_id: number
  full_name: string
  avatar_url?: string | null
  message: string
  created_at: string
  edited_at?: string | null
  read_by_all?: boolean
  attachments?: TaskAttachmentType[]
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'מחכה לטיפול',
  in_progress: 'בטיפול',
  completed: 'טופלה',
  pending_closure: 'ממתין לאישור סגירה',
}

export const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
  pending: '#6B7280',
  in_progress: '#3B82F6',
  completed: '#10B981',
  pending_closure: '#F59E0B',
}

const USER_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444',
  '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16',
]

const WEEKDAY_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳']

/** Returns overdue info for a task that wasn't completed and has a due date in the past. */
function getOverdueInfo(task: Task): { delayText: string } | null {
  if (task.status === 'completed') return null
  const dueStr = task.end_time ?? task.start_time ?? null
  if (!dueStr) return null
  const due = new Date(dueStr)
  const now = new Date()
  if (due.getTime() >= now.getTime()) return null
  const diffMs = now.getTime() - due.getTime()
  const diffMins = Math.floor(diffMs / (60 * 1000))
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000))
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000))
  let delayText: string
  if (diffDays > 0) {
    const hours = Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
    delayText = hours > 0 ? `פיגור של ${diffDays} ימים ו-${hours} שעות` : `פיגור של ${diffDays} ימים`
  } else if (diffHours > 0) {
    const mins = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000))
    delayText = mins > 0 ? `פיגור של ${diffHours} שעות ו-${diffMins % 60} דקות` : `פיגור של ${diffHours} שעות`
  } else {
    delayText = `פיגור של ${diffMins} דקות`
  }
  return { delayText }
}

export const USER_CALENDAR_COLORS = USER_COLORS

/** Recurrence fields shared by the create and edit forms. */
export interface RecurrenceFormFields {
  recurrence_rule: RecurrenceRule
  recurrence_interval: number
  recurrence_weekdays: number[]
  recurrence_monthly_mode: MonthlyMode
  recurrence_end_mode: RecurrenceEndMode
  recurrence_end_date: string
  recurrence_count: string
}

/** Convert the form's recurrence fields into the API payload (used by both create and edit). */
export function buildRecurrencePayload(form: RecurrenceFormFields): {
  recurrence_rule: RecurrenceRule
  recurrence_interval: number
  recurrence_weekdays: string | null
  recurrence_monthly_mode: MonthlyMode | null
  recurrence_end_date: string | null
  recurrence_count: number | null
} {
  const rule = (form.recurrence_rule || '') as RecurrenceRule
  if (!rule) {
    return {
      recurrence_rule: '',
      recurrence_interval: 1,
      recurrence_weekdays: null,
      recurrence_monthly_mode: null,
      recurrence_end_date: null,
      recurrence_count: null,
    }
  }
  const interval = Math.max(1, Math.floor(form.recurrence_interval || 1))
  const weekdays =
    rule === 'weekly' && form.recurrence_weekdays.length > 0
      ? [...form.recurrence_weekdays].sort((a, b) => a - b).join(',')
      : null
  const monthlyMode = rule === 'monthly' ? form.recurrence_monthly_mode : null
  let endDate: string | null = null
  let count: number | null = null
  if (form.recurrence_end_mode === 'date') {
    endDate = form.recurrence_end_date.trim() || null
  } else if (form.recurrence_end_mode === 'count') {
    const parsed = parseInt(form.recurrence_count, 10)
    count = Number.isInteger(parsed) && parsed >= 1 ? parsed : null
  }
  return {
    recurrence_rule: rule,
    recurrence_interval: interval,
    recurrence_weekdays: weekdays,
    recurrence_monthly_mode: monthlyMode,
    recurrence_end_date: endDate,
    recurrence_count: count,
  }
}

/** Nth occurrence (1-based) of `weekday` (0–6) within month `year`/`monthIndex`, or null if it doesn't exist. */
function nthWeekdayOfMonth(year: number, monthIndex: number, weekday: number, ordinal: number): Date | null {
  const first = new Date(year, monthIndex, 1)
  const offset = (weekday - first.getDay() + 7) % 7
  const day = 1 + offset + (ordinal - 1) * 7
  const candidate = new Date(year, monthIndex, day)
  if (candidate.getMonth() !== monthIndex) return null // ordinal beyond this month (e.g. 5th Monday)
  return candidate
}

/**
 * Expand one task into its occurrences within [rangeStart, rangeEnd) for the calendar.
 * Supports daily/weekly/monthly/yearly with an interval ("every N"), weekly-on-specific-
 * weekdays, monthly-by-day-of-week, and ending by date OR after N occurrences.
 */
export function getTaskOccurrences(
  task: Task,
  rangeStart: Date,
  rangeEnd: Date
): { start: Date; end: Date }[] {
  const startTime = task.start_time
  const endTime = task.end_time
  if (!startTime || !endTime) return []
  const start = new Date(startTime)
  const end = new Date(endTime)
  const durationMs = end.getTime() - start.getTime()
  const rule = (task.recurrence_rule || '') as RecurrenceRule

  const occurrences: { start: Date; end: Date }[] = []
  if (!rule) {
    if (start.getTime() < rangeEnd.getTime() && end.getTime() > rangeStart.getTime()) {
      occurrences.push({ start, end })
    }
    return occurrences
  }

  const interval = Math.max(1, task.recurrence_interval || 1)
  const maxCount = task.recurrence_count && task.recurrence_count > 0 ? task.recurrence_count : null
  // recurrence_end_date is an inclusive whole day
  const seriesEnd = task.recurrence_end_date ? new Date(`${task.recurrence_end_date}T23:59:59`) : null
  const HARD_CAP = 1500
  const hours = start.getHours()
  const minutes = start.getMinutes()
  const seconds = start.getSeconds()

  let produced = 0 // total occurrences generated (for the count limit), regardless of visible range
  let iterations = 0

  const atTimeOfDay = (d: Date): Date => {
    const occ = new Date(d)
    occ.setHours(hours, minutes, seconds, 0)
    return occ
  }
  // Returns true to keep going, false to stop the whole series.
  const emit = (occStart: Date): boolean => {
    if (occStart.getTime() < start.getTime()) return true // before the real series start → skip but continue
    if (seriesEnd && occStart.getTime() > seriesEnd.getTime()) return false
    if (maxCount !== null && produced >= maxCount) return false
    produced++
    const occEnd = new Date(occStart.getTime() + durationMs)
    if (occStart.getTime() < rangeEnd.getTime() && occEnd.getTime() > rangeStart.getTime()) {
      occurrences.push({ start: occStart, end: occEnd })
    }
    return true
  }
  // Once we are past the visible range and there is no count limit, no later occurrence can fall in range.
  const pastRange = (d: Date) => maxCount === null && d.getTime() > rangeEnd.getTime()

  if (rule === 'daily') {
    const current = new Date(start)
    // Fast-forward near the visible range for old open-ended dailies (avoids the HARD_CAP).
    if (maxCount === null) {
      const dayMs = 86_400_000
      const gap = rangeStart.getTime() - end.getTime()
      if (gap > 0) {
        const steps = Math.floor(gap / (interval * dayMs))
        if (steps > 0) current.setDate(current.getDate() + steps * interval)
      }
    }
    while (iterations < HARD_CAP) {
      if (!emit(atTimeOfDay(current))) break
      current.setDate(current.getDate() + interval)
      if (pastRange(current)) break
      iterations++
    }
    return occurrences
  }

  if (rule === 'weekly') {
    const weekdays = parseWeekdays(task.recurrence_weekdays)
    const days = weekdays.length > 0 ? weekdays : [start.getDay()]
    // Anchor on the Sunday of the start's week, then advance whole interval-week blocks.
    const weekAnchor = new Date(start)
    weekAnchor.setDate(start.getDate() - start.getDay())
    weekAnchor.setHours(0, 0, 0, 0)
    let stop = false
    while (!stop && iterations < HARD_CAP) {
      for (const weekday of days) {
        const occDay = new Date(weekAnchor)
        occDay.setDate(weekAnchor.getDate() + weekday)
        if (!emit(atTimeOfDay(occDay))) { stop = true; break }
      }
      weekAnchor.setDate(weekAnchor.getDate() + 7 * interval)
      if (pastRange(weekAnchor)) break
      if (seriesEnd && weekAnchor.getTime() > seriesEnd.getTime()) break
      iterations++
    }
    return occurrences
  }

  // monthly / yearly: index-based stepping from the start month/year (avoids day-overflow drift).
  const monthlyMode = task.recurrence_monthly_mode === 'day_of_week' ? 'day_of_week' : 'day_of_month'
  const startWeekday = start.getDay()
  const startOrdinal = weekdayOrdinalInMonth(start)
  const startDayOfMonth = start.getDate()
  let step = 0
  while (iterations < HARD_CAP) {
    let occStart: Date | null = null
    if (rule === 'monthly') {
      const target = new Date(start.getFullYear(), start.getMonth() + step * interval, 1)
      const year = target.getFullYear()
      const monthIndex = target.getMonth()
      if (monthlyMode === 'day_of_week') {
        occStart = nthWeekdayOfMonth(year, monthIndex, startWeekday, startOrdinal)
      } else {
        const candidate = new Date(year, monthIndex, startDayOfMonth)
        occStart = candidate.getMonth() === monthIndex ? candidate : null // skip months without that day (e.g. 31st)
      }
    } else {
      // yearly
      const year = start.getFullYear() + step * interval
      const candidate = new Date(year, start.getMonth(), startDayOfMonth)
      occStart = candidate.getMonth() === start.getMonth() ? candidate : null // skip Feb 29 on non-leap years
    }
    if (occStart) {
      if (!emit(atTimeOfDay(occStart))) break
      if (pastRange(occStart)) break
    } else {
      // A skipped slot: still bail out if we've clearly run past the range/series.
      const probe = new Date(
        rule === 'monthly' ? start.getFullYear() : start.getFullYear() + step * interval,
        rule === 'monthly' ? start.getMonth() + step * interval : start.getMonth(),
        1
      )
      if (pastRange(probe)) break
      if (seriesEnd && probe.getTime() > seriesEnd.getTime()) break
    }
    step++
    iterations++
  }
  return occurrences
}

export const RECURRENCE_INTERVAL_UNITS: Record<Exclude<RecurrenceRule, ''>, string> = {
  daily: 'ימים',
  weekly: 'שבועות',
  monthly: 'חודשים',
  yearly: 'שנים',
}

/**
 * Outlook-style recurrence editor shared by the create and edit task forms.
 * Operates on the recurrence subset of a form via an onChange patch callback.
 */
export function RecurrenceEditor({
  value,
  onChange,
  startDate,
  idPrefix,
}: {
  value: RecurrenceFormFields
  onChange: (patch: Partial<RecurrenceFormFields>) => void
  startDate: Date | null
  idPrefix: string
}) {
  const rule = value.recurrence_rule
  const toggleWeekday = (weekday: number) => {
    const has = value.recurrence_weekdays.includes(weekday)
    const next = has
      ? value.recurrence_weekdays.filter((d) => d !== weekday)
      : [...value.recurrence_weekdays, weekday].sort((a, b) => a - b)
    onChange({ recurrence_weekdays: next })
  }
  const monthlyDayOfWeekLabel = startDate
    ? `יום ${WEEKDAY_LABELS[startDate.getDay()]} ה-${weekdayOrdinalInMonth(startDate)} בחודש`
    : 'לפי יום בשבוע'
  const monthlyDayOfMonthLabel = startDate ? `בכל ${startDate.getDate()} בחודש` : 'לפי תאריך בחודש'

  return (
    <div className="p-2 bg-slate-50 dark:bg-slate-900/20 rounded-lg border border-slate-200 dark:border-slate-700 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${idPrefix}-recurrence`} className="text-xs font-medium text-gray-700 dark:text-gray-300">חזרה</label>
        <select
          id={`${idPrefix}-recurrence`}
          value={rule}
          onChange={(e) => onChange({ recurrence_rule: e.target.value as RecurrenceRule })}
          className={cn(
            'px-2 py-1 border rounded text-sm',
            'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
          )}
        >
          {(Object.keys(RECURRENCE_LABELS) as RecurrenceRule[]).map((r) => (
            <option key={r || 'none'} value={r}>{RECURRENCE_LABELS[r]}</option>
          ))}
        </select>
        {rule && (
          <span className="flex items-center gap-1 text-sm text-gray-700 dark:text-gray-300">
            כל
            <input
              type="number"
              min={1}
              value={value.recurrence_interval}
              onChange={(e) => onChange({ recurrence_interval: Math.max(1, parseInt(e.target.value, 10) || 1) })}
              className={cn(
                'w-14 px-2 py-1 border rounded text-sm',
                'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
              )}
              aria-label="מרווח חזרה"
            />
            {RECURRENCE_INTERVAL_UNITS[rule as Exclude<RecurrenceRule, ''>]}
          </span>
        )}
      </div>

      {rule === 'weekly' && (
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">בימים (ריק = לפי יום ההתחלה)</p>
          <div className="flex flex-wrap gap-1">
            {WEEKDAY_SHORT.map((label, weekday) => {
              const active = value.recurrence_weekdays.includes(weekday)
              return (
                <button
                  key={weekday}
                  type="button"
                  onClick={() => toggleWeekday(weekday)}
                  className={cn(
                    'w-8 h-8 rounded-full text-xs font-medium border transition-colors',
                    active
                      ? 'bg-violet-600 text-white border-violet-600'
                      : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                  )}
                  title={WEEKDAY_LABELS[weekday]}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {rule === 'monthly' && (
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name={`${idPrefix}-monthly-mode`}
              checked={value.recurrence_monthly_mode === 'day_of_month'}
              onChange={() => onChange({ recurrence_monthly_mode: 'day_of_month' })}
            />
            <span>{monthlyDayOfMonthLabel}</span>
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name={`${idPrefix}-monthly-mode`}
              checked={value.recurrence_monthly_mode === 'day_of_week'}
              onChange={() => onChange({ recurrence_monthly_mode: 'day_of_week' })}
            />
            <span>{monthlyDayOfWeekLabel}</span>
          </label>
        </div>
      )}

      {rule && (
        <div className="flex flex-col gap-1 pt-1 border-t border-slate-200 dark:border-slate-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">סיום</p>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name={`${idPrefix}-end-mode`}
              checked={value.recurrence_end_mode === 'never'}
              onChange={() => onChange({ recurrence_end_mode: 'never' })}
            />
            <span>ללא סיום</span>
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name={`${idPrefix}-end-mode`}
              checked={value.recurrence_end_mode === 'date'}
              onChange={() => onChange({ recurrence_end_mode: 'date' })}
            />
            <span>עד תאריך</span>
            <input
              type="date"
              value={value.recurrence_end_date}
              onChange={(e) => onChange({ recurrence_end_date: e.target.value, recurrence_end_mode: 'date' })}
              className={cn(
                'px-2 py-1 border rounded text-sm',
                'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
              )}
              aria-label="תאריך סיום חזרות"
            />
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name={`${idPrefix}-end-mode`}
              checked={value.recurrence_end_mode === 'count'}
              onChange={() => onChange({ recurrence_end_mode: 'count' })}
            />
            <span>אחרי</span>
            <input
              type="number"
              min={1}
              value={value.recurrence_count}
              onChange={(e) => onChange({ recurrence_count: e.target.value, recurrence_end_mode: 'count' })}
              className={cn(
                'w-16 px-2 py-1 border rounded text-sm',
                'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
              )}
              aria-label="מספר מופעים"
            />
            <span>פעמים</span>
          </label>
        </div>
      )}
    </div>
  )
}

interface TaskCalendarProps {
  embedded?: boolean
  pendingBacklogCreate?: boolean
  onBacklogCreateConsumed?: () => void
}

export default function TaskCalendar({
  embedded,
  pendingBacklogCreate,
  onBacklogCreateConsumed,
}: TaskCalendarProps = {}) {
  const dispatch = useDispatch()
  const me = useSelector((state: RootState) => state.auth.me)
  const isAdmin = me?.role === 'Admin'
  const [tasks, setTasks] = useState<Task[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [users, setUsers] = useState<UserForTask[]>([])
  const [taskLabels, setTaskLabels] = useState<TaskLabelType[]>([])
  const [loading, setLoading] = useState(true)
  const [filterUserId, setFilterUserId] = useState<number | null>(me?.id ?? null)
  const didInitFilterRef = useRef(me?.id != null)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [mobileSelectedDate, setMobileSelectedDate] = useState<Date>(() => new Date())
  // dedupe by day so re-emitted ranges from the child don't cause refetch churn
  const handleMobileRangeChange = useCallback((start: Date, end: Date) => {
    setDateRange(prev => {
      if (prev) {
        const pad = (n: number) => String(n).padStart(2, '0')
        const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
        if (ymd(prev.start) === ymd(start) && ymd(prev.end) === ymd(end)) return prev
      }
      return { start, end }
    })
  }, [])
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [mobileView, setMobileView] = useState<MobileCalendarView>(() => {
    try {
      const saved = sessionStorage.getItem('taskCalendarMobileView')
      if (saved === 'day' || saved === 'week' || saved === 'workweek' || saved === 'month') return saved
    } catch {
      /* ignore */
    }
    return 'day'
  })
  useEffect(() => {
    try {
      sessionStorage.setItem('taskCalendarMobileView', mobileView)
    } catch {
      /* ignore */
    }
  }, [mobileView])
  // On refresh always show today's date in Gregorian (לוח לועזי) — no restore from sessionStorage
  const [dateRange, setDateRange] = useState<{ start: Date; end: Date } | null>(() => {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
    return { start, end }
  })
  const [currentViewType, setCurrentViewType] = useState<string>(() => {
    try {
      const saved = sessionStorage.getItem('taskCalendarView')
      if (saved && ['dayGridMonth', 'timeGridDay', 'timeGridWeek', 'timeGridWorkWeek', 'listWeek'].includes(saved)) return saved
    } catch {
      /* ignore */
    }
    // On phones, default to list/agenda view — much more productive than a cramped month grid.
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches) {
      return 'listWeek'
    }
    return 'dayGridMonth'
  })
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createAsBacklog, setCreateAsBacklog] = useState(false)
  const [backlogRefreshKey, setBacklogRefreshKey] = useState(0)
  // Pre-fill configuration handed to the shared CreateTaskModal when it opens
  // (e.g. a calendar drag-select supplies the chosen start/end time).
  const [createDefaults, setCreateDefaults] = useState<CreateTaskDefaults | undefined>(undefined)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  // The task being edited; the shared TaskEditModal owns its own form state and
  // seeds itself from this task. Null closes the modal.
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [outlookStatus, setOutlookStatus] = useState<{
    configured: boolean
    connected: boolean
    last_sync_at: string | null
  } | null>(null)
  const [outlookDisconnecting, setOutlookDisconnecting] = useState(false)
  const [updatingUserColorId, setUpdatingUserColorId] = useState<number | null>(null)
  const [dropConfirm, setDropConfirm] = useState<{
    taskId: number
    taskTitle: string
    oldStart: Date
    oldEnd: Date
    newStart: Date
    newEnd: Date
    customStart: string
    customEnd: string
    info: EventChangeArg | null
  } | null>(null)
  const [dropConfirmSaving, setDropConfirmSaving] = useState(false)
  const [calendarRefreshKey, setCalendarRefreshKey] = useState(0)
  const { toast, showToast, hideToast } = useToast()

  // Opens the shared create-task modal with the given pre-fill configuration.
  const openCreateModal = useCallback((defaults: CreateTaskDefaults, asBacklog = false) => {
    setCreateAsBacklog(asBacklog)
    setCreateDefaults(defaults)
    setShowCreateModal(true)
  }, [])

  // Opens the standard create-task modal pre-configured for a no-date backlog task.
  const openBacklogCreate = useCallback(() => {
    openCreateModal({ taskType: 'no_date' }, true)
  }, [openCreateModal])

  // When the parent (e.g. the BacklogPanel in TaskManagement) requests a backlog
  // create, open the no-date create modal exactly once and acknowledge consumption.
  // Works both when this component is already mounted (flag flips true) and when it
  // mounts with the flag already true (tab switch via AnimatePresence mode="wait").
  useEffect(() => {
    if (!pendingBacklogCreate) return
    openBacklogCreate()
    onBacklogCreateConsumed?.()
  }, [pendingBacklogCreate, openBacklogCreate, onBacklogCreateConsumed])
  const [localCalendarDateDisplay, setLocalCalendarDateDisplay] = useState<CalendarDateDisplay>(() => {
    try {
      const saved = sessionStorage.getItem('taskCalendarDateDisplay')
      if (saved === 'hebrew' || saved === 'both' || saved === 'gregorian') return saved
    } catch {
      /* ignore */
    }
    return (me?.calendar_date_display as CalendarDateDisplay) ?? 'gregorian'
  })
  useEffect(() => {
    const v = (me?.calendar_date_display as CalendarDateDisplay) ?? 'gregorian'
    setLocalCalendarDateDisplay(v)
    try {
      if (v === 'hebrew' || v === 'both' || v === 'gregorian') sessionStorage.setItem('taskCalendarDateDisplay', v)
    } catch {
      /* ignore */
    }
  }, [me?.calendar_date_display])

  const [localShowJewishHolidays, setLocalShowJewishHolidays] = useState<boolean>(
    () => me?.show_jewish_holidays ?? true
  )
  const [localShowIslamicHolidays, setLocalShowIslamicHolidays] = useState<boolean>(
    () => me?.show_islamic_holidays ?? false
  )

  useEffect(() => {
    setLocalShowJewishHolidays(me?.show_jewish_holidays ?? true)
  }, [me?.show_jewish_holidays])

  useEffect(() => {
    setLocalShowIslamicHolidays(me?.show_islamic_holidays ?? false)
  }, [me?.show_islamic_holidays])

  // silent=true refreshes in the background (the periodic refresh): it
  // keeps the current events and never shows a spinner or error toast, so the
  // calendar doesn't flicker or nag on a transient poll failure.
  const fetchTasks = useCallback(async (silent = false) => {
    try {
      const params: Record<string, string | boolean> = {}
      if (filterUserId) params.assigned_to_user_id = String(filterUserId)
      if (includeArchived) params.include_archived = true
      if (dateRange) {
        // Send local time strings (no timezone) — the backend stores naive datetimes
        // that represent local time. Using toISOString() would send UTC, causing mismatches.
        const pad = (n: number) => String(n).padStart(2, '0')
        const fmtLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
        params.start = fmtLocal(dateRange.start)
        params.end = fmtLocal(dateRange.end)
      }
      const { data } = await api.get<Task[]>('/tasks/', { params })
      setTasks(data)
    } catch (err) {
      console.error('Failed to fetch tasks:', err)
      if (!silent) {
        setTasks([])
        showToast('שגיאה בטעינת משימות. נסה לרענן את הדף.', 'error')
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }, [filterUserId, dateRange, includeArchived])

  const fetchUsers = useCallback(async () => {
    try {
      const { data } = await api.get<UserForTask[]>('/users/for-tasks')
      setUsers(data)
    } catch (err) {
      console.error('Failed to fetch users:', err)
      setUsers([])
    }
  }, [])

  const fetchTaskLabels = useCallback(async () => {
    try {
      const { data } = await api.get<TaskLabelType[]>('/tasks/labels')
      setTaskLabels(data)
    } catch (err) {
      console.error('Failed to fetch task labels:', err)
      setTaskLabels([])
    }
  }, [])

  useEffect(() => {
    if (!didInitFilterRef.current && me?.id != null) {
      setFilterUserId(me.id)
      didInitFilterRef.current = true
    }
  }, [me?.id])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  useEffect(() => {
    fetchTaskLabels()
  }, [fetchTaskLabels])

  const hasFetchedOnceRef = useRef(false)
  useEffect(() => {
    if (!hasFetchedOnceRef.current) {
      setLoading(true)
    }
    hasFetchedOnceRef.current = true
    fetchTasks()
  }, [fetchTasks])

  // Refresh in the background so other users' changes show up on the calendar
  // without a manual reload; also refresh the moment the tab regains focus.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) void fetchTasks(true)
    }, 30_000)
    const onVisible = () => { if (!document.hidden) void fetchTasks(true) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [fetchTasks])

  const fetchOutlookStatus = useCallback(async () => {
    try {
      const { data } = await api.get<{ configured: boolean; connected: boolean; last_sync_at: string | null }>('/outlook/status')
      setOutlookStatus(data)
    } catch {
      setOutlookStatus({ configured: false, connected: false, last_sync_at: null })
    }
  }, [])

  useEffect(() => {
    fetchOutlookStatus()
  }, [fetchOutlookStatus])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const outlookParam = params.get('outlook')
    if (outlookParam === 'connected') {
      fetchOutlookStatus()
      window.history.replaceState({}, '', window.location.pathname)
    }
    if (outlookParam === 'error') {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [fetchOutlookStatus])

  // Open a specific task when arriving from a notification deep link (?taskId=…)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const taskIdParam = params.get('taskId')
    if (!taskIdParam) return
    const taskId = parseInt(taskIdParam, 10)
    // Remove taskId from the URL (keep other params like tab) so it won't reopen on re-render/back
    params.delete('taskId')
    const remaining = params.toString()
    window.history.replaceState({}, '', `${window.location.pathname}${remaining ? `?${remaining}` : ''}`)
    if (Number.isNaN(taskId)) return
    let cancelled = false
    api.get<Task>(`/tasks/${taskId}`)
      .then(({ data }) => {
        if (!cancelled) setSelectedTask(data)
      })
      .catch(() => {
        if (!cancelled) showToast('לא ניתן לפתוח את המשימה המבוקשת', 'error')
      })
    return () => { cancelled = true }
  }, [])

  const handleOutlookConnect = () => {
    const token = getToken()
    const base = (api.defaults.baseURL || '').replace(/\/$/, '')
    if (token) {
      window.location.href = `${base}/outlook/connect?token=${encodeURIComponent(token)}`
    }
  }

  const handleOutlookDisconnect = async () => {
    if (!confirm('לנתק את סנכרון Outlook?')) return
    setOutlookDisconnecting(true)
    try {
      await api.delete('/outlook/disconnect')
      await fetchOutlookStatus()
    } finally {
      setOutlookDisconnecting(false)
    }
  }

  const handleUserColorChange = async (userId: number, hex: string) => {
    const value = hex ? (hex.startsWith('#') ? hex : `#${hex}`) : ''
    setUpdatingUserColorId(userId)
    try {
      await api.put(`/users/${userId}`, { calendar_color: value || null })
      await fetchUsers()
      await fetchTasks()
    } catch {
      await fetchUsers()
    } finally {
      setUpdatingUserColorId(null)
    }
  }

  const lastEventClickRef = useRef<{ id: string; time: number } | null>(null)
  const calendarRef = useRef<InstanceType<typeof FullCalendar>>(null)
  /** Drag to edge of month view to go prev/next month: timeout and cooldown. */
  const edgeNavTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastEdgeNavTimeRef = useRef<number>(0)
  /** Which edge zone we're in so we don't reset the timer on every mousemove. */
  const edgeZoneRef = useRef<'left' | 'right' | null>(null)
  const currentViewTypeRef = useRef(currentViewType)
  currentViewTypeRef.current = currentViewType
  /** Track previous isHebrewMode to detect display-mode transitions. */
  const prevIsHebrewModeRef = useRef<boolean | null>(null)

  /**
   * Mobile detection: under 640px we render compact UI and prefer list/agenda view.
   * Tied to a matchMedia listener so changes to viewport (rotation, devtools resize) react live.
   */
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia?.('(max-width: 640px)').matches ?? false
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(max-width: 640px)')
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    // Older Safari uses addListener; modern uses addEventListener.
    if (mq.addEventListener) mq.addEventListener('change', onChange)
    else mq.addListener(onChange)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange)
      else mq.removeListener(onChange)
    }
  }, [])
  /**
   * When the viewport crosses INTO mobile and we're on a heavy view (month/week),
   * auto-switch to list view for readability. Going back to desktop does NOT auto-switch
   * (we respect the user's last explicit choice on the larger viewport).
   */
  const didMobileSwitchRef = useRef(false)
  useEffect(() => {
    if (!isMobile || didMobileSwitchRef.current) return
    const heavyViews = ['dayGridMonth', 'timeGridWeek', 'timeGridWorkWeek']
    if (heavyViews.includes(currentViewTypeRef.current)) {
      const cal = calendarRef.current?.getApi()
      if (cal) {
        cal.changeView('listWeek')
        didMobileSwitchRef.current = true
      }
    }
  }, [isMobile])

  const handleEventClick = (info: EventClickArg) => {
    if (info.event.id.startsWith('jewish-') || info.event.id.startsWith('islamic-')) return
    const taskId = info.event.extendedProps?.taskId ?? (info.event.id.includes('-') ? parseInt(info.event.id.split('-')[0], 10) : parseInt(info.event.id, 10))
    const task = tasks.find(t => t.id === taskId)
    if (!task) return
    const now = Date.now()
    const last = lastEventClickRef.current
    if (last?.id === info.event.id && now - last.time < 400) {
      lastEventClickRef.current = null
      setSelectedTask(null)
      openEditModal(task)
      return
    }
    lastEventClickRef.current = { id: info.event.id, time: now }
    setSelectedTask(task)
  }

  // Update toolbar title when switching hebrew/gregorian display (datesSet handles date navigation)
  // In Hebrew month view, use the middle of the range to determine the current month header.
  // We use a MutationObserver because FullCalendar may re-render its own Gregorian title
  // after our manual override, causing both titles to appear together.
  useEffect(() => {
    if (currentViewType !== 'dayGridMonth' || !dateRange?.start || !dateRange?.end) return
    const el = document.querySelector('.task-calendar-wrap .fc-toolbar-title')
    if (!el) return

    const midDate = new Date((dateRange.start.getTime() + dateRange.end.getTime()) / 2)
    let desiredTitle: string
    if (localCalendarDateDisplay === 'hebrew' || localCalendarDateDisplay === 'both') {
      desiredTitle = getHebrewMonthYearHeader(midDate)
    } else {
      desiredTitle = midDate.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' })
    }

    const applyTitle = () => {
      if (el.textContent !== desiredTitle) {
        el.textContent = desiredTitle
      }
    }
    applyTitle()

    // Watch for FullCalendar overwriting our title and re-apply
    const observer = new MutationObserver(applyTitle)
    observer.observe(el, { childList: true, characterData: true, subtree: true })
    return () => observer.disconnect()
  }, [localCalendarDateDisplay, currentViewType, dateRange?.start, dateRange?.end])

  const handleDatesSet = (arg: DatesSetArg) => {
    const viewType = arg.view?.type ?? 'dayGridMonth'
    setCurrentViewType(viewType)
    setDateRange(prev => {
      const newStart = arg.start.getTime()
      const newEnd = arg.end.getTime()
      if (prev && prev.start.getTime() === newStart && prev.end.getTime() === newEnd) return prev
      return { start: arg.start, end: arg.end }
    })
  }

  const toDateTimeLocal = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  /** Local ISO string with seconds — matches the format used by the create flow.
   *  IMPORTANT: Do NOT use Date.toISOString() for task times — that produces UTC
   *  (with Z suffix) which the backend strips, causing a timezone shift. */
  const toLocalISO = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  const EDGE_NAV_ZONE = 0.18
  const EDGE_NAV_DELAY_MS = 450
  const EDGE_NAV_COOLDOWN_MS = 700

  const handleDragMoveForEdgeNav = useCallback((e: MouseEvent) => {
    if (currentViewTypeRef.current !== 'dayGridMonth') return
    const wrap = document.querySelector('.task-calendar-wrap')
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    const now = Date.now()
    if (now - lastEdgeNavTimeRef.current < EDGE_NAV_COOLDOWN_MS) return
    const x = e.clientX
    const isRtl = document.documentElement.dir === 'rtl'
    const nearLeft = x <= rect.left + rect.width * EDGE_NAV_ZONE
    const nearRight = x >= rect.right - rect.width * EDGE_NAV_ZONE
    if (!nearLeft && !nearRight) {
      edgeZoneRef.current = null
      if (edgeNavTimeoutRef.current) {
        clearTimeout(edgeNavTimeoutRef.current)
        edgeNavTimeoutRef.current = null
      }
      return
    }
    const zone: 'left' | 'right' = nearLeft ? 'left' : 'right'
    if (edgeZoneRef.current === zone) return
    edgeZoneRef.current = zone
    if (edgeNavTimeoutRef.current) {
      clearTimeout(edgeNavTimeoutRef.current)
      edgeNavTimeoutRef.current = null
    }
    const go = (zone === 'left' && isRtl) || (zone === 'right' && !isRtl) ? 'next' : 'prev'
    edgeNavTimeoutRef.current = setTimeout(() => {
      edgeNavTimeoutRef.current = null
      lastEdgeNavTimeRef.current = Date.now()
      edgeZoneRef.current = null
      calendarRef.current?.getApi()?.[go]()
    }, EDGE_NAV_DELAY_MS)
  }, [])

  const handleEventDragStart = useCallback((_arg: EventDragStartArg) => {
    lastEdgeNavTimeRef.current = 0
    edgeZoneRef.current = null
    if (edgeNavTimeoutRef.current) {
      clearTimeout(edgeNavTimeoutRef.current)
      edgeNavTimeoutRef.current = null
    }
    document.addEventListener('mousemove', handleDragMoveForEdgeNav)
  }, [handleDragMoveForEdgeNav])

  const handleEventDragStop = useCallback(() => {
    document.removeEventListener('mousemove', handleDragMoveForEdgeNav)
    edgeZoneRef.current = null
    if (edgeNavTimeoutRef.current) {
      clearTimeout(edgeNavTimeoutRef.current)
      edgeNavTimeoutRef.current = null
    }
  }, [handleDragMoveForEdgeNav])

  // Cleanup edge-nav timeout & listener on unmount (e.g. if user navigates away mid-drag)
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleDragMoveForEdgeNav)
      if (edgeNavTimeoutRef.current) {
        clearTimeout(edgeNavTimeoutRef.current)
        edgeNavTimeoutRef.current = null
      }
    }
  }, [handleDragMoveForEdgeNav])

  const handleEventDrop = (info: EventChangeArg) => {
    if (info.event.id.startsWith('jewish-') || info.event.id.startsWith('islamic-')) {
      info.revert()
      return
    }
    const taskId = info.event.extendedProps?.taskId ?? (info.event.id.includes('-') ? parseInt(info.event.id.split('-')[0], 10) : parseInt(info.event.id, 10))
    const start = info.event.start
    const end = info.event.end
    if (!start || !end) return
    const task = tasks.find(t => t.id === taskId)
    if (!task) {
      info.revert()
      return
    }
    const oldStart = task.start_time ? new Date(task.start_time) : start
    const oldEnd = task.end_time ? new Date(task.end_time) : end
    setDropConfirm({
      taskId,
      taskTitle: info.event.title || '',
      oldStart,
      oldEnd,
      newStart: start,
      newEnd: end,
      customStart: toDateTimeLocal(start),
      customEnd: toDateTimeLocal(end),
      info,
    })
  }

  const handleDropConfirm = async (useCustomDate: boolean) => {
    if (!dropConfirm) return
    const start = useCustomDate
      ? new Date(dropConfirm.customStart)
      : dropConfirm.newStart
    const end = useCustomDate
      ? new Date(dropConfirm.customEnd)
      : dropConfirm.newEnd
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) {
      alert('נא לבחור תאריך ושעה תקינים. שעת הסיום חייבת להיות אחרי שעת ההתחלה.')
      return
    }
    setDropConfirmSaving(true)
    try {
      const { data: updatedTask } = await api.put<Task>(`/tasks/${dropConfirm.taskId}`, {
        start_time: toLocalISO(start),
        end_time: toLocalISO(end),
      })
      setDropConfirm(null)
      // Update task in state from server response so the calendar shows new position
      // (refetch would exclude the task if it was dragged outside current date range)
      setTasks((prev) =>
        prev.map((t) => (t.id === updatedTask.id ? { ...t, ...updatedTask } : t))
      )
      try {
        sessionStorage.setItem('taskCalendarView', currentViewType)
        if (dateRange?.start) sessionStorage.setItem('taskCalendarDate', dateRange.start.toISOString())
      } catch {
        /* ignore */
      }
      // Force calendar to re-render with new event positions
      setCalendarRefreshKey((k) => k + 1)
    } catch (err) {
      console.error('Failed to update task:', err)
      if (dropConfirm.info) dropConfirm.info.revert()
      setDropConfirm(null)
    } finally {
      setDropConfirmSaving(false)
    }
  }

  const handleDropCancel = () => {
    if (dropConfirm?.info) dropConfirm.info.revert()
    setDropConfirm(null)
  }

  const handleEventResize = async (info: EventChangeArg) => {
    if (info.event.id.startsWith('jewish-') || info.event.id.startsWith('islamic-')) {
      info.revert()
      return
    }
    const taskId = info.event.extendedProps?.taskId ?? (info.event.id.includes('-') ? parseInt(info.event.id.split('-')[0], 10) : parseInt(info.event.id, 10))
    const start = info.event.start
    const end = info.event.end
    if (!start || !end) return
    try {
      await api.put(`/tasks/${taskId}`, {
        start_time: toLocalISO(start),
        end_time: toLocalISO(end),
      })
      await fetchTasks()
    } catch (err) {
      info.revert()
      console.error('Failed to update task:', err)
    }
  }

  /** Outlook-style: select time range on calendar to create new meeting */
  const handleSelect = (arg: DateSelectArg) => {
    const pad = (n: number) => String(n).padStart(2, '0')
    const start = arg.start
    const end = arg.end
    const toLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    openCreateModal({ taskType: 'meeting', startTime: toLocal(start), endTime: toLocal(end) })
    arg.view.calendar.unselect()
  }

  // Opens the shared TaskEditModal for a task (closing the detail popup first).
  // The modal seeds its own form from the task, so no seeding is needed here.
  const openEditModal = useCallback((task: Task) => {
    setSelectedTask(null)
    setEditingTask(task)
  }, [])

  const handleCalendarDateDisplayChange = async (value: CalendarDateDisplay) => {
    setLocalCalendarDateDisplay(value)
    try {
      sessionStorage.setItem('taskCalendarDateDisplay', value)
    } catch {
      /* ignore */
    }
    // Optimistically update Redux store to avoid "revert" flicker from useEffect
    dispatch(updateUser({ calendar_date_display: value }))
    
    try {
      await api.patch('/users/me', { calendar_date_display: value })
      // No need to fetchMe() here, we already updated locally.
      // This prevents the global loading spinner and full page refresh.
    } catch {
      // Revert if failed
      setLocalCalendarDateDisplay((me?.calendar_date_display as CalendarDateDisplay) ?? 'gregorian')
      dispatch(updateUser({ calendar_date_display: (me?.calendar_date_display as CalendarDateDisplay) ?? 'gregorian' }))
    }
  }

  const handleJewishHolidaysChange = async (value: boolean) => {
    setLocalShowJewishHolidays(value)
    dispatch(updateUser({ show_jewish_holidays: value }))
    try {
      await api.patch('/users/me', { show_jewish_holidays: value })
    } catch {
      /* ignore */
    }
  }

  const handleIslamicHolidaysChange = async (value: boolean) => {
    setLocalShowIslamicHolidays(value)
    dispatch(updateUser({ show_islamic_holidays: value }))
    try {
      await api.patch('/users/me', { show_islamic_holidays: value })
    } catch {
      /* ignore */
    }
  }

  const calendarDateDisplay = localCalendarDateDisplay
  const showJewishHolidays = localShowJewishHolidays
  const showIslamicHolidays = localShowIslamicHolidays

  /** Stable visibleRange for Hebrew month – prevents re-render loops and navigation issues. */
  const hebrewVisibleRange = useCallback((currentDate: Date) => {
    const range = getHebrewMonthRange(currentDate)
    if (!range) {
      const s = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1)
      const e = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0)
      return { start: s, end: new Date(e.getTime() + 86400000) }
    }
    const end = new Date(range.end)
    end.setDate(end.getDate() + 1) // FullCalendar end is exclusive
    return { start: range.start, end }
  }, [])

  const isHebrewMode = calendarDateDisplay === 'hebrew' || calendarDateDisplay === 'both'

  const hebrewMonthViews = useMemo(() => {
    const base: Record<string, object> = {
      timeGridWorkWeek: {
        type: 'timeGrid',
        duration: { days: 5 },
        buttonText: 'שבוע עבודה',
      },
    }
    if (isHebrewMode) {
      base.dayGridMonth = {
        fixedWeekCount: false,
        showNonCurrentDates: false,
        visibleRange: hebrewVisibleRange,
      }
    }
    return base
  }, [isHebrewMode, hebrewVisibleRange])

  /**
   * Custom prev/next/today buttons for Hebrew mode.
   * Standard FullCalendar prev/next computes dateIncrement from the visible range duration,
   * which breaks for variable-length Hebrew months (29–30 days) – going back from a 30-day
   * month can skip a 29-day month entirely.
   * These custom buttons always navigate to the exact adjacent Hebrew month.
   */
  const hebrewCustomButtons = useMemo(() => {
    if (!isHebrewMode) return undefined
    return {
      hebrewPrev: {
        text: '‹',
        click: () => {
          const cal = calendarRef.current?.getApi()
          if (!cal) return
          if (cal.view.type === 'dayGridMonth') {
            const prevStart = getPrevHebrewMonthStart(cal.getDate())
            cal.gotoDate(prevStart)
          } else {
            cal.prev()
          }
        },
      },
      hebrewNext: {
        text: '›',
        click: () => {
          const cal = calendarRef.current?.getApi()
          if (!cal) return
          if (cal.view.type === 'dayGridMonth') {
            const nextStart = getNextHebrewMonthStart(cal.getDate())
            cal.gotoDate(nextStart)
          } else {
            cal.next()
          }
        },
      },
      hebrewToday: {
        text: 'היום',
        click: () => {
          calendarRef.current?.getApi()?.today()
        },
      },
    }
  }, [isHebrewMode])

  // When the display mode changes (Hebrew ↔ Gregorian ↔ Both), the calendar stays mounted
  // (no key change). We use the API to re-evaluate the view so Hebrew month boundaries,
  // day-cell rendering, and the toolbar update correctly – without losing the current date.
  useEffect(() => {
    const calApi = calendarRef.current?.getApi()
    if (!calApi) return
    // Skip the very first render – nothing to transition from
    if (prevIsHebrewModeRef.current === null) {
      prevIsHebrewModeRef.current = isHebrewMode
      return
    }
    const hebrewModeChanged = prevIsHebrewModeRef.current !== isHebrewMode
    prevIsHebrewModeRef.current = isHebrewMode

    if (hebrewModeChanged && calApi.view.type === 'dayGridMonth') {
      // Re-initialize month view so FullCalendar picks up the new visibleRange config
      const currentDate = calApi.getDate()
      calApi.changeView('dayGridMonth', currentDate)
    } else {
      // For non-month views or same-mode switches (hebrew ↔ both), just re-render cells
      calApi.render()
    }
  }, [calendarDateDisplay, isHebrewMode])

  const jewishHolidayList =
    dateRange?.start && dateRange?.end && showJewishHolidays
      ? getJewishHolidays(dateRange.start, dateRange.end)
      : []
  const islamicHolidayList =
    dateRange?.start && dateRange?.end && showIslamicHolidays
      ? getIslamicHolidays(dateRange.start, dateRange.end)
      : []
  const holidayEvents = [...jewishHolidayList, ...islamicHolidayList]

  // Quick client-side text filter of the already-loaded tasks. Matches on the
  // task title, task number/unique tag, assignee/participant names, and label
  // names (NOT description), case-insensitive substring. An empty/whitespace
  // query returns tasks as-is.
  const filteredTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return tasks
    return tasks.filter(t => {
      // Include the task number so a user can paste a call number straight into
      // the search box. Both forms are searchable: the code exactly as shown in
      // the UI ("ZP225") and the bare number ("225"), since either is what a
      // user is likely to type.
      const haystack: string[] = [
        t.title,
        formatTaskCode(t.id),
        String(t.id),
        t.unique_tag ?? '',
        t.assigned_user_name ?? '',
      ]
      for (const participant of t.participants ?? []) haystack.push(participant.full_name)
      for (const label of t.labels ?? []) haystack.push(label.name)
      return haystack.some(value => value.toLowerCase().includes(query))
    })
  }, [tasks, searchQuery])

  const events = [
    ...holidayEvents,
    ...(dateRange
      ? filteredTasks
          .filter(t => t.start_time && t.end_time)
          .flatMap(t => {
            const rangeStart = dateRange.start
            const rangeEnd = dateRange.end
            const occurrences = getTaskOccurrences(t, rangeStart, rangeEnd)
            const eventType = (t.event_type || 'task') as EventType
            const status = (t.status || 'pending') as TaskStatus
            const color = status === 'completed'
              ? TASK_STATUS_COLORS.completed
              : (t.assigned_user_color ?? USER_COLORS[(t.assigned_to_user_id - 1) % USER_COLORS.length])
            const labels = t.labels || []
            const isRecurring = (t.recurrence_rule || '') !== ''
            return occurrences.map((occ, i) => {
              const start = occ.start
              const end = occ.end
              const isAllDay = start.getHours() === 0 && start.getMinutes() === 0 && end.getHours() === 23 && end.getMinutes() === 59
              const isAllDayTask = isAllDay
              const eventId = occurrences.length > 1 ? `${t.id}-${i}` : String(t.id)
              // Use local date / local-naive datetime strings (NOT toISOString, which is UTC).
              // toISOString() shifts all-day events by the UTC offset, landing them on the wrong
              // day (and out of the visible range near week/day boundaries). See toLocalISO note above.
              const pad = (n: number) => String(n).padStart(2, '0')
              const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
              const localDateTime = (d: Date) => `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
              return {
                id: eventId,
                title: t.title,
                start: isAllDayTask ? localDate(start) : localDateTime(start),
                end: isAllDayTask ? undefined : localDateTime(end),
                allDay: isAllDayTask,
                backgroundColor: isAllDayTask ? color : 'transparent',
                borderColor: isAllDayTask ? color : 'transparent',
                textColor: 'inherit',
                classNames: [eventType === 'meeting' ? 'fc-event-meeting' : 'fc-event-task', isAllDayTask ? 'fc-event-task-no-time' : '', 'fc-event-outlook'],
                extendedProps: { eventType, labels, taskId: t.id, isAllDayTask, status, isRecurring, color },
              }
            })
          })
      : []),
  ]

  return (
    <div className={cn('task-calendar-page', !embedded && 'min-h-screen bg-[#f0f4f8] dark:bg-[#0f1419]')}>
      <div className={cn('max-w-[1680px] mx-auto px-2 sm:px-6 space-y-4 sm:space-y-6', !embedded && 'py-6 sm:py-8')}>
        {!embedded && (
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/25 dark:shadow-violet-600/20">
              <Calendar className="w-7 h-7" strokeWidth={2.5} />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white tracking-tight">
                יומן משימות
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                ניהול פגישות ומשימות
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <BacklogPanel onRequestCreate={openBacklogCreate} refreshSignal={backlogRefreshKey} onEditTask={openEditModal} />
            {(isAdmin || users.some(u => u.id === me?.id)) && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => openCreateModal({ taskType: 'meeting' })}
                  className="inline-flex items-center gap-2 px-4 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl font-medium shadow-md hover:shadow-lg transition-all duration-200 hover:-translate-y-0.5"
                >
                  <Calendar className="w-4 h-4" />
                  פגישה חדשה
                </button>
                <PermissionGuard action="write" resource="task">
                  <button
                    type="button"
                    onClick={() => openCreateModal({ taskType: 'all_day' })}
                    className="inline-flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-medium shadow-md hover:shadow-lg transition-all duration-200 hover:-translate-y-0.5"
                  >
                    <Plus className="w-4 h-4" />
                    משימה חדשה
                  </button>
                </PermissionGuard>
              </div>
            )}
          </div>
        </header>
        )}

        {outlookStatus?.configured && (
          <div className="flex items-center gap-2 justify-end">
            {outlookStatus.connected ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400 font-medium">
                  <CalendarSync className="w-4 h-4" />
                  מחובר ל-Outlook
                </span>
                <button
                  type="button"
                  onClick={handleOutlookDisconnect}
                  disabled={outlookDisconnecting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 border border-gray-200 dark:border-gray-600 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700/50 disabled:opacity-50 transition-colors"
                >
                  <Unlink className="w-3.5 h-3.5" />
                  נתק
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleOutlookConnect}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200 transition-colors shadow-sm"
              >
                <Link2 className="w-4 h-4" />
                סנכרון ל-Outlook
              </button>
            )}
          </div>
        )}

        <div className="space-y-3">
            <div className="rounded-xl sm:rounded-2xl border border-gray-200/80 dark:border-gray-700/80 bg-white/95 dark:bg-gray-800/95 backdrop-blur-xl shadow-xl shadow-gray-200/40 dark:shadow-none p-2 sm:p-6">
              {loading && tasks.length === 0 ? (
                <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400 font-medium">טוען...</div>
              ) : isMobile ? (
                <OutlookMobileCalendar
                  tasks={filteredTasks}
                  jewishHolidays={jewishHolidayList}
                  islamicHolidays={islamicHolidayList}
                  selectedDate={mobileSelectedDate}
                  onSelectDate={setMobileSelectedDate}
                  onRangeChange={handleMobileRangeChange}
                  mobileView={mobileView}
                  onMobileViewChange={setMobileView}
                  onEventClick={(t) => {
                    setSelectedTask(t)
                  }}
                  onCreateClick={() => setShowCreateModal(true)}
                  onOpenFilters={() => setMobileFiltersOpen(true)}
                  canCreate={isAdmin || users.some(u => u.id === me?.id)}
                  calendarDateDisplay={calendarDateDisplay}
                  users={users}
                  filterUserId={filterUserId}
                  onFilterUserChange={setFilterUserId}
                  showUserFilter={isAdmin}
                />
              ) : (
                <>
                <div className="task-calendar-filterbar flex flex-nowrap sm:flex-wrap items-center gap-2 mb-3 sm:mb-4 pb-3 sm:pb-4 border-b border-gray-200 dark:border-gray-600 overflow-x-auto sm:overflow-visible -mx-1 px-1">
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-400">סוג תאריך בתאים:</span>
                  <div className="flex rounded-xl overflow-hidden border border-gray-200 dark:border-gray-600 bg-gray-100 dark:bg-gray-700/50 p-0.5">
                    {(['gregorian', 'hebrew', 'both'] as const).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => handleCalendarDateDisplayChange(opt)}
                        className={cn(
                          'px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200',
                          calendarDateDisplay === opt
                            ? 'bg-violet-600 text-white shadow-md'
                            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                        )}
                      >
                        {opt === 'gregorian' ? 'לועזי' : opt === 'hebrew' ? 'עברי' : 'עברי ולועזי'}
                      </button>
                    ))}
                  </div>
                  <div className="h-5 w-px bg-gray-200 dark:bg-gray-600" />
                  <button
                    type="button"
                    onClick={() => handleJewishHolidaysChange(!showJewishHolidays)}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-all',
                      showJewishHolidays
                        ? 'bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-800 dark:text-blue-300'
                        : 'bg-gray-50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400'
                    )}
                  >
                    ✡️ חגי ישראל
                  </button>
                  <button
                    type="button"
                    onClick={() => handleIslamicHolidaysChange(!showIslamicHolidays)}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-all',
                      showIslamicHolidays
                        ? 'bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700 text-green-800 dark:text-green-300'
                        : 'bg-gray-50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400'
                    )}
                  >
                    ☪️ חגים אסלאמיים
                  </button>
                  <div className="h-5 w-px bg-gray-200 dark:bg-gray-600" />
                  <div className="relative" dir="rtl">
                    <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500 pointer-events-none" />
                    <input
                      id="task-search"
                      name="task-search"
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="חיפוש משימות..."
                      className="task-calendar-select w-48 pr-8 pl-7 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 text-sm font-medium focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500 transition-shadow"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        aria-label="נקה חיפוש"
                        className="absolute left-2 top-1/2 -translate-y-1/2 p-0.5 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  {isAdmin && (
                    <>
                      <select
                        id="filter-user"
                        name="filter-user"
                        value={filterUserId ?? ''}
                        onChange={(e) => setFilterUserId(e.target.value ? Number(e.target.value) : null)}
                        className="task-calendar-select px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 text-sm font-medium focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500 transition-shadow"
                      >
                        <option value="">כל המשתמשים</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>{u.full_name}</option>
                        ))}
                      </select>
                      {users.length > 0 && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-gray-400 dark:text-gray-500">צבע:</span>
                          {users.map((u) => {
                            const color = u.calendar_color || USER_COLORS[(u.id - 1) % USER_COLORS.length]
                            return (
                              <label key={u.id} title={u.full_name} className="relative cursor-pointer group">
                                <div
                                  className="w-6 h-6 rounded-full shadow-sm ring-2 ring-white dark:ring-gray-800 group-hover:ring-violet-400 transition-all"
                                  style={{ backgroundColor: color }}
                                />
                                <input
                                  id={`user-color-${u.id}`}
                                  name={`user-color-${u.id}`}
                                  type="color"
                                  value={color.startsWith('#') ? color : `#${color}`}
                                  onChange={(e) => handleUserColorChange(u.id, e.target.value)}
                                  disabled={!!updatingUserColorId}
                                  className="absolute inset-0 opacity-0 cursor-pointer w-full h-full disabled:cursor-not-allowed"
                                  aria-label={`צבע ל${u.full_name}`}
                                />
                              </label>
                            )
                          })}
                        </div>
                      )}
                      <div className="h-5 w-px bg-gray-200 dark:bg-gray-600" />
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => setIncludeArchived(v => !v)}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-all',
                      includeArchived
                        ? 'bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300'
                        : 'bg-gray-50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-600 hover:border-amber-300 hover:text-amber-700 dark:hover:text-amber-400'
                    )}
                  >
                    <Archive className="w-3.5 h-3.5" />
                    {includeArchived ? 'הסתר ארכיון' : 'הצג ארכיון'}
                  </button>
                </div>
                <div
                  className={cn(
                    'task-calendar-wrap',
                    currentViewType === 'dayGridMonth' && 'task-calendar-wrap--month',
                    (calendarDateDisplay === 'hebrew' || calendarDateDisplay === 'both') && currentViewType === 'dayGridMonth' && 'task-calendar-wrap--hebrew-month'
                  )}
                >
            <FullCalendar
              ref={calendarRef}
              key={calendarRefreshKey}
              plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
              initialView={currentViewType}
              initialDate={dateRange?.start ?? undefined}
              events={events}
              dayCellContent={(arg) => {
                const esc = (s: string) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;')
                if (calendarDateDisplay === 'both') {
                  const parts = getCalendarDayBothParts(arg.date)
                  if (parts) {
                    const html = `<span class="fc-daygrid-day-number fc-day-both"><span class="fc-day-greg">${esc(String(parts.gregorian))}</span><span class="fc-day-heb">${esc(parts.hebrew)}</span></span>`
                    return { html }
                  }
                }
                const text = formatCalendarDay(arg.date, calendarDateDisplay)
                return { html: `<span class="fc-daygrid-day-number">${esc(text)}</span>` }
              }}
              eventDidMount={(info) => {
                const el = info.el
                const ev = info.event
                const ext = ev.extendedProps as { isHoliday?: boolean; kind?: 'jewish' | 'islamic'; taskId?: number }
                if (ext.isHoliday) {
                  el.setAttribute('title', ev.title || '')
                  return
                }
                const taskId = ext.taskId
                if (taskId != null) {
                  const t = tasks.find(x => x.id === taskId)
                  if (t) {
                    const typeLabel = EVENT_TYPE_LABELS[(t.event_type || 'task') as EventType]
                    const statusLabel = TASK_STATUS_LABELS[(t.status || 'pending') as TaskStatus]
                    const parts: string[] = [
                      t.title,
                      `סוג: ${typeLabel}`,
                      `מוקצה: ${t.assigned_user_name || '-'}`,
                      `מצב: ${statusLabel}`,
                    ]
                    const overdue = getOverdueInfo(t)
                    if (overdue) parts.push(`משימות בפיגור: ${overdue.delayText}`)
                    if (t.start_time && t.end_time) {
                      const fmt = (s: string) => new Date(s).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })
                      parts.push(`משעה: ${fmt(t.start_time)}`, `עד שעה: ${fmt(t.end_time)}`)
                    }
                    if (t.description?.trim()) parts.push(`תיאור: ${t.description.trim()}`)
                    el.setAttribute('title', parts.join('\n'))
                  }
                }
              }}
              editable={true}
              droppable={true}
              selectable={true}
              fixedMirrorParent={typeof document !== 'undefined' ? document.body : undefined}
              select={handleSelect}
              eventDragStart={handleEventDragStart}
              eventDragStop={handleEventDragStop}
              eventDrop={handleEventDrop}
              eventResize={handleEventResize}
              eventClick={handleEventClick}
              datesSet={handleDatesSet}
              eventContent={(arg) => {
                const esc = (s: string) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;')
                if ((arg.event.extendedProps as { isHoliday?: boolean }).isHoliday) {
                  const title = arg.event.title
                  return {
                    html: `<div class="fc-event-main-frame"><div class="fc-event-title-container"><div class="fc-event-title fc-sticky">${esc(title)}</div></div></div>`,
                  }
                }
                const ext = arg.event.extendedProps as {
                  labels?: TaskLabelType[]
                  eventType?: EventType
                  status?: TaskStatus
                  isRecurring?: boolean
                  color?: string
                  isAllDayTask?: boolean
                  taskId?: number
                }
                const labels = ext.labels || []
                const eventType = ext.eventType || 'task'
                const status = ext.status || 'pending'
                const isRecurring = ext.isRecurring || false
                const color = ext.color || '#6B7280'
                const title = arg.event.title
                const taskCode = ext.taskId != null ? formatTaskCode(ext.taskId) : ''

                // Format time (all-day tasks have no time → renders title-only Outlook chip)
                const startDate = arg.event.start
                const endDate = arg.event.end
                let timeStr = ''
                if (startDate && !arg.event.allDay) {
                  const pad = (n: number) => String(n).padStart(2, '0')
                  const startHH = pad(startDate.getHours())
                  const startMM = pad(startDate.getMinutes())
                  timeStr = `${startHH}:${startMM}`
                  if (endDate) {
                    const endHH = pad(endDate.getHours())
                    const endMM = pad(endDate.getMinutes())
                    timeStr += ` - ${endHH}:${endMM}`
                  }
                }

                // Status icon
                const statusIcon = status === 'completed' ? '✓' : status === 'in_progress' ? '●' : status === 'pending_closure' ? '◐' : '○'
                const typeIcon = eventType === 'meeting' ? '📅' : '📋'
                const recurIcon = isRecurring ? ' 🔁' : ''

                // Labels pills
                const pills = labels
                  .map((l: TaskLabelType) =>
                    `<span class="fc-event-label-pill" style="background:${l.color};color:white;padding:1px 5px;border-radius:4px;font-size:10px;white-space:nowrap;line-height:1.4">${esc(l.name)}</span>`
                  )
                  .join('')

                return {
                  html: `<div class="fc-outlook-event" style="--evt-color:${color}">
                    <div class="fc-outlook-bar" style="background:${color}"></div>
                    <div class="fc-outlook-body">
                      ${timeStr ? `<div class="fc-outlook-time">${typeIcon} ${esc(timeStr)}${recurIcon}</div>` : `<div class="fc-outlook-time">${typeIcon}${recurIcon}</div>`}
                      <div class="fc-outlook-title">${taskCode ? `<span class="fc-outlook-code" style="opacity:0.6;font-size:0.85em;margin-inline-end:4px">${esc(taskCode)}</span>` : ''}${esc(title)}</div>
                      ${labels.length > 0 ? `<div class="fc-outlook-labels">${pills}</div>` : ''}
                    </div>
                    <div class="fc-outlook-status" title="${esc(TASK_STATUS_LABELS[status as TaskStatus] || '')}">${statusIcon}</div>
                  </div>`,
                }
              }}
              customButtons={hebrewCustomButtons}
              headerToolbar={
                isMobile
                  ? {
                      // Phone-friendly toolbar: nav buttons on left, compact title on right.
                      // View switcher moved to footer to keep header short and tappable.
                      start: isHebrewMode ? 'hebrewPrev,hebrewToday,hebrewNext' : 'prev,today,next',
                      center: '',
                      end: 'title',
                    }
                  : {
                      start: 'timeGridDay,timeGridWeek,timeGridWorkWeek,dayGridMonth,listWeek',
                      center: 'title',
                      end: isHebrewMode ? 'hebrewPrev,hebrewNext hebrewToday' : 'prev,next today',
                    }
              }
              footerToolbar={
                isMobile
                  ? {
                      // Reduced view-switcher set on mobile: list (default), day, month.
                      start: '',
                      center: 'listWeek,timeGridDay,dayGridMonth',
                      end: '',
                    }
                  : undefined
              }
              views={hebrewMonthViews}
              buttonText={{
                today: 'היום',
                month: 'חודש',
                week: 'שבוע',
                day: 'יום',
                listWeek: 'רשימה',
                listDay: 'רשימה (יום)',
                listMonth: 'רשימה (חודש)',
              }}
              locale="he"
              direction="rtl"
              firstDay={0}
              slotDuration="00:30:00"
              slotLabelInterval="01:00:00"
              nowIndicator={true}
              navLinks={true}
              contentHeight={isMobile ? 'auto' : 720}
              handleWindowResize={true}
              expandRows={isMobile}
              slotMinTime="00:00:00"
              slotMaxTime="24:00:00"
              allDayText="כל היום"
              eventDisplay="block"
            />
            </div>
            </>
          )}
        </div>
        </div>
      </div>

      {dropConfirm && (
        <Modal
          isOpen={!!dropConfirm}
          onClose={handleDropCancel}
          title="אישור הזזת אירוע"
        >
          <div className="space-y-4">
            <p className="text-gray-700 dark:text-gray-300">
              <strong>{dropConfirm.taskTitle.replace(/^[📅📋]\s*/, '')}</strong>
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              האם אתה בטוח שברצונך להעביר מתאריך ושעה אלו:
            </p>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {dropConfirm.oldStart.toLocaleString('he-IL')} – {dropConfirm.oldEnd.toLocaleString('he-IL')}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              לתאריך ושעה אלו:
            </p>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {dropConfirm.newStart.toLocaleString('he-IL')} – {dropConfirm.newEnd.toLocaleString('he-IL')}
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                type="button"
                onClick={() => handleDropConfirm(false)}
                disabled={dropConfirmSaving}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50"
              >
                {dropConfirmSaving ? 'שומר...' : 'כן, העבר לתאריך הזה'}
              </button>
              <button
                type="button"
                onClick={handleDropCancel}
                disabled={dropConfirmSaving}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-600 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 disabled:opacity-50"
              >
                ביטול
              </button>
            </div>
            <div className="pt-4 border-t border-gray-200 dark:border-gray-600">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">או בחר תאריך ושעה אחרים:</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="drop-custom-start" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">משעה</label>
                  <input
                    id="drop-custom-start"
                    name="drop-custom-start"
                    type="datetime-local"
                    value={dropConfirm.customStart}
                    onChange={(e) => setDropConfirm(d => d ? { ...d, customStart: e.target.value } : d)}
                    className={cn(
                      "w-full px-3 py-2 border rounded-lg text-sm",
                      "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    )}
                  />
                </div>
                <div>
                  <label htmlFor="drop-custom-end" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">עד שעה</label>
                  <input
                    id="drop-custom-end"
                    name="drop-custom-end"
                    type="datetime-local"
                    value={dropConfirm.customEnd}
                    onChange={(e) => setDropConfirm(d => d ? { ...d, customEnd: e.target.value } : d)}
                    className={cn(
                      "w-full px-3 py-2 border rounded-lg text-sm",
                      "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    )}
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleDropConfirm(true)}
                disabled={dropConfirmSaving}
                className="mt-3 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-50 text-sm"
              >
                העבר לתאריך שנבחר
              </button>
            </div>
          </div>
        </Modal>
      )}

      <TaskDetailModal
        taskId={selectedTask?.id ?? null}
        initialTask={selectedTask}
        onClose={() => setSelectedTask(null)}
        onEdit={(task) => openEditModal(task)}
        onTaskUpdated={(updated) => {
          setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
          setSelectedTask((prev) => (prev?.id === updated.id ? updated : prev))
        }}
        onTaskDeleted={() => { void fetchTasks(); setSelectedTask(null) }}
        onTaskArchived={() => { void fetchTasks(); setSelectedTask(null) }}
      />

      <TaskEditModal
        task={editingTask}
        isOpen={!!editingTask}
        onClose={() => setEditingTask(null)}
        users={users}
        taskLabels={taskLabels}
        onSaved={() => { void fetchTasks(); setBacklogRefreshKey(k => k + 1); setSelectedTask(null) }}
        onLabelsChanged={() => { void fetchTaskLabels() }}
      />

      <CreateTaskModal
        isOpen={showCreateModal}
        onClose={() => { setShowCreateModal(false); setCreateAsBacklog(false); setCreateDefaults(undefined) }}
        users={users}
        taskLabels={taskLabels}
        defaults={createDefaults}
        defaultAssigneeId={me && users.length === 1 && users[0].id === me.id ? me.id : null}
        defaultBacklog={createAsBacklog}
        onCreated={() => { setBacklogRefreshKey(k => k + 1); void fetchTasks() }}
        onLabelsChanged={() => { void fetchTaskLabels() }}
      />
      {mobileFiltersOpen && (
        <Modal isOpen={mobileFiltersOpen} onClose={() => setMobileFiltersOpen(false)} title="סינון יומן">
          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">סוג תאריך בתאים</div>
              <div className="flex rounded-xl overflow-hidden border border-gray-200 dark:border-gray-600 bg-gray-100 dark:bg-gray-700/50 p-0.5">
                {(['gregorian', 'hebrew', 'both'] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => handleCalendarDateDisplayChange(opt)}
                    className={cn(
                      'flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-all',
                      calendarDateDisplay === opt
                        ? 'bg-violet-600 text-white shadow-md'
                        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                    )}
                  >
                    {opt === 'gregorian' ? 'לועזי' : opt === 'hebrew' ? 'עברי' : 'עברי ולועזי'}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleJewishHolidaysChange(!showJewishHolidays)}
              className={cn(
                'w-full inline-flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-sm font-medium border',
                showJewishHolidays
                  ? 'bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-800 dark:text-blue-300'
                  : 'bg-gray-50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400'
              )}
            >
              <span>✡️ חגי ישראל</span>
              <span>{showJewishHolidays ? 'מוצג' : 'מוסתר'}</span>
            </button>
            <button
              type="button"
              onClick={() => handleIslamicHolidaysChange(!showIslamicHolidays)}
              className={cn(
                'w-full inline-flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-sm font-medium border',
                showIslamicHolidays
                  ? 'bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700 text-green-800 dark:text-green-300'
                  : 'bg-gray-50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400'
              )}
            >
              <span>☪️ חגים אסלאמיים</span>
              <span>{showIslamicHolidays ? 'מוצג' : 'מוסתר'}</span>
            </button>
            <div>
              <label htmlFor="mobile-task-search" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">חיפוש משימות</label>
              <div className="relative" dir="rtl">
                <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500 pointer-events-none" />
                <input
                  id="mobile-task-search"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="חיפוש משימות..."
                  className="w-full pr-8 pl-7 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 text-sm"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="נקה חיפוש"
                    className="absolute left-2 top-1/2 -translate-y-1/2 p-0.5 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            {isAdmin && (
              <div>
                <label htmlFor="mobile-filter-user" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">סינון לפי משתמש</label>
                <select
                  id="mobile-filter-user"
                  value={filterUserId ?? ''}
                  onChange={(e) => setFilterUserId(e.target.value ? Number(e.target.value) : null)}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 text-sm"
                >
                  <option value="">כל המשתמשים</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.full_name}</option>
                  ))}
                </select>
              </div>
            )}
            <button
              type="button"
              onClick={() => setIncludeArchived(v => !v)}
              className={cn(
                'w-full inline-flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-sm font-medium border',
                includeArchived
                  ? 'bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300'
                  : 'bg-gray-50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300'
              )}
            >
              <span>כולל ארכיון</span>
              <span>{includeArchived ? 'מוצג' : 'מוסתר'}</span>
            </button>
          </div>
        </Modal>
      )}
      <ToastNotification toast={toast} onClose={hideToast} />
    </div>
  )
}
