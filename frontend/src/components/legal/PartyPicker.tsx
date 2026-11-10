import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { LegalAPI, type ContactSummary, type NewContactDetails, type PartySelection } from '../../lib/legalApi'
import { FIELD_CLASS } from '../collection/collectionUtils'

export interface PartyValue {
  mode: 'existing' | 'new'
  contact: ContactSummary | null
  details: NewContactDetails
}

export const emptyParty = (): PartyValue => ({
  mode: 'existing',
  contact: null,
  details: { kind: 'person', name: '', phone: '', phone_2: '', email: '', address: '' },
})

/** The API selection, or null when nothing was chosen yet. */
export function toPartySelection(value: PartyValue): PartySelection | null {
  if (value.mode === 'existing') return value.contact ? { contact_id: value.contact.id } : null
  return { details: { ...value.details, phone_2: value.details.phone_2 || null } }
}

const TEXT_FIELDS: Array<{ key: keyof Omit<NewContactDetails, 'kind'>; label: string; type?: string; required?: boolean }> = [
  { key: 'name', label: 'שם', required: true },
  { key: 'phone', label: 'טלפון', type: 'tel', required: true },
  { key: 'phone_2', label: 'טלפון נוסף', type: 'tel' },
  { key: 'email', label: 'דוא"ל', type: 'email', required: true },
  { key: 'address', label: 'כתובת', required: true },
]

interface PartyPickerProps {
  label: string
  value: PartyValue
  onChange: (value: PartyValue) => void
}

/** Choose an existing contact (used as it is) or enter a new one. */
export default function PartyPicker({ label, value, onChange }: PartyPickerProps) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<ContactSummary[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const query = term.trim()
    if (value.mode !== 'existing' || value.contact || query.length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      LegalAPI.searchContacts(query)
        .then((found) => { if (!cancelled) setResults(found) })
        .catch(() => { if (!cancelled) setResults([]) })
        .finally(() => { if (!cancelled) setSearching(false) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer); setSearching(false) }
  }, [term, value.mode, value.contact])

  const setDetail = (key: keyof NewContactDetails, text: string) =>
    onChange({ ...value, details: { ...value.details, [key]: text } })

  return (
    <fieldset className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
      <legend className="px-1 text-sm font-medium text-gray-900 dark:text-white">{label}</legend>
      <div role="tablist" className="mb-3 inline-flex rounded-md border border-gray-200 dark:border-gray-700 text-xs">
        {([['existing', 'איש קשר קיים'], ['new', 'איש קשר חדש']] as const).map(([mode, text]) => (
          <button key={mode} type="button" role="tab" aria-selected={value.mode === mode}
            onClick={() => onChange({ ...value, mode })}
            className={cn('px-3 py-1.5 first:rounded-r-md last:rounded-l-md',
              value.mode === mode ? 'bg-primary/10 text-primary font-medium' : 'text-gray-600 dark:text-gray-300')}>
            {text}
          </button>
        ))}
      </div>

      {value.mode === 'existing' && value.contact && (
        <div className="flex items-start justify-between gap-2 rounded-md bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm">
          <div className="min-w-0">
            <div className="font-medium text-gray-900 dark:text-white">{value.contact.name}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {[value.contact.phone, value.contact.email, value.contact.address].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button type="button" aria-label={`הסרת ${label}`} onClick={() => { onChange({ ...value, contact: null }); setTerm('') }}
            className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><X className="w-4 h-4" /></button>
        </div>
      )}

      {value.mode === 'existing' && !value.contact && (
        <div>
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input aria-label={`חיפוש ${label}`} value={term} onChange={(e) => setTerm(e.target.value)}
              placeholder="חיפוש לפי שם, טלפון או דוא״ל" className={cn(FIELD_CLASS, 'pr-9')} />
          </div>
          {searching && <p className="mt-2 text-xs text-gray-500">מחפש...</p>}
          {results.length > 0 && (
            <ul className="mt-2 max-h-40 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700 rounded-md border border-gray-200 dark:border-gray-700">
              {results.map((contact) => (
                <li key={contact.id}>
                  <button type="button" onClick={() => onChange({ ...value, contact })}
                    className="w-full text-right px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800">
                    <span className="font-medium text-gray-900 dark:text-white">{contact.name}</span>
                    <span className="mr-2 text-xs text-gray-500" dir="ltr">{contact.phone}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!searching && term.trim().length >= 2 && results.length === 0 && (
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
          {TEXT_FIELDS.map((field) => (
            <label key={field.key} className="text-xs text-gray-600 dark:text-gray-300">
              {field.label}{field.required && <span className="text-destructive"> *</span>}
              <input type={field.type ?? 'text'} aria-label={`${label} ${field.label}`} value={value.details[field.key] ?? ''}
                onChange={(e) => setDetail(field.key, e.target.value)} className={cn(FIELD_CLASS, 'mt-1')} />
            </label>
          ))}
        </div>
      )}
    </fieldset>
  )
}
