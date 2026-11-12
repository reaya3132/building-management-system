import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowRight, ChevronDown, Lock, LockOpen, Pencil } from 'lucide-react'
import api from '../lib/api'
import { cn } from '../lib/utils'
import { LegalAPI, type ContactSummary, type LegalDocument, type LegalEntry, type LegalProceedingDetail, type LegalTeam } from '../lib/legalApi'
import SearchableMultiSelect, { type ComboOption } from '../components/task-management/SearchableMultiSelect'
import { formatILS } from '../components/collection/collectionUtils'
import { ErrorBanner } from '../components/collection/CollectionModal'
import LedgerItems from '../components/ledger/LedgerItems'
import LegalModal, { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../components/legal/LegalModal'
import LegalStagePanel from '../components/legal/LegalStagePanel'
import LegalStageStepper from '../components/legal/LegalStageStepper'
import { DocumentList, EntryList, NoteForm } from '../components/legal/LegalDocumentation'
import { PARTY_ROLE_LABELS, STATUS_BADGE, STATUS_LABELS, formatDate, legalErrorMessage } from '../components/legal/legalUtils'

/** The surface every block of the page sits on (the system's card style). */
const CARD = 'rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-sm'
const CARD_TITLE = 'text-sm font-semibold text-gray-900 dark:text-white'

function Party({ title, contact }: { title: string; contact: ContactSummary }) {
  const details = [contact.phone, contact.phone_2, contact.email, contact.address].filter(Boolean).join(' · ')
  return (
    <div className="min-w-0">
      <div className="text-xs text-gray-500 dark:text-gray-400">{title}</div>
      <div className="text-sm font-medium text-gray-900 dark:text-white">
        {contact.name}{contact.apartment_number && <span className="font-normal text-gray-500 dark:text-gray-400"> · דירה {contact.apartment_number}</span>}
      </div>
      {details && <div className="text-xs text-gray-500 dark:text-gray-400 truncate" dir="auto">{details}</div>}
    </div>
  )
}

interface UserOption { id: number; full_name: string }

/**
 * The proceeding's team: the creator as primary owner and the assigned users.
 * Editing follows the collection EditForm pattern (view -> edit -> save / cancel)
 * with the shared SearchableMultiSelect; saving goes through LegalAPI.saveAssignees
 * (the full set in one PATCH, all or nothing), which a future proceeding edit form
 * can call the same way.
 */
function TeamSection({ proceedingId, canAssign }: { proceedingId: number; canAssign: boolean }) {
  const [team, setTeam] = useState<LegalTeam | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [users, setUsers] = useState<UserOption[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<{ done: string[]; failed: string[] } | null>(null)

  const loadTeam = useCallback(async () => {
    try { setTeam(await LegalAPI.team(proceedingId)); setLoadError(null) }
    catch (e) { setLoadError(legalErrorMessage(e, 'טעינת צוות ההליך נכשלה.')) }
  }, [proceedingId])
  useEffect(() => { void loadTeam() }, [loadTeam])

  const startEditing = async () => {
    if (!team) return
    setOutcome(null)
    setSelected(team.assignees.map((a) => a.user.id))
    setEditing(true)
    if (users.length) return
    setUsersLoading(true)
    try { setUsers((await api.get<UserOption[]>('/users/for-tasks')).data) }
    catch (e) { setLoadError(legalErrorMessage(e, 'טעינת רשימת המשתמשים נכשלה.')) }
    finally { setUsersLoading(false) }
  }

  const save = async () => {
    if (!team) return
    setSaving(true)
    const nameOf = (id: number) => users.find((u) => u.id === id)?.full_name
      ?? team.assignees.find((a) => a.user.id === id)?.user.full_name ?? `משתמש ${id}`
    try {
      const result = await LegalAPI.saveAssignees(proceedingId, selected)
      setTeam(result.team)
      const done = [...result.added.map((id) => `${nameOf(id)} שויך להליך`), ...result.removed.map((id) => `${nameOf(id)} הוסר מההליך`)]
      setEditing(false)
      setOutcome(done.length ? { done, failed: [] } : null)
    } catch (e) {
      // All or nothing: the server saved none of the changes. Show the error and what it holds.
      setOutcome({ done: [], failed: [`השיוכים לא נשמרו: ${legalErrorMessage(e, 'שמירת השיוכים נכשלה.')}`] })
      await loadTeam()
    } finally {
      setSaving(false)
    }
  }

  const options: ComboOption[] = users
    .filter((u) => u.id !== team?.owner?.id)
    .map((u) => ({ id: u.id, label: u.full_name }))

  return (
    <section aria-label="צוות ההליך" className={cn(CARD, 'px-4 py-3 space-y-2.5')}>
      <div className="flex items-center justify-between gap-2">
        <h2 className={CARD_TITLE}>צוות ההליך</h2>
        {canAssign && team && !editing && (
          <button type="button" className={BUTTON_SECONDARY} onClick={() => void startEditing()}>
            <Pencil className="w-4 h-4" /> עריכת שיוכים
          </button>
        )}
      </div>
      <ErrorBanner message={loadError} />
      {!team && !loadError && <p className="text-sm text-gray-500">טוען...</p>}
      {team && (
        <>
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400">אחראי ראשי</div>
            <div className="text-sm font-medium text-gray-900 dark:text-white">{team.owner?.full_name ?? '—'}</div>
          </div>
          {editing ? (
            <div className="space-y-2">
              <SearchableMultiSelect label="משתמשים משויכים" options={options} selectedIds={selected} onChange={setSelected}
                placeholder={usersLoading ? 'טוען משתמשים...' : 'בחר משתמשים...'} emptyText="אין משתמשים זמינים" />
              <div className="flex gap-2">
                <button type="button" className={BUTTON_PRIMARY} disabled={saving || usersLoading} onClick={() => void save()}>
                  {saving ? 'שומר...' : 'שמירה'}
                </button>
                <button type="button" className={BUTTON_SECONDARY} disabled={saving} onClick={() => { setEditing(false); setOutcome(null) }}>ביטול</button>
              </div>
            </div>
          ) : (
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400">משתמשים משויכים</div>
              {team.assignees.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">אין משתמשים משויכים.</p>
              ) : (
                <ul className="space-y-0.5">
                  {team.assignees.map((a) => (
                    <li key={a.user.id} className="text-sm text-gray-900 dark:text-white">
                      {a.user.full_name}
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {' · '}{a.assigned_by ? `שויך ע"י ${a.assigned_by.full_name} · ` : ''}{formatDate(a.assigned_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {outcome && (
            <div role="status" className="space-y-1 text-xs">
              {outcome.done.length > 0 && (
                <ul className="text-emerald-700 dark:text-emerald-400">{outcome.done.map((t) => <li key={t}>✓ {t}</li>)}</ul>
              )}
              {outcome.failed.length > 0 && (
                <ul className="text-red-600 dark:text-red-400">{outcome.failed.map((t) => <li key={t}>✗ {t}</li>)}</ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** One proceeding: details, parties, ledger, the fixed stages, and general documents and notes. */
export default function LegalProceedingPage() {
  const proceedingId = Number(useParams().proceedingId)
  const [detail, setDetail] = useState<LegalProceedingDetail | null>(null)
  const [documents, setDocuments] = useState<LegalDocument[]>([])
  const [notes, setNotes] = useState<LegalEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [stageKey, setStageKey] = useState<string | null>(null)
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [statusDialog, setStatusDialog] = useState<'close' | 'reopen' | null>(null)
  const [reason, setReason] = useState('')

  const loadDocuments = useCallback(async () => setDocuments(await LegalAPI.documents(proceedingId)), [proceedingId])
  const loadNotes = useCallback(async () => setNotes((await LegalAPI.entries(proceedingId, { general_only: true })).items), [proceedingId])

  const load = useCallback(async () => {
    setError(null)
    try {
      const [data] = await Promise.all([LegalAPI.get(proceedingId), loadDocuments(), loadNotes()])
      setDetail(data)
      setStageKey((current) => current ?? (data.stages.find((s) => s.status === 'pending') ?? data.stages[0])?.key ?? null)
    } catch (e) {
      setError(legalErrorMessage(e, 'טעינת ההליך נכשלה.'))
    }
  }, [proceedingId, loadDocuments, loadNotes])

  useEffect(() => { void load() }, [load])

  /** One change from this page, then reload what it may have changed. */
  const run = async (action: () => Promise<unknown>, after: () => Promise<unknown> = async () => setDetail(await LegalAPI.get(proceedingId))) => {
    setBusy(true)
    setActionError(null)
    try {
      await action()
      await after()
      return true
    } catch (e) {
      setActionError(legalErrorMessage(e, 'הפעולה נכשלה.'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const back = (
    <Link to="/legal-proceedings" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-primary dark:text-gray-400">
      <ArrowRight className="w-4 h-4" /> חזרה לרשימת ההליכים
    </Link>
  )
  if (error) return <div dir="rtl" className="p-4 sm:p-6 space-y-3">{back}<ErrorBanner message={error} /></div>
  if (!detail) return <div dir="rtl" className="p-4 sm:p-6 space-y-3">{back}<p className="text-sm text-gray-500">טוען...</p></div>

  const isOpen = detail.status === 'open'
  const canChange = detail.permissions.can_update && isOpen
  const stage = detail.stages.find((s) => s.key === stageKey) ?? null
  const generalDocuments = documents.filter((d) => !d.stage_key && !d.entry_id)
  const bases = detail.ledger_items.filter((i) => i.item_type === 'base_amount').length
  const additions = detail.ledger_items.length - bases
  const noteProps = {
    canChange, busy, act: (action: () => Promise<unknown>) => run(action, loadNotes),
    onUpdate: (entry: LegalEntry, patch: Parameters<typeof LegalAPI.updateEntry>[2]) => LegalAPI.updateEntry(detail.id, entry.id, patch),
    onDelete: (entry: LegalEntry) => LegalAPI.deleteEntry(detail.id, entry.id),
    onDeleteFile: (entry: LegalEntry, doc: LegalDocument) => LegalAPI.deleteEntryDocument(detail.id, entry.id, doc.id),
    onUploadFiles: (entry: LegalEntry, files: File[]) => LegalAPI.uploadEntryDocuments(detail.id, entry.id, files),
  }

  const changeStatus = async () => {
    const call = statusDialog === 'close' ? () => LegalAPI.close(detail.id, reason.trim()) : () => LegalAPI.reopen(detail.id, reason.trim())
    if (await run(call)) { setStatusDialog(null); setReason('') }
  }

  return (
    <div dir="rtl" className="mx-auto max-w-6xl p-4 sm:p-6 space-y-4">
      {back}

      <header className={cn(CARD, 'px-4 py-3 flex flex-wrap items-center justify-between gap-3')}>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white">{detail.title}</h1>
            <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_BADGE[detail.status]}`}>{STATUS_LABELS[detail.status]}</span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            הליך #{detail.id} · {PARTY_ROLE_LABELS[detail.party_role]} · נפתח {formatDate(detail.opened_at)}
            {detail.project && ` · ${detail.project.name}`}
            {detail.close_reason && ` · נסגר: ${detail.close_reason}`}
          </p>
          <div className="flex items-center gap-2" aria-label={`${detail.progress.resolved} מתוך ${detail.progress.total} שלבים טופלו`}>
            <div className="h-1.5 w-32 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
              <div className="h-full rounded-full bg-primary" style={{ width: `${detail.progress.percent}%` }} />
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">{detail.progress.resolved} מתוך {detail.progress.total} שלבים</span>
          </div>
        </div>
        {detail.permissions.can_update && (
          <button type="button" className={BUTTON_SECONDARY} onClick={() => { setReason(''); setStatusDialog(isOpen ? 'close' : 'reopen') }}>
            {isOpen ? <><Lock className="w-4 h-4" /> סגירת הליך</> : <><LockOpen className="w-4 h-4" /> פתיחה מחדש</>}
          </button>
        )}
      </header>
      <ErrorBanner message={actionError} />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <section aria-label="צדדים" className={cn(CARD, 'px-4 py-3 space-y-2.5')}>
          <Party title={PARTY_ROLE_LABELS[detail.party_role]} contact={detail.contact} />
          {detail.linked_landlord && <Party title="בעל הדירה המשויך" contact={detail.linked_landlord} />}
          {detail.claim_details && <p className="text-xs text-gray-600 dark:text-gray-300 whitespace-pre-wrap">{detail.claim_details}</p>}
        </section>

        {/* Assigning needs the proceeding open; the server checks the same (creator / Admin + update). */}
        <TeamSection proceedingId={detail.id} canAssign={detail.permissions.can_assign && isOpen} />

        <section aria-label="כרטסת" className={cn(CARD, 'px-4 py-3')}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400">סכום כולל</div>
              <div className="text-xl font-semibold text-gray-900 dark:text-white tabular-nums">{formatILS(detail.total_amount)}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{bases} פריטי בסיס · {additions} תוספות</div>
            </div>
            <button type="button" aria-expanded={ledgerOpen} onClick={() => setLedgerOpen((v) => !v)} className={BUTTON_SECONDARY}>
              {ledgerOpen ? 'הסתרת הפירוט' : 'הצגת הפירוט'} <ChevronDown className={cn('w-4 h-4 transition-transform', ledgerOpen && 'rotate-180')} />
            </button>
          </div>
          {ledgerOpen && (
            <div className="mt-3 space-y-2">
              {!isOpen && <p className="text-xs text-gray-500 dark:text-gray-400">ההליך סגור. הכרטסת לקריאה בלבד.</p>}
              <LedgerItems
                items={detail.ledger_items}
                canChange={canChange}
                busy={busy}
                setError={setActionError}
                canArchive={(item) => item.item_type === 'addition'}
                renderTag={(item) => (item.item_type === 'base_amount'
                  ? <span className="mr-2 rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[11px] text-gray-500 dark:text-gray-300">בסיס</span> : null)}
                onAdd={(data) => run(() => LegalAPI.addLedgerItem(detail.id, data))}
                onUpdate={(item, patch) => run(() => LegalAPI.updateLedgerItem(detail.id, item.id, patch))}
                onArchive={(item) => run(() => LegalAPI.archiveLedgerItem(detail.id, item.id))}
              />
            </div>
          )}
        </section>
      </div>

      <section aria-label="שלבי ההליך" className="space-y-3">
        <LegalStageStepper stages={detail.stages} selected={stageKey} onSelect={setStageKey} />
        {!isOpen && <p className="text-xs text-gray-500 dark:text-gray-400">ההליך סגור. השלבים והתיעוד לקריאה בלבד.</p>}
        {stage && (
          <LegalStagePanel key={stage.key} proceeding={detail} stage={stage} documents={documents} canChange={canChange}
            onDetail={setDetail} onDocumentsChanged={loadDocuments} />
        )}
      </section>

      <section aria-label="מסמכים והערות כלליים" className="grid gap-4 md:grid-cols-2">
        <div className={cn(CARD, 'px-4 py-3 space-y-1')}>
          <h2 className={CARD_TITLE}>מסמכים כלליים</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">מסמכים של ההליך שאינם שייכים לשלב מסוים.</p>
          <DocumentList documents={generalDocuments} canChange={canChange} busy={busy} emptyText="אין מסמכים כלליים." uploadLabel="העלאת מסמכים כלליים"
            onUpload={(files) => run(() => LegalAPI.uploadDocuments(detail.id, files), loadDocuments)}
            onDelete={(doc) => run(() => LegalAPI.deleteDocument(detail.id, doc.id), loadDocuments)} />
        </div>
        <div className={cn(CARD, 'px-4 py-3 space-y-1')}>
          <h2 className={CARD_TITLE}>הערות כלליות</h2>
          <EntryList entries={notes} emptyText="אין הערות כלליות." {...noteProps} />
          {canChange && <NoteForm label="הערה כללית" busy={busy}
            onAdd={(content) => run(() => LegalAPI.createEntry(detail.id, { entry_type: 'note', content }), loadNotes)} />}
        </div>
      </section>

      <LegalModal isOpen={statusDialog !== null} onClose={() => setStatusDialog(null)}
        title={statusDialog === 'close' ? 'סגירת הליך' : 'פתיחת הליך מחדש'}
        footer={<>
          <button type="button" className={BUTTON_SECONDARY} onClick={() => setStatusDialog(null)}>ביטול</button>
          <button type="button" className={BUTTON_PRIMARY} disabled={busy || (statusDialog === 'close' && !reason.trim())} onClick={() => void changeStatus()}>
            {statusDialog === 'close' ? 'סגירה' : 'פתיחה מחדש'}
          </button>
        </>}>
        <label className="block text-xs text-gray-600 dark:text-gray-300">{statusDialog === 'close' ? 'סיבה' : 'סיבה (לא חובה)'}
          <textarea aria-label="סיבת שינוי הסטטוס" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm" />
        </label>
      </LegalModal>
    </div>
  )
}
