import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { LegalAPI, type PartyRole } from '../../lib/legalApi'
import { cn } from '../../lib/utils'
import { FIELD_CLASS } from '../collection/collectionUtils'
import SearchableSelect from '../task-management/SearchableSelect'
import type { ComboOption } from '../task-management/SearchableMultiSelect'
import LegalModal, { BUTTON_PRIMARY, BUTTON_SECONDARY } from './LegalModal'
import PartyPicker, { emptyParty, toPartySelection, type PartyValue } from './PartyPicker'
import { PARTY_ROLE_LABELS, legalErrorCode, legalErrorMessage } from './legalUtils'

interface Props {
  isOpen: boolean
  onClose: () => void
  onCreated: () => void
}

const ROLES = Object.keys(PARTY_ROLE_LABELS) as PartyRole[]
const CONFIRMABLE = { tenant_has_open_proceeding: 'confirm_open_proceeding', duplicate_phone: 'confirm_duplicate_contact' } as const
type ConfirmFlag = (typeof CONFIRMABLE)[keyof typeof CONFIRMABLE]

/** Opens a proceeding. The server enforces every rule; warnings it raises are confirmed here. */
export default function CreateLegalProceedingModal({ isOpen, onClose, onCreated }: Props) {
  const [role, setRole] = useState<PartyRole>('tenant')
  const [contact, setContact] = useState<PartyValue>(emptyParty)
  const [landlord, setLandlord] = useState<PartyValue>(emptyParty)
  const [apartment, setApartment] = useState('')
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState<number | null>(null)
  const [amount, setAmount] = useState('')
  const [details, setDetails] = useState('')
  const [projects, setProjects] = useState<ComboOption[]>([])
  const [confirmed, setConfirmed] = useState<Partial<Record<ConfirmFlag, boolean>>>({})
  const [prompt, setPrompt] = useState<{ flag: ConfirmFlag; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    setRole('tenant'); setContact(emptyParty()); setLandlord(emptyParty()); setApartment(''); setTitle('')
    setProjectId(null); setAmount(''); setDetails(''); setConfirmed({}); setPrompt(null); setError(null)
    LegalAPI.projectOptions()
      .then((list) => setProjects(list
        .map((p) => ({ id: p.id, label: p.parent_name ? `${p.parent_name} › ${p.name}` : p.name }))
        .sort((a, b) => a.label.localeCompare(b.label, 'he'))))
      .catch(() => setProjects([]))
  }, [isOpen])

  const changeRole = (next: PartyRole) => {
    setRole(next)
    if (next !== 'tenant') setLandlord(emptyParty())   // only a tenant's proceeding has a linked landlord
    setPrompt(null)
  }

  const submit = async (flags = confirmed) => {
    const contactSelection = toPartySelection(contact)
    const landlordSelection = role === 'tenant' ? toPartySelection(landlord) : null
    if (!contactSelection) return setError('יש לבחור איש קשר או להזין פרטי איש קשר חדש.')
    if (role === 'tenant' && !landlordSelection) return setError('בהליך מול שוכר יש לבחור בעל דירה.')
    setSaving(true)
    setError(null)
    setPrompt(null)
    try {
      await LegalAPI.create({
        party_role: role,
        apartment_number: apartment.trim(),
        title: title.trim(),
        contact: contactSelection,
        ...(landlordSelection ? { landlord: landlordSelection } : {}),
        project_id: projectId,
        claim_amount: amount.trim() || null,
        claim_details: details.trim() || null,
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
        <button type="button" onClick={() => void submit()} disabled={saving || !title.trim() || !apartment.trim() || !!prompt} className={BUTTON_PRIMARY}>
          {saving ? 'שומר...' : 'פתיחת הליך'}
        </button>
      </>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-gray-600 dark:text-gray-300">סוג איש הקשר הראשי
            <select aria-label="סוג איש הקשר" value={role} onChange={(e) => changeRole(e.target.value as PartyRole)} className={cn(FIELD_CLASS, 'mt-1')}>
              {ROLES.map((r) => <option key={r} value={r}>{PARTY_ROLE_LABELS[r]}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-600 dark:text-gray-300">מספר דירה<span className="text-destructive"> *</span>
            <input aria-label="מספר דירה" value={apartment} maxLength={32} onChange={(e) => setApartment(e.target.value)} className={cn(FIELD_CLASS, 'mt-1')} />
          </label>
        </div>

        <PartyPicker label={PARTY_ROLE_LABELS[role]} value={contact} onChange={setContact} />
        {role === 'tenant' && <PartyPicker label="בעל הדירה המשויך" value={landlord} onChange={setLandlord} />}

        <label className="block text-xs text-gray-600 dark:text-gray-300">כותרת<span className="text-destructive"> *</span>
          <input aria-label="כותרת" value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} className={cn(FIELD_CLASS, 'mt-1')} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="text-xs text-gray-600 dark:text-gray-300">
            <div className="mb-1">פרויקט</div>
            <SearchableSelect options={projects} value={projectId} onChange={setProjectId} placeholder="ללא פרויקט" clearLabel="ללא פרויקט" ariaLabel="פרויקט להליך" />
          </div>
          <label className="text-xs text-gray-600 dark:text-gray-300">סכום תביעה
            <input aria-label="סכום תביעה" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} className={cn(FIELD_CLASS, 'mt-1 text-right')} />
          </label>
        </div>
        <label className="block text-xs text-gray-600 dark:text-gray-300">פרטי התביעה
          <textarea aria-label="פרטי התביעה" rows={3} value={details} onChange={(e) => setDetails(e.target.value)} className={cn(FIELD_CLASS, 'mt-1')} />
        </label>

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
