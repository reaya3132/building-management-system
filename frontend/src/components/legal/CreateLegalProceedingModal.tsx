import { useCallback, useEffect, useState } from 'react'
import { useSelector } from 'react-redux'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import type { RootState } from '../../store'
import api from '../../lib/api'
import { LegalAPI, type PartyRole } from '../../lib/legalApi'
import { cn } from '../../lib/utils'
import { FIELD_CLASS, parseMoneyInput } from '../collection/collectionUtils'
import SearchableSelect from '../task-management/SearchableSelect'
import SearchableMultiSelect, { type ComboOption } from '../task-management/SearchableMultiSelect'
import LegalModal, { BUTTON_PRIMARY, BUTTON_SECONDARY } from './LegalModal'
import PartyPicker, { emptyParty, isPartyReady, missingFields, toPartySelection, type PartyValue } from './PartyPicker'
import { PARTY_ROLE_LABELS, legalErrorCode, legalErrorMessage } from './legalUtils'

interface Props {
  isOpen: boolean
  onClose: () => void
  onCreated: () => void
  /** The assigning permission (IAM ``update``): shows the optional assignees field. The server checks it again. */
  canAssign?: boolean
}

interface BaseRow {
  key: number
  subject: string
  amount: string
}

const ROLES = Object.keys(PARTY_ROLE_LABELS) as PartyRole[]
const ENTITY_LABELS: Record<PartyRole, string> = { tenant: 'שוכר', landlord: 'בעל דירה', supplier: 'ספק', other: 'איש קשר' }
const CONFIRMABLE = { tenant_has_open_proceeding: 'confirm_open_proceeding', duplicate_phone: 'confirm_duplicate_contact' } as const
type ConfirmFlag = (typeof CONFIRMABLE)[keyof typeof CONFIRMABLE]

let nextRowKey = 1
const newBaseRow = (subject = ''): BaseRow => ({ key: nextRowKey++, subject, amount: '' })

