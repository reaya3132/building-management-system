import { useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { Plus, Trash2, Wallet } from 'lucide-react'
import type { RootState } from '../../store'
import { cn } from '../../lib/utils'
import { CollectionAPI, type CollectionTaskDetail, type CollectionType } from '../../lib/collectionApi'
import AssigneePicker from '../task-management/AssigneePicker'
import SearchableSelect from '../task-management/SearchableSelect'
import CollectionModal, { ErrorBanner, Field, PrimaryButton, SecondaryButton } from './CollectionModal'
import {
  COLLECTION_TYPE_LABELS,
  FIELD_CLASS,
  collectionErrorMessage,
  formatILS,
  parseMoneyInput,
} from './collectionUtils'
import { useCollectionLookups } from './useCollectionLookups'

interface ItemDraft {
  key: number
  subject: string
  amount: string
}

interface CreateCollectionTaskModalProps {
  isOpen: boolean
  onClose: () => void
  /** Pre-fills the billing month (YYYY-MM), usually the month being viewed. */
  defaultMonth: string
  onCreated: (task: CollectionTaskDetail) => void
}

let itemKey = 0
const newItem = (): ItemDraft => ({ key: ++itemKey, subject: '', amount: '' })

/**
 * Validates the form against the backend rules and returns either an error
 * message or nothing. Exported for focused unit tests.
 */
export function validateCollectionForm(form: {
  title: string
  projectId: number | null
  month: string
  assigneeIds: number[]
  type: CollectionType
  initialAmount: string
  items: { subject: string; amount: string }[]
}): string | null {
  if (!form.title.trim()) return 'יש להזין כותרת'
  if (form.projectId == null) return 'יש לבחור פרויקט'
  if (!/^\d{4}-\d{2}$/.test(form.month)) return 'יש לבחור חודש חיוב'
  if (form.assigneeIds.length === 0) return 'יש לבחור לפחות מוקצה אחד'
  if (form.type === 'single') {
    if (parseMoneyInput(form.initialAmount) == null) return 'יש להזין סכום חיובי עם עד שתי ספרות אחרי הנקודה'
  } else {
    for (const item of form.items) {
      if (!item.subject.trim()) return 'לכל פריט יש להזין נושא'
      if (parseMoneyInput(item.amount) == null) return `סכום לא תקין בפריט "${item.subject.trim()}"`
    }
  }
  return null
}

export default function CreateCollectionTaskModal({ isOpen, onClose, defaultMonth, onCreated }: CreateCollectionTaskModalProps) {
  const me = useSelector((s: RootState) => s.auth.me)
  const { projectOptions, users, loading } = useCollectionLookups()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<CollectionType>('single')
  const [projectId, setProjectId] = useState<number | null>(null)
  const [month, setMonth] = useState(defaultMonth)
  const [assigneeIds, setAssigneeIds] = useState<number[]>([])
  const [initialAmount, setInitialAmount] = useState('')
  const [items, setItems] = useState<ItemDraft[]>([newItem()])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fresh form on every open; the current user is the default assignee.
  useEffect(() => {
    if (!isOpen) return
    setTitle('')
    setDescription('')
    setType('single')
    setProjectId(null)
    setMonth(defaultMonth)
    setAssigneeIds(me?.id ? [me.id] : [])
    setInitialAmount('')
    setItems([newItem()])
    setError(null)
  }, [isOpen, defaultMonth, me?.id])

  const ledgerTotal = useMemo(
    () => items.reduce((sum, item) => sum + (Number(parseMoneyInput(item.amount) ?? 0)), 0),
    [items]
  )

  // An empty last row is a placeholder, not an item.
  const filledItems = items.filter((i) => i.subject.trim() || i.amount.trim())

  const submit = async () => {
    const problem = validateCollectionForm({
      title, projectId, month, assigneeIds, type, initialAmount, items: filledItems,
    })
    if (problem) { setError(problem); return }
    setSaving(true)
    setError(null)
    try {
      const created = await CollectionAPI.create({
        title: title.trim(),
        description: description.trim() || null,
        collection_type: type,
        project_id: projectId!,
        billing_month: month,
        assignee_ids: assigneeIds,
        ...(type === 'single'
          ? { initial_amount: parseMoneyInput(initialAmount)! }
          : { items: filledItems.map((i) => ({ subject: i.subject.trim(), amount: parseMoneyInput(i.amount)! })) }),
      })
      onCreated(created)
      onClose()
    } catch (err) {
      setError(collectionErrorMessage(err, 'יצירת המשימה נכשלה'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <CollectionModal
      isOpen={isOpen}
      onClose={onClose}
      icon={Wallet}
      title="משימת גבייה חדשה"
      subtitle="סכום יחיד או פירוט פריטים לחודש חיוב אחד"
      maxWidth="max-w-2xl"
      footer={
        <>
          <PrimaryButton onClick={submit} disabled={saving}>{saving ? 'שומר...' : 'יצירה'}</PrimaryButton>
          <SecondaryButton onClick={onClose} disabled={saving}>ביטול</SecondaryButton>
        </>
      }
    >
      <ErrorBanner message={error} />

      <Field label="כותרת" required>
        <input className={FIELD_CLASS} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} placeholder="לדוגמה: דמי ניהול" />
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <span className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1.5">
            פרויקט<span className="text-red-500 mr-0.5">*</span>
          </span>
          <SearchableSelect
            options={projectOptions}
            value={projectId}
            onChange={setProjectId}
            placeholder="בחר פרויקט..."
            ariaLabel="פרויקט"
            loading={loading}
          />
        </div>
        <Field label="חודש חיוב" required>
          <input type="month" className={FIELD_CLASS} value={month} onChange={(e) => setMonth(e.target.value)} />
        </Field>
      </div>

      <AssigneePicker users={users} selectedIds={assigneeIds} onChange={setAssigneeIds} />

      <div>
        <span className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1.5">סוג גבייה</span>
        <div role="radiogroup" className="grid grid-cols-2 gap-2">
          {(['single', 'ledger'] as CollectionType[]).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
              className={cn(
                'rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors',
                type === t
                  ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
              )}
            >
              {COLLECTION_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {type === 'single' ? (
        <Field label="סכום (₪)" required>
          <input
            className={FIELD_CLASS}
            inputMode="decimal"
            dir="ltr"
            value={initialAmount}
            onChange={(e) => setInitialAmount(e.target.value)}
            placeholder="0.00"
          />
          <span className="block text-xs text-gray-500 dark:text-gray-400 mt-1">
            הסכום ההתחלתי אינו ניתן לשינוי; בהמשך ניתן רק להוסיף תוספות.
          </span>
        </Field>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">פריטים</span>
            <span className="text-xs text-gray-500 dark:text-gray-400">סה״כ: {formatILS(ledgerTotal)}</span>
          </div>
          {items.map((item, idx) => (
            <div key={item.key} className="flex gap-2">
              <input
                className={cn(FIELD_CLASS, 'flex-1 min-w-0')}
                value={item.subject}
                onChange={(e) => setItems((prev) => prev.map((i) => (i.key === item.key ? { ...i, subject: e.target.value } : i)))}
                placeholder={`נושא ${idx + 1}`}
                aria-label={`נושא פריט ${idx + 1}`}
                maxLength={255}
              />
              <input
                className={cn(FIELD_CLASS, 'w-28 sm:w-36')}
                inputMode="decimal"
                dir="ltr"
                value={item.amount}
                onChange={(e) => setItems((prev) => prev.map((i) => (i.key === item.key ? { ...i, amount: e.target.value } : i)))}
                placeholder="0.00"
                aria-label={`סכום פריט ${idx + 1}`}
              />
              <button
                type="button"
                onClick={() => setItems((prev) => (prev.length > 1 ? prev.filter((i) => i.key !== item.key) : [newItem()]))}
                className="p-2 rounded-xl text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                aria-label="הסר פריט"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setItems((prev) => [...prev, newItem()])}
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline"
          >
            <Plus className="w-4 h-4" /> הוסף פריט
          </button>
        </div>
      )}

      <Field label="תיאור">
        <textarea className={FIELD_CLASS} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </CollectionModal>
  )
}
