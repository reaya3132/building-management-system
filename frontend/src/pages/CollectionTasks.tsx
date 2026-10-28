import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { useSearchParams } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  List,
  MessageCircle,
  Plus,
  Search,
  SlidersHorizontal,
  Wallet,
} from 'lucide-react'
import type { RootState } from '../store'
import { usePermission } from '../hooks/usePermission'
import { cn } from '../lib/utils'
import {
  CollectionAPI,
  type ArchivedFilter,
  type CollectionListFilters,
  type CollectionStatus,
  type CollectionSummary,
  type CollectionTaskListItem,
  type CollectionType,
} from '../lib/collectionApi'
import SearchableSelect from '../components/task-management/SearchableSelect'
import UnreadMessagesDot from '../components/task-management/UnreadMessagesDot'
import CollectionTaskCard, { StatusChip, projectLabel } from '../components/collection/CollectionTaskCard'
import CollectionTaskDetailModal from '../components/collection/CollectionTaskDetailModal'
import CreateCollectionTaskModal from '../components/collection/CreateCollectionTaskModal'
import { useCollectionLookups } from '../components/collection/useCollectionLookups'
import {
  COLLECTION_STATUSES,
  COLLECTION_STATUS_DOT,
  COLLECTION_STATUS_LABELS,
  COLLECTION_TYPE_LABELS,
  FIELD_CLASS,
  collectionErrorMessage,
  currentMonth,
  formatILS,
  formatMonth,
  shiftMonth,
} from '../components/collection/collectionUtils'

type View = 'month' | 'list'

const PAGE_SIZE = 50
// The month board shows every task of the month in one request (server max).
const BOARD_PAGE_SIZE = 200

/**
 * Collection (גבייה) module: one billing month at a time, as a status board or
 * a paged list, with filters and per-status totals. Data visibility and every
 * action are enforced by the server; the UI only hides what is unavailable.
 */
