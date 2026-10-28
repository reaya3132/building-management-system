import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAppSelector } from '../utils/hooks'
import api from '../lib/api'

// ─── Types ───────────────────────────────────────────────────────────────────

interface User {
  id: number
  email: string
  full_name: string
  role: string
  is_active: boolean
}

interface IamPermission {
  resource_type: string
  action: string
  source: string
  resource_id?: string
  effect?: string
}

interface IamData {
  user_id: number
  global_role: string | null
  project_roles: Array<{ project_id: number; role: string }>
  permissions: IamPermission[]
}

interface Project {
  id: number
  name: string
}

interface BuildingOption {
  id: number
  name: string
  project_id: number | null
}

interface BuildingReceptionAccess {
  building_id: number
  building_name: string | null
  actions: string[]
}

interface RolesData {
  global_roles: Array<{ name: string; key: string }>
  project_roles: Array<{ name: string; key: string }>
  actions: Array<{ name: string; key: string }>
  resource_types: Array<{ name: string; key: string }>
}

// ─── Label maps ──────────────────────────────────────────────────────────────

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  project: 'פרויקט',
  transaction: 'עסקה',
  budget: 'תקציב',
  report: 'דוח',
  user: 'משתמש',
  supplier: 'ספק',
  task: 'יומן משימות',
  category: 'קטגוריה',
  audit_log: 'היסטורית פעילות',
  contract: 'חוזה',
  quote: 'הצעת מחיר',
  member_invite: 'הזמנת חבר',
  admin_invite: 'הזמנת מנהל',
  notification: 'התראה',
  dashboard: 'לוח בקרה',
  building_reception: 'דלפק בניין',
  building: 'ניהול בניינים',
  collection_task: 'גבייה',
  cems_warehouse: 'מחסן',
  cems_consumable: 'חומר מתכלה',
  cems_fixed_asset: 'רכוש קבוע',
  cems_transfer: 'העברת נכס',
  cems_warehouse_return: 'החזרה למחסן',
  cems_retirement: 'גריטת נכס',
  cems_document: 'מסמך מלאי',
  cems_report: 'דוח מלאי',
}

const ACTION_LABELS: Record<string, string> = {
  read: 'קריאה',
  write: 'כתיבה',
  update: 'עדכון',
  delete: 'מחיקה',
}

const PROJECT_ROLE_LABELS: Record<string, string> = {
  ProjectManager: 'מנהל פרויקט',
  ProjectContributor: 'משתמש',
  ProjectViewer: 'צופה',
}

