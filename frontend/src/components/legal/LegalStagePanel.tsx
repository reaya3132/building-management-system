import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, RotateCcw, SkipForward } from 'lucide-react'
import { cn } from '../../lib/utils'
import { LegalAPI, type LegalDocument, type LegalEntry, type LegalProceedingDetail, type LegalStage } from '../../lib/legalApi'
import { ErrorBanner } from '../collection/CollectionModal'
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from './LegalModal'
import { CommunicationForm, DocumentList, EntryList, NoteForm } from './LegalDocumentation'
import { STAGE_STATUS_BADGE, STAGE_STATUS_LABELS, formatDateTime, legalErrorMessage, missingDocumentation } from './legalUtils'

interface Props {
  proceeding: LegalProceedingDetail
  stage: LegalStage
  /** Every document of the proceeding; this panel shows its stage's component files. */
  documents: LegalDocument[]
  canChange: boolean
  onDetail: (detail: LegalProceedingDetail) => void
  onDocumentsChanged: () => Promise<void>
}

type Tab = 'documentation' | 'notes'
type Pending = { kind: 'skip' | 'reopen'; reason: string }

function DocState({ documented }: { documented: boolean }) {
  return (
    <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-medium',
      documented ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300')}>
      {documented ? 'תועד' : 'חסר'}
    </span>
  )
}

