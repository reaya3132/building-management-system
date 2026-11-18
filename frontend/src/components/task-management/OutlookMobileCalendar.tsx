import { useEffect, useMemo, useRef } from 'react'
import { ChevronRight, ChevronLeft, Plus, CalendarDays, Settings } from 'lucide-react'
import {
  Task,
  TASK_STATUS_LABELS,
  TASK_STATUS_COLORS,
  EVENT_TYPE_LABELS,
  USER_CALENDAR_COLORS,
  getTaskOccurrences,
  type UserForTask,
} from '../../pages/TaskCalendar'
import {
  formatCalendarDay,
  type CalendarDateDisplay,
  type HolidayEvent,
} from '../../lib/calendarUtils'
import { cn } from '../../lib/utils'
import { formatTaskCode } from '../../lib/taskCode'

export type MobileCalendarView = 'day' | 'week' | 'workweek' | 'month'

interface OutlookMobileCalendarProps {
  tasks: Task[]
  jewishHolidays?: HolidayEvent[]
  islamicHolidays?: HolidayEvent[]
  selectedDate: Date
  onSelectDate: (d: Date) => void
  onRangeChange: (start: Date, end: Date) => void
  onEventClick: (task: Task) => void
  onCreateClick: () => void
  onOpenFilters?: () => void
  canCreate: boolean
  calendarDateDisplay: CalendarDateDisplay
  mobileView: MobileCalendarView
  onMobileViewChange: (v: MobileCalendarView) => void
  /** רשימת המשתמשים לבורר הסינון (מוצג רק כאשר showUserFilter) */
  users?: UserForTask[]
  /** המשתמש שלפיו מסננים כרגע (null = כל המשתמשים) */
  filterUserId?: number | null
  /** שינוי סינון המשתמש מתוך היומן במובייל */
  onFilterUserChange?: (userId: number | null) => void
  /** האם להציג את בורר "כל המשתמשים" (מנהלים בלבד) */
  showUserFilter?: boolean
}

const HEBREW_WEEKDAY_INITIALS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש']
const HEBREW_WEEKDAY_FULL = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
]

const SWIPE_THRESHOLD_PX = 50
const WORKWEEK_DAYS = 5

const VIEW_TABS: { value: MobileCalendarView; label: string }[] = [
  { value: 'month', label: 'חודש' },
  { value: 'week', label: 'שבוע' },
  { value: 'workweek', label: 'שבוע עבודה' },
  { value: 'day', label: 'יום' },
]

function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function endOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

function startOfWeek(d: Date): Date {
  const x = startOfDay(d)
  const day = x.getDay()
  x.setDate(x.getDate() - day)
  return x
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999)
}

