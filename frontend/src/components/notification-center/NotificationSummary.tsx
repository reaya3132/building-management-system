import { useState } from 'react'
import { ArrowRight, Eye } from 'lucide-react'
import NotificationContent, { canShowContent, taskStatusNote } from './NotificationContent'
import { formatNotificationTime } from './NotificationListItem'
import type { CenterNotification } from './useNotificationCenter'

interface Props {
  notification: CenterNotification
  marking: boolean
  onMarkUnread: () => void
  onBack: () => void
  /** The list should refresh (something changed in the task). */
  onChanged: () => void
  /** Local facts about the selected one, until the list refreshes. */
  onUpdate: (patch: Partial<CenterNotification>) => void
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div className="flex gap-2 text-sm">
      <dt className="shrink-0 text-gray-500 dark:text-gray-400">{label}:</dt>
      <dd className="min-w-0 text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  )
}

/**
 * The selected notification's details: a summary built from the notification
 * alone (nothing is fetched), and — only on "הצגת ההודעה" — the task's full
 * content through the existing panels. An archive notification is a snapshot; a
 * notification on an archived or deleted task shows itself only, with a note.
 */
export default function NotificationSummary({ notification: n, marking, onMarkUnread, onBack, onChanged, onUpdate }: Props) {
  const [showContent, setShowContent] = useState(false)
  const kind = n.task_kind === 'collection' ? 'משימת גבייה' : n.task_kind === 'general' ? 'משימה' : null
  const note = taskStatusNote(n)
  const archiveSnapshot = n.type === 'task_archived'
  const chat = n.type === 'task_message'

  return (
    <div className="space-y-4" data-testid="selected-notification">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-sm text-blue-600 lg:hidden">
        <ArrowRight className="h-4 w-4" /> חזרה לרשימה
      </button>

      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{n.title}</h2>
        <time dateTime={n.created_at} className="block text-xs text-gray-500 dark:text-gray-400">
          {formatNotificationTime(n.created_at)}
        </time>
      </div>

      {archiveSnapshot ? (
        // Everything shown is the text kept in the notification: it needs no task.
        n.body_preview && <p className="text-sm text-gray-700 dark:text-gray-300">{n.body_preview}</p>
      ) : (
        <dl className="space-y-1.5">
          <Row label={chat ? 'נשלח על ידי' : 'מאת'} value={n.from_user_name} />
          <Row label={kind ?? 'משימה'} value={n.task_title} />
          {/* A chat message's content is not shown here — only who, where and when. */}
          {!chat && n.body_preview && (
            <p className="pt-1 text-sm text-gray-700 dark:text-gray-300">{n.body_preview}</p>
          )}
        </dl>
      )}

      {note && (
        <p className="inline-block rounded-lg bg-gray-100 px-2.5 py-1 text-sm text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          {note}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {canShowContent(n) && !showContent && (
          <button
            type="button"
            onClick={() => setShowContent(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Eye className="h-4 w-4" /> הצגת ההודעה
          </button>
        )}
        {n.read_at != null && (
          <button
            type="button"
            onClick={onMarkUnread}
            disabled={marking}
            className="text-sm text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
          >
            סמן כלא נקראה
          </button>
        )}
      </div>

      {showContent && (
        <div className="border-t border-gray-200 pt-4 dark:border-gray-700" data-testid="notification-content">
          <NotificationContent
            notification={n}
            onClose={() => setShowContent(false)}
            onChanged={onChanged}
            onTaskArchived={() => { onUpdate({ task_archived: true }); onChanged() }}
            onTaskDeleted={() => { onUpdate({ task_id: null, task_archived: null, task_kind: null }); onChanged() }}
          />
        </div>
      )}
    </div>
  )
}
