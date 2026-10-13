import { useEffect, useState, useCallback, useRef } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '../../store'
import api from '../../lib/api'
import { avatarUrl } from '../../lib/api'
import { User, RefreshCw, GripVertical, Tag, LayoutGrid, Archive, Plus } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Task, TaskStatus, TaskLabelType, UserForTask } from '../../pages/TaskCalendar'
import TaskDetailModal from './TaskDetailModal'
import CreateEventModal from './CreateEventModal'
import TaskEditModal from './TaskEditModal'
import UnreadMessagesDot from './UnreadMessagesDot'
import ToastNotification, { useToast } from '../ToastNotification'
import { usePermissionDenied } from '../../lib/usePermissionDenied'

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'מחכה לטיפול',
  in_progress: 'בטיפול',
  completed: 'טופלה',
  pending_closure: 'ממתין לאישור סגירה',
}

const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
  pending: '#6B7280',
  in_progress: '#3B82F6',
  completed: '#10B981',
  pending_closure: '#F59E0B',
}

const USER_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444',
  '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16',
]

const STATUS_ORDER: TaskStatus[] = ['pending', 'in_progress', 'pending_closure', 'completed']

const UNLABELED_ID = -1

function formatDate(s: string | null): string {
  if (!s) return 'ללא תאריך'
  try {
    const d = new Date(s)
    return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return s
  }
}

