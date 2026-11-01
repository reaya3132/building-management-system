import { extractErrorMessage } from '../../lib/apiError'
import type { NoteBoard } from '../../lib/projectNotesApi'

export const NOTE_CONTENT_MAX = 10_000
export const NOTE_TITLE_MAX = 255

/** Board names as shown in the UI. */
export const NOTE_BOARD_TITLES: Record<NoteBoard, string> = {
  general: 'תיעוד הפרויקט',
  fund: 'תיעוד הקופה',
}

const DATE = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' })
const TIME = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' })

/** A note's own date and time (each note shows its own — no group headings). */
export function formatNoteDate(value: string): { date: string; time: string } {
  const d = new Date(value)
  return { date: DATE.format(d), time: TIME.format(d) }
}

const ERROR_CODES: Record<string, string> = {
  parent_project: 'לוחות תיעוד אינם זמינים בפרויקט אב.',
  no_fund: 'לפרויקט אין קופה, ולכן תיעוד הקופה אינו זמין.',
}

const STATUS_MESSAGES: Record<number, string> = {
  403: 'אין לך הרשאה לבצע פעולה זו.',
  404: 'הרשומה לא נמצאה.',
}

/** Hebrew text for an API error from the notes endpoints. */
export function noteErrorMessage(error: unknown, fallback: string): string {
  const response = (error as { response?: { status?: number; data?: { detail?: unknown } } })?.response
  const detail = response?.data?.detail
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const { code } = detail as { code?: string }
    if (code && ERROR_CODES[code]) return ERROR_CODES[code]
  }
  if (response?.status && STATUS_MESSAGES[response.status]) return STATUS_MESSAGES[response.status]
  return extractErrorMessage(error, fallback)
}
