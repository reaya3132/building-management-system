import { useState } from 'react'
import { Lock, Plus } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CollectionAPI, type CollectionTaskDetail } from '../../lib/collectionApi'
import LedgerItems, { INVALID_AMOUNT } from '../ledger/LedgerItems'
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
        <CollectionLedger task={task} canChange={canChange} busy={busy} run={run} setError={setError} />
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

function CollectionLedger({ task, canChange, busy, run, setError }: SectionProps) {
  return (
    <LedgerItems
      items={task.ledger_items.filter((i) => !i.archived_at)}
      canChange={canChange}
      busy={busy}
      setError={setError}
      onAdd={(data) => run(() => CollectionAPI.addLedgerItem(task.id, data), 'הוספת הפריט נכשלה')}
      onUpdate={(item, patch) => run(() => CollectionAPI.updateLedgerItem(task.id, item.id, patch), 'עדכון הפריט נכשל')}
      onArchive={(item) => run(() => CollectionAPI.archiveLedgerItem(task.id, item.id), 'העברת הפריט לארכיון נכשלה')}
    />
  )
}