function formatTimeHM(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatRangeLabel(start: Date, endInclusive: Date): string {
  const sameYear = start.getFullYear() === endInclusive.getFullYear()
  const sameMonth = sameYear && start.getMonth() === endInclusive.getMonth()
  if (sameMonth) {
    return `${start.getDate()}–${endInclusive.getDate()} ב${HEBREW_MONTHS[start.getMonth()]} ${start.getFullYear()}`
  }
  if (sameYear) {
    return `${start.getDate()} ב${HEBREW_MONTHS[start.getMonth()]} – ${endInclusive.getDate()} ב${HEBREW_MONTHS[endInclusive.getMonth()]} ${start.getFullYear()}`
  }
  return `${start.getDate()} ב${HEBREW_MONTHS[start.getMonth()]} ${start.getFullYear()} – ${endInclusive.getDate()} ב${HEBREW_MONTHS[endInclusive.getMonth()]} ${endInclusive.getFullYear()}`
}

interface DayEntry {
  task: Task
  start: Date
  end: Date
  allDay: boolean
  color: string
}

interface DayBucket {
  tasks: DayEntry[]
  holidays: HolidayEvent[]
}

interface ViewSpec {
  rangeStart: Date
  rangeEndInclusive: Date
  fetchStart: Date
  fetchEnd: Date
}

function computeViewSpec(view: MobileCalendarView, selected: Date): ViewSpec {
  if (view === 'day') {
    const ws = startOfWeek(selected)
    return {
      rangeStart: ws,
      rangeEndInclusive: addDays(ws, 6),
      fetchStart: ws,
      fetchEnd: endOfDay(addDays(ws, 6)),
    }
  }
  if (view === 'week') {
    const ws = startOfWeek(selected)
    return {
      rangeStart: ws,
      rangeEndInclusive: addDays(ws, 6),
      fetchStart: ws,
      fetchEnd: endOfDay(addDays(ws, 6)),
    }
  }
  if (view === 'workweek') {
    const ws = startOfWeek(selected)
    return {
      rangeStart: ws,
      rangeEndInclusive: addDays(ws, WORKWEEK_DAYS - 1),
      fetchStart: ws,
      fetchEnd: endOfDay(addDays(ws, WORKWEEK_DAYS - 1)),
    }
  }
  const ms = startOfMonth(selected)
  const me = endOfMonth(selected)
  const gridStart = startOfWeek(ms)
  const gridEndDays = 6 - me.getDay()
  const gridEnd = endOfDay(addDays(me, gridEndDays))
  return {
    rangeStart: ms,
    rangeEndInclusive: me,
    fetchStart: gridStart,
    fetchEnd: gridEnd,
  }
}

interface AgendaCardProps {
  entry: DayEntry
  onClick: (task: Task) => void
}

function AgendaCard({ entry, onClick }: AgendaCardProps) {
  const { task, start, end, allDay, color } = entry
  const status = (task.status || 'pending') as Task['status']
  return (
    <button
      type="button"
      onClick={() => onClick(task)}
      className="w-full text-right bg-white dark:bg-gray-800 rounded-xl shadow-sm p-3 flex gap-3 border-r-4"
      style={{ borderRightColor: color }}
    >
      <div className="flex flex-col items-end justify-start min-w-[3.25rem] text-xs text-gray-500 dark:text-gray-400">
        {allDay ? (
          <span className="font-semibold text-gray-700 dark:text-gray-200">כל היום</span>
        ) : (
          <>
            <span className="font-semibold text-gray-900 dark:text-white text-sm">{formatTimeHM(start.toISOString())}</span>
            <span>{formatTimeHM(end.toISOString())}</span>
          </>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-semibold text-gray-900 dark:text-white truncate">{task.title}</span>
        </div>
        <div className="font-mono text-[11px] text-gray-400 dark:text-gray-500">{formatTaskCode(task.id)}</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 truncate">
          {task.assigned_user_name && <span className="truncate">{task.assigned_user_name}</span>}
          <span
            className="px-1.5 py-0.5 rounded-full text-[10px] font-medium text-white"
            style={{ backgroundColor: TASK_STATUS_COLORS[status] }}
          >
            {TASK_STATUS_LABELS[status]}
          </span>
          {task.event_type && task.event_type !== 'task' && (
            <span className="text-[10px] font-medium text-violet-600 dark:text-violet-300">
              {EVENT_TYPE_LABELS[task.event_type]}
            </span>
          )}
        </div>
        {task.labels && task.labels.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {task.labels.map((lbl) => (
              <span
                key={lbl.id}
                className="text-[10px] px-1.5 py-0.5 rounded-full"
                style={{ backgroundColor: `${lbl.color}22`, color: lbl.color, border: `1px solid ${lbl.color}55` }}
              >
                {lbl.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  )
}

function HolidayPill({ holiday }: { holiday: HolidayEvent }) {
  return (
    <div
      className="px-3 py-1.5 rounded-full text-xs font-semibold inline-flex items-center"
      style={{ backgroundColor: holiday.backgroundColor, color: holiday.borderColor, border: `1px solid ${holiday.borderColor}` }}
    >
      {holiday.title}
    </div>
  )
}

interface DayAgendaProps {
  date: Date
  bucket: DayBucket
  onEventClick: (task: Task) => void
  emptyText?: string
}

function DayAgenda({ bucket, onEventClick, emptyText = 'אין אירועים' }: DayAgendaProps) {
  const sorted = [...bucket.tasks].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
    return a.start.getTime() - b.start.getTime()
  })
  if (sorted.length === 0 && bucket.holidays.length === 0) {
    return <div className="text-xs text-gray-400 dark:text-gray-500 py-1.5">{emptyText}</div>
  }
  return (
    <div className="space-y-2">
      {bucket.holidays.map((h) => (
        <HolidayPill key={h.id} holiday={h} />
      ))}
      {sorted.map((entry) => (
        <AgendaCard key={`${entry.task.id}-${entry.start.getTime()}`} entry={entry} onClick={onEventClick} />
      ))}
    </div>
  )
}

export default function OutlookMobileCalendar({
  tasks,
  jewishHolidays = [],
  islamicHolidays = [],
  selectedDate,
  onSelectDate,
  onRangeChange,
  onEventClick,
  onCreateClick,
  onOpenFilters,
  canCreate,
  calendarDateDisplay,
  mobileView,
  onMobileViewChange,
  users = [],
  filterUserId = null,
  onFilterUserChange,
  showUserFilter = false,
}: OutlookMobileCalendarProps) {
  const today = useMemo(() => startOfDay(new Date()), [])
  const viewSpec = useMemo(() => computeViewSpec(mobileView, selectedDate), [mobileView, selectedDate])

  const lastRangeRef = useRef<string>('')
  useEffect(() => {
    const key = `${ymd(viewSpec.fetchStart)}|${ymd(viewSpec.fetchEnd)}`
    if (lastRangeRef.current !== key) {
      lastRangeRef.current = key
      onRangeChange(viewSpec.fetchStart, viewSpec.fetchEnd)
    }
  }, [viewSpec.fetchStart, viewSpec.fetchEnd, onRangeChange])

  const dayBuckets = useMemo(() => {
    const buckets = new Map<string, DayBucket>()
    const ensure = (key: string): DayBucket => {
      let b = buckets.get(key)
      if (!b) {
        b = { tasks: [], holidays: [] }
        buckets.set(key, b)
      }
      return b
    }
    const rangeStart = startOfDay(addDays(viewSpec.fetchStart, -7))
    const rangeEnd = endOfDay(addDays(viewSpec.fetchEnd, 7))
    for (const t of tasks) {
      if (!t.start_time || !t.end_time) continue
      const occurrences = getTaskOccurrences(t, rangeStart, rangeEnd)
      const color =
        t.status === 'completed'
          ? TASK_STATUS_COLORS.completed
          : (t.assigned_user_color ?? USER_CALENDAR_COLORS[(t.assigned_to_user_id - 1) % USER_CALENDAR_COLORS.length])
      for (const occ of occurrences) {
        const allDay =
          occ.start.getHours() === 0 && occ.start.getMinutes() === 0 &&
          occ.end.getHours() === 23 && occ.end.getMinutes() === 59
        ensure(ymd(occ.start)).tasks.push({ task: t, start: occ.start, end: occ.end, allDay, color })
      }
    }
    for (const h of [...jewishHolidays, ...islamicHolidays]) {
      const key = h.start.slice(0, 10)
      ensure(key).holidays.push(h)
    }
    return buckets
  }, [tasks, viewSpec.fetchStart, viewSpec.fetchEnd, jewishHolidays, islamicHolidays])

  const emptyBucket: DayBucket = useMemo(() => ({ tasks: [], holidays: [] }), [])
  const getBucket = (d: Date): DayBucket => dayBuckets.get(ymd(d)) ?? emptyBucket

  const headerLabel = useMemo(() => {
    if (mobileView === 'day') {
      return `יום ${HEBREW_WEEKDAY_FULL[selectedDate.getDay()]}, ${selectedDate.getDate()} ב${HEBREW_MONTHS[selectedDate.getMonth()]}`
    }
    if (mobileView === 'week' || mobileView === 'workweek') {
      return formatRangeLabel(viewSpec.rangeStart, viewSpec.rangeEndInclusive)
    }
    return `${HEBREW_MONTHS[selectedDate.getMonth()]} ${selectedDate.getFullYear()}`
  }, [mobileView, selectedDate, viewSpec.rangeStart, viewSpec.rangeEndInclusive])

  const goPrev = () => {
    if (mobileView === 'month') {
      onSelectDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() - 1, 1))
    } else if (mobileView === 'workweek') {
      onSelectDate(addDays(selectedDate, -7))
    } else {
      onSelectDate(addDays(selectedDate, -7))
    }
  }
  const goNext = () => {
    if (mobileView === 'month') {
      onSelectDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 1))
    } else if (mobileView === 'workweek') {
      onSelectDate(addDays(selectedDate, 7))
    } else {
      onSelectDate(addDays(selectedDate, 7))
    }
  }
  const goToday = () => onSelectDate(new Date())

  const touchStartXRef = useRef<number | null>(null)
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0]?.clientX ?? null
  }
  const handleTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartXRef.current
    touchStartXRef.current = null
    if (start == null) return
    const end = e.changedTouches[0]?.clientX ?? start
    const dx = end - start
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return
    if (dx > 0) goPrev()
    else goNext()
  }

  const dayStripDays = useMemo(() => {
    const ws = startOfWeek(selectedDate)
    return Array.from({ length: 7 }, (_, i) => addDays(ws, i))
  }, [selectedDate])

  const weekViewDays = useMemo(() => {
    const count = mobileView === 'workweek' ? WORKWEEK_DAYS : 7
    return Array.from({ length: count }, (_, i) => addDays(viewSpec.rangeStart, i))
  }, [viewSpec.rangeStart, mobileView])

  const monthGridDays = useMemo(() => {
    if (mobileView !== 'month') return []
    const days: Date[] = []
    let cur = viewSpec.fetchStart
    const last = viewSpec.fetchEnd
    while (cur <= last) {
      days.push(cur)
      cur = addDays(cur, 1)
    }
    return days
  }, [mobileView, viewSpec.fetchStart, viewSpec.fetchEnd])

  const visibleMonth = useMemo(() => startOfMonth(selectedDate), [selectedDate])

  return (
    <div className="outlook-mobile-cal flex flex-col bg-gray-50 dark:bg-gray-900 min-h-[70vh] rounded-xl overflow-hidden" dir="rtl">
      <div className="sticky top-0 z-10 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between px-3 py-2.5">
          {onOpenFilters ? (
            <button
              type="button"
              onClick={onOpenFilters}
              aria-label="פתח סינון"
              className="w-10 h-10 inline-flex items-center justify-center rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <Settings className="w-5 h-5" />
            </button>
          ) : (
            <span className="w-10 h-10" />
          )}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={goPrev}
              aria-label="קודם"
              className="w-9 h-9 inline-flex items-center justify-center rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
            <div className="text-sm sm:text-base font-semibold text-gray-900 dark:text-white min-w-[9rem] text-center">
              {headerLabel}
            </div>
            <button
              type="button"
              onClick={goNext}
              aria-label="הבא"
              className="w-9 h-9 inline-flex items-center justify-center rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          </div>
          <button
            type="button"
            onClick={goToday}
            className="px-3 h-9 inline-flex items-center rounded-lg text-sm font-medium text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/20"
          >
            היום
          </button>
        </div>

        <div
          role="tablist"
          aria-label="תצוגת לוח שנה"
          className="flex items-center gap-1 px-2 pb-2 border-t border-gray-100 dark:border-gray-700 pt-2"
        >
          {VIEW_TABS.map((tab) => {
            const selected = mobileView === tab.value
            return (
              <button
                key={tab.value}
                role="tab"
                aria-selected={selected}
                type="button"
                onClick={() => onMobileViewChange(tab.value)}
                className={cn(
                  'flex-1 h-8 inline-flex items-center justify-center rounded-full text-xs font-medium transition-colors',
                  selected
                    ? 'bg-violet-600 text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/40',
                )}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        {showUserFilter && (
          <div className="px-2 pb-2">
            <select
              aria-label="סינון לפי משתמש"
              value={filterUserId ?? ''}
              onChange={(e) => onFilterUserChange?.(e.target.value ? Number(e.target.value) : null)}
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 text-sm font-medium"
            >
              <option value="">כל המשתמשים</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>{user.full_name}</option>
              ))}
            </select>
          </div>
        )}

        {mobileView === 'day' && (
          <div
            className="outlook-mobile-cal__strip flex gap-1 px-2 pb-2 overflow-x-auto"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            {dayStripDays.map((d) => {
              const key = ymd(d)
              const bucket = dayBuckets.get(key)
              const isSelected = isSameDay(d, selectedDate)
              const isToday = isSameDay(d, today)
              const dotColors = bucket
                ? Array.from(new Set(bucket.tasks.map((t) => t.color))).slice(0, 3)
                : []
              const dayLabel = formatCalendarDay(d, calendarDateDisplay)
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onSelectDate(d)}
                  aria-label={`${HEBREW_WEEKDAY_FULL[d.getDay()]} ${d.getDate()} ב${HEBREW_MONTHS[d.getMonth()]}`}
                  aria-pressed={isSelected}
                  className={cn(
                    'outlook-mobile-cal__day flex-shrink-0 min-w-[44px] flex flex-col items-center gap-1 py-1.5 rounded-xl',
                    isSelected ? '' : 'hover:bg-gray-100 dark:hover:bg-gray-700/40',
                  )}
                >
                  <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                    {HEBREW_WEEKDAY_INITIALS[d.getDay()]}
                  </span>
                  <span
                    className={cn(
                      'w-10 h-10 inline-flex items-center justify-center rounded-full text-sm font-semibold transition-colors',
                      isSelected
                        ? 'bg-violet-600 text-white'
                        : isToday
                          ? 'ring-2 ring-violet-500 text-violet-700 dark:text-violet-300'
                          : 'text-gray-800 dark:text-gray-100',
                    )}
                  >
                    {dayLabel}
                  </span>
                  <span className="h-1.5 flex items-center gap-0.5">
                    {dotColors.map((c, i) => (
                      <span
                        key={i}
                        className="block w-1 h-1 rounded-full"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {mobileView === 'day' && (
        <>
          <div className="px-4 pt-4 pb-2">
            <h3 className="text-base font-bold text-gray-900 dark:text-white">
              {`יום ${HEBREW_WEEKDAY_FULL[selectedDate.getDay()]}, ${selectedDate.getDate()} ב${HEBREW_MONTHS[selectedDate.getMonth()]}`}
            </h3>
            <div className="mt-2 h-px bg-gray-200 dark:bg-gray-700" />
          </div>

          <div
            className="flex-1 px-3 pb-24"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            {(() => {
              const bucket = getBucket(selectedDate)
              const isEmpty = bucket.tasks.length === 0 && bucket.holidays.length === 0
              if (isEmpty) {
                return (
                  <div className="flex flex-col items-center justify-center py-16 text-gray-400 dark:text-gray-500 gap-3">
                    <CalendarDays className="w-10 h-10" />
                    <span className="text-sm font-medium">אין אירועים ביום זה</span>
                  </div>
                )
              }
              return <DayAgenda date={selectedDate} bucket={bucket} onEventClick={onEventClick} />
            })()}
          </div>
        </>
      )}

      {(mobileView === 'week' || mobileView === 'workweek') && (
        <div
          className="flex-1 px-3 pt-3 pb-24 space-y-3"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {weekViewDays.map((d) => {
            const bucket = getBucket(d)
            const isToday = isSameDay(d, today)
            const isSelected = isSameDay(d, selectedDate)
            const showMonth = d.getDate() === 1
            return (
              <section key={ymd(d)} className="space-y-2">
                <button
                  type="button"
                  onClick={() => onSelectDate(d)}
                  aria-pressed={isSelected}
                  className={cn(
                    'sticky top-[7.5rem] z-[5] w-full text-right flex items-center gap-2 px-2 py-1 rounded-lg backdrop-blur-md',
                    isSelected
                      ? 'bg-violet-50 dark:bg-violet-900/30'
                      : 'bg-gray-50/90 dark:bg-gray-900/80',
                  )}
                >
                  <span
                    className={cn(
                      'w-7 h-7 inline-flex items-center justify-center rounded-full text-xs font-bold',
                      isToday
                        ? 'bg-violet-600 text-white'
                        : 'text-gray-800 dark:text-gray-100',
                    )}
                  >
                    {d.getDate()}
                  </span>
                  <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                    {`יום ${HEBREW_WEEKDAY_FULL[d.getDay()]}`}
                  </span>
                  {showMonth && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {`ב${HEBREW_MONTHS[d.getMonth()]}`}
                    </span>
                  )}
                </button>
                <DayAgenda date={d} bucket={bucket} onEventClick={onEventClick} />
              </section>
            )
          })}
        </div>
      )}

      {mobileView === 'month' && (
        <div
          className="flex-1 pb-24"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <div className="px-3 pt-3">
            <div className="grid grid-cols-7 gap-1 mb-1">
              {HEBREW_WEEKDAY_INITIALS.map((w, i) => (
                <div key={i} className="text-center text-[11px] font-semibold text-gray-500 dark:text-gray-400 py-1">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {monthGridDays.map((d) => {
                const bucket = getBucket(d)
                const inMonth = d.getMonth() === visibleMonth.getMonth()
                const isSelected = isSameDay(d, selectedDate)
                const isToday = isSameDay(d, today)
                const dotColors = Array.from(new Set(bucket.tasks.map((t) => t.color))).slice(0, 3)
                return (
                  <button
                    key={ymd(d)}
                    type="button"
                    onClick={() => {
                      onSelectDate(d)
                      onMobileViewChange('day')
                    }}
                    aria-label={`${HEBREW_WEEKDAY_FULL[d.getDay()]} ${d.getDate()} ב${HEBREW_MONTHS[d.getMonth()]}`}
                    aria-pressed={isSelected}
                    className={cn(
                      'h-12 flex flex-col items-center justify-center gap-0.5 rounded-lg text-xs transition-colors',
                      inMonth
                        ? 'bg-white dark:bg-gray-800'
                        : 'bg-gray-100/60 dark:bg-gray-900/40 text-gray-400 dark:text-gray-600',
                      !isSelected && 'hover:bg-gray-50 dark:hover:bg-gray-700/50',
                    )}
                  >
                    <span
                      className={cn(
                        'w-6 h-6 inline-flex items-center justify-center rounded-full text-[12px] font-semibold',
                        isSelected
                          ? 'bg-violet-600 text-white'
                          : isToday
                            ? 'ring-2 ring-violet-500 text-violet-700 dark:text-violet-300'
                            : inMonth
                              ? 'text-gray-800 dark:text-gray-100'
                              : 'text-gray-400 dark:text-gray-600',
                      )}
                    >
                      {d.getDate()}
                    </span>
                    <span className="h-1 flex items-center gap-0.5">
                      {dotColors.map((c, i) => (
                        <span
                          key={i}
                          className="block w-1 h-1 rounded-full"
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="px-3 pt-4">
            <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-2">
              {`יום ${HEBREW_WEEKDAY_FULL[selectedDate.getDay()]}, ${selectedDate.getDate()} ב${HEBREW_MONTHS[selectedDate.getMonth()]}`}
            </h3>
            <DayAgenda
              date={selectedDate}
              bucket={getBucket(selectedDate)}
              onEventClick={onEventClick}
              emptyText="אין אירועים ביום זה"
            />
          </div>
        </div>
      )}

      {canCreate && (
        <button
          type="button"
          onClick={onCreateClick}
          aria-label="צור אירוע חדש"
          className="fixed bottom-5 left-5 z-20 w-14 h-14 rounded-full bg-violet-600 hover:bg-violet-700 text-white shadow-lg shadow-violet-500/40 inline-flex items-center justify-center"
        >
          <Plus className="w-6 h-6" />
        </button>
      )}
    </div>
  )
}
