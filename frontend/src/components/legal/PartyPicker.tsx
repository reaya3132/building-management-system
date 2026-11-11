import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { LegalAPI, type ContactCompletion, type ContactSummary, type NewContactDetails, type PartySelection } from '../../lib/legalApi'
import { FIELD_CLASS } from '../collection/collectionUtils'

export interface PartyValue {
  mode: 'existing' | 'new'
  contact: ContactSummary | null
  details: NewContactDetails
  complete: ContactCompletion
}

type DetailField = keyof Omit<NewContactDetails, 'kind'>
type CompletionField = keyof ContactCompletion

export const emptyParty = (): PartyValue => ({
  mode: 'existing',
  contact: null,
  details: { kind: 'person', name: '', phone: '', phone_2: '', email: '', address: '', apartment_number: '' },
  complete: {},
})

const FIELD_LABELS: Record<DetailField, string> = {
  name: 'שם', phone: 'טלפון', phone_2: 'טלפון נוסף', email: 'דוא"ל', address: 'כתובת', apartment_number: 'מספר דירה',
}
const FIELD_TYPES: Partial<Record<DetailField, string>> = { phone: 'tel', phone_2: 'tel', email: 'email' }
const TEXT_FIELDS: DetailField[] = ['name', 'phone', 'phone_2', 'email', 'address', 'apartment_number']
// The server applies the same rules: a linked landlord needs only a name and a phone.
const PRIMARY_REQUIRED: DetailField[] = ['name', 'phone', 'email', 'address', 'apartment_number']
const LINKED_REQUIRED: DetailField[] = ['name', 'phone']
const COMPLETABLE: CompletionField[] = ['phone', 'email', 'address', 'apartment_number']

const requiredFields = (primary: boolean) => (primary ? PRIMARY_REQUIRED : LINKED_REQUIRED)
const filled = (text: string | null | undefined) => Boolean(text && text.trim())

/** Fields this role requires that are empty on the selected card. */
export function missingFields(contact: ContactSummary, primary: boolean): CompletionField[] {
  const required = requiredFields(primary)
  return COMPLETABLE.filter((field) => required.includes(field) && !filled(contact[field]))
}

/** Are all the details this role requires present (on the card, or entered here)? */
export function isPartyReady(value: PartyValue, primary: boolean): boolean {
  if (value.mode === 'new') return requiredFields(primary).every((field) => filled(value.details[field]))
  if (!value.contact) return false
  return missingFields(value.contact, primary).every((field) => filled(value.complete[field]))
}

function trimmedValues<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, text]) => filled(text as string)).map(([key, text]) => [key, (text as string).trim()]),
  ) as Partial<T>
}

/** The API selection, or null when nothing was chosen yet. */
export function toPartySelection(value: PartyValue): PartySelection | null {
  if (value.mode === 'existing') {
    if (!value.contact) return null
    const complete = trimmedValues(value.complete)
    return { contact_id: value.contact.id, ...(Object.keys(complete).length ? { complete } : {}) }
  }
  return { details: { ...(trimmedValues(value.details) as NewContactDetails), kind: value.details.kind } }
}

interface PartyPickerProps {
  /** Section title, e.g. "שוכר" or "בעל הדירה המשויך". */
  label: string
  /** The kind of contact, for the existing / new choice. */
  entity: string
  value: PartyValue
  onChange: (value: PartyValue) => void
  /** The primary party of the proceeding (a linked landlord is not). */
  primary: boolean
  /** Read-only once the following step depends on it. */
  locked?: boolean
}

