import { useState } from 'react'
import { Archive, Check, Pencil, Plus, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { FIELD_CLASS, formatILS, parseMoneyInput } from '../collection/collectionUtils'
import { AmountWithVat, VatChoice, VatPreviewText } from '../collection/CollectionModal'

export const INVALID_AMOUNT = 'יש להזין סכום חיובי עם עד שתי ספרות אחרי הנקודה'
export const VAT_CHOICE_REQUIRED = 'יש לבחור אם הסכום כולל מע״מ'

export interface LedgerRow {
  id: number
  subject: string
  amount: string
  /** VAT facts, used only with the `vat` prop (collection items; see collectionApi). */
  vat_included?: boolean | null
  vat_rate?: string | null
  gross_amount?: string
}

/** A change to an item; `vat_included` is sent only with the `vat` prop. */
export interface LedgerItemPatch {
  subject?: string
  amount?: string
  vat_included?: boolean
}

interface LedgerItemsProps<T extends LedgerRow> {
  /** The active items, already in display order. */
  items: T[]
  canChange: boolean
  busy: boolean
  setError: (message: string | null) => void
  /** Each resolves to whether the server accepted the change. */
  onAdd: (data: { subject: string; amount: string; vat_included?: boolean }) => Promise<boolean>
  onUpdate: (item: T, patch: LedgerItemPatch) => Promise<boolean>
  onArchive: (item: T) => unknown
  /** Items that may not be archived hide the action (default: every item can). */
  canArchive?: (item: T) => boolean
  /** Optional marker shown beside the subject. */
  renderTag?: (item: T) => React.ReactNode
  /**
   * Per-item VAT (collection only). Omitted: plain subject + amount lines, exactly
   * as before (the legal proceedings' ledger). `rate` is the current VAT rate, for
   * previews only — the server freezes the rate when an amount is saved.
   */
  vat?: { rate: string | null }
}

/** Editable subject + amount lines. Knows nothing of a module or its API. */
export default function LedgerItems<T extends LedgerRow>({
  items, canChange, busy, setError, onAdd, onUpdate, onArchive, canArchive, renderTag, vat,
}: LedgerItemsProps<T>) {
  const [subject, setSubject] = useState('')
  const [amount, setAmount] = useState('')
  const [vatIncluded, setVatIncluded] = useState(true)
  const [editing, setEditing] = useState<{ id: number; subject: string; amount: string; vatIncluded: boolean | null } | null>(null)

  const add = async () => {
    const value = parseMoneyInput(amount)
    if (!subject.trim()) { setError('יש להזין נושא'); return }
    if (!value) { setError(INVALID_AMOUNT); return }
    if (await onAdd({ subject: subject.trim(), amount: value, ...(vat ? { vat_included: vatIncluded } : {}) })) {
      setSubject('')
      setAmount('')
      setVatIncluded(true)
    }
  }

  const save = async (item: T) => {
    if (!editing) return
    const value = parseMoneyInput(editing.amount)
    if (!editing.subject.trim()) { setError('יש להזין נושא'); return }
    if (!value) { setError(INVALID_AMOUNT); return }
    // Send only what changed; the server ignores equal values anyway.
    const patch: LedgerItemPatch = {}
    if (editing.subject.trim() !== item.subject) patch.subject = editing.subject.trim()
    if (Number(value) !== Number(item.amount)) patch.amount = value
    if (vat) {
      // A new amount for an item saved before VAT support needs an explicit choice;
      // a subject-only edit keeps its VAT facts as they are.
      if (patch.amount !== undefined && editing.vatIncluded === null) { setError(VAT_CHOICE_REQUIRED); return }
      if (editing.vatIncluded !== null && editing.vatIncluded !== (item.vat_included ?? null)) {
        patch.vat_included = editing.vatIncluded
      }
    }
    if (Object.keys(patch).length === 0) { setEditing(null); return }
    if (await onUpdate(item, patch)) setEditing(null)
  }

  const archive = (item: T) => {
    if (!window.confirm(`להעביר את "${item.subject}" לארכיון? הפריט לא ייכלל בסכום.`)) return
    void onArchive(item)
  }

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
                    {vat && (
                      <VatChoice
                        value={editing.vatIncluded}
                        onChange={(included) => setEditing({ ...editing, vatIncluded: included })}
                        label={`מע״מ ${item.subject}`}
                      />
                    )}
                    <button type="button" onClick={() => void save(item)} disabled={busy} className="p-2 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20" aria-label="שמירה">
                      <Check className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={() => setEditing(null)} className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700" aria-label="ביטול">
                      <X className="w-4 h-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 min-w-0 text-sm text-gray-800 dark:text-gray-100 break-words">
                      {item.subject}{renderTag?.(item)}
                    </span>
                    {vat ? (
                      // Always the amount to pay; "כולל מע״מ" only when the item's VAT is known.
                      <AmountWithVat
                        amount={item.gross_amount ?? item.amount}
                        vatKnown={item.vat_included != null}
                        className="text-sm font-semibold text-gray-900 dark:text-white"
                      />
                    ) : (
                      <span className="text-sm font-semibold text-gray-900 dark:text-white tabular-nums whitespace-nowrap">{formatILS(item.amount)}</span>
                    )}
                    {canChange && (
                      <span className="flex gap-0.5">
                        <button
                          type="button"
                          onClick={() => setEditing({
                            id: item.id, subject: item.subject, amount: item.amount, vatIncluded: item.vat_included ?? null,
                          })}
                          disabled={busy}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                          aria-label={`ערוך ${item.subject}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        {(canArchive?.(item) ?? true) && (
                          <button
                            type="button"
                            onClick={() => archive(item)}
                            disabled={busy}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                            aria-label={`העבר לארכיון ${item.subject}`}
                          >
                            <Archive className="w-4 h-4" />
                          </button>
                        )}
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
          {vat && <VatChoice value={vatIncluded} onChange={setVatIncluded} label="מע״מ פריט חדש" />}
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
      {canChange && vat && <VatPreviewText amount={amount} vatIncluded={vatIncluded} rate={vat.rate} />}
    </div>
  )
}
