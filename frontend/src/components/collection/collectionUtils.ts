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
  open: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/20 dark:text-orange-300 dark:border-orange-800',
  in_progress: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800',
  closed: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800',
}

/** Accent dot colour per status (column headers, summary tiles). */
export const COLLECTION_STATUS_DOT: Record<CollectionStatus, string> = {
  open: 'bg-orange-500',
  in_progress: 'bg-blue-500',
  closed: 'bg-emerald-500',
}

/** Side stripe of a task card per status: a soft colour on the card's start (right) edge. */
export const COLLECTION_STATUS_STRIPE: Record<CollectionStatus, string> = {
  open: 'border-s-orange-300 hover:border-s-orange-300 dark:border-s-orange-700 dark:hover:border-s-orange-700',
  in_progress: 'border-s-blue-300 hover:border-s-blue-300 dark:border-s-blue-700 dark:hover:border-s-blue-700',
  closed: 'border-s-emerald-300 hover:border-s-emerald-300 dark:border-s-emerald-700 dark:hover:border-s-emerald-700',
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

/** A server decimal string ("-12.30") as integer agorot, avoiding float sums. */
export function toAgorot(amount: string | number | null | undefined): number {
  const value = Number(amount ?? 0)
  return Number.isFinite(value) ? Math.round(value * 100) : 0
}

export type AdjustmentKind = 'addition' | 'reduction'

/** The signed server amount for a positive typed amount: a reduction is negative. */
export function signedAdjustment(positive: string, kind: AdjustmentKind): string {
  return kind === 'reduction' ? `-${positive}` : positive
}

/** The required detail of an addition / reduction, trimmed; null when empty or whitespace only. */
export function normalizeAdjustmentNote(raw: string): string | null {
  const text = raw.trim()
  return text ? text : null
}

/**
 * Client-side mirror of the server rule (the server decides): the total
 * (initial amount + all adjustments) may be 0 but never negative.
 */
export function totalStaysNonNegative(currentTotal: string, deltaAgorot: number): boolean {
  return toAgorot(currentTotal) + deltaAgorot >= 0
}

// ── VAT (מע״מ) ───────────────────────────────────────────────────────────────
//
// Preview mirror of backend/services/vat.py — the server computes every saved
// amount; this only previews a form before it is sent. Same exact rule: agorot ×
// rate in ten-thousandths, BigInt, round half up, per amount:
//   VAT excluded: vat = round(amount × rate);           to pay = amount + vat
//   VAT included: vat = round(amount × rate / (1+rate)); to pay = amount

/** "1234.5" → 123450n (exact; no float). Null when not a plain non-negative decimal. */
function decimalToUnits(value: string, scale: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (!match) return null
  const fraction = match[2] ?? ''
  if (fraction.length > scale && /[^0]/.test(fraction.slice(scale))) return null
  return BigInt(match[1] + fraction.slice(0, scale).padEnd(scale, '0'))
}

function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator)
}

export interface VatPreview {
  /** Agorot; null when the VAT facts are unknown (an amount saved before VAT support). */
  netAgorot: number | null
  vatAgorot: number | null
  /** Agorot to pay. */
  grossAgorot: number
}

/**
 * Before VAT / VAT / to pay of one amount ("1000.00", or "-100.00" for a
 * reduction), given whether it includes VAT and the rate ("0.1800"). A negative
 * amount mirrors the positive one (the rule on |amount|, the sign put back).
 * Null when the amount or rate is not valid.
 */
export function vatBreakdown(amount: string, vatIncluded: boolean | null, rate: string | null): VatPreview | null {
  const text = amount.trim()
  const sign = text.startsWith('-') ? -1 : 1
  const agorot = decimalToUnits(sign < 0 ? text.slice(1) : text, 2)
  if (agorot === null) return null
  if (vatIncluded === null || rate === null) return { netAgorot: null, vatAgorot: null, grossAgorot: sign * Number(agorot) }
  const units = decimalToUnits(rate, 4)
  if (units === null || units >= 10000n) return null
  const [net, vat, gross] = vatIncluded
    ? (() => { const v = divRoundHalfUp(agorot * units, 10000n + units); return [agorot - v, v, agorot] })()
    : (() => { const v = divRoundHalfUp(agorot * units, 10000n); return [agorot, v, agorot + v] })()
  return { netAgorot: sign * Number(net), vatAgorot: sign * Number(vat), grossAgorot: sign * Number(gross) }
}

/** Integer agorot → a server-style decimal string ("1180.00"). */
export function agorotToAmount(agorot: number): string {
  const sign = agorot < 0 ? '-' : ''
  const abs = Math.abs(agorot)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** "0.1800" → "18%", "0.1750" → "17.5%". */
export function formatVatRate(rate: string | null | undefined): string {
  if (rate == null) return ''
  const units = decimalToUnits(rate, 4)
  if (units === null) return ''
  const percent = Number(units) / 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, '')}%`
}

/** Short label of an amount's VAT choice; empty for an amount saved before VAT support. */
export function vatChoiceLabel(vatIncluded: boolean | null | undefined): string {
  if (vatIncluded == null) return ''
  return vatIncluded ? 'כולל מע״מ' : '+ מע״מ'
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
  total_negative: 'הסכום הכולל לגבייה לא יכול להיות שלילי.',
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