export default function TaskBoard() {
  const me = useSelector((state: RootState) => state.auth.me)
  const isAdmin = me?.role === 'Admin'
  const [tasks, setTasks] = useState<Task[]>([])
  const [labels, setLabels] = useState<TaskLabelType[]>([])
  const [users, setUsers] = useState<UserForTask[]>([])
  const [loading, setLoading] = useState(true)
  const [filterUserId, setFilterUserId] = useState<number | null>(null)
  const [groupBy, setGroupBy] = useState<'status' | 'label'>('status')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [draggedTask, setDraggedTask] = useState<Task | null>(null)
  const [draggedOverKey, setDraggedOverKey] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<number | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  // The task being edited via the shared TaskEditModal (opened from the detail modal).
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const didDragRef = useRef(false)
  const justDraggedRef = useRef(false)
  const draggedTaskRef = useRef<Task | null>(null)
  const dragStartFrameRef = useRef<number>(0)
  const { toast, showToast, hideToast } = useToast()

  usePermissionDenied((message) => {
    showToast(message, 'error')
  })

  const [showCreateModal, setShowCreateModal] = useState(false)

  // silent=true refreshes in the background (no spinner, keeps current rows on
  // error) so polling can surface new unread-reply dots without flicker.
  const fetchTasks = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const params: Record<string, string | number | boolean> = {}
      if (isAdmin && filterUserId) params.assigned_to_user_id = filterUserId
      if (includeArchived) params.include_archived = true
      const { data } = await api.get<Task[]>('/tasks/', { params })
      setTasks(data)
    } catch {
      if (!silent) setTasks([])
    } finally {
      if (!silent) setLoading(false)
    }
  }, [isAdmin, filterUserId, includeArchived])

  const fetchLabels = useCallback(async () => {
    try {
      const { data } = await api.get<TaskLabelType[]>('/tasks/labels')
      setLabels(data)
    } catch {
      setLabels([])
    }
  }, [])

  const fetchUsers = useCallback(async () => {
    try {
      const { data } = await api.get<UserForTask[]>('/users/for-tasks')
      setUsers(data)
    } catch {
      setUsers([])
    }
  }, [])

  useEffect(() => { fetchTasks() }, [fetchTasks])
  useEffect(() => { fetchLabels() }, [fetchLabels])
  // Users feed both the admin filter and the edit modal (assignees may edit too).
  useEffect(() => { fetchUsers() }, [fetchUsers])

  // True while a drag or status/label update is mid-flight — the background
  // poll must skip these moments so it can't clobber optimistic board state.
  const boardBusyRef = useRef(false)
  boardBusyRef.current = draggedTask !== null || draggedOverKey !== null || updatingId !== null

  // Poll in the background so a new reply's unread dot appears without a manual
  // reload; also refresh when the tab regains focus. Skipped while dragging.
  useEffect(() => {
    const maybeRefresh = () => {
      if (!document.hidden && !boardBusyRef.current) fetchTasks(true)
    }
    const interval = setInterval(maybeRefresh, 30_000)
    document.addEventListener('visibilitychange', maybeRefresh)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', maybeRefresh)
    }
  }, [fetchTasks])

  // ── Status drag-drop ───────────────────────────────────────────────────────

  const updateTaskStatus = async (taskId: number, prevStatus: TaskStatus, newStatus: TaskStatus) => {
    setUpdatingId(taskId)
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t)))
    try {
      await api.put(`/tasks/${taskId}`, { status: newStatus })
    } catch (err: any) {
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: prevStatus } : t)))
      showToast(err?.response?.data?.detail ?? 'שגיאה בעדכון סטטוס המשימה', 'error')
    } finally {
      setUpdatingId(null)
    }
  }

  // ── Label drag-drop ────────────────────────────────────────────────────────

  const updateTaskLabel = async (taskId: number, prevLabels: TaskLabelType[], targetLabelId: number | null) => {
    setUpdatingId(taskId)
    const nextLabels =
      targetLabelId === null
        ? []
        : labels.filter((l) => l.id === targetLabelId)
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, labels: nextLabels } : t))
    )
    try {
      const label_ids = targetLabelId === null ? [] : [targetLabelId]
      await api.put(`/tasks/${taskId}`, { label_ids })
    } catch (err: any) {
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, labels: prevLabels } : t))
      )
      showToast(err?.response?.data?.detail ?? 'שגיאה בעדכון תוויות המשימה', 'error')
    } finally {
      setUpdatingId(null)
    }
  }

  // ── Shared drag handlers ───────────────────────────────────────────────────

  const handleDragStart = (e: React.DragEvent, task: Task) => {
    didDragRef.current = true
    draggedTaskRef.current = task
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(task.id))
    // Delay the state update so the browser captures the ghost image from the
    // original DOM before React re-renders (which would overlay a transparent div
    // over the task card and produce an invisible ghost image).
    dragStartFrameRef.current = requestAnimationFrame(() => setDraggedTask(task))
  }

  const handleDragEnd = () => {
    cancelAnimationFrame(dragStartFrameRef.current)
    if (didDragRef.current) justDraggedRef.current = true
    didDragRef.current = false
    // NOTE: Do NOT clear draggedTaskRef here. In containers with overflow
    // (e.g. the label board's overflow-x-auto), some browsers fire dragend
    // before drop. The drop handlers (handleDropStatus / handleDropLabel)
    // are responsible for reading and clearing the ref themselves.
    setDraggedTask(null)
    setDraggedOverKey(null)
  }

  const handleDragOver = (e: React.DragEvent, key: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDraggedOverKey(key)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDraggedOverKey(null)
  }

  const resolveDraggedTask = (e: React.DragEvent): Task | null => {
    if (draggedTaskRef.current) return draggedTaskRef.current
    const raw = e.dataTransfer.getData('text/plain')
    const id = Number(raw)
    if (!Number.isFinite(id)) return null
    return tasks.find((t) => t.id === id) ?? null
  }

  const handleDropStatus = (e: React.DragEvent, targetStatus: TaskStatus) => {
    e.preventDefault()
    setDraggedOverKey(null)
    const task = resolveDraggedTask(e)
    draggedTaskRef.current = null
    setDraggedTask(null)
    const currentStatus = (task?.status || 'pending') as TaskStatus
    if (task && currentStatus !== targetStatus) {
      updateTaskStatus(task.id, currentStatus, targetStatus)
    }
  }

  const handleDropLabel = (e: React.DragEvent, targetLabelId: number | null) => {
    e.preventDefault()
    setDraggedOverKey(null)
    const task = resolveDraggedTask(e)
    draggedTaskRef.current = null
    setDraggedTask(null)
    if (!task) return
    const prevLabels = task.labels ? [...task.labels] : []
    const currentPrimary = task.labels?.[0]?.id ?? null
    if (currentPrimary !== targetLabelId) {
      updateTaskLabel(task.id, prevLabels, targetLabelId)
    }
  }

  // ── Grouping helpers ───────────────────────────────────────────────────────

  const tasksByStatus = STATUS_ORDER.reduce(
    (acc, status) => {
      acc[status] = tasks.filter((t) => (t.status || 'pending') === status)
      return acc
    },
    {} as Record<TaskStatus, Task[]>
  )

  const labelColumns: Array<{ id: number | null; name: string; color: string }> = [
    ...labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    { id: null, name: 'ללא תווית', color: '#9CA3AF' },
  ]

  const tasksByLabel = labelColumns.reduce(
    (acc, col) => {
      acc[col.id ?? UNLABELED_ID] =
        col.id === null
          ? tasks.filter((t) => !t.labels || t.labels.length === 0)
          : tasks.filter((t) => t.labels?.some((l) => l.id === col.id))
      return acc
    },
    {} as Record<number, Task[]>
  )

  // ── Task card ──────────────────────────────────────────────────────────────

  const renderCard = (task: Task) => {
    const color =
      task.assigned_user_color ??
      USER_COLORS[(task.assigned_to_user_id - 1) % USER_COLORS.length]
    const avatarSrc = avatarUrl(task.assigned_user_avatar)
    const isDragging = draggedTask?.id === task.id
    const isUpdating = updatingId === task.id

    return (
      <div
        key={task.id}
        draggable
        onDragStart={(e) => handleDragStart(e, task)}
        onDragEnd={handleDragEnd}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => {
          if (justDraggedRef.current) { justDraggedRef.current = false; return }
          // Opening the task reads its chat → clear the red unread dot immediately
          // (the server also marks it read via GET /tasks/{id}).
          if (task.has_unread_messages) {
            setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, has_unread_messages: false } : t)))
          }
          setSelectedTask(task)
          setSelectedTaskId(task.id)
        }}
        className={cn(
          'group flex items-start gap-2 p-3 rounded-xl border shadow-sm',
          task.is_archived
            ? 'bg-amber-50/60 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800/40 cursor-default opacity-75'
            : 'bg-white dark:bg-gray-800 cursor-grab active:cursor-grabbing hover:ring-2 hover:ring-blue-400/50',
          'transition-shadow select-none',
          isDragging && 'opacity-50 shadow-lg',
          isUpdating && 'opacity-70',
        )}
      >
        <GripVertical className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <UnreadMessagesDot show={task.has_unread_messages} count={task.unread_messages_count} />
            <p className="font-medium text-gray-900 dark:text-white truncate">{task.title}</p>
            {task.is_archived && (
              <span className="flex-shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-200 dark:bg-amber-800/50 text-amber-800 dark:text-amber-300">
                <Archive className="w-2.5 h-2.5" />
                ארכיון
              </span>
            )}
          </div>
          {/* labels pills */}
          {(task.labels?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {task.labels!.map((l) => (
                <span
                  key={l.id}
                  className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium text-white"
                  style={{ backgroundColor: l.color }}
                >
                  {l.name}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 mt-1.5">
            {avatarSrc ? (
              <img src={avatarSrc} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
            ) : (
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                style={{ backgroundColor: color }}
              >
                {(task.assigned_user_name || '?').charAt(0)}
              </div>
            )}
            <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {task.assigned_user_name || 'לא הוגדר'}
            </span>
            {(task.assignees?.length ?? 0) > 1 && (
              <span
                className="text-xs px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 flex-shrink-0"
                title={task.assignees!.map((a) => a.full_name).join(', ')}
              >
                +{task.assignees!.length - 1}
              </span>
            )}
          </div>
          {(task.start_time || task.end_time) && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {formatDate(task.end_time ?? task.start_time)}
            </p>
          )}
        </div>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <RefreshCw className="w-8 h-8 text-gray-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <ToastNotification toast={toast} onClose={hideToast} />
      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Group-by toggle */}
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-xl p-1">
          <button
            type="button"
            onClick={() => setGroupBy('status')}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all',
              groupBy === 'status'
                ? 'bg-white dark:bg-gray-800 text-violet-700 dark:text-violet-300 shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            )}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            סטטוס
          </button>
          <button
            type="button"
            onClick={() => setGroupBy('label')}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all',
              groupBy === 'label'
                ? 'bg-white dark:bg-gray-800 text-violet-700 dark:text-violet-300 shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            )}
          >
            <Tag className="w-3.5 h-3.5" />
            תוויות
          </button>
        </div>

        {/* User filter (admin only) */}
        {isAdmin && users.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">סינון:</label>
            <select
              value={filterUserId ?? ''}
              onChange={(e) => setFilterUserId(e.target.value ? Number(e.target.value) : null)}
              className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-2 text-sm"
            >
              <option value="">הכל</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Archive toggle */}
        <button
          type="button"
          onClick={() => setIncludeArchived((v) => !v)}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium border transition-all',
            includeArchived
              ? 'bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300'
              : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-amber-300 hover:text-amber-700 dark:hover:text-amber-400'
          )}
        >
          <Archive className="w-3.5 h-3.5" />
          {includeArchived ? 'מוסתר ארכיון' : 'הצג ארכיון'}
        </button>

        {/* Add Task button */}
        <button
          type="button"
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl font-medium shadow-md hover:shadow-lg transition-all duration-200 text-sm ml-auto"
        >
          <Plus className="w-4 h-4" />
          משימה חדשה
        </button>
      </div>

      {/* ── Status board ────────────────────────────────────────────────────── */}
      {groupBy === 'status' && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {STATUS_ORDER.map((status) => (
            <div
              key={status}
              className={cn(
                'rounded-2xl border-2 border-dashed p-4 min-h-[300px] transition-colors',
                draggedOverKey === status
                  ? 'border-violet-500 bg-violet-50/50 dark:bg-violet-900/20'
                  : 'border-gray-200 dark:border-gray-700 bg-white/60 dark:bg-gray-800/60'
              )}
              onDragOver={(e) => handleDragOver(e, status)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDropStatus(e, status)}
            >
              <div
                className="flex items-center gap-2 mb-3 pb-2 border-b border-gray-200 dark:border-gray-600"
                style={{ borderLeftColor: TASK_STATUS_COLORS[status], borderLeftWidth: 4 }}
              >
                <h3 className="font-semibold text-gray-900 dark:text-white">
                  {TASK_STATUS_LABELS[status]}
                </h3>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  ({tasksByStatus[status].length})
                </span>
              </div>
              <div className="space-y-2">
                {tasksByStatus[status].map((task) => renderCard(task))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Label board ─────────────────────────────────────────────────────── */}
      {groupBy === 'label' && (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {labelColumns.map((col) => {
            const colKey = `label-${col.id ?? 'none'}`
            const colTasks = tasksByLabel[col.id ?? UNLABELED_ID] ?? []
            return (
              <div
                key={colKey}
                className={cn(
                  'rounded-2xl border-2 border-dashed p-4 min-h-[300px] min-w-[240px] w-64 flex-shrink-0 transition-colors',
                  draggedOverKey === colKey
                    ? 'border-violet-500 bg-violet-50/50 dark:bg-violet-900/20'
                    : 'border-gray-200 dark:border-gray-700 bg-white/60 dark:bg-gray-800/60'
                )}
                onDragOver={(e) => handleDragOver(e, colKey)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDropLabel(e, col.id)}
              >
                <div className="flex items-center gap-2 mb-3 pb-2 border-b border-gray-200 dark:border-gray-600">
                  <span
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: col.color }}
                  />
                  <h3 className="font-semibold text-gray-900 dark:text-white truncate">
                    {col.name}
                  </h3>
                  <span className="text-sm text-gray-500 dark:text-gray-400 ml-auto flex-shrink-0">
                    ({colTasks.length})
                  </span>
                </div>
                <div className="space-y-2">
                  {colTasks.map((task) => renderCard(task))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <TaskDetailModal
        taskId={selectedTaskId}
        initialTask={selectedTask ?? undefined}
        onClose={() => { setSelectedTaskId(null); setSelectedTask(null) }}
        onTaskUpdated={(updated) => {
          setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
          if (selectedTask?.id === updated.id) setSelectedTask(updated)
        }}
        onTaskDeleted={() => {
          if (selectedTaskId) setTasks((prev) => prev.filter((t) => t.id !== selectedTaskId))
          setSelectedTaskId(null)
          setSelectedTask(null)
        }}
        onTaskArchived={() => {
          if (selectedTaskId) setTasks((prev) => prev.filter((t) => t.id !== selectedTaskId))
          setSelectedTaskId(null)
          setSelectedTask(null)
        }}
        onEdit={(task) => setEditingTask(task)}
      />

      {/* Edit modal — TaskDetailModal only shows its edit button when given onEdit. */}
      <TaskEditModal
        task={editingTask}
        isOpen={!!editingTask}
        onClose={() => setEditingTask(null)}
        users={users}
        taskLabels={labels}
        onSaved={() => { void fetchTasks(true) }}
        onLabelsChanged={fetchLabels}
      />

      <CreateEventModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        initialEventType="task"
        onCreated={fetchTasks}
      />
    </div>
  )
}