/** One of the five fixed stages: its status actions, its fixed components, and the records added to it. */
export default function LegalStagePanel({ proceeding, stage, documents, canChange, onDetail, onDocumentsChanged }: Props) {
  const id = proceeding.id
  const [entries, setEntries] = useState<LegalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState<Array<{ key: string; label: string }> | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [tab, setTab] = useState<Tab>('documentation')
  const [openComponent, setOpenComponent] = useState<string | null>(null)

  const loadEntries = useCallback(async () => {
    try {
      setEntries((await LegalAPI.entries(id, { stage_key: stage.key })).items)
    } catch (e) {
      setError(legalErrorMessage(e, 'טעינת התיעוד נכשלה.'))
    } finally {
      setLoading(false)
    }
  }, [id, stage.key])

  useEffect(() => {
    setLoading(true); setError(null); setMissing(null); setPending(null); setTab('documentation'); setOpenComponent(null)
    void loadEntries()
  }, [loadEntries])

  /** Runs one change, then reloads what it may have changed. */
  const act = async (action: () => Promise<unknown>, reload: 'entries' | 'documents' = 'entries') => {
    setBusy(true)
    setError(null)
    try {
      await action()
      if (reload === 'entries') await loadEntries()
      else await onDocumentsChanged()
      return true
    } catch (e) {
      setError(legalErrorMessage(e, 'הפעולה נכשלה.'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const changeStatus = async (call: () => Promise<LegalProceedingDetail>) => {
    setBusy(true)
    setError(null)
    try {
      onDetail(await call())
      setMissing(null)
      setPending(null)
    } catch (e) {
      const list = missingDocumentation(e)
      if (list) setMissing(list)
      else setError(legalErrorMessage(e, 'עדכון השלב נכשל.'))
    } finally {
      setBusy(false)
    }
  }

  const stageNotes = entries.filter((e) => e.entry_type === 'note' && !e.context_key)
  const communications = entries.filter((e) => e.entry_type === 'communication')
  const componentFiles = (key: string) => documents.filter((d) => d.stage_key === stage.key && d.component_key === key && !d.entry_id)
  const componentNotes = (key: string) => entries.filter((e) => e.entry_type === 'note' && e.context_key === key)
  // Shown for orientation only; the server's check on completion is the one that counts.
  const documentedCount = stage.requires_communication
    ? Number(communications.some((e) => e.documents.length > 0))
    : stage.components.filter((c) => componentFiles(c.key).length > 0).length
  const requiredCount = stage.requires_communication ? 1 : stage.components.length
  // A completed or skipped stage is read-only until it is reopened.
  const canEdit = canChange && stage.status === 'pending'
  const entryProps = {
    canChange: canEdit, busy, act,
    onUpdate: (entry: LegalEntry, patch: Parameters<typeof LegalAPI.updateEntry>[2]) => LegalAPI.updateEntry(id, entry.id, patch),
    onDelete: (entry: LegalEntry) => LegalAPI.deleteEntry(id, entry.id),
    onDeleteFile: (entry: LegalEntry, doc: LegalDocument) => LegalAPI.deleteEntryDocument(id, entry.id, doc.id),
    onUploadFiles: (entry: LegalEntry, files: File[]) => LegalAPI.uploadEntryDocuments(id, entry.id, files),
  }
  const addNote = (contextKey: string | null) => (content: string) =>
    act(() => LegalAPI.createEntry(id, { entry_type: 'note', stage_key: stage.key, context_key: contextKey, content }))

  const tabs: Array<[Tab, string]> = [
    ['documentation', stage.requires_communication ? `תיעוד שליחה (${communications.length})` : `רכיבי תיעוד (${stage.components.length})`],
    ['notes', `הערות לשלב ${stage.position}`],
  ]

  return (
    <section aria-label={`שלב ${stage.position}: ${stage.label}`} className="rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-sm">
      <header className="px-4 pt-4 pb-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">שלב {stage.position}: {stage.label}</h2>
              <span className={`rounded-full border px-2 py-0.5 text-xs ${STAGE_STATUS_BADGE[stage.status]}`}>{STAGE_STATUS_LABELS[stage.status]}</span>
            </div>
            {stage.description && <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{stage.description}</p>}
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {stage.status === 'pending'
                ? `${documentedCount} מתוך ${requiredCount} ${stage.requires_communication ? 'דרישות' : 'רכיבים'} תועדו`
                : [stage.resolved_by?.full_name, formatDateTime(stage.resolved_at)].filter(Boolean).join(' · ')}
            </p>
          </div>
          {canChange && !pending && !missing && (
            <div className="flex flex-wrap items-center gap-2">
              {stage.status === 'pending' ? (
                <>
                  <button type="button" className={BUTTON_SECONDARY} disabled={busy} onClick={() => setPending({ kind: 'skip', reason: '' })}>
                    <SkipForward className="w-4 h-4" /> סימון כלא רלוונטי
                  </button>
                  <button type="button" className={BUTTON_PRIMARY} disabled={busy} onClick={() => void changeStatus(() => LegalAPI.completeStage(id, stage.key))}>
                    <CheckCircle2 className="w-4 h-4" /> סימון כהושלם
                  </button>
                </>
              ) : (
                <button type="button" className={BUTTON_SECONDARY} disabled={busy} onClick={() => setPending({ kind: 'reopen', reason: '' })}>
                  <RotateCcw className="w-4 h-4" /> פתיחת השלב מחדש
                </button>
              )}
            </div>
          )}
        </div>

        {pending && (
          <div className="rounded-xl bg-gray-50 dark:bg-gray-900/40 p-3 space-y-2">
            <label className="block text-xs text-gray-600 dark:text-gray-300">
              {pending.kind === 'skip' ? 'סיבה לסימון השלב כלא רלוונטי (לא חובה)' : 'סיבה לפתיחת השלב מחדש (לא חובה)'}
              <input aria-label="סיבה" autoFocus value={pending.reason} onChange={(e) => setPending({ ...pending, reason: e.target.value })}
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm" />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className={BUTTON_SECONDARY} onClick={() => setPending(null)}>ביטול</button>
              <button type="button" className={BUTTON_PRIMARY} disabled={busy}
                onClick={() => void changeStatus(() => (pending.kind === 'skip'
                  ? LegalAPI.skipStage(id, stage.key, pending.reason)
                  : LegalAPI.reopenStage(id, stage.key, pending.reason)))}>
                {pending.kind === 'skip' ? 'אישור: לא רלוונטי' : 'אישור פתיחה מחדש'}
              </button>
            </div>
          </div>
        )}

        {missing && (
          <div role="alertdialog" aria-label="תיעוד חסר" className="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20 p-3 text-sm">
            <div className="flex items-start gap-2 text-amber-900 dark:text-amber-200">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium">חסר תיעוד בשלב זה:</p>
                <ul className="list-disc pr-5">{missing.map((m) => <li key={m.key}>{m.label}</li>)}</ul>
              </div>
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" className={BUTTON_SECONDARY} onClick={() => setMissing(null)}>חזרה</button>
              <button type="button" className={BUTTON_PRIMARY} disabled={busy}
                onClick={() => void changeStatus(() => LegalAPI.completeStage(id, stage.key, true))}>סימון כהושלם בכל זאת</button>
            </div>
          </div>
        )}
        <ErrorBanner message={error} />
      </header>

      <div role="tablist" aria-label="תוכן השלב" className="flex gap-1 border-b border-gray-100 dark:border-gray-700 px-4">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={cn('-mb-px border-b-2 px-2 py-2 text-sm transition-colors',
              tab === key ? 'border-primary font-medium text-gray-900 dark:text-white' : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200')}>
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="px-4 py-3">
        {loading && <p className="text-sm text-gray-500">טוען תיעוד...</p>}

        {!loading && tab === 'documentation' && stage.requires_communication && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">תיעוד ידני של הודעות שנשלחו במייל או ב־WhatsApp, עם צילומי מסך או מסמכים.</p>
            <EntryList entries={communications} emptyText="עדיין לא תועדה שליחה." {...entryProps} />
            {canEdit && <CommunicationForm busy={busy} onAdd={(entry) => act(() => LegalAPI.createEntry(id, { ...entry, stage_key: stage.key }))} />}
          </div>
        )}

        {!loading && tab === 'documentation' && !stage.requires_communication && (
          <ul className="divide-y divide-gray-100 dark:divide-gray-700/60">
            {stage.components.map((component) => {
              const files = componentFiles(component.key)
              const notes = componentNotes(component.key)
              const isOpen = openComponent === component.key
              return (
                <li key={component.key} role="group" aria-label={component.label}
                  className={cn('-mx-2 px-2 rounded-lg', files.length > 0 && 'bg-amber-50 dark:bg-amber-900/15')}>
                  <button type="button" aria-expanded={isOpen} onClick={() => setOpenComponent(isOpen ? null : component.key)}
                    className="flex w-full items-center gap-2 py-2.5 text-right">
                    <span className="flex-1 min-w-0 truncate text-sm text-gray-900 dark:text-white">{component.label}</span>
                    <span className="hidden sm:inline text-xs text-gray-500 dark:text-gray-400">{files.length} קבצים · {notes.length} הערות</span>
                    <DocState documented={files.length > 0} />
                    <ChevronDown className={cn('w-4 h-4 text-gray-400 transition-transform', isOpen && 'rotate-180')} />
                  </button>
                  {isOpen && (
                    <div className="pb-3 pr-2 space-y-3">
                      <div>
                        <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">מסמכים</h3>
                        <DocumentList documents={files} canChange={canEdit} busy={busy} emptyText="אין מסמכים." uploadLabel={`העלאת קבצים: ${component.label}`}
                          onUpload={(picked) => act(() => LegalAPI.uploadDocuments(id, picked, { stage_key: stage.key, component_key: component.key }), 'documents')}
                          onDelete={(doc) => act(() => LegalAPI.deleteDocument(id, doc.id), 'documents')} />
                      </div>
                      <div>
                        <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">הערות</h3>
                        <EntryList entries={notes} emptyText="אין הערות." {...entryProps} />
                        {canEdit && <NoteForm label={`הערה: ${component.label}`} busy={busy} onAdd={addNote(component.key)} />}
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {!loading && tab === 'notes' && (
          <div className="space-y-2">
            <EntryList entries={stageNotes} emptyText="אין הערות לשלב." {...entryProps} />
            {canEdit && <NoteForm label={`הערה לשלב ${stage.position}`} busy={busy} onAdd={addNote(null)} />}
          </div>
        )}
      </div>
    </section>
  )
}
