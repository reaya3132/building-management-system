import { useEffect, useState, useCallback, useRef } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '../../store'
import api, { avatarUrl, fileAttachmentUrl } from '../../lib/api'
import Modal from '../Modal'
import { cn } from '../../lib/utils'
import { formatTaskCode } from '../../lib/taskCode'
import { canEditTask } from '../../lib/taskPermissions'
import {
  Archive,
  Bell,
  Check,
  CheckCheck,
  CheckCircle,
  MessageCircle,
  Paperclip,
  Pencil,
  Send,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import type {
  Task,
  TaskStatus,
  TaskLabelType,
  TaskMessageType,
  EventType,
} from '../../pages/TaskCalendar'
import { EVENT_TYPE_LABELS, isAllDayTask, describeRecurrence } from '../../lib/taskDisplay'
import { PermissionGuard } from '../ui/PermissionGuard'
import TaskChecklist from './TaskChecklist'
import AttachmentView from './AttachmentView'
import RecordButton from './RecordButton'

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'מחכה לטיפול',
  in_progress: 'בטיפול',
  completed: 'טופלה',
  pending_closure: 'ממתין לאישור סגירה',
}

function getOverdueInfo(task: Task): { delayText: string } | null {
  if (task.status === 'completed') return null
  const dueStr = task.end_time ?? task.start_time ?? null
  if (!dueStr) return null
  const due = new Date(dueStr)
  const now = new Date()
  if (due.getTime() >= now.getTime()) return null
  const diffMs = now.getTime() - due.getTime()
  const diffMins = Math.floor(diffMs / (60 * 1000))
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000))
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000))
  let delayText: string
  if (diffDays > 0) {
    const hours = Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
    delayText = hours > 0 ? `פיגור של ${diffDays} ימים ו-${hours} שעות` : `פיגור של ${diffDays} ימים`
  } else if (diffHours > 0) {
    const mins = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000))
    delayText = mins > 0 ? `פיגור של ${diffHours} שעות ו-${diffMins % 60} דקות` : `פיגור של ${diffHours} שעות`
  } else {
    delayText = `פיגור של ${diffMins} דקות`
  }
  return { delayText }
}

export interface TaskDetailModalProps {
  taskId: number | null
  initialTask?: Task | null
  onClose: () => void
  onTaskUpdated?: (task: Task) => void
  onTaskDeleted?: () => void
  onTaskArchived?: () => void
  onEdit?: (task: Task) => void
}

export interface TaskDetailPanelProps extends TaskDetailModalProps {
  /** Shown inside another page (the notification center) rather than in a modal:
   * actions that open UI outside that page — editing, which opens the edit form
   * modal of the task screens — are not offered. Viewing files keeps its viewer
   * overlay; the user stays on the page. */
  embedded?: boolean
}

/** The task detail content and all its actions (status, chat, files, checklist,
 * acknowledge, remind, archive, delete). TaskDetailModal shows it in a modal;
 * the notification center shows it inline with `embedded`. */