/** Opens a proceeding. The server enforces every rule; warnings it raises are confirmed here. */
export default function CreateLegalProceedingModal({ isOpen, onClose, onCreated, canAssign = false }: Props) {
  const me = useSelector((s: RootState) => s.auth.me)
  const [assigneeIds, setAssigneeIds] = useState<number[]>([])
  const [users, setUsers] = useState<Array<{ id: number; full_name: string }>>([])
  const [usersState, setUsersState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [role, setRole] = useState<PartyRole>('tenant')
  const [contact, setContact] = useState<PartyValue>(emptyParty)
  const [landlord, setLandlord] = useState<PartyValue>(emptyParty)
  const [tenantConfirmed, setTenantConfirmed] = useState(false)
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState<number | null>(null)
  const [baseRows, setBaseRows] = useState<BaseRow[]>(() => [newBaseRow()])
  const [details, setDetails] = useState('')
  const [projects, setProjects] = useState<ComboOption[]>([])
  const [projectsState, setProjectsState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [confirmed, setConfirmed] = useState<Partial<Record<ConfirmFlag, boolean>>>({})
  const [prompt, setPrompt] = useState<{ flag: ConfirmFlag; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const loadProjects = useCallback(() => {
    setProjectsState('loading')
    LegalAPI.projectOptions()
      .then((list) => {
        setProjects(list
          .map((p) => ({ id: p.id, label: p.parent_name ? `${p.parent_name} › ${p.name}` : p.name }))
          .sort((a, b) => a.label.localeCompare(b.label, 'he')))
        setProjectsState('ready')
      })
      .catch(() => { setProjects([]); setProjectsState('error') })
  }, [])

  useEffect(() => {
    if (!isOpen) return
    setRole('tenant'); setContact(emptyParty()); setLandlord(emptyParty()); setTenantConfirmed(false); setTitle('')
    setProjectId(null); setBaseRows([newBaseRow()]); setDetails(''); setConfirmed({}); setPrompt(null); setError(null)
    setAssigneeIds([])
    loadProjects()
  }, [isOpen, loadProjects])

  // The same user list as collection and tasks; only for a user who may assign.
  useEffect(() => {
    if (!isOpen || !canAssign) return
    let cancelled = false
    setUsersState('loading')
    api.get<Array<{ id: number; full_name: string }>>('/users/for-tasks')
      .then((r) => { if (!cancelled) { setUsers(r.data); setUsersState('ready') } })
      .catch(() => { if (!cancelled) { setUsers([]); setUsersState('error') } })
    return () => { cancelled = true }
  }, [isOpen, canAssign])
  // The creator is the primary owner, never an assignee.
  const userOptions: ComboOption[] = users.filter((u) => u.id !== me?.id).map((u) => ({ id: u.id, label: u.full_name }))

  const isTenant = role === 'tenant'
  // An existing tenant with every detail is ready at once; anything entered here is confirmed first.
  const tenantSettled = isTenant && (tenantConfirmed
    || (contact.mode === 'existing' && !!contact.contact && missingFields(contact.contact, true).length === 0))

  const changeRole = (next: PartyRole) => {
    if (next === role) return
    setRole(next)
    setContact(emptyParty())
    setLandlord(emptyParty())
    setTenantConfirmed(false)
    setPrompt(null)
    setError(null)
  }

  /** Choosing a different primary party drops what depended on it. */
  const changeContact = (next: PartyValue) => {
    if (next.mode !== contact.mode || next.contact?.id !== contact.contact?.id) {
      setLandlord(emptyParty())
      setTenantConfirmed(false)
    }
    setContact(next)
    setPrompt(null)
  }

  const editTenant = () => {
    setLandlord(emptyParty())
    setTenantConfirmed(false)
    setPrompt(null)
  }

  const setBaseRow = (key: number, patch: Partial<BaseRow>) =>
    setBaseRows((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  const validate = (): string | null => {
    if (!title.trim()) return 'יש להזין את נושא ההליך.'
    for (const row of baseRows) {
      if (!row.subject.trim()) return 'יש להזין נושא לכל סכום.'
      if (!parseMoneyInput(row.amount)) return `סכום לא תקין בפריט "${row.subject.trim()}".`
    }
    if (!isPartyReady(contact, true)) return 'יש להשלים את פרטי איש הקשר.'
    if (isTenant && !isPartyReady(landlord, false)) return 'בהליך מול שוכר יש לבחור בעל דירה.'
    return null
  }

  const submit = async (flags = confirmed) => {
    const invalid = validate()
    if (invalid) return setError(invalid)
    const contactSelection = toPartySelection(contact)
    const landlordSelection = isTenant ? toPartySelection(landlord) : null
    if (!contactSelection || (isTenant && !landlordSelection)) return setError('יש לבחור איש קשר או להזין פרטי איש קשר חדש.')
    setSaving(true)
    setError(null)
    setPrompt(null)
    try {
      await LegalAPI.create({
        party_role: role,
        title: title.trim(),
        contact: contactSelection,
        ...(landlordSelection ? { landlord: landlordSelection } : {}),
        project_id: projectId,
        base_items: baseRows.map((row) => ({ subject: row.subject.trim(), amount: parseMoneyInput(row.amount)! })),
        claim_details: details.trim() || null,
        // Sent only when chosen, so a create without assignees is the same request as before.
        ...(canAssign && assigneeIds.length ? { assignee_ids: assigneeIds } : {}),
        ...flags,
      })
      onCreated()
    } catch (e) {
      const code = legalErrorCode(e)
      const flag = code && code in CONFIRMABLE ? CONFIRMABLE[code as keyof typeof CONFIRMABLE] : null
      const message = legalErrorMessage(e, 'פתיחת ההליך נכשלה.')
      if (flag && !flags[flag]) setPrompt({ flag, message })
      else setError(message)
    } finally {
      setSaving(false)
    }
  }

  const accept = () => {
    if (!prompt) return
    const next = { ...confirmed, [prompt.flag]: true }
    setConfirmed(next)
    void submit(next)
  }

  return (
    <LegalModal isOpen={isOpen} onClose={onClose} title="פתיחת הליך משפטי" maxWidth="max-w-2xl"
      footer={<>
        <button type="button" onClick={onClose} className={BUTTON_SECONDARY}>ביטול</button>
        <button type="button" onClick={() => void submit()} disabled={saving || !!prompt} className={BUTTON_PRIMARY}>
          {saving ? 'שומר...' : 'פתיחת הליך'}
        </button>
      </>}>
      <div className="space-y-4">
        <section aria-label="פרטי ההליך" className="space-y-3">
          <div className="text-xs text-gray-600 dark:text-gray-300">
            <div className="mb-1">פרויקט</div>
            <SearchableSelect options={projects} value={projectId} onChange={setProjectId} placeholder="ללא פרויקט" clearLabel="ללא פרויקט"
              ariaLabel="פרויקט להליך" loading={projectsState === 'loading'} disabled={projectsState !== 'ready'} />
            {projectsState === 'error' && (
              <p role="alert" className="mt-1 text-red-600 dark:text-red-400">טעינת הפרויקטים נכשלה.{' '}
                <button type="button" onClick={loadProjects} className="underline">ניסיון חוזר</button>
              </p>
            )}
            {projectsState === 'ready' && projects.length === 0 && <p className="mt-1 text-gray-500">אין פרויקטים פעילים לבחירה.</p>}
          </div>
          <label className="block text-xs text-gray-600 dark:text-gray-300">נושא ההליך<span className="text-destructive"> *</span>
            <input aria-label="נושא ההליך" value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)}
              placeholder="לדוגמה: חוב דמי שכירות לחודשים ינואר עד מרץ" className={cn(FIELD_CLASS, 'mt-1')} />
          </label>
          <div className="space-y-2">
            <div className="text-xs text-gray-600 dark:text-gray-300">סכום התביעה<span className="text-destructive"> *</span></div>
            {baseRows.map((row, index) => (
              <div key={row.key} className="flex gap-2">
                <input aria-label={`נושא סכום ${index + 1}`} value={row.subject} maxLength={255} placeholder="סיבת הגבייה"
                  onChange={(e) => setBaseRow(row.key, { subject: e.target.value })} className={cn(FIELD_CLASS, 'flex-1')} />
                <input aria-label={`סכום ${index + 1}`} inputMode="decimal" dir="ltr" value={row.amount} placeholder="0.00"
                  onChange={(e) => setBaseRow(row.key, { amount: e.target.value })} className={cn(FIELD_CLASS, 'w-32 text-right')} />
                {baseRows.length > 1 && (
                  <button type="button" aria-label={`הסרת סכום ${index + 1}`} onClick={() => setBaseRows((rows) => rows.filter((r) => r.key !== row.key))}
                    className="p-2 text-gray-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                )}
              </div>
            ))}
            <button type="button" onClick={() => setBaseRows((rows) => [...rows, newBaseRow()])}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              <Plus className="w-3.5 h-3.5" /> הוספת סכום
            </button>
          </div>
        </section>

        <section className="space-y-3">
          <h3 id="legal-party-heading" className="text-sm font-semibold text-gray-900 dark:text-white">מי הצד בהליך?</h3>
          <div role="radiogroup" aria-labelledby="legal-party-heading" className="inline-flex flex-wrap rounded-md border border-gray-200 dark:border-gray-700 text-sm">
            {ROLES.map((r) => (
              <button key={r} type="button" role="radio" aria-checked={role === r} onClick={() => changeRole(r)}
                className={cn('px-4 py-1.5 first:rounded-r-md last:rounded-l-md',
                  role === r ? 'bg-primary/10 text-primary font-medium' : 'text-gray-600 dark:text-gray-300')}>
                {PARTY_ROLE_LABELS[r]}
              </button>
            ))}
          </div>

          <PartyPicker key={role} label={PARTY_ROLE_LABELS[role]} entity={ENTITY_LABELS[role]} value={contact} onChange={changeContact} primary locked={tenantConfirmed} />

          {isTenant && !tenantSettled && (
            <button type="button" onClick={() => setTenantConfirmed(true)} disabled={!isPartyReady(contact, true)} className={BUTTON_SECONDARY}>
              אישור פרטי השוכר
            </button>
          )}
          {tenantConfirmed && (
            <button type="button" onClick={editTenant} className="text-xs font-medium text-primary hover:underline">עריכת פרטי השוכר</button>
          )}
          {tenantSettled && (
            <PartyPicker label="בעל הדירה המשויך" entity="בעל דירה" value={landlord} onChange={setLandlord} primary={false} />
          )}
        </section>

        <label className="block text-xs text-gray-600 dark:text-gray-300">פרטי התביעה
          <textarea aria-label="פרטי התביעה" rows={3} value={details} onChange={(e) => setDetails(e.target.value)} className={cn(FIELD_CLASS, 'mt-1')} />
        </label>

        {canAssign && (
          <section aria-label="משתמשים משויכים" className="space-y-1">
            <SearchableMultiSelect label="משתמשים משויכים" options={userOptions} selectedIds={assigneeIds} onChange={setAssigneeIds}
              placeholder={usersState === 'loading' ? 'טוען משתמשים...' : 'בחר משתמשים (לא חובה)...'} emptyText="אין משתמשים זמינים" />
            <p className="text-xs text-gray-500 dark:text-gray-400">יוצר ההליך מוגדר כאחראי הראשי.</p>
            {usersState === 'error' && <p role="alert" className="text-xs text-red-600 dark:text-red-400">טעינת רשימת המשתמשים נכשלה.</p>}
          </section>
        )}

        {prompt && (
          <div role="alertdialog" aria-label="אישור המשך" className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20 px-3 py-2.5">
            <div className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>{prompt.message}</span>
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => setPrompt(null)} className={BUTTON_SECONDARY}>חזרה</button>
              <button type="button" onClick={accept} disabled={saving} className={BUTTON_PRIMARY}>המשך בכל זאת</button>
            </div>
          </div>
        )}
        {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</div>}
      </div>
    </LegalModal>
  )
}
