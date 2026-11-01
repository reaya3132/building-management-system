import { useEffect, useState } from 'react'
import { NotebookPen } from 'lucide-react'
import type { NoteInput, ProjectNote } from '../../lib/projectNotesApi'
import CollectionModal, { ErrorBanner, Field, PrimaryButton, SecondaryButton } from '../collection/CollectionModal'
import { FIELD_CLASS } from '../collection/collectionUtils'
import { NOTE_CONTENT_MAX, NOTE_TITLE_MAX, noteErrorMessage } from './noteUtils'

interface NoteEditorModalProps {
  isOpen: boolean
  /** The note being edited, or null for a new one. */
  note: ProjectNote | null
  boardTitle: string
  onClose: () => void
  /** Saves; sends only the changed fields when editing. */
  onSave: (input: Partial<NoteInput>) => Promise<void>
}

/** Create / edit a documentation note (reuses the shared modal chrome and fields). */
export default function NoteEditorModal({ isOpen, note, boardTitle, onClose, onSave }: NoteEditorModalProps) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setTitle(note?.title ?? '')
    setContent(note?.content ?? '')
    setError(null)
  }, [isOpen, note])

  const submit = async () => {
    const t = title.trim()
    const c = content.trim()
    if (!t) { setError('יש להזין כותרת'); return }
    const input: Partial<NoteInput> = note
      ? { ...(t !== note.title && { title: t }), ...(c !== note.content && { content: c }) }
      : { title: t, content: c }
    if (note && Object.keys(input).length === 0) { onClose(); return }
    setSaving(true)
    setError(null)
    try {
      await onSave(input)
      onClose()
    } catch (err) {
      setError(noteErrorMessage(err, 'שמירת הרשומה נכשלה'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <CollectionModal
      isOpen={isOpen}
      onClose={onClose}
      icon={NotebookPen}
      title={note ? 'עריכת רשומה' : 'רשומה חדשה'}
      subtitle={boardTitle}
      maxWidth="max-w-2xl"
      footer={
        <>
          <PrimaryButton onClick={submit} disabled={saving}>{saving ? 'שומר...' : 'שמירה'}</PrimaryButton>
          <SecondaryButton onClick={onClose} disabled={saving}>ביטול</SecondaryButton>
        </>
      }
    >
      <ErrorBanner message={error} />
      <Field label="כותרת" required>
        <input className={FIELD_CLASS} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={NOTE_TITLE_MAX} autoFocus />
      </Field>
      <Field label="תוכן (לא חובה)">
        <textarea
          className={`${FIELD_CLASS} min-h-[10rem] leading-relaxed`}
          rows={8}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={NOTE_CONTENT_MAX}
        />
        <span className="block text-xs text-gray-400 mt-1 text-left tabular-nums">{content.length}/{NOTE_CONTENT_MAX}</span>
      </Field>
    </CollectionModal>
  )
}
