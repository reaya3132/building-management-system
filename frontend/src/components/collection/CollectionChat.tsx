import { useCallback, useEffect, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import { Check, CheckCheck, MessageCircle, Paperclip, Pencil, Send, Trash2, X } from 'lucide-react'
import type { RootState } from '../../store'
import api, { avatarUrl, fileAttachmentUrl } from '../../lib/api'
import { cn } from '../../lib/utils'
import type { TaskMessageType } from '../../pages/TaskCalendar'
import AttachmentView from '../task-management/AttachmentView'
import RecordButton from '../task-management/RecordButton'
import { collectionErrorMessage, formatDateTime } from './collectionUtils'

const POLL_MS = 8000

interface CollectionChatProps {
  taskId: number
}

/**
 * Chat for a collection task. Uses the same shared task-chat endpoints as
 * regular tasks (/tasks/{id}/messages*) — the server applies the collection
 * read permission and the assignment rule — with its own compact UI.
 */
export default function CollectionChat({ taskId }: CollectionChatProps) {
  const me = useSelector((s: RootState) => s.auth.me)
  const isAdmin = me?.role === 'Admin'

  const [messages, setMessages] = useState<TaskMessageType[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const [busyMessageId, setBusyMessageId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingText, setEditingText] = useState('')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastScrollKeyRef = useRef<string | null>(null)

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const { data } = await api.get<TaskMessageType[]>(`/tasks/${taskId}/messages`, {
        params: { _t: Date.now() },
        headers: { 'Cache-Control': 'no-cache' },
      })
      setMessages(data)
      setError(null)
    } catch (err) {
      if (!silent) setError(collectionErrorMessage(err, 'שגיאה בטעינת ההודעות'))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    void reload()
  }, [reload])

  // Live refresh while open; paused during an edit so a reload can't clobber it.
  useEffect(() => {
    if (editingId !== null) return
    const intervalId = window.setInterval(() => {
      if (!document.hidden) void reload(true)
    }, POLL_MS)
    const onVisible = () => { if (!document.hidden) void reload(true) }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [editingId, reload])

  // Scroll to the bottom only when the newest message changes.
  useEffect(() => {
    if (messages.length === 0) return
    const key = `${taskId}:${messages[messages.length - 1].id}`
    if (lastScrollKeyRef.current === key) return
    lastScrollKeyRef.current = key
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [taskId, messages])

  const send = useCallback(async () => {
    if (sending) return
    const text = draft.trim()
    const files = pendingFiles
    if (!text && files.length === 0) return
    setDraft('')
    setPendingFiles([])
    setSending(true)
    try {
      const formData = new FormData()
      formData.append('message', text)
      files.forEach((file) => formData.append('files', file))
      const { data } = await api.post<TaskMessageType>(`/tasks/${taskId}/messages`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setMessages((prev) => [...prev, data])
      setError(null)
    } catch (err) {
      // Restore the draft so the user can retry.
      setDraft(text)
      setPendingFiles(files)
      setError(collectionErrorMessage(err, 'שליחת ההודעה נכשלה'))
    } finally {
      setSending(false)
    }
  }, [draft, pendingFiles, sending, taskId])

  const runOnMessage = useCallback(async (messageId: number, action: () => Promise<unknown>, fallback: string) => {
    if (busyMessageId !== null) return
    setBusyMessageId(messageId)
    try {
      await action()
      await reload(true)
    } catch (err) {
      setError(collectionErrorMessage(err, fallback))
    } finally {
      setBusyMessageId(null)
    }
  }, [busyMessageId, reload])

  const deleteMessage = (messageId: number) => {
    if (!window.confirm('למחוק את ההודעה?')) return
    void runOnMessage(messageId, () => api.delete(`/tasks/${taskId}/messages/${messageId}`), 'מחיקת ההודעה נכשלה')
  }

  const deleteAttachment = (messageId: number, attachmentId: number) => {
    if (!window.confirm('למחוק קובץ זה?')) return
    void runOnMessage(
      messageId,
      () => api.delete(`/tasks/${taskId}/messages/${messageId}/attachments/${attachmentId}`),
      'מחיקת הקובץ נכשלה'
    )
  }

  const saveEdit = () => {
    const text = editingText.trim()
    if (editingId === null || !text) return
    const id = editingId
    void runOnMessage(id, async () => {
      await api.patch(`/tasks/${taskId}/messages/${id}`, { message: text })
      setEditingId(null)
      setEditingText('')
    }, 'עריכת ההודעה נכשלה')
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div role="alert" className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div
        ref={scrollRef}
        className="h-72 sm:h-80 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 space-y-2"
      >
        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">טוען הודעות...</p>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 dark:text-gray-500 gap-2">
            <MessageCircle className="w-8 h-8" />
            <p className="text-sm">אין הודעות עדיין</p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMine = msg.user_id === me?.id
            const canDelete = isAdmin || isMine
            const isBusy = busyMessageId === msg.id
            const isEditing = editingId === msg.id
            const avatar = avatarUrl(msg.avatar_url)
            const iconButton = cn(
              'p-0.5 rounded flex-shrink-0 disabled:opacity-50',
              isMine ? 'text-blue-100 hover:bg-blue-700' : 'text-gray-400 hover:bg-red-100 dark:hover:bg-red-900/40'
            )
            return (
              <div key={msg.id} className={cn('flex w-full', isMine ? 'justify-end' : 'justify-start')}>
                <div className={cn('flex gap-2 max-w-[85%] sm:max-w-[75%]', isMine && 'flex-row-reverse')}>
                  {avatar ? (
                    <img src={avatar} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center flex-shrink-0 text-xs text-gray-600 dark:text-gray-300">
                      {(msg.full_name || '?').charAt(0)}
                    </div>
                  )}
                  <div
                    className={cn(
                      'min-w-0 px-3 py-2 rounded-2xl',
                      isMine
                        ? 'bg-blue-600 text-white rounded-tr-sm'
                        : 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-600 rounded-tl-sm'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {!isMine && <p className="text-xs font-medium text-gray-600 dark:text-gray-400 flex-1">{msg.full_name}</p>}
                      {isMine && !!msg.message && !isEditing && (
                        <button
                          type="button"
                          onClick={() => { setEditingId(msg.id); setEditingText(msg.message) }}
                          disabled={isBusy}
                          className={iconButton}
                          aria-label="ערוך הודעה"
                          title="ערוך הודעה"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {canDelete && (
                        <button type="button" onClick={() => deleteMessage(msg.id)} disabled={isBusy} className={iconButton} aria-label="מחק הודעה" title="מחק הודעה">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    {isEditing ? (
                      <div className="mt-1 space-y-1">
                        <textarea
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit() }
                            if (e.key === 'Escape') { e.preventDefault(); setEditingId(null) }
                          }}
                          rows={2}
                          className="w-full min-w-[12rem] rounded-lg px-2 py-1 text-sm text-gray-900 bg-white border border-gray-300"
                          autoFocus
                        />
                        <div className="flex gap-1 justify-end">
                          <button type="button" onClick={() => setEditingId(null)} className="px-2 py-0.5 text-xs rounded bg-white/20 hover:bg-white/30">
                            ביטול
                          </button>
                          <button type="button" onClick={saveEdit} disabled={isBusy || !editingText.trim()} className="px-2 py-0.5 text-xs rounded bg-white text-blue-700 disabled:opacity-50">
                            שמירה
                          </button>
                        </div>
                      </div>
                    ) : (
                      msg.message && <p className="text-sm whitespace-pre-wrap break-words">{msg.message}</p>
                    )}

                    {(msg.attachments?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        {msg.attachments?.map((att) => (
                          <span key={att.id} className="inline-flex items-center gap-1">
                            <AttachmentView fileName={att.file_name} fileUrl={fileAttachmentUrl(att.file_url)} />
                            {canDelete && (
                              <button type="button" onClick={() => deleteAttachment(msg.id, att.id)} disabled={isBusy} className={iconButton} aria-label="מחק קובץ" title="מחק קובץ">
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className={cn('flex items-center gap-1 mt-0.5 text-xs', isMine ? 'text-blue-100/80 justify-end' : 'text-gray-400 dark:text-gray-500')}>
                      <span>{formatDateTime(msg.created_at)}</span>
                      {msg.edited_at && <span>· נערך</span>}
                      {isMine && (msg.read_by_all
                        ? <CheckCheck className="w-4 h-4 text-sky-300" aria-label="נקרא" />
                        : <Check className="w-4 h-4 text-blue-100/70" aria-label="נשלח" />)}
                    </div>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {pendingFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pendingFiles.map((file, idx) => (
            <span key={`${file.name}-${idx}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-xs text-gray-700 dark:text-gray-200">
              <Paperclip className="w-3 h-3 flex-shrink-0" />
              <span className="truncate max-w-[140px]" title={file.name}>{file.name}</span>
              <button
                type="button"
                onClick={() => setPendingFiles((prev) => prev.filter((_, i) => i !== idx))}
                disabled={sending}
                className="p-0.5 rounded hover:bg-red-200 dark:hover:bg-red-900/50 disabled:opacity-50"
                aria-label="הסר קובץ"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.zip"
          onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : []
            if (files.length) setPendingFiles((prev) => [...prev, ...files])
            e.target.value = ''
          }}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending}
          className="p-2 rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          aria-label="צרף קובץ"
          title="צרף קובץ"
        >
          <Paperclip className="w-4 h-4" />
        </button>
        <RecordButton onRecorded={(file) => setPendingFiles((prev) => [...prev, file])} disabled={sending} />
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
          }}
          placeholder="כתוב הודעה..."
          disabled={sending}
          className="flex-1 min-w-0 rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-blue-500"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || (!draft.trim() && pendingFiles.length === 0)}
          className="p-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          aria-label="שלח"
          title="שלח"
        >
          <Send className="w-4 h-4 rtl:-scale-x-100" />
        </button>
      </div>
    </div>
  )
}
