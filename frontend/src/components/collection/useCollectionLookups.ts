import { useEffect, useMemo, useState } from 'react'
import api from '../../lib/api'
import { CollectionAPI, type CollectionProjectOption } from '../../lib/collectionApi'
import type { UserForTask } from '../../pages/TaskCalendar'
import type { ComboOption } from '../task-management/SearchableMultiSelect'

/**
 * Selectable projects for the picker: active projects only, a sub-project
 * labelled "parent › child" (its parent may be inactive — it is listed only to
 * group, never selectable), sorted by that label.
 */
export function toProjectComboOptions(projects: CollectionProjectOption[]): ComboOption[] {
  const byId = new Map(projects.map((p) => [p.id, p]))
  return projects
    .filter((p) => p.is_active)
    .map((p) => {
      const parent = p.relation_project != null ? byId.get(p.relation_project) : undefined
      return { id: p.id, label: parent ? `${parent.name} › ${p.name}` : p.name }
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'he'))
}

/** Loads the project picker options and the assignable users once per mount. */
export function useCollectionLookups() {
  const [projects, setProjects] = useState<CollectionProjectOption[]>([])
  const [users, setUsers] = useState<UserForTask[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      CollectionAPI.projectOptions(),
      api.get<UserForTask[]>('/users/for-tasks').then((r) => r.data),
    ]).then(([projectsResult, usersResult]) => {
      if (cancelled) return
      if (projectsResult.status === 'fulfilled') setProjects(projectsResult.value)
      if (usersResult.status === 'fulfilled') setUsers(usersResult.value)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const projectOptions = useMemo(() => toProjectComboOptions(projects), [projects])
  const userOptions = useMemo<ComboOption[]>(() => users.map((u) => ({ id: u.id, label: u.full_name })), [users])

  return { projects, projectOptions, users, userOptions, loading }
}
