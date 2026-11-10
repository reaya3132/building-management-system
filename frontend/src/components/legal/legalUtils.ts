import type { PartyRole, ProceedingStatus, StageStatus } from '../../lib/legalApi'

export const STATUS_LABELS: Record<ProceedingStatus, string> = { open: 'פתוח', closed: 'סגור' }

export const STATUS_BADGE: Record<ProceedingStatus, string> = {
  open: 'bg-primary/10 text-primary border-primary/20',
  closed: 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700',
}

export const PARTY_ROLE_LABELS: Record<PartyRole, string> = {
  tenant: 'שוכר',
  landlord: 'בעל דירה',
  supplier: 'ספק',
  other: 'אחר',
}

export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  pending: 'ממתין',
  completed: 'הושלם',
  skipped: 'לא רלוונטי',
}

export function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString('he-IL') : '—'
}

interface ApiErrorShape {
  response?: { status?: number; data?: { detail?: unknown } }
}

const CODE_MESSAGES: Record<string, string> = {
  contact_required: 'יש לבחור איש קשר או להזין פרטי איש קשר חדש.',
  landlord_required: 'בהליך מול שוכר יש לבחור בעל דירה.',
  contact_details_incomplete: 'חסרים פרטי חובה באיש הקשר.',
  contact_not_found: 'איש הקשר לא נמצא.',
  contact_inactive: 'איש הקשר אינו פעיל.',
  invalid_phone: 'מספר הטלפון אינו תקין.',
  apartment_number_required: 'יש להזין מספר דירה.',
  title_required: 'יש להזין כותרת.',
  invalid_amount: 'סכום התביעה אינו תקין.',
  project_not_found: 'הפרויקט לא נמצא.',
  already_closed: 'ההליך כבר סגור.',
  already_open: 'ההליך כבר פתוח.',
  close_reason_required: 'יש להזין סיבת סגירה.',
}

const STATUS_MESSAGES: Record<number, string> = {
  403: 'אין לך הרשאה לבצע פעולה זו.',
  404: 'ההליך לא נמצא.',
  422: 'יש לבדוק שכל השדות מולאו כראוי.',
}

const hasHebrew = (text: string) => /[֐-׿]/.test(text)

/** The server's business-rule code, when the error carries one. */
export function legalErrorCode(error: unknown): string | undefined {
  const detail = (error as ApiErrorShape)?.response?.data?.detail
  return detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as { code?: string }).code : undefined
}

/** A Hebrew message for an API error: the server's own when Hebrew, otherwise by code or status. */
export function legalErrorMessage(error: unknown, fallback: string): string {
  const response = (error as ApiErrorShape)?.response
  const detail = response?.data?.detail
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const { code, message } = detail as { code?: string; message?: string }
    if (message && hasHebrew(message)) return message
    if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code]
  }
  if (typeof detail === 'string' && hasHebrew(detail)) return detail
  return (response?.status && STATUS_MESSAGES[response.status]) || fallback
}