/** Choose an existing contact (only its empty fields can be filled) or enter a new one. */
export default function PartyPicker({ label, entity, value, onChange, primary, locked }: PartyPickerProps) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<ContactSummary[]>([])
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)

  useEffect(() => {
    const query = term.trim()
    setSearchFailed(false)
    if (value.mode !== 'existing' || value.contact || query.length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      LegalAPI.searchContacts(query)
        .then((found) => { if (!cancelled) setResults(found) })
        .catch(() => { if (!cancelled) { setResults([]); setSearchFailed(true) } })
        .finally(() => { if (!cancelled) setSearching(false) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer); setSearching(false) }
  }, [term, value.mode, value.contact])

  const required = requiredFields(primary)
  const setDetail = (key: keyof NewContactDetails, text: string) =>
    onChange({ ...value, details: { ...value.details, [key]: text } })
  const setCompletion = (key: CompletionField, text: string) =>
    onChange({ ...value, complete: { ...value.complete, [key]: text } })

  const textField = (field: DetailField, text: string, isRequired: boolean, change: (text: string) => void) => (
    <label key={field} className="text-xs text-gray-600 dark:text-gray-300">
      {FIELD_LABELS[field]}{isRequired && <span className="text-destructive"> *</span>}
      <input type={FIELD_TYPES[field] ?? 'text'} aria-label={`${label} ${FIELD_LABELS[field]}`} value={text}
        maxLength={field === 'apartment_number' ? 32 : undefined}
        onChange={(e) => change(e.target.value)} className={cn(FIELD_CLASS, 'mt-1')} />
    </label>
  )

  const missing = value.mode === 'existing' && value.contact ? missingFields(value.contact, primary) : []
  const canAddPhone2 = value.mode === 'existing' && value.contact && !filled(value.contact.phone_2)

  return (
    <fieldset disabled={locked} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
      <legend className="px-1 text-sm font-medium text-gray-900 dark:text-white">{label}</legend>
      <div role="tablist" className="mb-3 inline-flex rounded-md border border-gray-200 dark:border-gray-700 text-xs">
        {([['existing', `${entity} קיים`], ['new', `${entity} חדש`]] as const).map(([mode, text]) => (
          <button key={mode} type="button" role="tab" aria-selected={value.mode === mode}
            onClick={() => onChange({ ...value, mode })}
            className={cn('px-3 py-1.5 first:rounded-r-md last:rounded-l-md',
              value.mode === mode ? 'bg-primary/10 text-primary font-medium' : 'text-gray-600 dark:text-gray-300')}>
            {text}
          </button>
        ))}
      </div>

      {value.mode === 'existing' && value.contact && (
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-2 rounded-md bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="font-medium text-gray-900 dark:text-white">{value.contact.name}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {[value.contact.phone, value.contact.phone_2, value.contact.email, value.contact.address,
                  value.contact.apartment_number && `דירה ${value.contact.apartment_number}`].filter(Boolean).join(' · ')}
              </div>
            </div>
            <button type="button" aria-label={`הסרת ${label}`} onClick={() => { onChange({ ...value, contact: null, complete: {} }); setTerm('') }}
              className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><X className="w-4 h-4" /></button>
          </div>
          {missing.length > 0 && <p className="text-xs text-amber-700 dark:text-amber-300">חסרים פרטים הנדרשים להליך. יש להשלים אותם כאן.</p>}
          {(missing.length > 0 || canAddPhone2) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {missing.map((field) => textField(field, value.complete[field] ?? '', true, (text) => setCompletion(field, text)))}
              {canAddPhone2 && textField('phone_2', value.complete.phone_2 ?? '', false, (text) => setCompletion('phone_2', text))}
            </div>
          )}
        </div>
      )}

      {value.mode === 'existing' && !value.contact && (
        <div>
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input aria-label={`חיפוש ${label}`} value={term} onChange={(e) => setTerm(e.target.value)}
              placeholder="חיפוש לפי שם, טלפון, טלפון נוסף או דוא״ל" className={cn(FIELD_CLASS, 'pr-9')} />
          </div>
          {searching && <p className="mt-2 text-xs text-gray-500">מחפש...</p>}
          {searchFailed && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">החיפוש נכשל. יש לנסות שוב.</p>}
          {results.length > 0 && (
            <ul className="mt-2 max-h-40 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700 rounded-md border border-gray-200 dark:border-gray-700">
              {results.map((contact) => (
                <li key={contact.id}>
                  <button type="button" onClick={() => onChange({ ...value, contact, complete: {} })}
                    className="w-full text-right px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800">
                    <span className="font-medium text-gray-900 dark:text-white">{contact.name}</span>
                    <span className="mr-2 text-xs text-gray-500" dir="ltr">{[contact.phone, contact.phone_2].filter(Boolean).join(' / ')}</span>
                    {contact.email && <span className="mr-2 text-xs text-gray-500">{contact.email}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!searching && !searchFailed && term.trim().length >= 2 && results.length === 0 && (
            <p className="mt-2 text-xs text-gray-500">לא נמצאו אנשי קשר.</p>
          )}
        </div>
      )}

      {value.mode === 'new' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-gray-600 dark:text-gray-300">סוג
            <select value={value.details.kind} onChange={(e) => setDetail('kind', e.target.value)} className={cn(FIELD_CLASS, 'mt-1')}>
              <option value="person">אדם פרטי</option>
              <option value="business">עסק</option>
            </select>
          </label>
          {TEXT_FIELDS.map((field) => textField(field, value.details[field] ?? '', required.includes(field), (text) => setDetail(field, text)))}
        </div>
      )}
    </fieldset>
  )
}
