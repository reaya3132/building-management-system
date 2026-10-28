import React, { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Link, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  FolderOpen,
  BarChart3,
  Users,
  Settings,
  Menu,
  X,
  ChevronLeft,
  ChevronRight,
  Home,
  FileText,
  Building2,
  UserCog,
  Activity,
  Receipt,
  ClipboardList,
  Bell,
  BookOpen,
  Package,
  SlidersHorizontal,
  Wallet
} from 'lucide-react'
import { useTheme } from '../../contexts/ThemeContext'
import { useInventorySettings } from '../../contexts/InventorySettingsContext'
import { cn } from '../../lib/utils'
import api from '../../lib/api'
import { useSelector, useDispatch } from 'react-redux'
import type { RootState, AppDispatch } from '../../store'
import { fetchUnreadCount } from '../../store/slices/notificationsSlice'
import type { Permission } from '../../store/slices/permissionsSlice'
import { Logo } from './Logo'

interface NavigationItem {
  name: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  description: string
  adminOnly?: boolean
  permission?: { resource: string }
  settingsHref?: string
  onSettingsClick?: () => void
}

interface SidebarProps {
  isCollapsed: boolean
  onToggle: () => void
}

const ALL_NAVIGATION_ITEMS: NavigationItem[] = [
  {
    name: 'לוח בקרה',
    href: '/dashboard',
    icon: LayoutDashboard,
    description: 'סקירה כללית של הפרויקטים',
    permission: { resource: 'dashboard' }
  },
  {
    name: 'פרויקטים',
    href: '/projects',
    icon: FolderOpen,
    description: 'ניהול פרויקטים ותת-פרויקטים',
    permission: { resource: 'project' },
    settingsHref: '/projects/settings'
  },
  {
    name: 'דוחות',
    href: '/reports',
    icon: BarChart3,
    description: 'דוחות פיננסיים ומעקב',
    permission: { resource: 'report' }
  },
  {
    name: 'הצעות מחיר',
    href: '/price-quotes',
    icon: Receipt,
    description: 'בניית הצעות מחיר והמרה לפרויקטים',
    permission: { resource: 'quote' },
    settingsHref: '/price-quotes/settings'
  },
  {
    name: 'ניהול משימות',
    href: '/task-management',
    icon: ClipboardList,
    description: 'לוח, יומן, משימות והודעות',
    permission: { resource: 'task' }
  },
  {
    name: 'גבייה',
    href: '/collection-tasks',
    icon: Wallet,
    description: 'משימות גבייה לפי חודש חיוב',
    permission: { resource: 'collection_task' }
  },
  {
    name: 'דלפק הבניין',
    href: '/building-reception',
    icon: Building2,
    description: 'בניינים, דירות, מפתחות ומשלוחים',
    permission: { resource: 'building_reception' }
  },
  {
    name: 'ניהול מלאי',
    href: '/inventory',
    icon: Package,
    description: 'ציוד, מחסנים ומלאי',
  },
  {
    name: 'היסטורית פעילות',
    href: '/audit-logs',
    icon: Activity,
    description: 'מעקב אחר כל הפעולות במערכת',
    permission: { resource: 'audit_log' }
  },
  {
    name: 'ניהול מנהלים',
    href: '/admin-management',
    icon: UserCog,
    description: 'ניהול מנהלי מערכת נוספים',
    adminOnly: true
  },
  {
    name: 'ניהול משתמשים',
    href: '/users',
    icon: UserCog,
    description: 'ניהול משתמשי המערכת והרשאות',
    adminOnly: true
  },
  {
    name: 'הגדרות',
    href: '/settings',
    icon: Settings,
    description: 'אזור אישי, הגדרות מערכת ומשתמש'
  }
]

function filterNavigationItems(
  items: NavigationItem[],
  userRole: string | undefined,
  permissions: Permission[]
): NavigationItem[] {
  const isAdmin = userRole === 'Admin'

  return items.filter((item) => {
    if (item.adminOnly) return isAdmin
    if (!item.permission) return true
    if (isAdmin) return true

    const { resource } = item.permission
    return permissions.some(p => p.resource_type === resource)
  })
}

/**
 * Total unread task-chat messages for the current user, polled in the background
 * (~30s) and refreshed on tab focus. Drives the red badge on the "ניהול משימות"
 * nav item so a new message is visible from anywhere in the app.
 */
