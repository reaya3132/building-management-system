import { useEffect, useState } from 'react'
import { Check, Lock, Pencil, Plus, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CollectionAPI, type CollectionTaskDetail } from '../../lib/collectionApi'
import LedgerItems, { INVALID_AMOUNT, VAT_CHOICE_REQUIRED } from '../ledger/LedgerItems'
import { AmountWithVat, ErrorBanner, VatChoice, VatIncludedTag, VatPreviewText } from './CollectionModal'

/** Editing an addition / reduction's VAT choice is hidden for now (the server still supports it). */
const ADJUSTMENT_VAT_EDIT_ENABLED = false
import {
  FIELD_CLASS,
  collectionErrorMessage,
  formatDateTime,
  formatILS,
  normalizeAdjustmentNote,
  parseMoneyInput,
  signedAdjustment,
  toAgorot,
  totalStaysNonNegative,
  vatBreakdown,
  type AdjustmentKind,
} from './collectionUtils'

interface CollectionAmountsPanelProps {
  task: CollectionTaskDetail
  /** Whether the user may change amounts (assignee / Admin, task open & active). */
  canChange: boolean
  /** Why amounts are locked, shown when `canChange` is false. */
  lockReason?: string | null
  /** Called after a successful change so the parent reloads the task. */
  onChanged: () => void
}

/**
 * Amounts of a collection task: the editable (positive) initial amount plus
 * append-only additions/reductions ("single"; the total never goes below 0), or the editable ledger items ("ledger"). Items are
 * archived, never deleted, as the server requires.
 */
export default function CollectionAmountsPanel({ task, canChange, lockReason, onChanged }: CollectionAmountsPanelProps) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The current VAT rate, for form previews only (the server freezes the rate on save).
  const [vatRate, setVatRate] = useState<string | null>(null)

  useEffect(() => {
    if (!canChange) return
    let cancelled = false
    CollectionAPI.vatRate().then((rate) => { if (!cancelled) setVatRate(rate) }).catch(() => {})
    return () => { cancelled = true }
  }, [canChange])

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
      return true
    } catch (err) {
      setError(collectionErrorMessage(err, fallback))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-2xl bg-gradient-to-l from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 border border-emerald-100 dark:border-emerald-900/40 px-4 py-3">
        <span className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">סה״כ לתשלום</span>
        <AmountWithVat
          amount={task.total_amount}
          vatKnown={totalVatKnown(task)}
          className="text-xl font-bold text-emerald-700 dark:text-emerald-300"
        />
      </div>

      {!canChange && lockReason && (
        <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Lock className="w-3.5 h-3.5" /> {lockReason}
        </p>
      )}

      <ErrorBanner message={error} />

      {task.collection_type === 'single' ? (
        <SingleAmounts task={task} canChange={canChange} busy={busy} run={run} setError={setError} vatRate={vatRate} />
      ) : (
        <CollectionLedger task={task} canChange={canChange} busy={busy} run={run} setError={setError} vatRate={vatRate} />
      )}
    </div>
  )
}

interface SectionProps {
  task: CollectionTaskDetail
  canChange: boolean
  busy: boolean
  run: (action: () => Promise<unknown>, fallback: string) => Promise<boolean>
  setError: (message: string | null) => void
  /** The current VAT rate, for previews only. */
  vatRate: string | null
}

/**
 * Whether the total may be marked "כולל מע״מ": the VAT of every amount that
 * carries VAT is known (`single`: the initial amount; `ledger`: every active
 * item). Never for an amount saved before VAT support.
 */
function totalVatKnown(task: CollectionTaskDetail): boolean {
  if (task.collection_type === 'single') return task.initial_vat?.vat_included != null
  return task.total_vat_amount != null && task.ledger_items.some((i) => !i.archived_at)
}

const TOTAL_NEGATIVE = 'הסכום הכולל לגבייה לא יכול להיות שלילי.'
const NOTE_REQUIRED = 'יש להזין פירוט לתוספת או להפחתה.'