const GLOBAL_ROLE_LABELS: Record<string, string> = {
  Admin: 'מנהל מערכת',
  Member: 'משתמש',
  SuperAdmin: 'סופר אדמין',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function labelFor(map: Record<string, string>, key: string): string {
  return map[key] ?? key
}

function isAllowed(permissions: IamPermission[], rt: string, action: string): boolean {
  // The matrix is a blanket "does this user have this capability everywhere"
  // overview, so a permission scoped to a single resource instance (a specific
  // resource_id, e.g. one building's reception desk) must NOT light the cell —
  // otherwise a per-building grant looks identical to all-building/global access.
  // Wildcard ('*') and role/global sources (no resource_id) still count.
  return permissions.some(
    (p) =>
      p.resource_type === rt &&
      p.action === action &&
      (p.resource_id === undefined || p.resource_id === '*')
  )
}

function getResourcePolicies(permissions: IamPermission[]): IamPermission[] {
  return permissions.filter((p) => p.source === 'resource_policy')
}

const AVATAR_COLORS = [
  'bg-rose-400', 'bg-sky-400', 'bg-emerald-400',
  'bg-amber-400', 'bg-violet-400', 'bg-teal-400',
]

function avatarColorFromName(name: string): string {
  const code = name.charCodeAt(0) || 0
  return AVATAR_COLORS[code % AVATAR_COLORS.length]
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return (name[0] ?? '?').toUpperCase()
}

function roleBadgeClasses(role: string): string {
  if (role === 'Admin') return 'bg-red-600 text-white'
  if (role === 'SuperAdmin') return 'bg-purple-600 text-white'
  return 'bg-blue-500 text-white'
}

function projectRoleBadgeClasses(role: string): string {
  if (role === 'ProjectManager') return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
  if (role === 'ProjectContributor') return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
  return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
}

// Inline spinner SVG for buttons
function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 inline-block" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

type Tab = 'project-roles' | 'matrix' | 'policies' | 'building-reception'

interface TabBarProps {
  active: Tab
  onChange: (t: Tab) => void
  projectRolesCount: number
  policiesCount: number
  buildingReceptionCount: number
}

function TabBar({ active, onChange, projectRolesCount, policiesCount, buildingReceptionCount }: TabBarProps) {
  const tabs: { id: Tab; label: string; count: number | null }[] = [
    { id: 'project-roles', label: 'תפקידים בפרויקטים', count: projectRolesCount },
    { id: 'matrix', label: 'מטריצת הרשאות', count: null },
    { id: 'policies', label: 'מדיניות ספציפית', count: policiesCount },
    { id: 'building-reception', label: 'דלפק לפי בניין', count: buildingReceptionCount },
  ]
  return (
    <div className="flex gap-0 border-b border-gray-200 dark:border-gray-700 mb-6">
      {tabs.map((t) => {
        const isActive = active === t.id
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`relative px-5 py-3 text-sm font-medium transition-all duration-150 ${
              isActive
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50'
            } rounded-t-lg`}
          >
            <span className="flex items-center gap-2">
              {t.label}
              {t.count !== null && (
                <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-semibold ${
                  isActive
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                }`}>
                  {t.count}
                </span>
              )}
            </span>
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 dark:bg-blue-400" />
            )}
          </button>
        )
      })}
    </div>
  )
}

// ── Tab 1: Project Roles ──────────────────────────────────────────────────────

interface ProjectRolesTabProps {
  userId: number
  projects: Project[]
  iamData: IamData
  projectRoles: RolesData['project_roles']
  onRefresh: () => void
}

function ProjectRolesTab({ userId, projects, iamData, projectRoles, onRefresh }: ProjectRolesTabProps) {
  const assignedIds = new Set(iamData.project_roles.map((pr) => pr.project_id))

  // Form state for adding a new project role
  const [addProjectId, setAddProjectId] = useState<string>('')
  const [addRole, setAddRole] = useState<string>('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // Per-row update/remove state
  const [saving, setSaving] = useState<number | null>(null)
  const [editRoles, setEditRoles] = useState<Record<number, string>>(
    Object.fromEntries(iamData.project_roles.map((pr) => [pr.project_id, pr.role]))
  )
  const [rowError, setRowError] = useState<string | null>(null)

  // Projects not yet assigned → available for the "Add" selector
  const unassignedProjects = projects.filter((p) => !assignedIds.has(p.id))

  const projectName = (pid: number) =>
    projects.find((p) => p.id === pid)?.name ?? `פרויקט #${pid}`

  const handleRoleUpdate = async (pid: number) => {
    setSaving(pid)
    setRowError(null)
    try {
      await api.post(`/iam/projects/${pid}/roles`, {
        user_id: userId,
        project_id: pid,
        role: editRoles[pid],
      })
      onRefresh()
    } catch (err: any) {
      setRowError(err.response?.data?.detail || err.message || 'שגיאה בעדכון')
    } finally {
      setSaving(null)
    }
  }

  const handleRevoke = async (pid: number, role: string) => {
    setSaving(pid)
    setRowError(null)
    try {
      await api.delete(`/iam/projects/${pid}/roles/${userId}`, {
        params: { role },
      })
      onRefresh()
    } catch (err: any) {
      setRowError(err.response?.data?.detail || err.message || 'שגיאה בהסרה')
    } finally {
      setSaving(null)
    }
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!addProjectId || !addRole) return
    setAdding(true)
    setAddError(null)
    try {
      await api.post(`/iam/projects/${addProjectId}/roles`, {
        user_id: userId,
        project_id: Number(addProjectId),
        role: addRole,
      })
      setAddProjectId('')
      setAddRole('')
      onRefresh()
    } catch (err: any) {
      setAddError(err.response?.data?.detail || err.message || 'שגיאה בהוספה')
    } finally {
      setAdding(false)
    }
  }

  // Keep editRoles in sync when iamData refreshes
  useEffect(() => {
    setEditRoles(Object.fromEntries(iamData.project_roles.map((pr) => [pr.project_id, pr.role])))
  }, [iamData.project_roles])

  return (
    <div className="space-y-6">
      {/* Assigned projects as cards */}
      <div>
        {iamData.project_roles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <svg className="w-16 h-16 text-gray-300 dark:text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            <p className="text-gray-500 dark:text-gray-400 text-sm font-medium mb-1">אין תפקידים מוקצים בפרויקטים</p>
            <p className="text-gray-400 dark:text-gray-500 text-xs mb-4">הוסף תפקיד בפרויקט באמצעות הטופס למטה</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {iamData.project_roles.map((pr) => (
              <div
                key={pr.project_id}
                className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm p-4 transition-all duration-150 hover:shadow-md"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="text-base font-bold text-gray-900 dark:text-white">
                      {projectName(pr.project_id)}
                    </span>
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${projectRoleBadgeClasses(pr.role)}`}>
                      {labelFor(PROJECT_ROLE_LABELS, pr.role)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={editRoles[pr.project_id] ?? pr.role}
                      onChange={(e) => setEditRoles((prev) => ({ ...prev, [pr.project_id]: e.target.value }))}
                      className="px-2.5 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm transition-all duration-150 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      {projectRoles.map((r) => (
                        <option key={r.name} value={r.name}>
                          {labelFor(PROJECT_ROLE_LABELS, r.name)}
                        </option>
                      ))}
                    </select>
                    {editRoles[pr.project_id] !== pr.role && (
                      <button
                        onClick={() => handleRoleUpdate(pr.project_id)}
                        disabled={saving === pr.project_id}
                        className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150"
                      >
                        {saving === pr.project_id ? <Spinner /> : 'שמור'}
                      </button>
                    )}
                    <button
                      onClick={() => handleRevoke(pr.project_id, pr.role)}
                      disabled={saving === pr.project_id}
                      className="px-3 py-1.5 text-red-600 dark:text-red-400 text-xs font-medium rounded-lg border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150"
                    >
                      {saving === pr.project_id ? <Spinner /> : 'הסר'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {rowError && (
          <div className="mt-3 flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-600 dark:text-red-400">
            <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            {rowError}
          </div>
        )}
      </div>

      {/* Add new project role */}
      <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-xl p-5">
        <h3 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-4">הוסף תפקיד בפרויקט</h3>
        {unassignedProjects.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">כל הפרויקטים כבר מוקצים</p>
        ) : (
          <form onSubmit={handleAdd} className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[180px]">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">פרויקט</label>
              <select
                value={addProjectId}
                onChange={(e) => setAddProjectId(e.target.value)}
                required
                className="w-full px-3 py-2 border border-blue-200 dark:border-blue-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm transition-all duration-150 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">בחר פרויקט...</option>
                {unassignedProjects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="flex-1 min-w-[150px]">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">תפקיד</label>
              <select
                value={addRole}
                onChange={(e) => setAddRole(e.target.value)}
                required
                className="w-full px-3 py-2 border border-blue-200 dark:border-blue-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm transition-all duration-150 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">בחר תפקיד...</option>
                {projectRoles.map((r) => (
                  <option key={r.name} value={r.name}>
                    {labelFor(PROJECT_ROLE_LABELS, r.name)}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={adding}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 text-sm font-semibold shadow-sm"
            >
              {adding ? <><Spinner />{' '}מוסיף...</> : '+ הוסף תפקיד'}
            </button>
          </form>
        )}
        {addError && (
          <div className="mt-3 flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-600 dark:text-red-400">
            <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            {addError}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Tab 2: Permission Matrix ──────────────────────────────────────────────────

interface MatrixTabProps {
  permissions: IamPermission[]
  rolesData: RolesData
}

function MatrixTab({ permissions, rolesData }: MatrixTabProps) {
  return (
    <div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        מבט-על של כל ההרשאות האפקטיביות של המשתמש (לפי תפקיד גלובלי, תפקיד בפרויקט, ומדיניות ספציפית).
      </p>
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="text-xs border-collapse w-full">
          <thead>
            <tr className="bg-gray-100 dark:bg-gray-700/50">
              <th className="py-3 px-4 text-right font-semibold text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-600 sticky right-0 z-10 min-w-[140px] bg-white dark:bg-gray-800 shadow-[inset_-4px_0_6px_-4px_rgba(0,0,0,0.1)]">
                משאב \ פעולה
              </th>
              {rolesData.actions.map((a) => (
                <th
                  key={a.name}
                  className="py-3 px-3 text-center font-semibold text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-600 bg-gray-100 dark:bg-gray-700/50 whitespace-nowrap"
                >
                  {labelFor(ACTION_LABELS, a.name)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rolesData.resource_types.map((rt) => (
              <tr key={rt.name} className="transition-all duration-150 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <td className="py-2.5 px-4 font-medium text-gray-800 dark:text-gray-200 border-b border-gray-100 dark:border-gray-700 sticky right-0 bg-white dark:bg-gray-800 whitespace-nowrap shadow-[inset_-4px_0_6px_-4px_rgba(0,0,0,0.1)]">
                  {labelFor(RESOURCE_TYPE_LABELS, rt.name)}
                </td>
                {rolesData.actions.map((a) => {
                  const allowed = isAllowed(permissions, rt.name, a.name)
                  return (
                    <td
                      key={a.name}
                      className={`py-2.5 px-3 text-center border-b border-gray-100 dark:border-gray-700 transition-all duration-150 ${
                        allowed
                          ? 'bg-green-50 dark:bg-green-900/20'
                          : ''
                      }`}
                    >
                      {allowed ? (
                        <span className="text-green-600 dark:text-green-400 font-extrabold text-sm">&#10003;</span>
                      ) : (
                        <span className="text-gray-300 dark:text-gray-600">&mdash;</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Legend */}
      <div className="mt-4 flex gap-3 items-center">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800">
          <span className="font-extrabold">&#10003;</span> מותר
        </span>
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-gray-50 dark:bg-gray-700/30 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-600">
          &mdash; אסור
        </span>
      </div>
    </div>
  )
}

// ── Tab 3: Resource Policies ──────────────────────────────────────────────────

interface PoliciesTabProps {
  userId: number
  permissions: IamPermission[]
  rolesData: RolesData
  onRefresh: () => void
}

function PoliciesTab({ userId, permissions, rolesData, onRefresh }: PoliciesTabProps) {
  const policies = getResourcePolicies(permissions)
  const [form, setForm] = useState({ resource_type: '', action: '' })
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.resource_type || !form.action) return
    setAdding(true)
    setError(null)
    try {
      const actionsToGrant = form.action === 'ALL'
        ? ['read', 'write', 'update', 'delete']
        : [form.action]
      for (const action of actionsToGrant) {
        await api.post('/iam/resource-policies', null, {
          params: {
            user_id: userId,
            resource_type: form.resource_type,
            resource_id: '*',
            action,
          },
        })
      }
      setForm({ resource_type: '', action: '' })
      onRefresh()
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'שגיאה בהוספה')
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = async (p: IamPermission) => {
    const key = `${p.resource_type}:${p.resource_id}:${p.action}`
    setRemoving(key)
    setError(null)
    try {
      await api.delete('/iam/resource-policies', {
        params: {
          user_id: userId,
          resource_type: p.resource_type,
          resource_id: p.resource_id,
          action: p.action,
        },
      })
      onRefresh()
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'שגיאה במחיקה')
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        מדיניות מפורשת על סוג משאב ופעולה. גוברת על תפקידים. אם לא מצוין מזהה — המדיניות חלה על כל המשאבים מאותו סוג.
      </p>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-600 dark:text-red-400">
          <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
          {error}
        </div>
      )}

      {/* Existing policies */}
      <div>
        <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">מדיניות קיימת</h3>
        {policies.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <svg className="w-14 h-14 text-gray-300 dark:text-gray-600 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <p className="text-gray-500 dark:text-gray-400 text-sm">אין מדיניות מפורשת</p>
          </div>
        ) : (
          <div className="space-y-2">
            {policies.map((p) => {
              const key = `${p.resource_type}:${p.resource_id}:${p.action}`
              return (
                <div key={key} className="flex items-center justify-between bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3 transition-all duration-150 hover:shadow-sm">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                      אפשר
                    </span>
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      {labelFor(RESOURCE_TYPE_LABELS, p.resource_type)}
                    </span>
                    <span className="text-gray-400 dark:text-gray-500">/</span>
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      {labelFor(ACTION_LABELS, p.action)}
                    </span>
                    {p.resource_id && p.resource_id !== '*' && (
                      <span className="text-xs font-mono bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-2 py-0.5 rounded">
                        #{p.resource_id}
                      </span>
                    )}
                    {(!p.resource_id || p.resource_id === '*') && (
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        (כל המשאבים)
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => handleRemove(p)}
                    disabled={removing === key}
                    className="p-2 text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
                    title="מחק מדיניות"
                  >
                    {removing === key ? (
                      <Spinner />
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Add new policy */}
      <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-5">
        <h3 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-4">הוסף מדיניות</h3>
        <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">סוג משאב</label>
            <select
              value={form.resource_type}
              onChange={(e) => setForm({ ...form, resource_type: e.target.value })}
              required
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm transition-all duration-150 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="">בחר...</option>
              {rolesData.resource_types.map((rt) => (
                <option key={rt.name} value={rt.name}>
                  {labelFor(RESOURCE_TYPE_LABELS, rt.name)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">פעולה</label>
            <select
              value={form.action}
              onChange={(e) => setForm({ ...form, action: e.target.value })}
              required
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm transition-all duration-150 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="">בחר...</option>
              <option value="ALL">הכל (קריאה + כתיבה + עדכון + מחיקה)</option>
              {rolesData.actions.map((a) => (
                <option key={a.name} value={a.name}>
                  {labelFor(ACTION_LABELS, a.name)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <button
              type="submit"
              disabled={adding}
              className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 text-sm font-semibold shadow-sm"
            >
              {adding ? <><Spinner />{' '}מוסיף...</> : '+ הוסף מדיניות'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Tab 4: Building Reception (per-building desk access) ──────────────────────

const RECEPTION_ACTIONS = ['read', 'write', 'update', 'delete'] as const

interface BuildingReceptionTabProps {
  userId: number
  access: BuildingReceptionAccess[]
  buildings: BuildingOption[]
  onRefresh: () => void
}

function BuildingReceptionTab({ userId, access, buildings, onRefresh }: BuildingReceptionTabProps) {
  const [buildingId, setBuildingId] = useState<string>('')
  const [selectedActions, setSelectedActions] = useState<string[]>([...RECEPTION_ACTIONS])
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const grantedIds = new Set(access.map((a) => a.building_id))
  const availableBuildings = buildings.filter((b) => !grantedIds.has(b.id))

  const buildingName = (id: number) =>
    buildings.find((b) => b.id === id)?.name ?? `בניין #${id}`

  const toggleAction = (action: string) => {
    // READ is the baseline the desk needs to list/open a building, so it stays
    // on and cannot be turned off — a write/update/delete-only grant would be
    // silently unusable (the server also forces read in on every grant).
    if (action === 'read') return
    setSelectedActions((prev) =>
      prev.includes(action) ? prev.filter((a) => a !== action) : [...prev, action]
    )
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!buildingId || selectedActions.length === 0) return
    setAdding(true)
    setError(null)
    try {
      await api.post(`/iam/users/${userId}/building-reception`, {
        building_id: Number(buildingId),
        actions: selectedActions,
      })
      setBuildingId('')
      setSelectedActions([...RECEPTION_ACTIONS])
      onRefresh()
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'שגיאה בהוספה')
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = async (bid: number) => {
    setRemoving(bid)
    setError(null)
    try {
      await api.delete(`/iam/users/${userId}/building-reception/${bid}`)
      onRefresh()
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'שגיאה בהסרה')
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        הענקת גישה לדלפק של בניין ספציפי. המשתמש יראה ויפעל רק בבניינים שהוקצו לו כאן.
        מנהל מערכת ומדיניות "כל המשאבים" מקבלים גישה לכל הבניינים.
      </p>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-600 dark:text-red-400">
          <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
          {error}
        </div>
      )}

      {/* Existing per-building grants */}
      <div>
        <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">בניינים מוקצים</h3>
        {access.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <svg className="w-14 h-14 text-gray-300 dark:text-gray-600 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
            <p className="text-gray-500 dark:text-gray-400 text-sm">אין בניינים מוקצים</p>
          </div>
        ) : (
          <div className="space-y-2">
            {access.map((a) => (
              <div key={a.building_id} className="flex items-center justify-between bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3 transition-all duration-150 hover:shadow-sm">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-sm font-bold text-gray-900 dark:text-white">
                    {a.building_name ?? buildingName(a.building_id)}
                  </span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {a.actions.map((action) => (
                      <span key={action} className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                        {labelFor(ACTION_LABELS, action)}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => handleRemove(a.building_id)}
                  disabled={removing === a.building_id}
                  className="p-2 text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
                  title="הסר גישה לבניין"
                >
                  {removing === a.building_id ? (
                    <Spinner />
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add new per-building grant */}
      <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-xl p-5">
        <h3 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-4">הוסף גישה לבניין</h3>
        {availableBuildings.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {buildings.length === 0 ? 'אין בניינים במערכת' : 'כל הבניינים כבר מוקצים'}
          </p>
        ) : (
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">בניין</label>
                <select
                  value={buildingId}
                  onChange={(e) => setBuildingId(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-blue-200 dark:border-blue-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm transition-all duration-150 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">בחר בניין...</option>
                  {availableBuildings.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">הרשאות</label>
              <div className="flex flex-wrap gap-2">
                {RECEPTION_ACTIONS.map((action) => {
                  const checked = selectedActions.includes(action)
                  const locked = action === 'read'
                  return (
                    <button
                      type="button"
                      key={action}
                      onClick={() => toggleAction(action)}
                      disabled={locked}
                      title={locked ? 'קריאה נדרשת תמיד כדי לצפות בבניין' : undefined}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all duration-150 ${
                        checked
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:border-blue-400'
                      } ${locked ? 'opacity-70 cursor-not-allowed' : ''}`}
                    >
                      {labelFor(ACTION_LABELS, action)}
                      {locked ? ' •' : ''}
                    </button>
                  )
                })}
              </div>
            </div>
            <button
              type="submit"
              disabled={adding || selectedActions.length === 0}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 text-sm font-semibold shadow-sm"
            >
              {adding ? <><Spinner />{' '}מוסיף...</> : '+ הוסף גישה'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function UserPermissions() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const me = useAppSelector((s) => s.auth.me)

  const [user, setUser] = useState<User | null>(null)
  const [iamData, setIamData] = useState<IamData | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [rolesData, setRolesData] = useState<RolesData | null>(null)
  const [buildings, setBuildings] = useState<BuildingOption[]>([])
  const [buildingAccess, setBuildingAccess] = useState<BuildingReceptionAccess[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('project-roles')
  const [editingGlobalRole, setEditingGlobalRole] = useState(false)
  const [newGlobalRole, setNewGlobalRole] = useState('')
  const [savingRole, setSavingRole] = useState(false)
  const [roleError, setRoleError] = useState<string | null>(null)

  const uid = Number(userId)

  const fetchAll = useCallback(async () => {
    if (!uid) return
    setLoading(true)
    setError(null)
    try {
      const [userRes, iamRes, projectsRes, rolesRes] = await Promise.all([
        api.get<User>(`/users/${uid}`),
        api.get<IamData>(`/iam/users/${uid}/permissions`),
        api.get('/projects'),
        api.get<RolesData>('/iam/roles'),
      ])
      setUser(userRes.data)
      setIamData(iamRes.data)
      // projects endpoint may return array or paginated object
      const pd = projectsRes.data
      setProjects(Array.isArray(pd) ? pd : (pd.items ?? pd.projects ?? []))
      setRolesData(rolesRes.data)
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'שגיאה בטעינת נתונים')
    } finally {
      setLoading(false)
    }
  }, [uid])

  const refreshIam = useCallback(async () => {
    if (!uid) return
    try {
      const res = await api.get<IamData>(`/iam/users/${uid}/permissions`)
      setIamData(res.data)
    } catch {
      // silent – main data stays
    }
  }, [uid])

  const refreshBuildingAccess = useCallback(async () => {
    if (!uid) return
    try {
      const res = await api.get<BuildingReceptionAccess[]>(`/iam/users/${uid}/building-reception`)
      setBuildingAccess(res.data)
    } catch {
      // silent – main data stays
    }
  }, [uid])

  // The per-building reception data loads independently of the main page so a
  // failure here only disables the reception tab, never the whole permissions
  // screen (roles / matrix / policies stay usable).
  const fetchBuildingReception = useCallback(async () => {
    if (!uid) return
    try {
      const [buildingsRes, accessRes] = await Promise.all([
        api.get<BuildingOption[]>('/iam/buildings'),
        api.get<BuildingReceptionAccess[]>(`/iam/users/${uid}/building-reception`),
      ])
      setBuildings(buildingsRes.data)
      setBuildingAccess(accessRes.data)
    } catch {
      // silent – the reception tab shows its empty state
    }
  }, [uid])

  useEffect(() => {
    fetchAll()
    fetchBuildingReception()
  }, [fetchAll, fetchBuildingReception])

  const handleGlobalRoleChange = async () => {
    if (!newGlobalRole) return
    setSavingRole(true)
    setRoleError(null)
    try {
      await api.put(`/users/${uid}`, { role: newGlobalRole })
      setEditingGlobalRole(false)
      await fetchAll()
    } catch (err: any) {
      setRoleError(err.response?.data?.detail || err.message || 'שגיאה בשמירת תפקיד')
    } finally {
      setSavingRole(false)
    }
  }

  // ── Guards ────────────────────────────────────────────────────────────────

  if (!me) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  if (me.role !== 'Admin' && me.role !== 'SuperAdmin') {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center" dir="rtl">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">גישה נדחית</h1>
          <p className="text-gray-500 dark:text-gray-400">רק מנהלי מערכת יכולים לנהל הרשאות</p>
        </div>
      </div>
    )
  }

  // ── Loading / Error ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  if (error || !user || !iamData || !rolesData) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6" dir="rtl">
        <div className="max-w-4xl mx-auto">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-600 dark:text-red-400">
            {error || 'שגיאה בטעינת נתונים'}
          </div>
        </div>
      </div>
    )
  }

  const policiesCount = getResourcePolicies(iamData.permissions).length
  const projectRolesCount = iamData.project_roles.length
  const buildingReceptionCount = buildingAccess.length

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6" dir="rtl">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* Breadcrumb navigation */}
        <nav className="flex items-center gap-2 text-sm">
          <button
            onClick={() => navigate('/users')}
            className="flex items-center gap-1 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-all duration-150 font-medium"
          >
            ניהול משתמשים
          </button>
          <svg className="w-4 h-4 text-gray-400 dark:text-gray-500 rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          <span className="text-gray-900 dark:text-white font-medium">{user.full_name}</span>
        </nav>

        {/* User header card */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            {/* Left: avatar + info */}
            <div className="flex items-center gap-4">
              {/* Initials avatar */}
              <div className={`w-14 h-14 rounded-full flex items-center justify-center text-white font-bold text-xl ${avatarColorFromName(user.full_name)}`}>
                {getInitials(user.full_name)}
              </div>
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                    {user.full_name}
                  </h1>
                  {/* Role badge with inline edit */}
                  {editingGlobalRole ? (
                    <div className="flex items-center gap-2">
                      <select
                        value={newGlobalRole}
                        onChange={(e) => setNewGlobalRole(e.target.value)}
                        className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-xs"
                      >
                        <option value="Admin">מנהל מערכת</option>
                        <option value="Member">משתמש</option>
                        <option value="SuperAdmin">סופר אדמין</option>
                      </select>
                      <button
                        onClick={handleGlobalRoleChange}
                        disabled={savingRole}
                        className="px-2.5 py-1 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 disabled:opacity-50"
                      >
                        {savingRole ? <Spinner /> : 'שמור'}
                      </button>
                      <button
                        onClick={() => setEditingGlobalRole(false)}
                        className="px-2.5 py-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 text-xs rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500"
                      >
                        ביטול
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className={`px-3 py-0.5 rounded-full text-xs font-bold ${roleBadgeClasses(user.role)}`}>
                        {labelFor(GLOBAL_ROLE_LABELS, iamData.global_role ?? user.role)}
                      </span>
                      <button
                        onClick={() => {
                          setNewGlobalRole(iamData.global_role ?? user.role)
                          setEditingGlobalRole(true)
                        }}
                        className="px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 border border-gray-300 dark:border-gray-600 rounded-lg hover:border-blue-400 transition-all duration-150"
                        title="ערוך תפקיד גלובלי"
                      >
                        ערוך תפקיד
                      </button>
                    </div>
                  )}
                  {roleError && (
                    <span className="text-xs text-red-600 dark:text-red-400">{roleError}</span>
                  )}
                  {/* Active status */}
                  <span className="flex items-center gap-1.5 text-sm">
                    <span className={`inline-block w-2 h-2 rounded-full ${user.is_active ? 'bg-green-500' : 'bg-gray-400'}`} />
                    <span className={user.is_active ? 'text-green-700 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}>
                      {user.is_active ? 'פעיל' : 'לא פעיל'}
                    </span>
                  </span>
                </div>
                <p className="text-gray-500 dark:text-gray-400 text-sm mt-0.5">
                  {user.email}
                </p>
              </div>
            </div>
            {/* Right: summary stats */}
            <div className="flex gap-3">
              <div className="flex items-center gap-2 bg-gray-100 dark:bg-gray-700/50 rounded-lg px-4 py-2">
                <span className="text-lg font-bold text-gray-900 dark:text-white">{projectRolesCount}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">תפקידים בפרויקטים</span>
              </div>
              <div className="flex items-center gap-2 bg-gray-100 dark:bg-gray-700/50 rounded-lg px-4 py-2">
                <span className="text-lg font-bold text-gray-900 dark:text-white">{policiesCount}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">מדיניות מפורשת</span>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs + content card */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
          <TabBar
            active={activeTab}
            onChange={setActiveTab}
            projectRolesCount={projectRolesCount}
            policiesCount={policiesCount}
            buildingReceptionCount={buildingReceptionCount}
          />

          {activeTab === 'project-roles' && (
            <ProjectRolesTab
              userId={uid}
              projects={projects}
              iamData={iamData}
              projectRoles={rolesData.project_roles}
              onRefresh={refreshIam}
            />
          )}

          {activeTab === 'matrix' && (
            <MatrixTab
              permissions={iamData.permissions}
              rolesData={rolesData}
            />
          )}

          {activeTab === 'policies' && (
            <PoliciesTab
              userId={uid}
              permissions={iamData.permissions}
              rolesData={rolesData}
              onRefresh={refreshIam}
            />
          )}

          {activeTab === 'building-reception' && (
            <BuildingReceptionTab
              userId={uid}
              access={buildingAccess}
              buildings={buildings}
              onRefresh={refreshBuildingAccess}
            />
          )}
        </div>
      </div>
    </div>
  )
}