function useTaskUnreadTotal(): number {
  const me = useSelector((state: RootState) => state.auth.me)
  const [total, setTotal] = useState(0)
  useEffect(() => {
    if (!me) {
      setTotal(0)
      return
    }
    let active = true
    const load = async () => {
      try {
        const { data } = await api.get<{ total_unread: number }>('/tasks/unread-summary')
        if (active) setTotal(data.total_unread ?? 0)
      } catch {
        /* ignore transient failures */
      }
    }
    void load()
    const interval = setInterval(() => { if (!document.hidden) void load() }, 30_000)
    const onVisible = () => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [me])
  return total
}

export function Sidebar({ isCollapsed, onToggle }: SidebarProps) {
  const location = useLocation()
  const dispatch = useDispatch<AppDispatch>()
  const { theme, toggleTheme } = useTheme()
  const me = useSelector((state: RootState) => state.auth.me)
  const taskUnread = useTaskUnreadTotal()
  const permissions = useSelector((state: RootState) => state.permissions.permissions)
  const { open: openInventorySettings } = useInventorySettings()
  const navigationItems = filterNavigationItems(ALL_NAVIGATION_ITEMS, me?.role, permissions)
    .map(item => item.href === '/inventory' ? { ...item, onSettingsClick: openInventorySettings } : item)

  useEffect(() => {
    if (me) dispatch(fetchUnreadCount())
  }, [dispatch, me])

  return (
    <motion.aside
      initial={false}
      animate={{ width: isCollapsed ? 80 : 280 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className="fixed right-0 top-0 h-screen bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 flex flex-col z-30"
    >
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <AnimatePresence>
            {!isCollapsed ? (
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
                className="flex items-center gap-2"
              >
                <Logo size="lg" showText={true} />
                <a
                  href="/guide"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="פתח מדריך למשתמש"
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-xs font-semibold hover:bg-blue-200 dark:hover:bg-blue-800/60 transition-colors whitespace-nowrap"
                >
                  <BookOpen className="w-3 h-3" />
                  מדריך
                </a>
              </motion.div>
            ) : (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="flex flex-col items-center gap-1"
              >
                <Logo size="lg" showText={false} collapsed={true} />
                <a
                  href="/guide"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="פתח מדריך למשתמש"
                  className="w-7 h-7 flex items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-800/60 transition-colors"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                </a>
              </motion.div>
            )}
          </AnimatePresence>

          <button
            onClick={onToggle}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            {isCollapsed ? (
              <ChevronLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            ) : (
              <ChevronRight className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            )}
          </button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
        {navigationItems.map((item) => {
          const isActive = location.pathname === item.href || (item.href !== '/' && location.pathname.startsWith(item.href + '/'))
          const Icon = item.icon

          const settingsActive = item.settingsHref ? location.pathname.startsWith(item.settingsHref) : false

          return (
            <div key={item.name} className="relative group/nav">
              <Link
                to={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200",
                  isActive
                    ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
                    : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800",
                  !isCollapsed && (item.settingsHref || item.onSettingsClick) ? "pr-3 pl-8" : ""
                )}
              >
                <span className="relative flex-shrink-0">
                  <Icon className={cn(
                    "w-5 h-5",
                    isActive ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"
                  )} />
                  {item.href === '/task-management' && taskUnread > 0 && (
                    <span className="absolute -top-1 -left-1 min-w-[1.25rem] h-5 px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-xs font-medium">
                      {taskUnread > 99 ? '99+' : taskUnread}
                    </span>
                  )}
                </span>

                <AnimatePresence>
                  {!isCollapsed && (
                    <motion.div
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 10 }}
                      transition={{ duration: 0.2 }}
                      className="flex-1 min-w-0"
                    >
                      <div className="font-medium">{item.name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {item.description}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </Link>

              {!isCollapsed && item.onSettingsClick && (
                <button
                  onClick={item.onSettingsClick}
                  title={`הגדרות ${item.name}`}
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md transition-all text-gray-400 dark:text-gray-500 opacity-0 group-hover/nav:opacity-100 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                </button>
              )}

              {!isCollapsed && !item.onSettingsClick && item.settingsHref && (
                <Link
                  to={item.settingsHref}
                  title={`הגדרות ${item.name}`}
                  className={cn(
                    "absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md transition-all",
                    settingsActive
                      ? "text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/30"
                      : "text-gray-400 dark:text-gray-500 opacity-0 group-hover/nav:opacity-100 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
                  )}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                </Link>
              )}
            </div>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-gray-200 dark:border-gray-700">
        <AnimatePresence>
          {!isCollapsed && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              transition={{ duration: 0.2 }}
              className="space-y-3"
            >
              {/* Theme Toggle */}
              <button
                onClick={toggleTheme}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <div className="w-5 h-5 flex-shrink-0">
                  {theme === 'dark' ? (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                    </svg>
                  )}
                </div>
                <span className="text-sm font-medium">
                  {theme === 'dark' ? 'מצב בהיר' : 'מצב כהה'}
                </span>
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.aside>
  )
}

interface MobileSidebarProps {
  isOpen: boolean
  onClose: () => void
}

export function MobileSidebar({ isOpen, onClose }: MobileSidebarProps) {
  const location = useLocation()
  const { theme, toggleTheme } = useTheme()
  const me = useSelector((state: RootState) => state.auth.me)
  const taskUnread = useTaskUnreadTotal()
  const permissions = useSelector((state: RootState) => state.permissions.permissions)
  const { open: openInventorySettings } = useInventorySettings()
  const navigationItems = filterNavigationItems(ALL_NAVIGATION_ITEMS, me?.role, permissions)
    .map(item => item.href === '/inventory' ? { ...item, onSettingsClick: openInventorySettings } : item)

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            onClick={onClose}
          />
          
          {/* Sidebar */}
          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="fixed inset-y-0 right-0 w-80 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 z-50 lg:hidden"
          >
            <div className="p-4 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Logo size="lg" showText={true} />
                  <a
                    href="/guide"
                    target="_blank"
                    rel="noopener noreferrer"
                    title="פתח מדריך למשתמש"
                    className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-xs font-semibold hover:bg-blue-200 dark:hover:bg-blue-800/60 transition-colors whitespace-nowrap"
                  >
                    <BookOpen className="w-3 h-3" />
                    מדריך
                  </a>
                </div>
                <button
                  onClick={onClose}
                  className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <X className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                </button>
              </div>
            </div>

            <nav className="flex-1 p-4 space-y-2">
              {navigationItems.map((item) => {
                const isActive = location.pathname === item.href || (item.href !== '/' && location.pathname.startsWith(item.href + '/'))
                const Icon = item.icon

                const settingsActive = item.settingsHref ? location.pathname.startsWith(item.settingsHref) : false

                return (
                  <div key={item.name} className="relative group/nav">
                    <Link
                      to={item.href}
                      onClick={onClose}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200",
                        isActive
                          ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
                          : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800",
                        (item.settingsHref || item.onSettingsClick) ? "pl-8" : ""
                      )}
                    >
                      <span className="relative flex-shrink-0">
                        <Icon className={cn(
                          "w-5 h-5",
                          isActive ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"
                        )} />
                        {item.href === '/task-management' && taskUnread > 0 && (
                          <span className="absolute -top-1 -left-1 min-w-[1.25rem] h-5 px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-xs font-medium">
                            {taskUnread > 99 ? '99+' : taskUnread}
                          </span>
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{item.name}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          {item.description}
                        </div>
                      </div>
                    </Link>

                    {item.onSettingsClick && (
                      <button
                        onClick={() => { item.onSettingsClick!(); onClose() }}
                        title={`הגדרות ${item.name}`}
                        className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md transition-colors text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {!item.onSettingsClick && item.settingsHref && (
                      <Link
                        to={item.settingsHref}
                        onClick={onClose}
                        title={`הגדרות ${item.name}`}
                        className={cn(
                          "absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md transition-colors",
                          settingsActive
                            ? "text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/30"
                            : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
                        )}
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                      </Link>
                    )}
                  </div>
                )
              })}
            </nav>

            <div className="p-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={toggleTheme}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <div className="w-5 h-5 flex-shrink-0">
                  {theme === 'dark' ? (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                    </svg>
                  )}
                </div>
                <span className="text-sm font-medium">
                  {theme === 'dark' ? 'מצב בהיר' : 'מצב כהה'}
                </span>
              </button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