export default function CollectionTasks() {
  const me = useSelector((s: RootState) => s.auth.me)
  const isAdmin = me?.role === 'Admin'
  const canCreate = usePermission('write', 'collection_task')
  const { projectOptions, userOptions, loading: lookupsLoading } = useCollectionLookups()

  const [searchParams, setSearchParams] = useSearchParams()
  const month = /^\d{4}-\d{2}$/.test(searchParams.get('month') ?? '') ? searchParams.get('month')! : currentMonth()
  const view: View = searchParams.get('view') === 'list' ? 'list' : 'month'
  const openTaskId = Number(searchParams.get('task')) || null

  const updateParams = useCallback((changes: Record<string, string | null>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      Object.entries(changes).forEach(([key, value]) => (value == null ? next.delete(key) : next.set(key, value)))
      return next
    }, { replace: true })
  }, [setSearchParams])

  const [statuses, setStatuses] = useState<CollectionStatus[]>([])
  const [projectId, setProjectId] = useState<number | null>(null)
  const [type, setType] = useState<CollectionType | ''>('')
  const [assigneeId, setAssigneeId] = useState<number | null>(null)
  const [archived, setArchived] = useState<ArchivedFilter>('false')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [page, setPage] = useState(1)

  const [items, setItems] = useState<CollectionTaskListItem[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<CollectionSummary | null>(null)
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // Debounce the free-text search.
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput), 300)
    return () => window.clearTimeout(id)
  }, [searchInput])

  const filters = useMemo<CollectionListFilters>(() => ({
    month,
    status: statuses,
    project_id: projectId,
    collection_type: type || null,
    assignee_id: isAdmin ? assigneeId : null,
    archived,
    search,
  }), [month, statuses, projectId, type, assigneeId, isAdmin, archived, search])

  // Any filter / month / view change returns to the first page.
  useEffect(() => { setPage(1) }, [filters, view])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const listPage = view === 'month' ? 1 : page
    const pageSize = view === 'month' ? BOARD_PAGE_SIZE : PAGE_SIZE
    Promise.all([
      CollectionAPI.list(filters, listPage, pageSize),
      CollectionAPI.summary(filters),
      CollectionAPI.unreadSummary().catch(() => null),
    ])
      .then(([pageData, summaryData, unreadData]) => {
        if (cancelled) return
        setItems(pageData.items)
        setTotal(pageData.total)
        setSummary(summaryData)
        setUnread(unreadData?.total_unread ?? 0)
        setError(null)
      })
      .catch((err) => {
        if (!cancelled) setError(collectionErrorMessage(err, 'שגיאה בטעינת משימות הגבייה'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [filters, page, view, reloadKey])

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])
  const openTask = useCallback((id: number | null) => updateParams({ task: id ? String(id) : null }), [updateParams])

  const activeFilterCount =
    statuses.length + (projectId != null ? 1 : 0) + (type ? 1 : 0) + (assigneeId != null ? 1 : 0) + (archived !== 'false' ? 1 : 0)

  const clearFilters = () => {
    setStatuses([])
    setProjectId(null)
    setType('')
    setAssigneeId(null)
    setArchived('false')
    setSearchInput('')
  }

  return (
    <div className="min-h-screen bg-[#f0f4f8] dark:bg-[#0f1419]" dir="rtl">
      <div className="max-w-[1680px] mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5">
        {/* Header */}
        <header className="flex flex-wrap items-center gap-4">
          <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/25">
            <Wallet className="w-7 h-7" strokeWidth={2.5} />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white tracking-tight">גבייה</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">משימות גבייה לפי חודש חיוב</p>
          </div>
          {unread > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-700 dark:text-gray-200">
              <MessageCircle className="w-4 h-4" /> הודעות שלא נקראו
              <UnreadMessagesDot count={unread} />
            </span>
          )}
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-blue-600/20"
            >
              <Plus className="w-4 h-4" /> משימת גבייה חדשה
            </button>
          )}
        </header>

        {/* Month navigation + view switch */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-1 shadow-sm">
            <button
              type="button"
              onClick={() => updateParams({ month: shiftMonth(month, -1) })}
              className="p-2 rounded-xl text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              aria-label="החודש הקודם"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
            <span className="min-w-[8.5rem] text-center font-semibold text-gray-900 dark:text-white">{formatMonth(month)}</span>
            <button
              type="button"
              onClick={() => updateParams({ month: shiftMonth(month, 1) })}
              className="p-2 rounded-xl text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              aria-label="החודש הבא"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            {month !== currentMonth() && (
              <button
                type="button"
                onClick={() => updateParams({ month: null })}
                className="px-2.5 py-1.5 rounded-xl text-xs font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
              >
                החודש
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div role="tablist" className="flex rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-1 shadow-sm">
              {([['month', 'לוח חודשי', Columns3], ['list', 'רשימה', List]] as const).map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={view === id}
                  onClick={() => updateParams({ view: id === 'month' ? null : id })}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-medium transition-colors',
                    view === id ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                  )}
                >
                  <Icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setFiltersOpen((o) => !o)}
              aria-expanded={filtersOpen}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-2xl border px-3 py-2 text-sm font-medium shadow-sm transition-colors',
                filtersOpen || activeFilterCount > 0
                  ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-900/20 dark:text-blue-300'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300'
              )}
            >
              <SlidersHorizontal className="w-4 h-4" />
              <span>סינון</span>
              {activeFilterCount > 0 && <span className="text-xs">({activeFilterCount})</span>}
            </button>
          </div>
        </div>

        {/* Search + filters */}
        <div className="relative">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            className={cn(FIELD_CLASS, 'pr-9 shadow-sm')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="חיפוש לפי כותרת..."
            aria-label="חיפוש"
            maxLength={255}
          />
        </div>

        {filtersOpen && (
          <div className="rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-4 shadow-sm space-y-4">
            <div>
              <span className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1.5">סטטוס</span>
              <div className="flex flex-wrap gap-2">
                {COLLECTION_STATUSES.map((status) => {
                  const on = statuses.includes(status)
                  return (
                    <button
                      key={status}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setStatuses((prev) => (on ? prev.filter((s) => s !== status) : [...prev, status]))}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors',
                        on
                          ? 'border-blue-400 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                          : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                      )}
                    >
                      <span className={cn('w-2 h-2 rounded-full', COLLECTION_STATUS_DOT[status])} />
                      {COLLECTION_STATUS_LABELS[status]}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <span className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1.5">פרויקט</span>
                <SearchableSelect
                  options={projectOptions}
                  value={projectId}
                  onChange={setProjectId}
                  placeholder="כל הפרויקטים"
                  clearLabel="כל הפרויקטים"
                  ariaLabel="סינון לפי פרויקט"
                  loading={lookupsLoading}
                />
              </div>
              <label className="block">
                <span className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1.5">סוג גבייה</span>
                <select className={FIELD_CLASS} value={type} onChange={(e) => setType(e.target.value as CollectionType | '')}>
                  <option value="">הכל</option>
                  <option value="single">{COLLECTION_TYPE_LABELS.single}</option>
                  <option value="ledger">{COLLECTION_TYPE_LABELS.ledger}</option>
                </select>
              </label>
              <label className="block">
                <span className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1.5">ארכיון</span>
                <select className={FIELD_CLASS} value={archived} onChange={(e) => setArchived(e.target.value as ArchivedFilter)}>
                  <option value="false">פעילות בלבד</option>
                  <option value="true">בארכיון בלבד</option>
                  <option value="all">הכל</option>
                </select>
              </label>
              {isAdmin && (
                <div>
                  <span className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1.5">מוקצה</span>
                  <SearchableSelect
                    options={userOptions}
                    value={assigneeId}
                    onChange={setAssigneeId}
                    placeholder="כל המשתמשים"
                    clearLabel="כל המשתמשים"
                    ariaLabel="סינון לפי מוקצה"
                    loading={lookupsLoading}
                  />
                </div>
              )}
            </div>
            {activeFilterCount > 0 && (
              <button type="button" onClick={clearFilters} className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">
                ניקוי סינון
              </button>
            )}
          </div>
        )}

        {/* Summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SummaryTile label="סה״כ בחודש" count={summary?.count ?? 0} amount={summary?.total_amount ?? '0'} accent="bg-gray-700 dark:bg-gray-300" />
          {COLLECTION_STATUSES.map((status) => (
            <SummaryTile
              key={status}
              label={COLLECTION_STATUS_LABELS[status]}
              count={summary?.by_status[status]?.count ?? 0}
              amount={summary?.by_status[status]?.total_amount ?? '0'}
              accent={COLLECTION_STATUS_DOT[status]}
            />
          ))}
        </div>

        {error && (
          <div role="alert" className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {loading && items.length === 0 ? (
          <p className="text-center text-gray-500 dark:text-gray-400 py-12">טוען...</p>
        ) : view === 'month' ? (
          <MonthBoard items={items} onOpen={openTask} statuses={statuses} />
        ) : (
          <ListView items={items} total={total} page={page} onPage={setPage} onOpen={openTask} />
        )}
      </div>

      <CreateCollectionTaskModal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        defaultMonth={month}
        onCreated={(task) => {
          reload()
          openTask(task.id)
        }}
      />
      <CollectionTaskDetailModal taskId={openTaskId} onClose={() => openTask(null)} onChanged={reload} />
    </div>
  )
}

function SummaryTile({ label, count, amount, accent }: { label: string; count: number; amount: string; accent: string }) {
  return (
    <div className="rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-3 sm:p-4 shadow-sm">
      <div className="flex items-center gap-1.5 text-xs sm:text-sm text-gray-500 dark:text-gray-400">
        <span className={cn('w-2 h-2 rounded-full', accent)} />
        {label}
        <span className="mr-auto text-gray-400">{count}</span>
      </div>
      <p className="mt-1 text-lg sm:text-xl font-bold text-gray-900 dark:text-white tabular-nums truncate">{formatILS(amount)}</p>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded-2xl border-2 border-dashed border-gray-200 dark:border-gray-700 py-14 text-center text-gray-500 dark:text-gray-400">
      <Wallet className="w-10 h-10 mx-auto mb-2 opacity-60" />
      אין משימות גבייה התואמות לחודש ולסינון
    </div>
  )
}

function MonthBoard({
  items,
  onOpen,
  statuses,
}: {
  items: CollectionTaskListItem[]
  onOpen: (id: number) => void
  statuses: CollectionStatus[]
}) {
  if (items.length === 0) return <EmptyState />
  const columns = statuses.length ? COLLECTION_STATUSES.filter((s) => statuses.includes(s)) : COLLECTION_STATUSES
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {columns.map((status) => {
        const columnItems = items.filter((t) => t.status === status)
        return (
          <section key={status} className="rounded-2xl bg-white/60 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 p-3">
            <h2 className="flex items-center gap-2 px-1 pb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">
              <span className={cn('w-2.5 h-2.5 rounded-full', COLLECTION_STATUS_DOT[status])} />
              {COLLECTION_STATUS_LABELS[status]}
              <span className="text-gray-400 font-normal">{columnItems.length}</span>
            </h2>
            <div className="space-y-2.5">
              {columnItems.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">אין משימות</p>
              ) : (
                columnItems.map((task) => <CollectionTaskCard key={task.id} task={task} onOpen={onOpen} />)
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function ListView({
  items,
  total,
  page,
  onPage,
  onOpen,
}: {
  items: CollectionTaskListItem[]
  total: number
  page: number
  onPage: (page: number) => void
  onOpen: (id: number) => void
}) {
  if (items.length === 0) return <EmptyState />
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return (
    <div className="space-y-3">
      {/* Mobile: cards */}
      <div className="md:hidden space-y-2.5">
        {items.map((task) => <CollectionTaskCard key={task.id} task={task} onOpen={onOpen} showStatus />)}
      </div>

      {/* Desktop: table */}
      <div className="hidden md:block overflow-hidden rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/40 text-gray-500 dark:text-gray-400">
            <tr>
              <th className="text-right font-medium px-4 py-3">כותרת</th>
              <th className="text-right font-medium px-4 py-3">פרויקט</th>
              <th className="text-right font-medium px-4 py-3">סוג</th>
              <th className="text-right font-medium px-4 py-3">מוקצים</th>
              <th className="text-right font-medium px-4 py-3">סטטוס</th>
              <th className="text-left font-medium px-4 py-3">סכום</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {items.map((task) => (
              <tr
                key={task.id}
                onClick={() => onOpen(task.id)}
                className={cn('cursor-pointer hover:bg-blue-50/50 dark:hover:bg-blue-900/10', task.is_archived && 'opacity-70')}
              >
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-2 font-medium text-gray-900 dark:text-white">
                    <button type="button" className="text-right hover:underline" onClick={(e) => { e.stopPropagation(); onOpen(task.id) }}>
                      {task.title}
                    </button>
                    <UnreadMessagesDot show={task.unread_messages_count > 0} count={task.unread_messages_count} />
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{projectLabel(task)}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{COLLECTION_TYPE_LABELS[task.collection_type]}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-300 max-w-[14rem] truncate">{task.assignees.map((a) => a.full_name).join(', ')}</td>
                <td className="px-4 py-3"><StatusChip status={task.status} /></td>
                <td className="px-4 py-3 text-left font-semibold text-gray-900 dark:text-white tabular-nums whitespace-nowrap">{formatILS(task.total_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm text-gray-600 dark:text-gray-300">
          <button
            type="button"
            onClick={() => onPage(page - 1)}
            disabled={page <= 1}
            className="p-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 disabled:opacity-40"
            aria-label="העמוד הקודם"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <span>עמוד {page} מתוך {pages}</span>
          <button
            type="button"
            onClick={() => onPage(page + 1)}
            disabled={page >= pages}
            className="p-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 disabled:opacity-40"
            aria-label="העמוד הבא"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}
