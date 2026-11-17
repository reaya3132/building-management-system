import { useState, useEffect } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ClipboardList, Calendar, ListTodo, LayoutGrid, Archive } from 'lucide-react'
import { cn } from '../lib/utils'
import TaskBoard from '../components/task-management/TaskBoard'
import TaskCalendar from './TaskCalendar'
import TaskList from '../components/task-management/TaskList'
import ArchivedTasksList from '../components/task-management/ArchivedTasksList'
import SuperTasksPanel from '../components/task-management/SuperTasksPanel'
import BacklogTab from '../components/task-management/BacklogTab'

type TabId = 'board' | 'calendar' | 'tasks' | 'backlog' | 'archive'

const TABS: { id: TabId; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'board', label: 'לוח', icon: LayoutGrid },
  { id: 'calendar', label: 'יומן', icon: Calendar },
  { id: 'tasks', label: 'משימות', icon: ListTodo },
  { id: 'backlog', label: 'Backlog', icon: ListTodo },
  { id: 'archive', label: 'ארכיון', icon: Archive },
]

export default function TaskManagement() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') as TabId | null
  const [activeTab, setActiveTab] = useState<TabId>(
    () => (tabParam && TABS.some((t) => t.id === tabParam) ? tabParam : 'board')
  )
  useEffect(() => {
    if (tabParam && TABS.some((t) => t.id === tabParam)) {
      setActiveTab(tabParam)
    }
  }, [tabParam])

  // The messages tab became the notification center: old links land there.
  if ((tabParam as string | null) === 'messages') return <Navigate to="/notifications" replace />

  return (
    <div className="task-management-page min-h-screen bg-[#f0f4f8] dark:bg-[#0f1419]" dir="rtl">
      <div className="max-w-[1680px] mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {/* Header */}
        <header className="flex items-center gap-4">
          <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/25 dark:shadow-violet-600/20">
            <ClipboardList className="w-7 h-7" strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white tracking-tight">
              ניהול משימות
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              לוח, יומן ומשימות במקום אחד
            </p>
          </div>
        </header>

        {/* Tabs + Super Tasks Panel in one row */}
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 dark:border-gray-700 pb-2">
          {TABS.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id)
                  setSearchParams({ tab: tab.id }, { replace: true })
                }}
                className={cn(
                  'inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium transition-all duration-200',
                  activeTab === tab.id
                    ? 'bg-violet-600 text-white shadow-md'
                    : 'bg-white/80 dark:bg-gray-800/80 text-gray-700 dark:text-gray-300 hover:bg-violet-50 dark:hover:bg-violet-900/20 hover:text-violet-700 dark:hover:text-violet-300'
                )}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            )
          })}
          <SuperTasksPanel />
        </div>

        {/* Tab Content */}
        <div className="min-h-[400px]">
          <AnimatePresence mode="wait">
            {activeTab === 'board' && (
              <motion.div
                key="board"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <TaskBoard />
              </motion.div>
            )}
            {activeTab === 'calendar' && (
              <motion.div
                key="calendar"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <TaskCalendar embedded />
              </motion.div>
            )}
            {activeTab === 'tasks' && (
              <motion.div
                key="tasks"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <TaskList />
              </motion.div>
            )}
            {activeTab === 'backlog' && (
              <motion.div
                key="backlog"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <BacklogTab />
              </motion.div>
            )}
            {activeTab === 'archive' && (
              <motion.div
                key="archive"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <ArchivedTasksList />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