function SingleAmounts({ task, canChange, busy, run, setError, vatRate }: SectionProps) {
  const [kind, setKind] = useState<AdjustmentKind>('addition')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [adjVatIncluded, setAdjVatIncluded] = useState(true)
  const [editingInitial, setEditingInitial] = useState(false)
  const [initialDraft, setInitialDraft] = useState('')
  // null = an amount saved before VAT support: a new amount needs an explicit choice.
  const [initialVatDraft, setInitialVatDraft] = useState<boolean | null>(null)
  const initialVat = task.initial_vat ?? null

  const add = async () => {
    const value = parseMoneyInput(amount)
    if (!value) { setError(INVALID_AMOUNT); return }
    const detail = normalizeAdjustmentNote(note)
    if (!detail) { setError(NOTE_REQUIRED); return }
    const signed = signedAdjustment(value, kind)
    // Pre-check only (the server re-checks under a row lock, with the rate it freezes):
    // the adjustment's amount to pay.
    const delta = vatBreakdown(signed, adjVatIncluded, vatRate)?.grossAgorot ?? toAgorot(signed)
    if (!totalStaysNonNegative(task.total_amount, delta)) { setError(TOTAL_NEGATIVE); return }
    const failure = kind === 'reduction' ? 'הוספת ההפחתה נכשלה' : 'הוספת התוספת נכשלה'
    if (await run(() => CollectionAPI.addAdjustment(task.id, signed, detail, adjVatIncluded), failure)) {
      setAmount('')
      setNote('')
      setAdjVatIncluded(true)
    }
  }

  const startEditInitial = () => {
    setInitialDraft(task.initial_amount ?? '')
    setInitialVatDraft(initialVat?.vat_included ?? null)
    setEditingInitial(true)
    setError(null)
  }

  const saveInitial = async () => {
    const value = parseMoneyInput(initialDraft)
    if (!value) { setError(INVALID_AMOUNT); return }
    const amountChanged = Number(value) !== Number(task.initial_amount)
    const choiceChanged = initialVatDraft !== null && initialVatDraft !== (initialVat?.vat_included ?? null)
    if (!amountChanged && !choiceChanged) { setEditingInitial(false); return }
    if (initialVatDraft === null) { setError(VAT_CHOICE_REQUIRED); return }
    // Pre-check only (the server decides, with the rate it freezes): the change of
    // the initial amount to pay; adjustments are unaffected.
    const preview = vatBreakdown(value, initialVatDraft, vatRate ?? initialVat?.vat_rate ?? null)
    const oldGross = toAgorot(initialVat?.gross_amount ?? task.initial_amount)
    if (preview && !totalStaysNonNegative(task.total_amount, preview.grossAgorot - oldGross)) { setError(TOTAL_NEGATIVE); return }
    // The choice is sent only when it changes (or is made for an amount saved before VAT support).
    const sendChoice = choiceChanged || initialVat?.vat_included == null
    const save = () => sendChoice
      ? CollectionAPI.updateInitialAmount(task.id, value, initialVatDraft)
      : CollectionAPI.updateInitialAmount(task.id, value)
    if (await run(save, 'עדכון הסכום ההתחלתי נכשל')) {
      setEditingInitial(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
          <span className="text-sm text-gray-600 dark:text-gray-300">סכום התחלתי</span>
          {editingInitial ? (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <VatChoice value={initialVatDraft} onChange={setInitialVatDraft} label="מע״מ הסכום ההתחלתי" disabled={busy} />
              <input
                className={cn(FIELD_CLASS, 'w-32 py-1.5')}
                inputMode="decimal"
                dir="ltr"
                value={initialDraft}
                onChange={(e) => setInitialDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveInitial(); if (e.key === 'Escape') setEditingInitial(false) }}
                aria-label="סכום התחלתי חדש"
                autoFocus
              />
              <button type="button" onClick={saveInitial} disabled={busy || !initialDraft.trim()}
                className="p-1.5 rounded-lg text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-900/30 disabled:opacity-60"
                aria-label="שמור סכום התחלתי">
                <Check className="w-4 h-4" />
              </button>
              <button type="button" onClick={() => setEditingInitial(false)} disabled={busy}
                className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-60"
                aria-label="ביטול עריכה">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <AmountWithVat
                amount={initialVat?.gross_amount ?? task.initial_amount}
                vatKnown={initialVat?.vat_included != null}
                className="text-sm font-semibold text-gray-900 dark:text-white"
              />
              {canChange && (
                <button type="button" onClick={startEditInitial} disabled={busy}
                  className="p-1.5 rounded-lg text-gray-500 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-60"
                  aria-label="ערוך סכום התחלתי">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
          {editingInitial && (
            <div className="w-full">
              <VatPreviewText amount={initialDraft} vatIncluded={initialVatDraft} rate={vatRate} />
            </div>
          )}
        </div>
        {task.adjustments.map((adj) => (
          <AdjustmentRow key={adj.id} task={task} adj={adj} canChange={canChange} busy={busy} run={run}
            setError={setError} vatRate={vatRate} />
        ))}
      </div>

      {canChange && (
        <div className="flex flex-col sm:flex-row gap-2">
          <div role="radiogroup" aria-label="סוג השינוי" className="inline-flex rounded-xl border border-gray-300 dark:border-gray-600 p-0.5 self-start sm:self-auto">
            {([['addition', 'תוספת'], ['reduction', 'הפחתה']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={kind === value}
                onClick={() => setKind(value)}
                className={cn(
                  'px-3 py-2 text-sm font-medium rounded-lg',
                  kind === value
                    ? value === 'reduction' ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <VatChoice value={adjVatIncluded} onChange={setAdjVatIncluded} label="מע״מ השינוי" disabled={busy} />
          <input
            className={cn(FIELD_CLASS, 'sm:w-36')}
            inputMode="decimal"
            dir="ltr"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            aria-label={kind === 'reduction' ? 'סכום ההפחתה' : 'סכום התוספת'}
          />
          <input
            className={cn(FIELD_CLASS, 'flex-1')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="פירוט (חובה)"
            required
            aria-required="true"
            aria-label="פירוט השינוי"
          />
          <button
            type="button"
            onClick={add}
            disabled={busy || !amount.trim() || !normalizeAdjustmentNote(note)}
            className="inline-flex items-center justify-center gap-1 rounded-xl px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60"
          >
            <Plus className="w-4 h-4" /> {kind === 'reduction' ? 'הוסף הפחתה' : 'הוסף תוספת'}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * One addition / reduction: its amount to pay (signed) and the label of its VAT
 * choice ("כולל מע״מ" / "ללא מע״מ"; none for one saved before VAT support).
 * Only the VAT choice can be edited — never the amount or the note.
 */
function AdjustmentRow({ task, adj, canChange, busy, run, setError, vatRate }: Omit<SectionProps, 'task'> & {
  task: CollectionTaskDetail
  adj: CollectionTaskDetail['adjustments'][number]
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<boolean | null>(adj.vat_included ?? null)
  const gross = adj.gross_amount ?? adj.amount
  const reduction = Number(gross) < 0

  const save = async () => {
    if (draft === null || draft === (adj.vat_included ?? null)) { setEditing(false); return }
    // Pre-check only (the server decides): the change of this adjustment's amount to pay.
    const next = vatBreakdown(adj.amount, draft, vatRate ?? adj.vat_rate ?? null)
    if (next && !totalStaysNonNegative(task.total_amount, next.grossAgorot - toAgorot(gross))) {
      setError(TOTAL_NEGATIVE)
      return
    }
    if (await run(() => CollectionAPI.updateAdjustmentVat(task.id, adj.id, draft), 'עדכון המע״מ נכשל')) setEditing(false)
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm text-gray-700 dark:text-gray-200 break-words">{adj.note || (reduction ? 'הפחתה' : 'תוספת')}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {adj.created_by?.full_name ?? ''} · {formatDateTime(adj.created_at)}
        </p>
      </div>
      {editing ? (
        <div className="flex items-center gap-1.5">
          <VatChoice value={draft} onChange={setDraft} label={`מע״מ ${adj.note ?? ''}`} disabled={busy} />
          <button type="button" onClick={() => void save()} disabled={busy || draft === null}
            className="p-1.5 rounded-lg text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-900/30 disabled:opacity-60"
            aria-label="שמור מע״מ">
            <Check className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => { setEditing(false); setDraft(adj.vat_included ?? null) }} disabled={busy}
            className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-60"
            aria-label="ביטול עריכת מע״מ">
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          {/* Always the amount to pay (VAT included), whatever the adjustment's choice. */}
          <span className="inline-flex flex-col items-end leading-tight whitespace-nowrap">
            <bdi
              dir="ltr"
              className={cn(
                'text-sm font-semibold tabular-nums',
                reduction ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'
              )}
            >
              {reduction ? '−' : '+'}{formatILS(Math.abs(Number(gross)))}
            </bdi>
            {adj.vat_included != null && <VatIncludedTag />}
          </span>
          {canChange && ADJUSTMENT_VAT_EDIT_ENABLED && (
            <button type="button" onClick={() => { setDraft(adj.vat_included ?? null); setEditing(true); setError(null) }}
              disabled={busy}
              className="p-1.5 rounded-lg text-gray-500 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-60"
              aria-label={`ערוך מע״מ ${adj.note ?? ''}`}>
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function CollectionLedger({ task, canChange, busy, run, setError, vatRate }: SectionProps) {
  return (
    <LedgerItems
      items={task.ledger_items.filter((i) => !i.archived_at)}
      vat={{ rate: vatRate }}
      canChange={canChange}
      busy={busy}
      setError={setError}
      onAdd={(data) => run(() => CollectionAPI.addLedgerItem(task.id, data), 'הוספת הפריט נכשלה')}
      onUpdate={(item, patch) => run(() => CollectionAPI.updateLedgerItem(task.id, item.id, patch), 'עדכון הפריט נכשל')}
      onArchive={(item) => run(() => CollectionAPI.archiveLedgerItem(task.id, item.id), 'העברת הפריט לארכיון נכשלה')}
    />
  )
}
