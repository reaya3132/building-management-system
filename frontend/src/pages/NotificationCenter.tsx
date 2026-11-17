import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { cn } from '../lib/utils'
import NotificationList from '../components/notification-center/NotificationList'
import NotificationSummary from '../components/notification-center/NotificationSummary'
import NotificationListItem from '../components/notification-center/NotificationListItem'
import {
  CENTER_VIEWS, useNotificationCenter, type CenterView,
} from '../components/notification-center/useNotificationCenter'

const VIEW_LABELS: Record<CenterView, string> = { unread: 'לא נקראו', read: 'נקראו', all: 'הכול' }
export const HIGHLIGHT_MS = 4000

/**
 * מרכז העדכונים: one chronological list (three views) and the selected
 * notification's details: a summary from the notification itself, and the task's
 * full content (the existing panels) only on "הצגת ההודעה".
 */
export default function NotificationCenter() {
  const [params, setParams] = useSearchParams()
  const requested = params.get('view') as CenterView | null
  const view: CenterView = requested && CENTER_VIEWS.includes(requested) ? requested : 'unread'
  const center = useNotificationCenter(view)
  const { selected, focus, highlightedId, clearHighlight } = center

  // ?id= (from a toast): once the list is loaded, highlight that notification and
  // bring it into view — it is neither selected nor marked read; clicking it is.
  const focusId = Number(params.get('id')) || null
  useEffect(() => {
    if (focusId == null || center.loading) return
    void focus(focusId)
    const p = new URLSearchParams(params)
    p.delete('id')                                       // handled; a later toast sets it again
    setParams(p, { replace: true })
  }, [focusId, center.loading]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (highlightedId == null) return
    document.querySelector(`[data-notification-id="${highlightedId}"]`)?.scrollIntoView?.({ block: 'center' })
    const timer = setTimeout(clearHighlight, HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [highlightedId, clearHighlight])

  const setView = (next: CenterView) => {
    const p = new URLSearchParams(params)
    if (next === 'unread') p.delete('view'); else p.set('view', next)
    setParams(p, { replace: true })
  }

  return (
    <div className="h-full flex flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-gray-900 dark:text-gray-100">
          <Bell className="h-5 w-5" /> מרכז עדכונים
        </h1>
        <div role="tablist" aria-label="תצוגה" className="inline-flex rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
          {CENTER_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                view === v
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
                  : 'text-gray-600 hover:text-gray-900 dark:text-gray-300',
              )}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
      </div>

      {center.focusMissing && (
        <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          ההתראה לא נמצאה
        </p>
      )}

      {center.error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
          {center.error}
        </p>
      )}

      <div className="flex-1 min-h-0 grid gap-4 lg:grid-cols-[minmax(320px,2fr)_3fr]">
        <section
          aria-label="רשימת העדכונים"
          className={cn('min-h-0 overflow-y-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900',
            selected && 'hidden lg:block')}
        >
          {center.pinned && (
            <ul aria-label="ההתראה שנפתחה" className="border-b border-gray-200 dark:border-gray-700">
              <NotificationListItem
                notification={center.pinned}
                selected={center.pinned.id === selected?.id}
                highlighted={center.pinned.id === highlightedId}
                onSelect={center.select}
              />
            </ul>
          )}
          <NotificationList
            view={view}
            highlightedId={highlightedId}
            items={center.items}
            loading={center.loading}
            loadingMore={center.loadingMore}
            hasMore={center.hasMore}
            selectedId={selected?.id ?? null}
            onSelect={center.select}
            onLoadMore={center.loadMore}
          />
        </section>

        <section
          aria-label="פרטי העדכון"
          className={cn('min-h-0 overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900',
            !selected && 'hidden lg:block')}
        >
          {selected ? (
            <NotificationSummary
              key={selected.id}
              notification={selected}
              marking={center.patchingId === selected.id}
              onMarkUnread={() => void center.setRead(selected, false)}
              onBack={center.clearSelection}
              onChanged={() => void center.refresh()}
              onUpdate={center.updateSelected}
            />
          ) : (
            <p className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">בחרו עדכון מהרשימה</p>
          )}
        </section>
      </div>
    </div>
  )
}
