import { useEffect, useState, useCallback } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '../../store'
import api from '../../lib/api'
import { avatarUrl } from '../../lib/api'
import { RefreshCw, User, Plus, Search, MessageCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { formatTaskCode } from '../../lib/taskCode'
import type { Task, TaskStatus, UserForTask, TaskLabelType } from '../../pages/TaskCalendar'
import TaskDetailModal from './TaskDetailModal'
import CreateEventModal from './CreateEventModal'
import TaskEditModal from './TaskEditModal'
import UnreadMessagesDot from './UnreadMessagesDot'

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

function formatDate(s: string | null): string {
  if (!s) return '—'
  try {
    const d = new Date(s)
    return d.toLocaleDateString('he-IL', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return s
  }
}

export default function TaskList() {
  const me = useSelector((state: RootState) => state.auth.me)
  const isAdmin = me?.role === 'Admin'
  const [tasks, setTasks] = useState<Task[]>([])
  const [users, setUsers] = useState<UserForTask[]>([])
  const [taskLabels, setTaskLabels] = useState<TaskLabelType[]>([])
  const [loading, setLoading] = useState(true)
  const [filterUserId, setFilterUserId] = useState<number | null>(null)
  const [statusFilter, setStatusFilter] = useState<TaskStatus | ''>('')
  const [searchQuery, setSearchQuery] = useState<string>('')
  // When on, show only tasks that have an unread chat message, so the user does
  // not have to scroll the list hunting for the red dots.
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  // The task being edited via the shared TaskEditModal (opened from the detail modal).
  const [editingTask, setEditingTask] = useState<Task | null>(null)

  // -- Create modal --
  const [showCreateModal, setShowCreateModal] = useState(false)

  // silent=true refreshes in the background (no spinner, keeps current rows on
  // error) so polling can surface new unread-reply dots without flicker.
  const fetchTasks = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const params: Record<string, string | number> = {}
      if (isAdmin && filterUserId) params.assigned_to_user_id = filterUserId
      const { data } = await api.get<Task[]>('/tasks/', { params })
      setTasks(data)
    } catch {
      if (!silent) setTasks([])
    } finally {
      if (!silent) setLoading(false)
    }
  }, [isAdmin, filterUserId])

  const fetchUsers = useCallback(async () => {
    try {
      const { data } = await api.get<UserForTask[]>('/users/for-tasks')
      setUsers(data)
    } catch {
      setUsers([])
    }
  }, [])

  const fetchLabels = useCallback(async () => {
    try {
      const { data } = await api.get<TaskLabelType[]>('/tasks/labels')
      setTaskLabels(data)
    } catch {
      setTaskLabels([])
    }
  }, [])

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  // Poll in the background so a new reply's unread dot appears without a manual
  // reload; also refresh the moment the tab regains focus.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) fetchTasks(true)
    }, 30_000)
    const onVisible = () => { if (!document.hidden) fetchTasks(true) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [fetchTasks])

  // Users and labels feed both the admin filter and the edit modal (assignees may edit too).
  useEffect(() => {
    fetchUsers()
    fetchLabels()
  }, [fetchUsers, fetchLabels])

  const normalizedQuery = searchQuery.trim().toLowerCase()

  const matchesSearch = (task: Task): boolean => {
    if (!normalizedQuery) return true
    const searchableFields = [
      task.title,
      task.description,
      task.assigned_user_name,
    ]
    return searchableFields.some((field) =>
      (field ?? '').toLowerCase().includes(normalizedQuery)
    )
  }

  const unreadTaskCount = tasks.filter((t) => t.has_unread_messages).length

  const filteredTasks = tasks.filter((t) => {
    const status = (t.status || 'pending') as TaskStatus
    if (statusFilter && status !== statusFilter) return false
    if (unreadOnly && !t.has_unread_messages) return false
    if (!matchesSearch(t)) return false
    return true
  })

  // Opening a task reads its chat → clear the red unread dot immediately (the
  // server also marks it read via GET /tasks/{id}).
  const openTask = (task: Task) => {
    if (task.has_unread_messages) {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, has_unread_messages: false } : t)))
    }
    setSelectedTask(task)
    setSelectedTaskId(task.id)
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <RefreshCw className="w-8 h-8 text-gray-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="חיפוש משימה..."
            className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white pr-9 pl-3 py-2 text-sm"
          />
        </div>
        {isAdmin && users.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              משתמש:
            </label>
            <select
              value={filterUserId ?? ''}
              onChange={(e) =>
                setFilterUserId(e.target.value ? Number(e.target.value) : null)
              }
              className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-2 text-sm"
            >
              <option value="">הכל</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            סטטוס:
          </label>
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as TaskStatus | '')
            }
            className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-2 text-sm"
          >
            <option value="">הכל</option>
            {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        {/* Unread-messages filter toggle */}
        <button
          type="button"
          onClick={() => setUnreadOnly((v) => !v)}
          aria-pressed={unreadOnly}
          title="הצג רק משימות עם הודעה שלא נקראה"
          className={cn(
            'inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors',
            unreadOnly
              ? 'bg-red-600 border-red-600 text-white shadow-md'
              : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
          )}
        >
          <MessageCircle className="w-4 h-4" />
          הודעות שלא נקראו
          {unreadTaskCount > 0 && (
            <span
              className={cn(
                'inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs font-bold',
                unreadOnly ? 'bg-white/25 text-white' : 'bg-red-600 text-white'
              )}
            >
              {unreadTaskCount}
            </span>
          )}
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

      <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">
                  מזהה
                </th>
                <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">
                  משימה
                </th>
                <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">
                  סטטוס
                </th>
                <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">
                  מוקצה
                </th>
                <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">
                  תאריך
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredTasks.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="py-12 text-center text-gray-500 dark:text-gray-400"
                  >
                    אין משימות להצגה
                  </td>
                </tr>
              ) : (
                filteredTasks.map((task) => {
                  const status = (task.status || 'pending') as TaskStatus
                  const avatarSrc = avatarUrl(task.assigned_user_avatar)
                  return (
                    <tr
                      key={task.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openTask(task)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTask(task) } }}
                      className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors cursor-pointer"
                    >
                      <td className="py-3 px-4">
                        <span className="font-mono text-sm text-gray-600 dark:text-gray-400">
                          {formatTaskCode(task.id)}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="inline-flex items-center gap-1.5">
                          <UnreadMessagesDot show={task.has_unread_messages} count={task.unread_messages_count} />
                          <span className="font-medium text-gray-900 dark:text-white">
                            {task.title}
                          </span>
                        </span>
                        {task.description && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-1">
                            {task.description}
                          </p>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={cn(
                            'inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium',
                            status === 'completed'
                              ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200'
                              : status === 'in_progress'
                              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200'
                              : status === 'pending_closure'
                              ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200'
                              : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                          )}
                          style={{
                            backgroundColor:
                              status === 'pending'
                                ? `${TASK_STATUS_COLORS[status]}20`
                                : undefined,
                            color:
                              status === 'pending'
                                ? TASK_STATUS_COLORS[status]
                                : undefined,
                          }}
                        >
                          {TASK_STATUS_LABELS[status]}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          {avatarSrc ? (
                            <img
                              src={avatarSrc}
                              alt=""
                              className="w-6 h-6 rounded-full object-cover"
                            />
                          ) : (
                            <div className="w-6 h-6 rounded-full bg-gray-200 dark:bg-gray-600 flex items-center justify-center">
                              <User className="w-3 h-3 text-gray-500 dark:text-gray-400" />
                            </div>
                          )}
                          <span className="text-sm text-gray-700 dark:text-gray-300">
                            {task.assigned_user_name || 'לא הוגדר'}
                          </span>
                          {(task.assignees?.length ?? 0) > 1 && (
                            <span
                              className="text-xs px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                              title={task.assignees!.map((a) => a.full_name).join(', ')}
                            >
                              +{task.assignees!.length - 1}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-600 dark:text-gray-400">
                        {formatDate(task.end_time ?? task.start_time)}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

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
        taskLabels={taskLabels}
        onSaved={() => { void fetchTasks(true) }}
        onLabelsChanged={fetchLabels}
      />

      <CreateEventModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        initialEventType="task"
        onCreated={() => {
          fetchTasks()
          setShowCreateModal(false)
        }}
      />
    </div>
  )
}
