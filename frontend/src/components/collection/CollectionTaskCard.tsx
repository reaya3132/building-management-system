import { Archive, Users } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { CollectionTaskListItem } from '../../lib/collectionApi'
import UnreadMessagesDot from '../task-management/UnreadMessagesDot'
import { COLLECTION_STATUS_CHIP, COLLECTION_STATUS_LABELS, COLLECTION_TYPE_LABELS, formatILS } from './collectionUtils'

export function projectLabel(task: Pick<CollectionTaskListItem, 'project'>): string {
  return task.project.parent_name ? `${task.project.parent_name} › ${task.project.name}` : task.project.name
}

export function StatusChip({ status }: { status: CollectionTaskListItem['status'] }) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap', COLLECTION_STATUS_CHIP[status])}>
      {COLLECTION_STATUS_LABELS[status]}
    </span>
  )
}

/** A compact clickable card for one collection task (month board + mobile list). */
export default function CollectionTaskCard({
  task,
  onOpen,
  showStatus = false,
}: {
  task: CollectionTaskListItem
  onOpen: (id: number) => void
  showStatus?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(task.id)}
      className={cn(
        'w-full text-right rounded-2xl border bg-white dark:bg-gray-800 p-3.5 shadow-sm transition-all',
        'border-gray-200 dark:border-gray-700 hover:shadow-md hover:border-blue-300 dark:hover:border-blue-700',
        task.is_archived && 'opacity-70'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-gray-900 dark:text-white break-words min-w-0">{task.title}</p>
        <UnreadMessagesDot show={task.unread_messages_count > 0} count={task.unread_messages_count} />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{projectLabel(task)}</p>
      <div className="flex items-center justify-between gap-2 mt-3">
        <span className="text-lg font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">{formatILS(task.total_amount)}</span>
        <span className="text-xs text-gray-500 dark:text-gray-400">{COLLECTION_TYPE_LABELS[task.collection_type]}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-gray-500 dark:text-gray-400">
        {showStatus && <StatusChip status={task.status} />}
        <span className="inline-flex items-center gap-1 min-w-0">
          <Users className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate">{task.assignees.map((a) => a.full_name).join(', ')}</span>
        </span>
        {task.is_archived && (
          <span className="inline-flex items-center gap-1"><Archive className="w-3.5 h-3.5" /> בארכיון</span>
        )}
      </div>
    </button>
  )
}
