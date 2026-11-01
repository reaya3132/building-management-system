import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { ProjectNotesAPI, type NoteBoard, type NoteHistoryEntry, type ProjectNote } from '../../lib/projectNotesApi'
import CollectionModal from '../collection/CollectionModal'
import { formatNoteDate, noteErrorMessage } from './noteUtils'

const ACTION_LABELS: Record<string, string> = {
  created: 'הרשומה נוצרה',
  updated: 'הרשומה נערכה',
  deleted: 'הרשומה נמחקה',
}

const FIELD_LABELS: Record<string, string> = { title: 'כותרת', content: 'תוכן' }

interface NoteHistoryModalProps {
  projectId: number
  board: NoteBoard
  note: ProjectNote | null
  onClose: () => void
}

/** A note's change history from audit_logs: who, when, and previous vs. new text. */
export default function NoteHistoryModal({ projectId, board, note, onClose }: NoteHistoryModalProps) {
  const [entries, setEntries] = useState<NoteHistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!note) return
    let cancelled = false
    setEntries(null)
    setError(null)
    ProjectNotesAPI.history(projectId, board, note.id)
      .then((data) => { if (!cancelled) setEntries(data) })
      .catch((err) => { if (!cancelled) setError(noteErrorMessage(err, 'שגיאה בטעינת ההיסטוריה')) })
    return () => { cancelled = true }
  }, [projectId, board, note])

  return (
    <CollectionModal isOpen={note != null} onClose={onClose} icon={History} title="היסטוריית רשומה" subtitle={note?.title} maxWidth="max-w-2xl">
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!error && entries == null && <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-6">טוען...</p>}
      {entries && (
        <ol className="relative border-r-2 border-gray-200 dark:border-gray-700 pr-4 space-y-4">
          {entries.map((entry) => {
            const when = formatNoteDate(entry.created_at)
            const changed = Object.keys(entry.details?.after ?? {})
            return (
              <li key={entry.id} className="relative">
                <span className="absolute -right-[1.4rem] top-1 w-3 h-3 rounded-full bg-white dark:bg-gray-800 border-2 border-blue-500" />
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">{ACTION_LABELS[entry.action] ?? entry.action}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                    {entry.user_name ?? 'משתמש'} · {when.date} {when.time}
                  </span>
                </div>
                {entry.action === 'updated' && changed.map((field) => (
                  <div key={field} className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                    <div className="rounded-lg bg-red-50 dark:bg-red-900/20 px-2.5 py-1.5 text-red-800 dark:text-red-200 whitespace-pre-wrap break-words">
                      <span className="block text-xs font-semibold opacity-70">{FIELD_LABELS[field] ?? field} — לפני</span>
                      {String(entry.details?.before?.[field as 'title'] ?? '')}
                    </div>
                    <div className="rounded-lg bg-emerald-50 dark:bg-emerald-900/20 px-2.5 py-1.5 text-emerald-800 dark:text-emerald-200 whitespace-pre-wrap break-words">
                      <span className="block text-xs font-semibold opacity-70">{FIELD_LABELS[field] ?? field} — אחרי</span>
                      {String(entry.details?.after?.[field as 'title'] ?? '')}
                    </div>
                  </div>
                ))}
              </li>
            )
          })}
        </ol>
      )}
    </CollectionModal>
  )
}
