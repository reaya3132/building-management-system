import { useEffect, useState, useCallback } from 'react'
import { RefreshCw, User, Plus, ListTodo } from 'lucide-react'
import { cn } from '../../lib/utils'
import api, { avatarUrl, getBacklogTasks } from '../../lib/api'
import type { Task, TaskStatus, UserForTask, TaskLabelType } from '../../pages/TaskCalendar'
import TaskDetailModal from './TaskDetailModal'
import CreateTaskModal from './CreateTaskModal'
import TaskEditModal from './TaskEditModal'

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

interface BacklogTabProps {
  /** Bump this number to force a backlog refetch from the parent. */
  refreshSignal?: number
}

/**
 * Full-page Backlog tab. Lists all backlog tasks and lets the user create a new
 * backlog task inline via the shared CreateTaskModal (defaultBacklog), without
 * navigating to the calendar. Styled consistently with TaskList.
 */
export default function BacklogTab({ refreshSignal }: BacklogTabProps) {
  const [backlogTasks, setBacklogTasks] = useState<Task[]>([])
  const [users, setUsers] = useState<UserForTask[]>([])
  const [taskLabels, setTaskLabels] = useState<TaskLabelType[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  // The task being edited via the shared TaskEditModal (opened from the detail modal).
  const [editingTask, setEditingTask] = useState<Task | null>(null)

  // silent=true refreshes in the background: no spinner, and
  // it keeps the current rows on a transient failure instead of clearing them.
  const fetchBacklogTasks = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const tasks = await getBacklogTasks()
      setBacklogTasks(tasks)
    } catch {
      if (!silent) setBacklogTasks([])
    } finally {
      if (!silent) setLoading(false)
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

  const fetchLabels = useCallback(async () => {
    try {
      const { data } = await api.get<TaskLabelType[]>('/tasks/labels')
      setTaskLabels(data)
    } catch {
      setTaskLabels([])
    }
  }, [])

  useEffect(() => {
    fetchBacklogTasks()
    fetchUsers()
    fetchLabels()
  }, [fetchBacklogTasks, fetchUsers, fetchLabels])

  // Refetch when the parent signals a change.
  useEffect(() => {
    if (refreshSignal !== undefined) fetchBacklogTasks()
  }, [refreshSignal, fetchBacklogTasks])

  // Refresh in the background so other users' changes show up without a manual
  // reload; also refresh the moment the tab regains focus.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) void fetchBacklogTasks(true)
    }, 30_000)
    const onVisible = () => { if (!document.hidden) void fetchBacklogTasks(true) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [fetchBacklogTasks])

  const handleTaskUpdated = useCallback((updated: Task) => {
    setBacklogTasks((prev) => {
      if (updated.status === 'completed' || updated.is_backlog === false) {
        return prev.filter((task) => task.id !== updated.id)
      }
      return prev.map((task) => (task.id === updated.id ? updated : task))
    })
  }, [])

  const removeSelected = useCallback(() => {
    setBacklogTasks((prev) => prev.filter((task) => task.id !== selectedTaskId))
    setSelectedTaskId(null)
    setSelectedTask(null)
  }, [selectedTaskId])

  const openTask = (task: Task) => {
    setSelectedTask(task)
    setSelectedTaskId(task.id)
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16" dir="rtl">
        <RefreshCw className="w-8 h-8 text-gray-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-4" dir="rtl">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <ListTodo className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">Backlog</h2>
          <span className="text-xs font-bold rounded-full px-2 py-0.5 min-w-[20px] text-center bg-indigo-600 text-white">
            {backlogTasks.length}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl font-medium shadow-md hover:shadow-lg transition-all duration-200 text-sm ml-auto"
        >
          <Plus className="w-4 h-4" />
          משימה חדשה ל-Backlog
        </button>
      </div>

      {/* List */}
      <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden shadow-sm">
        {backlogTasks.length === 0 ? (
          <div className="py-12 text-center text-gray-500 dark:text-gray-400">
            אין משימות ב-Backlog
          </div>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-700/50">
            {backlogTasks.map((task) => {
              const status = (task.status || 'pending') as TaskStatus
              const avatarSrc = avatarUrl(task.assigned_user_avatar)
              return (
                <li key={task.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openTask(task)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openTask(task)
                      }
                    }}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors cursor-pointer"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-medium text-gray-900 dark:text-white truncate">
                          {task.title}
                        </span>
                      </span>
                      {task.description && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-1">
                          {task.description}
                        </p>
                      )}
                    </div>

                    <span
                      className={cn(
                        'inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium shrink-0',
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
                          status === 'pending' ? `${TASK_STATUS_COLORS[status]}20` : undefined,
                        color: status === 'pending' ? TASK_STATUS_COLORS[status] : undefined,
                      }}
                    >
                      {TASK_STATUS_LABELS[status]}
                    </span>

                    <div className="flex items-center gap-2 shrink-0">
                      {avatarSrc ? (
                        <img src={avatarSrc} alt="" className="w-6 h-6 rounded-full object-cover" />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-gray-200 dark:bg-gray-600 flex items-center justify-center">
                          <User className="w-3 h-3 text-gray-500 dark:text-gray-400" />
                        </div>
                      )}
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        {task.assigned_user_name || 'לא הוגדר'}
                      </span>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Task detail modal */}
      <TaskDetailModal
        taskId={selectedTaskId}
        initialTask={selectedTask ?? undefined}
        onClose={() => { setSelectedTaskId(null); setSelectedTask(null) }}
        onTaskUpdated={(updated) => {
          handleTaskUpdated(updated)
          setSelectedTask(updated)
        }}
        onTaskDeleted={removeSelected}
        onTaskArchived={removeSelected}
        onEdit={(task) => setEditingTask(task)}
      />

      {/* Edit modal — TaskDetailModal only shows its edit button when given onEdit. */}
      <TaskEditModal
        task={editingTask}
        isOpen={!!editingTask}
        onClose={() => setEditingTask(null)}
        users={users}
        taskLabels={taskLabels}
        onSaved={(updated) => {
          void fetchBacklogTasks()
          // Keep an open detail view in sync (e.g. a changed assignee set).
          if (updated && selectedTask?.id === updated.id) setSelectedTask(updated)
        }}
        onLabelsChanged={fetchLabels}
      />

      {/* Create backlog task modal */}
      <CreateTaskModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        users={users}
        taskLabels={taskLabels}
        defaultBacklog
        onCreated={() => {
          fetchBacklogTasks()
          setShowCreateModal(false)
        }}
        onLabelsChanged={fetchLabels}
      />
    </div>
  )
}
