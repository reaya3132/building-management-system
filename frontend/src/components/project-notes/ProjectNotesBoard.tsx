import { useCallback, useEffect, useRef, useState } from 'react'
import { NotebookPen, Plus, Search } from 'lucide-react'
import { cn } from '../../lib/utils'
import { ProjectNotesAPI, type NoteBoard, type NoteInput, type ProjectNote } from '../../lib/projectNotesApi'
import { ErrorBanner } from '../collection/CollectionModal'
import { FIELD_CLASS } from '../collection/collectionUtils'
import NoteCard from './NoteCard'
import NoteEditorModal from './NoteEditorModal'
import NoteHistoryModal from './NoteHistoryModal'
import { NOTE_BOARD_TITLES, noteErrorMessage } from './noteUtils'

const PAGE_SIZE = 20
const SEARCH_DELAY_MS = 300

interface ProjectNotesBoardProps {
  projectId: number
  board: NoteBoard
  /** Drops the outer card chrome when embedded inside another card / modal. */
  embedded?: boolean
}

/**
 * A documentation board: notes as standalone cards, newest first, with search
 * and "load more" (keyset pagination). One component for every board — the
 * `board` prop selects which one, and the server keeps them apart.
 */
export default function ProjectNotesBoard({ projectId, board, embedded = false }: ProjectNotesBoardProps) {
  const title = NOTE_BOARD_TITLES[board]
  const [notes, setNotes] = useState<ProjectNote[]>([])
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<ProjectNote | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [historyNote, setHistoryNote] = useState<ProjectNote | null>(null)
  const requestRef = useRef(0)

  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput), SEARCH_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [searchInput])

  // First page; a newer request (search typed meanwhile) wins over an older one.
  const loadFirst = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    try {
      const page = await ProjectNotesAPI.list(projectId, board, { search, limit: PAGE_SIZE })
      if (request !== requestRef.current) return
      setNotes(page.items)
      setNextBeforeId(page.next_before_id)
      setError(null)
    } catch (err) {
      if (request === requestRef.current) setError(noteErrorMessage(err, 'שגיאה בטעינת התיעוד'))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [projectId, board, search])

  useEffect(() => { void loadFirst() }, [loadFirst])

  const loadMore = async () => {
    if (nextBeforeId == null || loadingMore) return
    const request = requestRef.current
    setLoadingMore(true)
    try {
      const page = await ProjectNotesAPI.list(projectId, board, { search, beforeId: nextBeforeId, limit: PAGE_SIZE })
      if (request !== requestRef.current) return
      setNotes((prev) => [...prev, ...page.items])
      setNextBeforeId(page.next_before_id)
    } catch (err) {
      setError(noteErrorMessage(err, 'שגיאה בטעינת רשומות נוספות'))
    } finally {
      setLoadingMore(false)
    }
  }

  const save = async (input: Partial<NoteInput>) => {
    if (editing) {
      const updated = await ProjectNotesAPI.update(projectId, board, editing.id, input)
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)))
    } else {
      await ProjectNotesAPI.create(projectId, board, input as NoteInput)
      await loadFirst() // the new note goes on top, consistent with search / paging
    }
  }

  const remove = async (note: ProjectNote) => {
    if (!window.confirm(`למחוק את הרשומה "${note.title}"?`)) return
    try {
      await ProjectNotesAPI.remove(projectId, board, note.id)
      setNotes((prev) => prev.filter((n) => n.id !== note.id))
    } catch (err) {
      setError(noteErrorMessage(err, 'מחיקת הרשומה נכשלה'))
    }
  }

  // Empty: the card takes its natural, compact height. With notes: the card is
  // capped at 32rem and only the notes list scrolls; header and search stay put.
  // Derived from `notes`, so it follows every load, add and delete.
  const hasNotes = notes.length > 0

  return (
    <section
      aria-label={title}
      className={cn(
        'flex flex-col gap-4',
        hasNotes && 'max-h-[32rem] min-h-0',
        !embedded && 'rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-4 sm:p-5'
      )}
      dir="rtl"
    >
      <div className="flex flex-wrap items-center gap-3 flex-shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 flex items-center justify-center flex-shrink-0">
            <NotebookPen className="w-5 h-5" />
          </span>
          <h3 className="text-lg font-bold text-gray-900 dark:text-white">{title}</h3>
        </div>
        <button
          type="button"
          onClick={() => { setEditing(null); setEditorOpen(true) }}
          className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 px-3.5 py-2 text-sm font-semibold text-white"
        >
          <Plus className="w-4 h-4" /> רשומה חדשה
        </button>
      </div>

      <div className="relative flex-shrink-0">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          className={cn(FIELD_CLASS, 'pr-9')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="חיפוש בכותרת ובתוכן..."
          aria-label={`חיפוש ב${title}`}
          maxLength={255}
        />
      </div>

      <ErrorBanner message={error} />

      {loading && notes.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">טוען...</p>
      ) : notes.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-gray-200 dark:border-gray-700 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
          {search ? 'לא נמצאו רשומות התואמות לחיפוש' : 'אין רשומות עדיין'}
        </div>
      ) : (
        <div data-testid="notes-scroll" className="flex-1 min-h-0 overflow-y-auto space-y-3">
          {notes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              onEdit={(n) => { setEditing(n); setEditorOpen(true) }}
              onDelete={remove}
              onHistory={setHistoryNote}
            />
          ))}
          {nextBeforeId != null && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full rounded-xl border border-gray-200 dark:border-gray-700 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-60"
            >
              {loadingMore ? 'טוען...' : 'טען עוד'}
            </button>
          )}
        </div>
      )}

      <NoteEditorModal isOpen={editorOpen} note={editing} boardTitle={title} onClose={() => setEditorOpen(false)} onSave={save} />
      <NoteHistoryModal projectId={projectId} board={board} note={historyNote} onClose={() => setHistoryNote(null)} />
    </section>
  )
}
