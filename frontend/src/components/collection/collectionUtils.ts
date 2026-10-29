import { extractErrorMessage } from '../../lib/apiError'
import type { CollectionStatus, CollectionType } from '../../lib/collectionApi'

/** Display labels / colours for the three collection statuses. */
export const COLLECTION_STATUS_LABELS: Record<CollectionStatus, string> = {
  open: 'פתוחה',
  in_progress: 'בטיפול',
  closed: 'נסגרה',
}

export const COLLECTION_STATUSES: CollectionStatus[] = ['open', 'in_progress', 'closed']

/** Tailwind classes for a status chip (light + dark). */
export const COLLECTION_STATUS_CHIP: Record<CollectionStatus, string> = {
  open: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800',
  in_progress: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800',
  closed: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800',
}

/** Accent dot colour per status (column headers, summary tiles). */
export const COLLECTION_STATUS_DOT: Record<CollectionStatus, string> = {
  open: 'bg-amber-500',
  in_progress: 'bg-blue-500',
  closed: 'bg-emerald-500',
}

export const COLLECTION_TYPE_LABELS: Record<CollectionType, string> = {
  single: 'חד־פעמית',
  ledger: 'כרטסת',
}

/** Display prefix of a ledger task's title; never stored or sent to the server. */
export const LEDGER_TITLE_PREFIX = `${COLLECTION_TYPE_LABELS.ledger} - `

/**
 * The title as shown: "כרטסת - <title>" for a ledger, the stored title
 * otherwise. Display only — forms edit and save the raw `title`, so the prefix
 * can never be stored or doubled.
 */
export function displayCollectionTitle(task: { title: string; collection_type: CollectionType }): string {
  return task.collection_type === 'ledger' ? `${LEDGER_TITLE_PREFIX}${task.title}` : task.title
}

const HE_MONTHS_SHORT = new Intl.DateTimeFormat('he-IL', { month: 'short' })

/** Short Hebrew month name for month index 1–12. */
export function shortMonthName(month: number): string {
  return HE_MONTHS_SHORT.format(new Date(2000, month - 1, 1))
}

const ILS = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Formats a server decimal string (e.g. "1234.50") as ₪1,234.50. */
export function formatILS(amount: string | number | null | undefined): string {
  const value = typeof amount === 'number' ? amount : Number(amount ?? 0)
  return ILS.format(Number.isFinite(value) ? value : 0)
}

const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/

/**
 * Normalizes a user-typed amount to the server's format, or null when invalid.
 * Mirrors the backend Money rule: positive, up to 10 integer digits, ≤ 2 decimals.
 */
export function parseMoneyInput(raw: string): string | null {
  const text = raw.trim().replace(/,/g, '')
  if (!MONEY_PATTERN.test(text)) return null
  if (Number(text) <= 0) return null
  return text
}

// ── billing months (YYYY-MM) ──────────────────────────────────────────────────

export function currentMonth(today: Date = new Date()): string {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
}

export function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split('-').map(Number)
  const date = new Date(year, mon - 1 + delta, 1)
  return currentMonth(date)
}

/** "2026-10" or "2026-10-01" → "אוקטובר 2026". */
export function formatMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number)
  return new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' }).format(new Date(year, mon - 1, 1))
}

/** "2026-10-01" → "2026-10". */
export function toMonthKey(billingMonth: string): string {
  return billingMonth.slice(0, 7)
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return ''
  return new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

// ── errors ───────────────────────────────────────────────────────────────────

/** Hebrew text for the business error codes raised by CollectionTaskService. */
const ERROR_CODE_MESSAGES: Record<string, string> = {
  task_archived: 'המשימה בארכיון. יש לשחזר אותה לפני ביצוע שינויים.',
  task_closed: 'המשימה סגורה. יש לפתוח אותה מחדש כדי לשנות סכומים או פריטים.',
  wrong_collection_type: 'הפעולה אינה מתאימה לסוג הגבייה של המשימה.',
  unarchive_first: 'יש לשחזר את המשימה מהארכיון לפני פתיחתה מחדש.',
  item_not_found: 'הפריט לא נמצא.',
  item_archived: 'הפריט כבר הועבר לארכיון.',
  project_not_active: 'הפרויקט שנבחר אינו פעיל.',
  invalid_month: 'חודש לא תקין.',
}

const STATUS_MESSAGES: Record<number, string> = {
  403: 'אין לך הרשאה לבצע פעולה זו.',
  404: 'המשימה לא נמצאה.',
}

/**
 * Turns an API error into a Hebrew message. Handles the module's
 * `{code, message}` details, plain string details and HTTP status fallbacks.
 */
export function collectionErrorMessage(error: unknown, fallback: string): string {
  const response = (error as { response?: { status?: number; data?: { detail?: unknown } } })?.response
  const detail = response?.data?.detail
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const { code, message } = detail as { code?: string; message?: string }
    if (code && ERROR_CODE_MESSAGES[code]) return ERROR_CODE_MESSAGES[code]
    if (message) return message
  }
  // Hebrew server messages are shown as-is; English ones (e.g. "Access denied")
  // fall back to a Hebrew text for their HTTP status.
  if (typeof detail === 'string' && /[֐-׿]/.test(detail)) return detail
  if (response?.status && STATUS_MESSAGES[response.status]) return STATUS_MESSAGES[response.status]
  return extractErrorMessage(error, fallback)
}

/** Shared field styling, matching the system's rounded inputs (RTL + dark). */
export const FIELD_CLASS =
  'w-full rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60'
