import { useState } from 'react'
import { Clock, History, Pencil, Trash2 } from 'lucide-react'
import { avatarUrl } from '../../lib/api'
import type { NoteUser, ProjectNote } from '../../lib/projectNotesApi'
import { formatNoteDate } from './noteUtils'

const COLLAPSED_CHARS = 280

function Avatar({ user }: { user: NoteUser | null }) {
  const src = avatarUrl(user?.avatar_url)
  if (src) return <img src={src} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
  return (
    <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 flex items-center justify-center text-sm font-semibold flex-shrink-0">
      {(user?.full_name || '?').charAt(0)}
    </div>
  )
}

interface NoteCardProps {
  note: ProjectNote
  onEdit: (note: ProjectNote) => void
  onDelete: (note: ProjectNote) => void
  onHistory: (note: ProjectNote) => void
}

/** One documentation note as a standalone card, with its own date and time. */
export default function NoteCard({ note, onEdit, onDelete, onHistory }: NoteCardProps) {
  const [expanded, setExpanded] = useState(false)
  const created = formatNoteDate(note.created_at)
  const updated = note.updated_at ? formatNoteDate(note.updated_at) : null
  const long = note.content.length > COLLAPSED_CHARS
  const content = long && !expanded ? `${note.content.slice(0, COLLAPSED_CHARS).trimEnd()}…` : note.content
  const actionClass = 'p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors'

  return (
    <article className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm">
      <header className="flex items-start gap-3">
        <Avatar user={note.created_by} />
        <div className="flex-1 min-w-0">
          <h4 className="font-semibold text-gray-900 dark:text-white break-words">{note.title}</h4>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 flex flex-wrap items-center gap-x-1.5">
            <span className="font-medium text-gray-600 dark:text-gray-300">{note.created_by?.full_name ?? 'משתמש'}</span>
            <span aria-hidden>·</span>
            <time dateTime={note.created_at} className="inline-flex items-center gap-1 tabular-nums">
              <Clock className="w-3 h-3" /> {created.date} {created.time}
            </time>
          </p>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button type="button" onClick={() => onHistory(note)} className={`${actionClass} hover:text-gray-700 dark:hover:text-gray-200`} aria-label={`היסטוריה של ${note.title}`} title="היסטוריה">
            <History className="w-4 h-4" />
          </button>
          {note.can_modify && (
            <>
              <button type="button" onClick={() => onEdit(note)} className={`${actionClass} hover:text-blue-600`} aria-label={`עריכת ${note.title}`} title="עריכה">
                <Pencil className="w-4 h-4" />
              </button>
              <button type="button" onClick={() => onDelete(note)} className={`${actionClass} hover:text-red-600`} aria-label={`מחיקת ${note.title}`} title="מחיקה">
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </header>

      {note.content && (
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words leading-relaxed">{content}</p>
      )}
      {long && (
        <button type="button" onClick={() => setExpanded((e) => !e)} className="mt-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline">
          {expanded ? 'הצג פחות' : 'הצג עוד'}
        </button>
      )}

      {updated && (
        <p className="mt-3 pt-2 border-t border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
          נערך ע״י {note.updated_by?.full_name ?? 'משתמש'} ·{' '}
          <time dateTime={note.updated_at!} className="tabular-nums">{updated.date} {updated.time}</time>
        </p>
      )}
    </article>
  )
}
