import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, ExternalLink, FileText, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CollectionAPI, type CollectionTaskDetail, type StatementLine } from '../../lib/collectionApi'
import CollectionModal, { ErrorBanner, PrimaryButton, SecondaryButton } from './CollectionModal'
import { FIELD_CLASS, collectionErrorMessage, formatILS, formatMonth, parseMoneyInput, toMonthKey } from './collectionUtils'

const PREVIEW_DELAY_MS = 600

export interface DraftLine {
  key: string
  include: boolean
  subject: string
  amount: string
}

/** The document starts as the task's active ledger items, all included. */
export function initialDraft(task: Pick<CollectionTaskDetail, 'ledger_items'>): DraftLine[] {
  return task.ledger_items
    .filter((item) => !item.archived_at)
    .map((item) => ({ key: `item-${item.id}`, include: true, subject: item.subject, amount: item.amount }))
}

/**
 * The lines to render (included rows only) and their total in agorot, or an
 * error message when an included row is invalid. Integer agorot avoid float
 * drift; the server recomputes the same total with decimals.
 */
export function statementFromDraft(draft: DraftLine[]):
  { lines: StatementLine[]; totalAgorot: number; error: null } | { lines: null; totalAgorot: null; error: string } {
  const lines: StatementLine[] = []
  let totalAgorot = 0
  for (const row of draft) {
    if (!row.include) continue
    const amount = parseMoneyInput(row.amount)
    if (!row.subject.trim()) return { lines: null, totalAgorot: null, error: 'לכל שורה במסמך יש להזין נושא' }
    if (!amount) return { lines: null, totalAgorot: null, error: `סכום לא תקין בשורה "${row.subject.trim()}"` }
    lines.push({ subject: row.subject.trim(), amount })
    totalAgorot += Math.round(Number(amount) * 100)
  }
  return { lines, totalAgorot, error: null }
}

let newLineSeq = 0

interface StatementExportModalProps {
  task: CollectionTaskDetail
  isOpen: boolean
  onClose: () => void
}

/**
 * Edit-and-preview window for a ledger statement. Edits live in local state
 * only — they shape the exported document and are never saved to the ledger.
 * The preview is the real PDF rendered by the server from the current draft,
 * and "export" renders the same draft again, so the file matches the preview.
 * Mount it only while open: the draft is taken from the task on mount.
 */
