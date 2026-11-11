import { useRef, useState } from 'react'
import { Download, FileText, Paperclip, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import DocumentViewerModal from '../DocumentViewerModal'
import { cn } from '../../lib/utils'
import type { Channel, LegalDocument, LegalEntry, NewEntry } from '../../lib/legalApi'
import { FIELD_CLASS } from '../collection/collectionUtils'
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from './LegalModal'
import { CHANNEL_LABELS, formatDateTime } from './legalUtils'

/** Each action resolves to whether the server accepted it (the caller shows any error). */
type Act = (action: () => Promise<unknown>) => Promise<boolean>

/** Small text-style action used for "add" buttons throughout the documentation. */
export const ADD_BUTTON = 'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50'
const SMALL_FIELD = cn(FIELD_CLASS, 'py-1.5')

// ── documents ─────────────────────────────────────────────────────────────────

interface DocumentsProps {
  documents: LegalDocument[]
  canChange: boolean
  busy: boolean
  /** Upload control's accessible name; omit to hide uploading. */
  uploadLabel?: string
  onUpload?: (files: File[]) => Promise<boolean>
  onDelete?: (doc: LegalDocument) => unknown
  /** Text shown when there are no files (omit to show nothing). */
  emptyText?: string
}

/** Files of one owner: the proceeding, a stage component or an entry. */
export function DocumentList({ documents, canChange, busy, uploadLabel, onUpload, onDelete, emptyText }: DocumentsProps) {
  const input = useRef<HTMLInputElement>(null)
  const [viewing, setViewing] = useState<LegalDocument | null>(null)
  const pick = async (files: FileList | null) => {
    if (!files?.length || !onUpload) return
    await onUpload(Array.from(files))
    if (input.current) input.current.value = ''
  }
  return (
    <div className="space-y-1">
      {documents.length === 0 && emptyText && <p className="text-xs text-gray-400 dark:text-gray-500">{emptyText}</p>}
      {documents.length > 0 && (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700/60">
          {documents.map((doc) => (
            <li key={doc.id} className="flex items-center gap-2 py-1.5 text-sm">
              <FileText className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <button type="button" onClick={() => setViewing(doc)} className="flex-1 min-w-0 truncate text-right text-gray-800 dark:text-gray-100 hover:text-primary hover:underline">
                {doc.file_name || `מסמך ${doc.id}`}
              </button>
              <a href={doc.download_url} aria-label={`הורדת ${doc.file_name ?? 'מסמך'}`} className="p-1 rounded text-gray-400 hover:text-primary"><Download className="w-3.5 h-3.5" /></a>
              <span className="hidden sm:inline text-xs text-gray-400 whitespace-nowrap">{[doc.uploaded_by?.full_name, doc.uploaded_at && formatDateTime(doc.uploaded_at)].filter(Boolean).join(' · ')}</span>
              {canChange && onDelete && (
                <button type="button" disabled={busy} aria-label={`מחיקת ${doc.file_name ?? 'מסמך'}`}
                  onClick={() => { if (window.confirm('למחוק את המסמך?')) void onDelete(doc) }}
                  className="p-1 rounded text-gray-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canChange && onUpload && uploadLabel && (
        <label className={cn(ADD_BUTTON, 'relative cursor-pointer', busy && 'opacity-50 pointer-events-none')}>
          <Upload className="w-3.5 h-3.5" /> העלאת קובץ
          <input ref={input} type="file" multiple aria-label={uploadLabel} className="sr-only" disabled={busy}
            onChange={(e) => void pick(e.target.files)} />
        </label>
      )}
      <DocumentViewerModal isOpen={viewing !== null} onClose={() => setViewing(null)}
        document={viewing && { file_path: viewing.preview_url || viewing.download_url, description: viewing.file_name }} />
    </div>
  )
}

// ── entries (notes and communication records) ─────────────────────────────────

interface EntriesProps {
  entries: LegalEntry[]
  canChange: boolean
  busy: boolean
  act: Act
  onUpdate: (entry: LegalEntry, patch: { content?: string | null; channel?: Channel; occurred_at?: string }) => Promise<unknown>
  onDelete: (entry: LegalEntry) => Promise<unknown>
  onDeleteFile: (entry: LegalEntry, doc: LegalDocument) => Promise<unknown>
  onUploadFiles: (entry: LegalEntry, files: File[]) => Promise<unknown>
  emptyText?: string
}

/** Records the users add while working: notes, and stage 1 communication records. */
export function EntryList({ entries, canChange, busy, act, onUpdate, onDelete, onDeleteFile, onUploadFiles, emptyText }: EntriesProps) {
  const [editing, setEditing] = useState<{ id: number; content: string } | null>(null)
  if (entries.length === 0) return emptyText ? <p className="text-xs text-gray-400 dark:text-gray-500">{emptyText}</p> : null
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-700/60">
      {entries.map((entry) => {
        const editable = canChange && entry.can_modify
        const isCommunication = entry.entry_type === 'communication'
        const isEditing = editable && editing?.id === entry.id
        return (
          <li key={entry.id} className={cn('py-2 text-sm', isCommunication && '-mx-2 px-2 my-1 rounded-lg border-0 bg-amber-50 dark:bg-amber-900/15')}>
            <div className="flex items-center gap-2">
              {isCommunication && entry.channel && (
                <span className="rounded-md bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[11px] font-medium text-gray-700 dark:text-gray-200">{CHANNEL_LABELS[entry.channel]}</span>
              )}
              <span className="flex-1 min-w-0 text-xs text-gray-500 dark:text-gray-400 truncate">
                {formatDateTime(isCommunication ? entry.occurred_at : entry.created_at)}{entry.created_by?.full_name ? ` · ${entry.created_by.full_name}` : ''}
              </span>
              {entry.documents.length > 0 && <span className="inline-flex items-center gap-0.5 text-xs text-gray-500"><Paperclip className="w-3 h-3" />{entry.documents.length}</span>}
              {editable && (
                <span className="flex">
                  <button type="button" aria-label="עריכת רשומה" disabled={busy} onClick={() => setEditing({ id: entry.id, content: entry.content ?? '' })}
                    className="p-1 rounded text-gray-400 hover:text-primary"><Pencil className="w-3.5 h-3.5" /></button>
                  <button type="button" aria-label="מחיקת רשומה" disabled={busy}
                    onClick={() => { if (window.confirm('למחוק את הרשומה?')) void act(() => onDelete(entry)) }}
                    className="p-1 rounded text-gray-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                </span>
              )}
            </div>
            {isEditing && editing ? (
              <div className="mt-1.5 space-y-1.5">
                <textarea aria-label="תוכן הרשומה" rows={2} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} className={SMALL_FIELD} />
                <div className="flex gap-2 justify-end">
                  <button type="button" className={BUTTON_SECONDARY} onClick={() => setEditing(null)}>ביטול</button>
                  <button type="button" className={BUTTON_PRIMARY} disabled={busy}
                    onClick={async () => { if (await act(() => onUpdate(entry, { content: editing.content.trim() || null }))) setEditing(null) }}>שמירה</button>
                </div>
              </div>
            ) : (
              entry.content && <p className="mt-0.5 whitespace-pre-wrap text-gray-800 dark:text-gray-100">{entry.content}</p>
            )}
            {/* Files can be added or removed only while the record is being edited. */}
            {(entry.documents.length > 0 || isEditing) && (
              <div className="mt-1">
                <DocumentList documents={entry.documents} canChange={isEditing} busy={busy}
                  uploadLabel={`צירוף קבצים לרשומה ${entry.id}`}
                  onUpload={(files) => act(() => onUploadFiles(entry, files))}
                  onDelete={(doc) => act(() => onDeleteFile(entry, doc))} />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ── adding (opened only on demand) ────────────────────────────────────────────

/** "+ הוספת הערה", which opens a short form in place. */
export function NoteForm({ label, busy, onAdd }: { label: string; busy: boolean; onAdd: (content: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState('')
  if (!open) return <button type="button" className={ADD_BUTTON} disabled={busy} onClick={() => setOpen(true)}><Plus className="w-3.5 h-3.5" /> הוספת הערה</button>
  const close = () => { setOpen(false); setContent('') }
  return (
    <div className="flex gap-2">
      <input aria-label={label} placeholder="תוכן ההערה" autoFocus value={content} onChange={(e) => setContent(e.target.value)} className={cn(SMALL_FIELD, 'flex-1')} />
      <button type="button" className={BUTTON_PRIMARY} disabled={busy || !content.trim()}
        onClick={async () => { if (await onAdd(content.trim())) close() }}>הוספה</button>
      <button type="button" className={BUTTON_SECONDARY} onClick={close}>ביטול</button>
    </div>
  )
}

const nowLocal = () => {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

/** "+ תיעוד שליחה" for stage 1: a record of a message that was sent, with optional files. */
export function CommunicationForm({ busy, onAdd }: { busy: boolean; onAdd: (entry: NewEntry) => Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [channel, setChannel] = useState<Channel>('email')
  const [occurredAt, setOccurredAt] = useState(nowLocal)
  const [content, setContent] = useState('')
  const [files, setFiles] = useState<File[]>([])
  if (!open) return <button type="button" className={ADD_BUTTON} disabled={busy} onClick={() => setOpen(true)}><Plus className="w-3.5 h-3.5" /> הוספת תיעוד שליחה</button>
  const close = () => { setOpen(false); setContent(''); setFiles([]); setOccurredAt(nowLocal()) }
  const submit = async () => {
    const ok = await onAdd({ entry_type: 'communication', channel, occurred_at: new Date(occurredAt).toISOString(), content: content.trim() || null, files })
    if (ok) close()
  }
  return (
    <div className="rounded-xl bg-gray-50 dark:bg-gray-900/40 p-3 space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-gray-600 dark:text-gray-300">ערוץ
          <select aria-label="ערוץ" value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className={cn(SMALL_FIELD, 'mt-1')}>
            {(Object.keys(CHANNEL_LABELS) as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-600 dark:text-gray-300">מועד השליחה
          <input type="datetime-local" aria-label="מועד השליחה" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} className={cn(SMALL_FIELD, 'mt-1')} />
        </label>
      </div>
      <textarea aria-label="תוכן ההודעה" rows={2} placeholder="תוכן ההודעה או פירוט" value={content} onChange={(e) => setContent(e.target.value)} className={SMALL_FIELD} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className={cn(ADD_BUTTON, 'relative cursor-pointer')}>
          <Paperclip className="w-3.5 h-3.5" /> {files.length ? `${files.length} קבצים נבחרו` : 'צירוף צילום מסך או מסמך'}
          <input type="file" multiple aria-label="קבצי התיעוד" className="sr-only" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        </label>
        <div className="flex gap-2">
          <button type="button" className={BUTTON_SECONDARY} onClick={close}>ביטול</button>
          <button type="button" className={BUTTON_PRIMARY} disabled={busy || !occurredAt || (!content.trim() && files.length === 0)} onClick={() => void submit()}>
            שמירת התיעוד
          </button>
        </div>
      </div>
    </div>
  )
}
