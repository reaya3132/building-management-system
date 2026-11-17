import { cn } from '../../lib/utils'
import { serverTime, type CenterNotification } from './useNotificationCenter'

export function formatNotificationTime(iso: string, now = new Date()): string {
  const d = new Date(serverTime(iso))
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** The line under the title: who and where — never a chat message's content. */
export function notificationSubline(n: CenterNotification): string {
  const where = [n.from_user_name, n.task_title].filter(Boolean).join(' · ')
  if (n.type === 'task_message') return where
  // An archive notification's text holds its kind and who archived it (a snapshot).
  if (n.type === 'task_archived') return n.body_preview ?? ''
  return n.body_preview || where
}

interface Props {
  notification: CenterNotification
  selected: boolean
  highlighted?: boolean
  onSelect: (n: CenterNotification) => void
}

export default function NotificationListItem({ notification: n, selected, highlighted = false, onSelect }: Props) {
  const unread = n.read_at == null
  const tag = n.task_kind === 'collection' ? 'גבייה' : n.task_kind === 'general' ? 'משימה' : null
  const subline = notificationSubline(n)
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(n)}
        aria-current={selected ? 'true' : undefined}
        data-notification-id={n.id}
        className={cn(
          'w-full text-right px-4 py-3 flex gap-3 items-start transition-colors',
          'hover:bg-gray-50 dark:hover:bg-gray-800/60',
          selected && 'bg-blue-50 dark:bg-blue-900/20',
          highlighted && 'ring-2 ring-inset ring-amber-400',
        )}
      >
        <span
          aria-label={unread ? 'לא נקראה' : undefined}
          className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', unread ? 'bg-blue-600' : 'bg-transparent')}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={cn('truncate text-sm text-gray-900 dark:text-gray-100', unread ? 'font-semibold' : 'font-normal')}>
              {n.title}
            </span>
            {tag && (
              <span className="shrink-0 rounded px-1.5 text-[11px] bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                {tag}
              </span>
            )}
          </span>
          {subline && <span className="block truncate text-xs text-gray-500 dark:text-gray-400">{subline}</span>}
        </span>
        <time dateTime={n.created_at} className="shrink-0 text-xs text-gray-400 dark:text-gray-500">
          {formatNotificationTime(n.created_at)}
        </time>
      </button>
    </li>
  )
}
