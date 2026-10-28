import { useState } from 'react'
import { Archive, Check, Lock, Pencil, Plus, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CollectionAPI, type CollectionLedgerItem, type CollectionTaskDetail } from '../../lib/collectionApi'
import { ErrorBanner } from './CollectionModal'
import { FIELD_CLASS, collectionErrorMessage, formatDateTime, formatILS, parseMoneyInput } from './collectionUtils'

interface CollectionAmountsPanelProps {
  task: CollectionTaskDetail
  /** Whether the user may change amounts (assignee / Admin, task open & active). */
  canChange: boolean
  /** Why amounts are locked, shown when `canChange` is false. */
  lockReason?: string | null
  /** Called after a successful change so the parent reloads the task. */
  onChanged: () => void
}

const INVALID_AMOUNT = 'יש להזין סכום חיובי עם עד שתי ספרות אחרי הנקודה'

/**
 * Amounts of a collection task: the immutable initial amount plus append-only
 * adjustments ("single"), or the editable ledger items ("ledger"). Items are
 * archived, never deleted, as the server requires.
 */
export default function CollectionAmountsPanel({ task, canChange, lockReason, onChanged }: CollectionAmountsPanelProps) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
        <span className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">סה״כ לגבייה</span>
        <span className="text-xl font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">{formatILS(task.total_amount)}</span>
      </div>

      {!canChange && lockReason && (
        <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Lock className="w-3.5 h-3.5" /> {lockReason}
        </p>
      )}

      <ErrorBanner message={error} />

      {task.collection_type === 'single' ? (
        <SingleAmounts task={task} canChange={canChange} busy={busy} run={run} setError={setError} />
      ) : (
        <LedgerItems task={task} canChange={canChange} busy={busy} run={run} setError={setError} />
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
}

function SingleAmounts({ task, canChange, busy, run, setError }: SectionProps) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  const add = async () => {
    const value = parseMoneyInput(amount)
    if (!value) { setError(INVALID_AMOUNT); return }
    if (await run(() => CollectionAPI.addAdjustment(task.id, value, note), 'הוספת התוספת נכשלה')) {
      setAmount('')
      setNote('')
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-sm text-gray-600 dark:text-gray-300">סכום התחלתי</span>
          <span className="text-sm font-semibold text-gray-900 dark:text-white tabular-nums">{formatILS(task.initial_amount)}</span>
        </div>
        {task.adjustments.map((adj) => (
          <div key={adj.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm text-gray-700 dark:text-gray-200 break-words">{adj.note || 'תוספת'}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {adj.created_by?.full_name ?? ''} · {formatDateTime(adj.created_at)}
              </p>
            </div>
            <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums whitespace-nowrap">
              +{formatILS(adj.amount)}
            </span>
          </div>
        ))}
      </div>

      {canChange && (
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            className={cn(FIELD_CLASS, 'sm:w-36')}
            inputMode="decimal"
            dir="ltr"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            aria-label="סכום התוספת"
          />
          <input
            className={cn(FIELD_CLASS, 'flex-1')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="הערה (לא חובה)"
            aria-label="הערה לתוספת"
          />
          <button
            type="button"
            onClick={add}
            disabled={busy || !amount.trim()}
            className="inline-flex items-center justify-center gap-1 rounded-xl px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60"
          >
            <Plus className="w-4 h-4" /> הוסף תוספת
          </button>
        </div>
      )}
    </div>
  )
}

function LedgerItems({ task, canChange, busy, run, setError }: SectionProps) {
  const [subject, setSubject] = useState('')
  const [amount, setAmount] = useState('')
  const [editing, setEditing] = useState<{ id: number; subject: string; amount: string } | null>(null)

  const add = async () => {
    const value = parseMoneyInput(amount)
    if (!subject.trim()) { setError('יש להזין נושא'); return }
    if (!value) { setError(INVALID_AMOUNT); return }
    if (await run(() => CollectionAPI.addLedgerItem(task.id, { subject: subject.trim(), amount: value }), 'הוספת הפריט נכשלה')) {
      setSubject('')
      setAmount('')
    }
  }

  const save = async (item: CollectionLedgerItem) => {
    if (!editing) return
    const value = parseMoneyInput(editing.amount)
    if (!editing.subject.trim()) { setError('יש להזין נושא'); return }
    if (!value) { setError(INVALID_AMOUNT); return }
    // Send only what changed; the server ignores equal values anyway.
    const patch: { subject?: string; amount?: string } = {}
    if (editing.subject.trim() !== item.subject) patch.subject = editing.subject.trim()
    if (Number(value) !== Number(item.amount)) patch.amount = value
    if (Object.keys(patch).length === 0) { setEditing(null); return }
    if (await run(() => CollectionAPI.updateLedgerItem(task.id, item.id, patch), 'עדכון הפריט נכשל')) setEditing(null)
  }

  const archive = (item: CollectionLedgerItem) => {
    if (!window.confirm(`להעביר את "${item.subject}" לארכיון? הפריט לא ייכלל בסכום.`)) return
    void run(() => CollectionAPI.archiveLedgerItem(task.id, item.id), 'העברת הפריט לארכיון נכשלה')
  }

  const items = task.ledger_items.filter((i) => !i.archived_at)

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">אין פריטים</p>
      ) : (
        <ul className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
          {items.map((item) => {
            const isEditing = editing?.id === item.id
            return (
              <li key={item.id} className="flex flex-wrap sm:flex-nowrap items-center gap-2 px-3 py-2.5">
                {isEditing ? (
                  <>
                    <input
                      className={cn(FIELD_CLASS, 'flex-1 min-w-[10rem]')}
                      value={editing.subject}
                      onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
                      aria-label="נושא"
                      maxLength={255}
                    />
                    <input
                      className={cn(FIELD_CLASS, 'w-28')}
                      inputMode="decimal"
                      dir="ltr"
                      value={editing.amount}
                      onChange={(e) => setEditing({ ...editing, amount: e.target.value })}
                      aria-label="סכום"
                    />
                    <button type="button" onClick={() => void save(item)} disabled={busy} className="p-2 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20" aria-label="שמירה">
                      <Check className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={() => setEditing(null)} className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700" aria-label="ביטול">
                      <X className="w-4 h-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 min-w-0 text-sm text-gray-800 dark:text-gray-100 break-words">{item.subject}</span>
                    <span className="text-sm font-semibold text-gray-900 dark:text-white tabular-nums whitespace-nowrap">{formatILS(item.amount)}</span>
                    {canChange && (
                      <span className="flex gap-0.5">
                        <button
                          type="button"
                          onClick={() => setEditing({ id: item.id, subject: item.subject, amount: item.amount })}
                          disabled={busy}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                          aria-label={`ערוך ${item.subject}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => archive(item)}
                          disabled={busy}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                          aria-label={`העבר לארכיון ${item.subject}`}
                        >
                          <Archive className="w-4 h-4" />
                        </button>
                      </span>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {canChange && (
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            className={cn(FIELD_CLASS, 'flex-1')}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="נושא"
            aria-label="נושא פריט חדש"
            maxLength={255}
          />
          <input
            className={cn(FIELD_CLASS, 'sm:w-36')}
            inputMode="decimal"
            dir="ltr"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            aria-label="סכום פריט חדש"
          />
          <button
            type="button"
            onClick={add}
            disabled={busy || !subject.trim() || !amount.trim()}
            className="inline-flex items-center justify-center gap-1 rounded-xl px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60"
          >
            <Plus className="w-4 h-4" /> הוסף פריט
          </button>
        </div>
      )}
    </div>
  )
}
