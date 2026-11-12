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
  already_assigned: 'המשתמש כבר משויך להליך.',
  user_not_assignable: 'המשתמש אינו קיים או אינו פעיל.',
  creator_is_owner: 'יוצר ההליך הוא האחראי הראשי ואינו נדרש לשיוך.',
  contact_required: 'יש לבחור איש קשר או להזין פרטי איש קשר חדש.',
  landlord_required: 'בהליך מול שוכר יש לבחור בעל דירה.',
  contact_details_incomplete: 'חסרים פרטי חובה באיש הקשר.',
  contact_not_found: 'איש הקשר לא נמצא.',
  contact_inactive: 'איש הקשר אינו פעיל.',
  invalid_phone: 'מספר הטלפון אינו תקין.',
  title_required: 'יש להזין את נושא ההליך.',
  base_items_required: 'יש להזין לפחות סכום אחד.',
  ledger_subject_required: 'יש להזין נושא.',
  ledger_item_not_found: 'הפריט לא נמצא.',
  ledger_item_archived: 'הפריט כבר בארכיון.',
  base_item_not_archivable: 'לא ניתן להעביר סכום בסיס לארכיון.',
  contact_field_not_missing: 'ניתן להשלים רק פרטים חסרים.',
  proceeding_closed: 'ההליך סגור. יש לפתוח אותו מחדש.',
  stage_not_pending: 'ניתן להשלים או לדלג רק על שלב ממתין.',
  stage_not_resolved: 'ניתן לפתוח מחדש רק שלב שהושלם או שסומן כלא רלוונטי.',
  content_required: 'יש להזין תוכן.',
  channel_required: 'יש לבחור ערוץ.',
  occurred_at_required: 'יש להזין תאריך.',
  communication_needs_content_or_file: 'יש להזין תוכן או לצרף קובץ.',
  last_file_of_communication: 'לא ניתן למחוק את הקובץ האחרון של תיעוד ללא תוכן.',
  file_required: 'יש לבחור קובץ.',
  too_many_files: 'נבחרו יותר מדי קבצים.',
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

export const CHANNEL_LABELS: Record<'email' | 'whatsapp' | 'other', string> = { email: 'מייל', whatsapp: 'WhatsApp', other: 'אחר' }

export const STAGE_STATUS_BADGE: Record<StageStatus, string> = {
  pending: 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800',
  skipped: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800',
}

export function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

/** The documentation the server reported missing on a stage completion, if that was the error. */
export function missingDocumentation(error: unknown): Array<{ key: string; label: string }> | null {
  const detail = (error as ApiErrorShape)?.response?.data?.detail as { code?: string; missing?: Array<{ key: string; label: string }> } | undefined
  return detail && typeof detail === 'object' && detail.code === 'stage_requirements_missing' ? detail.missing ?? [] : null
}
