import { useSearchParams } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { cn } from '../lib/utils'
import NotificationList from '../components/notification-center/NotificationList'
import {
  CENTER_VIEWS, useNotificationCenter, type CenterView,
} from '../components/notification-center/useNotificationCenter'

const VIEW_LABELS: Record<CenterView, string> = { unread: 'לא נקראו', read: 'נקראו', all: 'הכול' }

/**
 * מרכז העדכונים: one chronological list (three views) and the selected
 * notification's details. Stage 3e-2a: the list, views, loading, selection and
 * read / unread; the details panel itself comes in 3e-2b.
 */
export default function NotificationCenter() {
  const [params, setParams] = useSearchParams()
  const requested = params.get('view') as CenterView | null
  const view: CenterView = requested && CENTER_VIEWS.includes(requested) ? requested : 'unread'
  const center = useNotificationCenter(view)
  const { selected } = center

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
          <NotificationList
            view={view}
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
            // The details panel (summary, full content, archived tasks) is stage 3e-2b.
            <div className="space-y-3" data-testid="selected-notification">
              <button type="button" className="text-sm text-blue-600 lg:hidden" onClick={() => center.clearSelection()}>
                חזרה לרשימה
              </button>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{selected.title}</h2>
              {selected.read_at != null ? (
                <button
                  type="button"
                  onClick={() => void center.setRead(selected, false)}
                  disabled={center.patchingId === selected.id}
                  className="text-sm text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
                >
                  סמן כלא נקראה
                </button>
              ) : (
                <span className="text-sm text-gray-500 dark:text-gray-400">לא נקראה</span>
              )}
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">בחרו עדכון מהרשימה</p>
          )}
        </section>
      </div>
    </div>
  )
}
