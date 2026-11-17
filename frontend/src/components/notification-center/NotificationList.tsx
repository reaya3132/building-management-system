import { useEffect, useRef } from 'react'
import NotificationListItem from './NotificationListItem'
import type { CenterNotification, CenterView } from './useNotificationCenter'

const EMPTY: Record<CenterView, string> = {
  unread: 'אין עדכונים שלא נקראו',
  read: 'אין עדכונים שנקראו',
  all: 'אין עדכונים',
}

interface Props {
  view: CenterView
  items: CenterNotification[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  selectedId: number | null
  highlightedId?: number | null
  onSelect: (n: CenterNotification) => void
  onLoadMore: () => void
}

/** One chronological list. More is loaded when its end scrolls into view (and by
 * the button, which also works without IntersectionObserver). */
export default function NotificationList({
  view, items, loading, loadingMore, hasMore, selectedId, highlightedId = null, onSelect, onLoadMore,
}: Props) {
  const sentinel = useRef<HTMLDivElement>(null)
  const loadMore = useRef(onLoadMore)
  loadMore.current = onLoadMore

  useEffect(() => {
    if (!hasMore || !sentinel.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore.current()
    })
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [hasMore, items.length])

  if (loading) return <p className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">טוען...</p>
  if (items.length === 0) return <p className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">{EMPTY[view]}</p>

  return (
    <div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700/60" aria-label="עדכונים">
        {items.map((n) => (
          <NotificationListItem
            key={n.id}
            notification={n}
            selected={n.id === selectedId}
            highlighted={n.id === highlightedId}
            onSelect={onSelect}
          />
        ))}
      </ul>
      {hasMore && (
        <div ref={sentinel} className="p-3 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="text-sm text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
          >
            {loadingMore ? 'טוען...' : 'טען עוד'}
          </button>
        </div>
      )}
    </div>
  )
}
