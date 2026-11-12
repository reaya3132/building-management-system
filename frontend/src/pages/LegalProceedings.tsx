import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Eye, Lock, LockOpen, Plus, Scale, Search } from 'lucide-react'
import { usePermission } from '../hooks/usePermission'
import { cn } from '../lib/utils'
import {
  LegalAPI,
  type LegalProceedingFilters,
  type LegalProceedingListItem,
  type LegalProceedingPage,
  type ProceedingStatus,
} from '../lib/legalApi'
import { FIELD_CLASS, formatILS } from '../components/collection/collectionUtils'
import SearchableSelect from '../components/task-management/SearchableSelect'
import type { ComboOption } from '../components/task-management/SearchableMultiSelect'
import CreateLegalProceedingModal from '../components/legal/CreateLegalProceedingModal'
import LegalModal, { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../components/legal/LegalModal'
import { PARTY_ROLE_LABELS, STATUS_BADGE, STATUS_LABELS, formatDate, legalErrorMessage } from '../components/legal/legalUtils'

const PAGE_SIZE = 25
const COLUMNS = 9
const TH = 'text-right font-medium px-3 py-2.5 whitespace-nowrap'
const TD = 'px-3 py-2.5 align-top'

type StatusAction = { kind: 'close' | 'reopen'; item: LegalProceedingListItem }

/** Legal proceedings list. Visibility and every action are enforced by the server. */
export default function LegalProceedings() {
  const canCreate = usePermission('write', 'legal_proceeding')
  const canUpdate = usePermission('update', 'legal_proceeding')

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [projectId, setProjectId] = useState<number | null>(null)
  const [landlordId, setLandlordId] = useState<number | null>(null)
  const [status, setStatus] = useState<ProceedingStatus | ''>('')
  const [page, setPage] = useState(1)

  const [data, setData] = useState<LegalProceedingPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [projectOptions, setProjectOptions] = useState<ComboOption[]>([])
  const [landlordOptions, setLandlordOptions] = useState<ComboOption[]>([])

  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()
  const openProceeding = (id: number) => navigate(`/legal-proceedings/${id}`)
  const [statusAction, setStatusAction] = useState<StatusAction | null>(null)

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchInput.trim()); setPage(1) }, 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    let cancelled = false
    const filters: LegalProceedingFilters = {
      search, project_id: projectId, landlord_contact_id: landlordId, status: status || null, page, page_size: PAGE_SIZE,
    }
    setLoading(true)
    setError(null)
    LegalAPI.list(filters)
      .then((result) => { if (!cancelled) setData(result) })
      .catch((e) => { if (!cancelled) setError(legalErrorMessage(e, 'טעינת ההליכים נכשלה.')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [search, projectId, landlordId, status, page, reloadKey])

  // The pickers only offer what the user can see, so they follow every change of the list.
  useEffect(() => {
    let cancelled = false
    Promise.allSettled([LegalAPI.projects(), LegalAPI.landlords()]).then(([projects, landlords]) => {
      if (cancelled) return
      if (projects.status === 'fulfilled') {
        setProjectOptions(projects.value.filter((p) => p.project_id !== null)
          .map((p) => ({ id: p.project_id as number, label: p.project_name ?? `#${p.project_id}` })))
      }
      if (landlords.status === 'fulfilled') {
        setLandlordOptions(landlords.value.map((l) => ({ id: l.id, label: l.name ?? `#${l.id}` })))
      }
    })
    return () => { cancelled = true }
  }, [reloadKey])

  const hasFilters = Boolean(search || projectId || landlordId || status)
  const totalPages = useMemo(() => (data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1), [data])
  const items = data?.items ?? []

  const clearFilters = () => { setSearchInput(''); setSearch(''); setProjectId(null); setLandlordId(null); setStatus(''); setPage(1) }

  return (
    <div dir="rtl" className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Scale className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">הליכים משפטיים</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {data ? `${data.total} הליכים` : 'ניהול הליכים ומעקב אחר התקדמותם'}
            </p>
          </div>
        </div>
        {canCreate && (
          <button type="button" onClick={() => setCreating(true)} className={BUTTON_PRIMARY}>
            <Plus className="w-4 h-4" />הליך חדש
          </button>
        )}
      </header>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
        <div className="relative">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input aria-label="חיפוש הליכים" value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
            placeholder="חיפוש לפי כותרת, איש קשר או דירה" className={cn(FIELD_CLASS, 'pr-9')} />
        </div>
        <SearchableSelect options={projectOptions} value={projectId} onChange={(id) => { setProjectId(id); setPage(1) }}
          placeholder="כל הפרויקטים" clearLabel="כל הפרויקטים" ariaLabel="סינון לפי פרויקט" />
        <SearchableSelect options={landlordOptions} value={landlordId} onChange={(id) => { setLandlordId(id); setPage(1) }}
          placeholder="כל בעלי הדירות" clearLabel="כל בעלי הדירות" ariaLabel="סינון לפי בעל דירה" />
        <select aria-label="סינון לפי סטטוס" value={status} onChange={(e) => { setStatus(e.target.value as ProceedingStatus | ''); setPage(1) }} className={FIELD_CLASS}>
          <option value="">כל הסטטוסים</option>
          <option value="open">{STATUS_LABELS.open}</option>
          <option value="closed">{STATUS_LABELS.closed}</option>
        </select>
      </div>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          <span>{error}</span>
          <button type="button" onClick={reload} className="font-medium underline">ניסיון חוזר</button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/40 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <th className={TH}>הליך</th>
              <th className={TH}>איש קשר ראשי</th>
              <th className={TH}>בעל דירה</th>
              <th className={TH}>דירה</th>
              <th className={TH}>פרויקט</th>
              <th className={TH}>התקדמות</th>
              <th className={TH}>סכום</th>
              <th className={TH}>סטטוס</th>
              <th className={cn(TH, 'text-left')}><span className="sr-only">פעולות</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {loading && !data && Array.from({ length: 6 }, (_, i) => (
              <tr key={i} data-testid="legal-skeleton">
                <td colSpan={COLUMNS} className="px-3 py-3"><div className="h-4 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" /></td>
              </tr>
            ))}
            {!loading && !error && items.length === 0 && (
              <tr>
                <td colSpan={COLUMNS} className="px-3 py-12 text-center">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{hasFilters ? 'לא נמצאו הליכים תואמים' : 'עדיין אין הליכים משפטיים'}</p>
                  {hasFilters && <button type="button" onClick={clearFilters} className="mt-2 text-sm text-primary hover:underline">ניקוי המסננים</button>}
                </td>
              </tr>
            )}
            {items.map((item) => (
              <tr key={item.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
                <td className={TD}>
                  <button type="button" onClick={() => openProceeding(item.id)} className="text-right font-medium text-gray-900 dark:text-white hover:text-primary">{item.title}</button>
                  <div className="text-xs text-gray-500 dark:text-gray-400">#{item.id} · נפתח {formatDate(item.opened_at)}</div>
                </td>
                <td className={TD}>
                  <div className="text-gray-900 dark:text-white">{item.contact.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{PARTY_ROLE_LABELS[item.party_role]}</div>
                </td>
                <td className={cn(TD, 'text-gray-700 dark:text-gray-300')}>{item.linked_landlord?.name ?? '—'}</td>
                <td className={cn(TD, 'text-gray-700 dark:text-gray-300 whitespace-nowrap')}>{item.apartment_number ?? '—'}</td>
                <td className={cn(TD, 'text-gray-700 dark:text-gray-300')}>{item.project?.name ?? '—'}</td>
                <td className={cn(TD, 'min-w-[7rem]')}>
                  <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">{item.progress.resolved} מתוך {item.progress.total}</div>
                  <div className="h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden" role="progressbar" aria-valuenow={item.progress.percent} aria-valuemin={0} aria-valuemax={100}>
                    <div className="h-full bg-primary" style={{ width: `${item.progress.percent}%` }} />
                  </div>
                </td>
                <td className={cn(TD, 'whitespace-nowrap text-gray-700 dark:text-gray-300')}>{formatILS(item.total_amount)}</td>
                <td className={TD}>
                  <span className={cn('inline-flex rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap', STATUS_BADGE[item.status])}>{STATUS_LABELS[item.status]}</span>
                </td>
                <td className={cn(TD, 'whitespace-nowrap text-left')}>
                  <button type="button" aria-label={`צפייה בהליך ${item.title}`} title="צפייה" onClick={() => openProceeding(item.id)}
                    className="p-1.5 rounded-md text-gray-500 hover:text-primary hover:bg-gray-100 dark:hover:bg-gray-700"><Eye className="w-4 h-4" /></button>
                  {canUpdate && (
                    <button type="button" aria-label={`${item.status === 'open' ? 'סגירת' : 'פתיחה מחדש של'} הליך ${item.title}`}
                      title={item.status === 'open' ? 'סגירה' : 'פתיחה מחדש'}
                      onClick={() => setStatusAction({ kind: item.status === 'open' ? 'close' : 'reopen', item })}
                      className="p-1.5 rounded-md text-gray-500 hover:text-primary hover:bg-gray-100 dark:hover:bg-gray-700">
                      {item.status === 'open' ? <Lock className="w-4 h-4" /> : <LockOpen className="w-4 h-4" />}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.total > 0 && (
        <nav aria-label="עימוד" className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-300">
          <span>עמוד {page} מתוך {totalPages}</span>
          <div className="flex gap-1">
            <button type="button" aria-label="העמוד הקודם" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} className={BUTTON_SECONDARY}><ChevronRight className="w-4 h-4" /></button>
            <button type="button" aria-label="העמוד הבא" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)} className={BUTTON_SECONDARY}><ChevronLeft className="w-4 h-4" /></button>
          </div>
        </nav>
      )}

      <CreateLegalProceedingModal isOpen={creating} canAssign={canUpdate} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); reload() }} />
      <StatusActionModal action={statusAction} onClose={() => setStatusAction(null)} onDone={() => { setStatusAction(null); reload() }} />
    </div>
  )
}

function StatusActionModal({ action, onClose, onDone }: { action: StatusAction | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setReason(''); setError(null) }, [action])

  const closing = action?.kind === 'close'
  const submit = async () => {
    if (!action) return
    setSaving(true)
    setError(null)
    try {
      if (closing) await LegalAPI.close(action.item.id, reason.trim())
      else await LegalAPI.reopen(action.item.id, reason.trim())
      onDone()
    } catch (e) {
      setError(legalErrorMessage(e, 'הפעולה נכשלה.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <LegalModal isOpen={action !== null} onClose={onClose} title={closing ? 'סגירת הליך' : 'פתיחת הליך מחדש'} subtitle={action?.item.title}
      footer={<>
        <button type="button" onClick={onClose} className={BUTTON_SECONDARY}>ביטול</button>
        <button type="button" onClick={() => void submit()} disabled={saving || (closing && !reason.trim())} className={BUTTON_PRIMARY}>
          {saving ? 'שומר...' : closing ? 'סגירה' : 'פתיחה מחדש'}
        </button>
      </>}>
      <label className="block text-xs text-gray-600 dark:text-gray-300">{closing ? 'סיבת הסגירה (חובה)' : 'סיבה (לא חובה)'}
        <textarea aria-label="סיבה" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={cn(FIELD_CLASS, 'mt-1')} />
      </label>
      {error && <div role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</div>}
    </LegalModal>
  )
}
