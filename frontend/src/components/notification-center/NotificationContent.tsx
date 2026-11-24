import { Suspense, lazy } from 'react'
import type { CenterNotification } from './useNotificationCenter'

// The existing detail panels (3c), loaded only when "הצגת ההודעה" is clicked —
// the regular task panel lives in a large chunk.
const TaskDetailPanel = lazy(() =>
  import('../task-management/TaskDetailModal').then((m) => ({ default: m.TaskDetailPanel })))
const CollectionTaskDetailPanel = lazy(() =>
  import('../collection/CollectionTaskDetailModal').then((m) => ({ default: m.CollectionTaskDetailPanel })))

const TASK_TYPES = new Set(['task_message', 'task_assignment', 'task_reminder', 'task_date_changed'])

/**
 * Whether the notification may open its task's full content. Never for:
 *  - an archive notification (a snapshot: the task is not loaded at all);
 *  - a notification whose task is archived now (general or collection);
 *  - a notification whose task no longer exists (task_id cleared).
 */
export function canShowContent(n: CenterNotification): boolean {
  return n.type !== 'task_archived' && n.task_id != null && n.task_archived !== true && n.task_kind != null
}

/** Why there is no full content, when the notification is about a task. */
export function taskStatusNote(n: CenterNotification): string | null {
  if (n.type === 'task_archived') return null                    // the snapshot says it all
  if (n.task_archived === true) return 'המשימה אורכבה'
  if (n.task_id == null && TASK_TYPES.has(n.type)) return 'המשימה אינה זמינה עוד'
  return null
}

interface Props {
  notification: CenterNotification
  /** Back to the summary. */
  onClose: () => void
  /** Something changed in the task (the list may refresh). */
  onChanged: () => void
  onTaskArchived: () => void
  onTaskDeleted: () => void
}

/** The task's full content inside the center, by its module. Checks
 * ``canShowContent`` again itself, so nothing is loaded for an archived / deleted
 * task even if it is rendered by mistake. */
export default function NotificationContent({ notification: n, onClose, onChanged, onTaskArchived, onTaskDeleted }: Props) {
  if (!canShowContent(n)) return null
  const taskId = n.task_id as number
  return (
    <Suspense fallback={<p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">טוען...</p>}>
      {n.task_kind === 'collection' ? (
        <CollectionTaskDetailPanel taskId={taskId} onChanged={onChanged} />
      ) : (
        <TaskDetailPanel
          taskId={taskId}
          embedded
          onClose={onClose}
          onTaskUpdated={onChanged}
          onTaskArchived={onTaskArchived}
          onTaskDeleted={onTaskDeleted}
        />
      )}
    </Suspense>
  )
}