export default function StatementExportModal({ task, isOpen, onClose }: StatementExportModalProps) {
  const [draft, setDraft] = useState<DraftLine[]>(() => initialDraft(task))
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const urlRef = useRef<string | null>(null)

  const statement = useMemo(() => statementFromDraft(draft), [draft])
  const linesKey = statement.lines ? JSON.stringify(statement.lines) : null

  const replacePreview = (url: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = url
    setPreviewUrl(url)
  }
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  // Live preview: re-render the PDF shortly after the draft stops changing.
  useEffect(() => {
    if (!isOpen || !statement.lines) return
    let cancelled = false
    const lines = statement.lines
    const timer = window.setTimeout(async () => {
      setPreviewing(true)
      try {
        const blob = await CollectionAPI.statementPdf(task.id, lines)
        if (!cancelled) { replacePreview(URL.createObjectURL(blob)); setError(null) }
      } catch (err) {
        if (!cancelled) setError(collectionErrorMessage(err, 'יצירת התצוגה המקדימה נכשלה'))
      } finally {
        if (!cancelled) setPreviewing(false)
      }
    }, PREVIEW_DELAY_MS)
    return () => { cancelled = true; window.clearTimeout(timer) }
    // linesKey stands for statement.lines' content (a new array every render).
  }, [isOpen, task.id, linesKey])

  const update = (key: string, patch: Partial<DraftLine>) =>
    setDraft((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  const exportPdf = async () => {
    if (!statement.lines) return
    setExporting(true)
    setError(null)
    try {
      const blob = await CollectionAPI.statementPdf(task.id, statement.lines)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `כרטסת-${task.title}-${toMonthKey(task.billing_month)}.pdf`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      setError(collectionErrorMessage(err, 'ייצוא ה־PDF נכשל'))
    } finally {
      setExporting(false)
    }
  }

  const projectText = task.project.parent_name ? `${task.project.parent_name} › ${task.project.name}` : task.project.name

  return (
    <CollectionModal
      isOpen={isOpen}
      onClose={onClose}
      icon={FileText}
      title="ייצוא כרטסת ל־PDF"
      subtitle="השינויים כאן חלים על המסמך בלבד ואינם נשמרים בכרטסת"
      maxWidth="max-w-6xl"
      footer={
        <>
          <PrimaryButton onClick={exportPdf} disabled={!statement.lines || exporting}>
            <Download className="w-4 h-4" /> {exporting ? 'מייצא...' : 'ייצוא PDF'}
          </PrimaryButton>
          <SecondaryButton onClick={onClose} disabled={exporting}>סגירה</SecondaryButton>
        </>
      }
    >
      <ErrorBanner message={error ?? statement.error} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Editor */}
        <section className="space-y-3 min-w-0" aria-label="עריכת המסמך">
          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-gray-50 dark:bg-gray-900/40 px-3 py-2">
              <dt className="text-xs text-gray-500 dark:text-gray-400">חודש חיוב</dt>
              <dd className="text-sm font-semibold text-gray-900 dark:text-white">{formatMonth(task.billing_month)}</dd>
            </div>
            <div className="rounded-xl bg-gray-50 dark:bg-gray-900/40 px-3 py-2 min-w-0">
              <dt className="text-xs text-gray-500 dark:text-gray-400">פרויקט</dt>
              <dd className="text-sm font-semibold text-gray-900 dark:text-white truncate" title={projectText}>{projectText}</dd>
            </div>
          </dl>

          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">שורות במסמך</span>
            <button
              type="button"
              onClick={() => setDraft(initialDraft(task))}
              className="inline-flex items-center gap-1 text-xs font-semibold text-gray-500 dark:text-gray-400 hover:text-blue-600"
            >
              <RotateCcw className="w-3.5 h-3.5" /> איפוס לפי הכרטסת
            </button>
          </div>

          <ul className="space-y-2">
            {draft.map((row, idx) => (
              <li key={row.key} className={cn('flex items-center gap-2', !row.include && 'opacity-50')}>
                <input
                  type="checkbox"
                  checked={row.include}
                  onChange={(e) => update(row.key, { include: e.target.checked })}
                  className="w-4 h-4 rounded accent-blue-600 flex-shrink-0"
                  aria-label={`לכלול במסמך: ${row.subject || `שורה ${idx + 1}`}`}
                />
                <input
                  className={cn(FIELD_CLASS, 'flex-1 min-w-0 py-2')}
                  value={row.subject}
                  onChange={(e) => update(row.key, { subject: e.target.value })}
                  placeholder="נושא"
                  aria-label={`נושא שורה ${idx + 1}`}
                  maxLength={255}
                />
                <input
                  className={cn(FIELD_CLASS, 'w-28 py-2')}
                  inputMode="decimal"
                  dir="ltr"
                  value={row.amount}
                  onChange={(e) => update(row.key, { amount: e.target.value })}
                  placeholder="0.00"
                  aria-label={`סכום שורה ${idx + 1}`}
                />
                <button
                  type="button"
                  onClick={() => setDraft((rows) => rows.filter((r) => r.key !== row.key))}
                  className="p-2 rounded-xl text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 flex-shrink-0"
                  aria-label={`הסר מהמסמך שורה ${idx + 1}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => setDraft((rows) => [...rows, { key: `new-${++newLineSeq}`, include: true, subject: '', amount: '' }])}
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline"
          >
            <Plus className="w-4 h-4" /> הוסף שורה למסמך
          </button>

          <div className="flex items-center justify-between rounded-2xl bg-gradient-to-l from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 border border-emerald-100 dark:border-emerald-900/40 px-4 py-3">
            <span className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">סה״כ במסמך</span>
            <span className="text-xl font-bold text-emerald-700 dark:text-emerald-300 tabular-nums" data-testid="statement-total">
              {statement.totalAgorot != null ? formatILS(statement.totalAgorot / 100) : '—'}
            </span>
          </div>
        </section>

        {/* Preview */}
        <section className="min-w-0 space-y-2" aria-label="תצוגה מקדימה">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">
              תצוגה מקדימה {previewing && <span className="font-normal text-gray-400">· מתעדכן...</span>}
            </span>
            {previewUrl && (
              <a href={previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline">
                <ExternalLink className="w-3.5 h-3.5" /> פתיחה בלשונית
              </a>
            )}
          </div>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-900 overflow-hidden h-[55vh] lg:h-[65vh]">
            {previewUrl ? (
              <iframe title="תצוגה מקדימה של ה־PDF" src={previewUrl} className="w-full h-full bg-white" />
            ) : (
              <p className="h-full flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
                {statement.error ? 'יש לתקן את השורות כדי לראות תצוגה מקדימה' : 'יוצר תצוגה מקדימה...'}
              </p>
            )}
          </div>
        </section>
      </div>
    </CollectionModal>
  )
}
