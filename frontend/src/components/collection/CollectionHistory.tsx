import { useCallback, useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { CollectionAPI, type CollectionAuditEntry } from '../../lib/collectionApi'
import {
  COLLECTION_STATUS_LABELS,
  collectionErrorMessage,
  formatDateTime,
  formatILS,
  formatMonth,
} from './collectionUtils'

const PAGE_SIZE = 30

/** Hebrew labels for the audit actions written by the collection service. */
export const COLLECTION_EVENT_LABELS: Record<string, string> = {
  created: 'המשימה נוצרה',
  updated: 'פרטי המשימה עודכנו',
  project_changed: 'הפרויקט שונה',
  month_changed: 'חודש החיוב הועבר',
  assignees_changed: 'המוקצים שונו',
  status_changed: 'הסטטוס שונה',
  reopened: 'המשימה נפתחה מחדש',
  archived: 'המשימה הועברה לארכיון',
  unarchived: 'המשימה שוחזרה מהארכיון',
  adjustment_added: 'נוספה תוספת לסכום',
  ledger_item_added: 'נוסף פריט',
  ledger_item_updated: 'פריט עודכן',
  ledger_item_archived: 'פריט הועבר לארכיון',
  message_added: 'נשלחה הודעה',
  message_edited: 'הודעה נערכה',
  message_deleted: 'הודעה נמחקה',
  attachment_added: 'צורף קובץ',
  attachment_deleted: 'קובץ נמחק',
}

// History may hold the stored task status (pending/completed) or the display one.
const STATUS_TEXT: Record<string, string> = {
  ...COLLECTION_STATUS_LABELS,
  pending: COLLECTION_STATUS_LABELS.open,
  completed: COLLECTION_STATUS_LABELS.closed,
}

type Snapshot = Record<string, unknown> | undefined

/** A short, human description of what changed, from the entry's details. */
export function describeCollectionEvent(entry: CollectionAuditEntry): string | null {
  const d = entry.details ?? {}
  const before = d.before as Snapshot
  const after = d.after as Snapshot
  switch (entry.action) {
    case 'status_changed':
    case 'reopened':
      return `${STATUS_TEXT[String(before?.status)] ?? before?.status ?? ''} ← ${STATUS_TEXT[String(after?.status)] ?? after?.status ?? ''}`
    case 'month_changed': {
      const text = `${formatMonth(String(before?.billing_month))} ← ${formatMonth(String(after?.billing_month))}`
      return d.reason ? `${text} · ${d.reason}` : text
    }
    case 'adjustment_added':
      return after?.note ? `${formatILS(after.amount as string)} · ${after.note}` : formatILS(after?.amount as string)
    case 'ledger_item_added':
      return `${after?.subject ?? ''} · ${formatILS(after?.amount as string)}`
    case 'ledger_item_archived':
      return `${before?.subject ?? ''} · ${formatILS(before?.amount as string)}`
    case 'ledger_item_updated': {
      const parts: string[] = []
      if (after && 'subject' in after) parts.push(`נושא: ${before?.subject} ← ${after.subject}`)
      if (after && 'amount' in after) parts.push(`סכום: ${formatILS(before?.amount as string)} ← ${formatILS(after.amount as string)}`)
      return parts.join(' · ') || null
    }
    case 'attachment_added':
    case 'attachment_deleted':
      return (d.file_name as string) ?? null
    case 'message_added':
    case 'message_deleted':
      return (d.preview as string) || null
    case 'message_edited':
      return (after?.preview as string) || null
    default:
      return null
  }
}

export default function CollectionHistory({ taskId, refreshKey }: { taskId: number; refreshKey?: number }) {
  const [entries, setEntries] = useState<CollectionAuditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (nextPage: number) => {
    setLoading(true)
    try {
      const data = await CollectionAPI.history(taskId, nextPage, PAGE_SIZE)
      setEntries((prev) => (nextPage === 1 ? data.items : [...prev, ...data.items]))
      setTotal(data.total)
      setPage(nextPage)
      setError(null)
    } catch (err) {
      setError(collectionErrorMessage(err, 'שגיאה בטעינת ההיסטוריה'))
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => { void load(1) }, [load, refreshKey])

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
  if (!loading && entries.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-6">אין היסטוריה עדיין</p>
  }

  return (
    <div className="space-y-3">
      <ol className="relative border-r-2 border-gray-200 dark:border-gray-700 pr-4 space-y-3">
        {entries.map((entry) => {
          const description = describeCollectionEvent(entry)
          return (
            <li key={entry.id} className="relative">
              <span className="absolute -right-[1.4rem] top-1 w-3 h-3 rounded-full bg-white dark:bg-gray-800 border-2 border-blue-500" />
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-semibold text-gray-900 dark:text-white">
                  {COLLECTION_EVENT_LABELS[entry.action] ?? entry.action}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {entry.user_name ?? 'מערכת'} · {formatDateTime(entry.created_at)}
                </span>
              </div>
              {description && <p className="text-sm text-gray-600 dark:text-gray-300 break-words">{description}</p>}
            </li>
          )
        })}
      </ol>
      {loading && <p className="text-sm text-gray-500 dark:text-gray-400 text-center">טוען...</p>}
      {!loading && entries.length < total && (
        <button
          type="button"
          onClick={() => void load(page + 1)}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-gray-200 dark:border-gray-700 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          <History className="w-4 h-4" /> הצג עוד
        </button>
      )}
    </div>
  )
}