export function TaskDetailPanel({
  taskId,
  initialTask,
  onClose,
  onTaskUpdated,
  onTaskDeleted,
  onTaskArchived,
  onEdit,
  embedded = false,
}: TaskDetailPanelProps) {
  const me = useSelector((state: RootState) => state.auth.me)
  const isAdmin = me?.role === 'Admin'
  const [task, setTask] = useState<Task | null>(initialTask ?? null)
  const [taskLoading, setTaskLoading] = useState(false)
  const [taskMessages, setTaskMessages] = useState<TaskMessageType[]>([])
  const [taskMessagesLoading, setTaskMessagesLoading] = useState(false)
  const [taskMessageInput, setTaskMessageInput] = useState('')
  const [taskMessageSending, setTaskMessageSending] = useState(false)
  const [deletingMessageId, setDeletingMessageId] = useState<number | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null)
  const [editingText, setEditingText] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [taskChatPendingFiles, setTaskChatPendingFiles] = useState<File[]>([])
  const taskChatFileInputRef = useRef<HTMLInputElement>(null)
  const [updatingStatus, setUpdatingStatus] = useState(false)
  const [acknowledgingTaskId, setAcknowledgingTaskId] = useState<number | null>(null)
  const [remindingTaskId, setRemindingTaskId] = useState<number | null>(null)
  const [deletingTaskId, setDeletingTaskId] = useState<number | null>(null)
  const [archivingTaskId, setArchivingTaskId] = useState<number | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [togglingSuper, setTogglingSuper] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  // Tracks the last (task, newest-message) we auto-scrolled for, so background
  // polls that return the same tail don't yank the user back to the bottom.
  const lastScrollKeyRef = useRef<string>('')

  const fetchTask = useCallback(async (id: number) => {
    setTaskLoading(true)
    try {
      const { data } = await api.get<Task>(`/tasks/${id}`)
      setTask(data)
      return data
    } catch {
      return null
    } finally {
      setTaskLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!taskId) {
      setTask(null)
      setTaskMessages([])
      setTaskMessageInput('')
      setTaskChatPendingFiles([])
      setEditingMessageId(null)
      setEditingText('')
      setShowDeleteConfirm(false)
      return
    }
    setShowDeleteConfirm(false)
    if (initialTask && initialTask.id === taskId) {
      setTask(initialTask)
    }
    fetchTask(taskId)
  }, [taskId, initialTask?.id, fetchTask])

  // Single source of truth for loading the chat. Reused by the open-task effect
  // and after any delete so this UI never diverges from the server.
  // `silent` skips the loading spinner (used by the background poll) so the list
  // doesn't flash the "loading" placeholder on every refresh.
  const reloadMessages = useCallback(async (silent = false) => {
    if (!taskId) return
    if (!silent) setTaskMessagesLoading(true)
    try {
      // Cache-bust + no-store so read receipts (✓✓) and new replies are never
      // served from a stale browser/proxy cache on the background poll.
      const { data } = await api.get<TaskMessageType[]>(`/tasks/${taskId}/messages`, {
        params: { _t: Date.now() },
        headers: { 'Cache-Control': 'no-cache' },
      })
      setTaskMessages(data)
    } catch {
      if (!silent) setTaskMessages([])
    } finally {
      if (!silent) setTaskMessagesLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    if (!taskId) return
    void reloadMessages()
  }, [taskId, reloadMessages])

  const handleDeleteMessage = useCallback(async (messageId: number) => {
    if (!taskId || deletingMessageId !== null) return
    if (!window.confirm('למחוק את ההודעה?')) return
    setDeletingMessageId(messageId)
    try {
      await api.delete(`/tasks/${taskId}/messages/${messageId}`)
      await reloadMessages()
    } finally {
      setDeletingMessageId(null)
    }
  }, [taskId, deletingMessageId, reloadMessages])

  const handleDeleteMessageAttachment = useCallback(async (messageId: number, attachmentId: number) => {
    if (!taskId || deletingMessageId !== null) return
    if (!window.confirm('למחוק קובץ זה?')) return
    setDeletingMessageId(messageId)
    try {
      await api.delete(`/tasks/${taskId}/messages/${messageId}/attachments/${attachmentId}`)
      await reloadMessages()
    } finally {
      setDeletingMessageId(null)
    }
  }, [taskId, deletingMessageId, reloadMessages])

  const handleStartEditMessage = useCallback((messageId: number, currentText: string) => {
    setEditingMessageId(messageId)
    setEditingText(currentText)
  }, [])

  const handleCancelEditMessage = useCallback(() => {
    setEditingMessageId(null)
    setEditingText('')
  }, [])

  const handleSaveEditMessage = useCallback(async () => {
    if (!taskId || editingMessageId === null || savingEdit) return
    const text = editingText.trim()
    if (!text) return
    setSavingEdit(true)
    try {
      await api.patch(`/tasks/${taskId}/messages/${editingMessageId}`, { message: text })
      setEditingMessageId(null)
      setEditingText('')
      await reloadMessages()
    } finally {
      setSavingEdit(false)
    }
  }, [taskId, editingMessageId, editingText, savingEdit, reloadMessages])

  // Live refresh (WhatsApp-style): while the chat is open, poll for new messages
  // and updated read receipts. Paused while editing so a reload can't clobber the
  // draft. Cleared on close / task change.
  useEffect(() => {
    if (!taskId || editingMessageId !== null) return
    const intervalId = window.setInterval(() => {
      if (!document.hidden) void reloadMessages(true)
    }, 8000)
    // Refresh the moment the sender returns to the tab/window, so read receipts
    // and new replies appear immediately rather than after the next poll tick.
    const onVisible = () => { if (!document.hidden) void reloadMessages(true) }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [taskId, editingMessageId, reloadMessages])

  useEffect(() => {
    if (!taskId || taskMessages.length === 0) return
    // Only auto-scroll when the newest message actually changes (open, or a new
    // reply arrives) — not on every 10s poll that returns the same messages.
    const lastId = taskMessages[taskMessages.length - 1].id
    const scrollKey = `${taskId}:${lastId}`
    if (lastScrollKeyRef.current === scrollKey) return
    lastScrollKeyRef.current = scrollKey
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [taskId, taskMessages])

  const handleStatusChange = useCallback(async (id: number, newStatus: TaskStatus) => {
    setUpdatingStatus(true)
    try {
      const { data } = await api.put<Task>(`/tasks/${id}`, { status: newStatus })
      setTask(data)
      onTaskUpdated?.(data)
    } finally {
      setUpdatingStatus(false)
    }
  }, [onTaskUpdated])

  const handleAcknowledgeTask = useCallback(async (t: Task) => {
    setAcknowledgingTaskId(t.id)
    try {
      const { data } = await api.post<Task>(`/tasks/${t.id}/acknowledge`)
      setTask(data)
      onTaskUpdated?.(data)
    } finally {
      setAcknowledgingTaskId(null)
    }
  }, [onTaskUpdated])

  const handleRemindTask = useCallback(async (t: Task) => {
    setRemindingTaskId(t.id)
    try {
      await api.post(`/tasks/${t.id}/remind`)
    } finally {
      setRemindingTaskId(null)
    }
  }, [])

  // Delete is guarded by an in-modal archive-or-delete confirmation panel (see
  // showDeleteConfirm) rather than window.confirm, so it performs the delete
  // directly once the user has chosen "delete permanently".
  const performDeleteTask = useCallback(async (t: Task) => {
    setDeletingTaskId(t.id)
    try {
      await api.delete(`/tasks/${t.id}`)
      onTaskDeleted?.()
      onClose()
    } finally {
      setDeletingTaskId(null)
    }
  }, [onClose, onTaskDeleted])

  // Archiving is non-destructive (restorable from the archive), so it needs no
  // extra confirmation — it is reached from the standalone "ארכב" button and as
  // the safe alternative inside the delete confirmation.
  const handleArchiveTask = useCallback(async (t: Task) => {
    setArchivingTaskId(t.id)
    try {
      await api.post(`/tasks/${t.id}/archive`)
      onTaskArchived?.()
      onClose()
    } catch (err: any) {
      window.alert(err?.response?.data?.detail ?? 'שגיאה בארכוב המשימה')
    } finally {
      setArchivingTaskId(null)
    }
  }, [onClose, onTaskArchived])

  const handleToggleSuperTask = useCallback(async (t: Task) => {
    setTogglingSuper(true)
    try {
      const { data } = await api.put<Task>(`/tasks/${t.id}`, { is_super_task: !t.is_super_task })
      setTask(data)
      onTaskUpdated?.(data)
    } finally {
      setTogglingSuper(false)
    }
  }, [onTaskUpdated])

  const handleSendMessage = useCallback(async () => {
    if (!taskId || taskMessageSending) return
    const text = taskMessageInput.trim()
    const files = taskChatPendingFiles
    if (!text && files.length === 0) return
    setTaskMessageInput('')
    setTaskChatPendingFiles([])
    setTaskMessageSending(true)
    try {
      const formData = new FormData()
      formData.append('message', text)
      files.forEach((file) => formData.append('files', file))
      const { data } = await api.post<TaskMessageType>(`/tasks/${taskId}/messages`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setTaskMessages(prev => [...prev, data])
    } catch {
      // Restore the draft (text + files) so the user can retry.
      setTaskMessageInput(text)
      setTaskChatPendingFiles(files)
    } finally {
      setTaskMessageSending(false)
    }
  }, [taskId, taskMessageInput, taskChatPendingFiles, taskMessageSending])

  if (!taskId) return null

  const effectiveTask = task ?? (initialTask && initialTask.id === taskId ? initialTask : null)
  const showEditButton = !embedded && typeof onEdit === 'function'

  return (
    <>
      {taskLoading && !effectiveTask ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-4">טוען...</p>
      ) : !effectiveTask ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-4">המשימה לא נמצאה.</p>
      ) : (
        <div className="space-y-3">
          <div>
            <span className="inline-block font-mono text-xs text-gray-500 dark:text-gray-400 mb-0.5">
              {formatTaskCode(effectiveTask.id)}
            </span>
            <p className="font-medium text-gray-900 dark:text-gray-100">{effectiveTask.title}</p>
          </div>
          <p className="text-sm">
            <span className="text-gray-600 dark:text-gray-400">סוג: </span>
            <span className="font-medium">{EVENT_TYPE_LABELS[(effectiveTask.event_type || 'task') as EventType]}</span>
          </p>
          {(() => {
            const overdueInfo = getOverdueInfo(effectiveTask)
            const isPendingClosure = effectiveTask.status === 'pending_closure'

            return (
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="detail-status" className="text-sm text-gray-600 dark:text-gray-400">מצב: </label>
                {isPendingClosure && !isAdmin ? (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-md text-sm font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                    ממתין לאישור סגירה
                  </span>
                ) : (
                  <select
                    id="detail-status"
                    value={effectiveTask.status || 'pending'}
                    onChange={(e) => handleStatusChange(effectiveTask.id, e.target.value as TaskStatus)}
                    disabled={updatingStatus}
                    className={cn(
                      'px-3 py-1.5 border rounded-lg text-sm',
                      'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100',
                      'disabled:opacity-50'
                    )}
                  >
                    {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[])
                      .filter((s) => {
                        if (isAdmin) return true
                        return s === 'pending' || s === 'in_progress' || s === 'completed'
                      })
                      .map((s) => (
                        <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>
                      ))}
                  </select>
                )}
                {isAdmin && isPendingClosure && (
                  <button
                    type="button"
                    onClick={() => handleStatusChange(effectiveTask.id, 'completed')}
                    disabled={updatingStatus}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg disabled:opacity-50"
                  >
                    <CheckCircle className="w-4 h-4" />
                    {updatingStatus ? 'מאשר...' : 'אשר סגירה'}
                  </button>
                )}
                {overdueInfo && (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-md text-sm font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200" title={overdueInfo.delayText}>
                    משימות בפיגור: {overdueInfo.delayText}
                  </span>
                )}
              </div>
            )
          })()}
          {effectiveTask.requires_closure_approval && (
            <p className="text-sm flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
              <span>🔒</span>
              <span>דורש אישור סגירה</span>
            </p>
          )}
              {/* Super tasks are admin-only, so only Admins may toggle the flag. */}
              {isAdmin && (
              <PermissionGuard action="update" resource="task">
                <div className="flex items-center gap-3 py-1">
                  <Zap className={cn('w-4 h-4', effectiveTask.is_super_task ? 'text-red-600' : 'text-gray-400')} />
                  <span className="text-sm text-gray-600 dark:text-gray-400">משימת על:</span>
                  <button
                    type="button"
                    onClick={() => handleToggleSuperTask(effectiveTask)}
                    disabled={togglingSuper}
                    className={cn(
                      'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                      effectiveTask.is_super_task ? 'bg-red-600' : 'bg-gray-300 dark:bg-gray-600',
                      'disabled:opacity-50'
                    )}
                    role="switch"
                    aria-checked={!!effectiveTask.is_super_task}
                  >
                    <span
                      className={cn(
                        'inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
                        effectiveTask.is_super_task ? 'translate-x-6' : 'translate-x-1'
                      )}
                    />
                  </button>
                  <span className={cn('text-sm font-medium', effectiveTask.is_super_task ? 'text-red-600' : 'text-gray-500')}>
                    {togglingSuper ? '...' : effectiveTask.is_super_task ? 'כן' : 'לא'}
                  </span>
                </div>
              </PermissionGuard>
              )}
          <div className="text-sm flex items-start gap-2 flex-wrap">
            <span className="text-gray-600 dark:text-gray-400">
              {(effectiveTask.assignees?.length ?? 0) > 1 ? 'מוקצה למשתמשים: ' : 'מוקצה למשתמש: '}
            </span>
            {(effectiveTask.assignees && effectiveTask.assignees.length > 0
              ? effectiveTask.assignees
              : [{
                  user_id: effectiveTask.assigned_to_user_id,
                  full_name: effectiveTask.assigned_user_name ?? '',
                  avatar_url: effectiveTask.assigned_user_avatar,
                }]
            ).map((assignee) => (
              <span key={assignee.user_id} className="inline-flex items-center gap-1">
                {avatarUrl(assignee.avatar_url) ? (
                  <img src={avatarUrl(assignee.avatar_url)!} alt="" className="w-6 h-6 rounded-full object-cover" />
                ) : (
                  <span className="w-6 h-6 rounded-full bg-gray-200 dark:bg-gray-600 flex items-center justify-center text-xs">
                    {(assignee.full_name || '?').charAt(0)}
                  </span>
                )}
                <span className="font-medium">{assignee.full_name}</span>
              </span>
            ))}
          </div>
          {effectiveTask.assignee_viewed_at && (
            <p className="text-sm flex items-center gap-2 text-blue-600 dark:text-blue-400">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              <span>נקראה ב־{new Date(effectiveTask.assignee_viewed_at).toLocaleString('he-IL')}</span>
            </p>
          )}
          {effectiveTask.assignee_acknowledged_at ? (
            <p className="text-sm flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              <span>הלקוח אימת קבלת המשימה ב־{new Date(effectiveTask.assignee_acknowledged_at).toLocaleString('he-IL')}</span>
            </p>
          ) : me?.id === effectiveTask.assigned_to_user_id && (
            <button
              type="button"
              onClick={() => handleAcknowledgeTask(effectiveTask)}
              disabled={acknowledgingTaskId === effectiveTask.id}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-50"
            >
              <CheckCircle className="w-4 h-4" />
              {acknowledgingTaskId === effectiveTask.id ? 'מאשר...' : 'אישרתי קבלת המשימה'}
            </button>
          )}
          {effectiveTask.start_time && effectiveTask.end_time && isAllDayTask(effectiveTask) && (
            <p className="text-sm">
              <span className="text-gray-600 dark:text-gray-400">תאריך: </span>
              {new Date(effectiveTask.start_time).toLocaleDateString('he-IL')}
              <span className="text-gray-500 dark:text-gray-500"> (בלי שעה)</span>
            </p>
          )}
          {effectiveTask.start_time && effectiveTask.end_time && !isAllDayTask(effectiveTask) && (
            <p className="text-sm">
              <span className="text-gray-600 dark:text-gray-400">משעה עד שעה: </span>
              {new Date(effectiveTask.start_time).toLocaleString('he-IL')} – {new Date(effectiveTask.end_time).toLocaleString('he-IL')}
            </p>
          )}
          {!effectiveTask.start_time && !effectiveTask.end_time && (
            <p className="text-sm text-gray-600 dark:text-gray-400">משימה בלי תאריך</p>
          )}
          {effectiveTask.recurrence_rule && (
            <p className="text-sm">
              <span className="text-gray-600 dark:text-gray-400">משימה מחזורית: </span>
              <span className="font-medium">{describeRecurrence(effectiveTask)}</span>
            </p>
          )}
          {effectiveTask.description && (
            <p className="text-sm">
              <span className="text-gray-600 dark:text-gray-400">תיאור: </span>
              {effectiveTask.description}
            </p>
          )}
          {(effectiveTask.attachments?.length ?? 0) > 0 && (
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-1 mb-1">
                <Paperclip className="w-3.5 h-3.5" /> קבצים מצורפים:
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {effectiveTask.attachments?.map((att) => (
                  <AttachmentView
                    key={att.id}
                    fileName={att.file_name}
                    fileUrl={fileAttachmentUrl(att.file_url)}
                  />
                ))}
              </div>
            </div>
          )}
          {(effectiveTask.labels?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-sm text-gray-600 dark:text-gray-400">לייבלים: </span>
              {effectiveTask.labels?.map((l: TaskLabelType) => (
                <span
                  key={l.id}
                  className="px-2 py-0.5 rounded-full text-xs text-white"
                  style={{ backgroundColor: l.color }}
                >
                  {l.name}
                </span>
              ))}
            </div>
          )}

          {/* רשימת משימות */}
          <TaskChecklist
            taskId={effectiveTask.id}
            canEdit={isAdmin || me?.id === effectiveTask.assigned_to_user_id}
            participants={(effectiveTask.participants || []).map((p) => ({
              id: p.user_id,
              name: p.full_name,
              avatar: p.avatar_url ?? null,
              color: null,
            }))}
            currentUserId={me?.id}
          />

          {/* שיח משימה */}
          <div className="border-t border-gray-200 dark:border-gray-600 pt-3 mt-3">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-2 mb-2">
              <MessageCircle className="w-4 h-4" />
              שיח משימה
            </p>
            <div
              ref={chatScrollRef}
              className="bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-600 overflow-y-auto min-h-[120px] max-h-[220px] p-2 space-y-2"
            >
              {taskMessagesLoading ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">טוען הודעות...</p>
              ) : taskMessages.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">אין הודעות. התחל שיחה.</p>
              ) : (
                taskMessages.map((msg) => {
                  const isMine = msg.user_id === me?.id
                  const canDelete = isAdmin || msg.user_id === me?.id
                  const canEdit = isMine && !!msg.message
                  const isDeleting = deletingMessageId === msg.id
                  const isEditing = editingMessageId === msg.id
                  return (
                    <div key={msg.id} className={cn('flex w-full', isMine ? 'justify-end' : 'justify-start')}>
                      <div className={cn('flex gap-2 max-w-[80%]', isMine && 'flex-row-reverse')}>
                        {avatarUrl(msg.avatar_url) ? (
                          <img src={avatarUrl(msg.avatar_url)!} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                        ) : (
                          <div className="w-7 h-7 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center flex-shrink-0 text-xs text-gray-600 dark:text-gray-300">
                            {(msg.full_name || '?').charAt(0)}
                          </div>
                        )}
                        <div
                          className={cn(
                            'min-w-0 p-2 rounded-2xl',
                            isMine
                              ? 'bg-blue-600 text-white rounded-tr-sm'
                              : 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-600 rounded-tl-sm'
                          )}
                        >
                          <div className="flex items-center gap-2">
                            {!isMine && (
                              <p className="text-xs font-medium text-gray-600 dark:text-gray-400 flex-1">{msg.full_name}</p>
                            )}
                            {canEdit && !isEditing && (
                              <button
                                type="button"
                                onClick={() => handleStartEditMessage(msg.id, msg.message)}
                                disabled={isDeleting}
                                className="p-0.5 rounded flex-shrink-0 disabled:opacity-50 text-blue-100 hover:bg-blue-700"
                                title="ערוך הודעה"
                                aria-label="ערוך הודעה"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {canDelete && (
                              <button
                                type="button"
                                onClick={() => handleDeleteMessage(msg.id)}
                                disabled={isDeleting}
                                className={cn(
                                  'p-0.5 rounded flex-shrink-0 disabled:opacity-50',
                                  isMine ? 'text-blue-100 hover:bg-blue-700' : 'text-gray-400 hover:bg-red-100 dark:hover:bg-red-900/40'
                                )}
                                title="מחק הודעה"
                                aria-label="מחק הודעה"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                          {isEditing ? (
                            <div className="mt-1">
                              <textarea
                                value={editingText}
                                onChange={(e) => setEditingText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault()
                                    void handleSaveEditMessage()
                                  }
                                  if (e.key === 'Escape') {
                                    e.preventDefault()
                                    handleCancelEditMessage()
                                  }
                                }}
                                rows={2}
                                autoFocus
                                disabled={savingEdit}
                                className="w-full text-sm rounded-lg p-1.5 text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 resize-none"
                              />
                              <div className="flex items-center justify-end gap-2 mt-1">
                                <button
                                  type="button"
                                  onClick={handleCancelEditMessage}
                                  disabled={savingEdit}
                                  className={cn('text-xs px-2 py-0.5 rounded disabled:opacity-50', isMine ? 'text-blue-100 hover:bg-blue-700' : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-600')}
                                >
                                  ביטול
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleSaveEditMessage()}
                                  disabled={savingEdit || !editingText.trim()}
                                  className="text-xs px-2 py-0.5 rounded bg-white text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                                >
                                  שמור
                                </button>
                              </div>
                            </div>
                          ) : (
                            msg.message && (
                              <p className="text-sm break-words whitespace-pre-wrap">{msg.message}</p>
                            )
                          )}
                          {(msg.attachments?.length ?? 0) > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              {msg.attachments?.map((att) => (
                                <span key={att.id} className="inline-flex items-center gap-1">
                                  <AttachmentView
                                    fileName={att.file_name}
                                    fileUrl={fileAttachmentUrl(att.file_url)}
                                  />
                                  {canDelete && (
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteMessageAttachment(msg.id, att.id)}
                                      disabled={isDeleting}
                                      className={cn(
                                        'p-0.5 rounded flex-shrink-0 disabled:opacity-50',
                                        isMine ? 'text-blue-100 hover:bg-blue-700' : 'text-gray-400 hover:bg-red-100 dark:hover:bg-red-900/40'
                                      )}
                                      title="מחק קובץ"
                                      aria-label="מחק קובץ"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  )}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className={cn('flex items-center gap-1 mt-0.5 text-xs', isMine ? 'text-blue-100/80 justify-end' : 'text-gray-400 dark:text-gray-500')}>
                            <span>{new Date(msg.created_at).toLocaleString('he-IL')}</span>
                            {msg.edited_at && <span title={new Date(msg.edited_at).toLocaleString('he-IL')}>· נערך</span>}
                            {isMine && (
                              msg.read_by_all
                                ? <CheckCheck className="w-4 h-4 text-sky-300" aria-label="נקרא" />
                                : <Check className="w-4 h-4 text-blue-100/70" aria-label="נשלח" />
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
            {taskChatPendingFiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {taskChatPendingFiles.map((file, idx) => (
                  <span key={`${file.name}-${idx}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-600 text-xs">
                    <Paperclip className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate max-w-[120px]" title={file.name}>{file.name}</span>
                    <button
                      type="button"
                      onClick={() => setTaskChatPendingFiles(prev => prev.filter((_, i) => i !== idx))}
                      disabled={taskMessageSending}
                      className="p-0.5 rounded hover:bg-red-200 dark:hover:bg-red-900/50 disabled:opacity-50"
                      aria-label="הסר קובץ"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2 mt-2">
              <input
                ref={taskChatFileInputRef}
                type="file"
                multiple
                accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.zip"
                onChange={(e) => {
                  const files = e.target.files ? Array.from(e.target.files) : []
                  if (files.length) setTaskChatPendingFiles(prev => [...prev, ...files])
                  if (taskChatFileInputRef.current) taskChatFileInputRef.current.value = ''
                }}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => taskChatFileInputRef.current?.click()}
                disabled={taskMessageSending}
                className="p-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
                title="צרף קובץ"
                aria-label="צרף קובץ"
              >
                <Paperclip className="w-4 h-4" />
              </button>
              <RecordButton
                onRecorded={(file) => setTaskChatPendingFiles(prev => [...prev, file])}
                disabled={taskMessageSending}
              />
              <input
                type="text"
                value={taskMessageInput}
                onChange={(e) => setTaskMessageInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSendMessage()
                  }
                }}
                placeholder="כתוב הודעה..."
                className={cn(
                  'flex-1 px-3 py-2 border rounded-lg text-sm',
                  'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100',
                  'placeholder:text-gray-400 dark:placeholder:text-gray-500'
                )}
                disabled={taskMessageSending}
              />
              <button
                type="button"
                onClick={handleSendMessage}
                disabled={(!taskMessageInput.trim() && taskChatPendingFiles.length === 0) || taskMessageSending}
                className="p-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                title="שלח"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>

          {showDeleteConfirm && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 mt-3 space-y-3">
              <p className="text-sm text-red-800 dark:text-red-200">
                האם למחוק את "{effectiveTask.title}"? מחיקה היא לצמיתות ואינה ניתנת לשחזור. במקום זאת אפשר לארכב את המשימה — היא תוסר מהרשימה אך תישמר בארכיון וניתן לשחזר אותה בכל עת.
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => handleArchiveTask(effectiveTask)}
                  disabled={archivingTaskId === effectiveTask.id}
                  className="inline-flex items-center gap-2 px-4 py-2 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50"
                >
                  <Archive className="w-4 h-4" />
                  {archivingTaskId === effectiveTask.id ? 'מארכב...' : 'ארכב במקום'}
                </button>
                <button
                  type="button"
                  onClick={() => performDeleteTask(effectiveTask)}
                  disabled={deletingTaskId === effectiveTask.id}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" />
                  {deletingTaskId === effectiveTask.id ? 'מוחק...' : 'מחק לצמיתות'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-4 py-2 bg-gray-200 dark:bg-gray-600 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500"
                >
                  ביטול
                </button>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-gray-200 dark:border-gray-600 mt-4">
            <button
              type="button"
              onClick={() => handleRemindTask(effectiveTask)}
              disabled={remindingTaskId === effectiveTask.id}
              className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg disabled:opacity-50"
              title="שלח תזכורת לעובד המוקצה"
            >
              <Bell className="w-4 h-4" />
              {remindingTaskId === effectiveTask.id ? 'שולח...' : 'הזכר'}
            </button>
            {showEditButton && canEditTask(effectiveTask, me) && (
              <button
                type="button"
                onClick={() => { onEdit?.(effectiveTask); onClose() }}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
              >
                <Pencil className="w-4 h-4" />
                עריכה
              </button>
            )}
            {effectiveTask.status === 'completed' && !effectiveTask.is_archived && canEditTask(effectiveTask, me) && (
              <button
                type="button"
                onClick={() => handleArchiveTask(effectiveTask)}
                disabled={archivingTaskId === effectiveTask.id}
                className="inline-flex items-center gap-2 px-4 py-2 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50"
                title="ארכב את המשימה שטופלה"
              >
                <Archive className="w-4 h-4" />
                {archivingTaskId === effectiveTask.id ? 'מארכב...' : 'ארכב'}
              </button>
            )}
            {canEditTask(effectiveTask, me) && (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={!!deletingTaskId || showDeleteConfirm}
                className="inline-flex items-center gap-2 px-4 py-2 text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4" />
                {deletingTaskId === effectiveTask.id ? 'מוחק...' : 'מחק'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-gray-200 dark:bg-gray-600 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500"
            >
              סגור
            </button>
          </div>
        </div>
      )}
    </>
  )
}

export default function TaskDetailModal(props: TaskDetailModalProps) {
  if (!props.taskId) return null
  return (
    <Modal isOpen={!!props.taskId} onClose={props.onClose} title="פרטי משימה">
      <TaskDetailPanel {...props} />
    </Modal>
  )
}
