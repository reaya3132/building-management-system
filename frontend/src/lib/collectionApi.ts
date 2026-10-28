import api from './api'
import type { TaskAttachmentType } from '../pages/TaskCalendar'

/**
 * API layer for the collection (גבייה) module — mirrors
 * backend/api/v1/endpoints/collection_tasks.py and schemas/collection_task.py.
 * Amounts are ILS decimals serialized by the server as strings; they are kept
 * as strings here and only formatted for display, so no float rounding occurs.
 */

export type CollectionType = 'single' | 'ledger'
export type CollectionStatus = 'open' | 'in_progress' | 'closed'
export type ArchivedFilter = 'false' | 'true' | 'all'

export interface CollectionUserBrief {
  id: number
  full_name: string
  avatar_url?: string | null
}

export interface CollectionProjectBrief {
  id: number
  name: string
  relation_project?: number | null
  parent_name?: string | null
}

export interface CollectionProjectOption {
  id: number
  name: string
  relation_project?: number | null
  is_parent_project: boolean
  /** False only for an inactive parent shown to group its active sub-projects. */
  is_active: boolean
}

export interface CollectionAdjustment {
  id: number
  amount: string
  note?: string | null
  created_by?: CollectionUserBrief | null
  created_at: string
}

export interface CollectionLedgerItem {
  id: number
  subject: string
  amount: string
  sort_order: number
  created_by_user_id: number
  updated_by_user_id?: number | null
  created_at: string
  updated_at: string
  archived_at?: string | null
  archived_by_user_id?: number | null
}

export interface CollectionTaskListItem {
  id: number
  title: string
  status: CollectionStatus
  collection_type: CollectionType
  /** First day of the billing month, YYYY-MM-DD. */
  billing_month: string
  project: CollectionProjectBrief
  assignees: CollectionUserBrief[]
  total_amount: string
  is_archived: boolean
  unread_messages_count: number
  created_at: string
  updated_at: string
}

export interface CollectionTaskDetail extends CollectionTaskListItem {
  description?: string | null
  initial_amount?: string | null
  adjustments: CollectionAdjustment[]
  ledger_items: CollectionLedgerItem[]
  attachments: TaskAttachmentType[]
  created_by_user_id?: number | null
  completed_at?: string | null
  archived_at?: string | null
}

export interface CollectionTaskPage {
  items: CollectionTaskListItem[]
  total: number
  page: number
  page_size: number
}

export interface CollectionStatusSummary {
  count: number
  total_amount: string
}

export interface CollectionSummary {
  by_status: Record<CollectionStatus, CollectionStatusSummary>
  count: number
  total_amount: string
}

export interface CollectionUnreadSummary {
  total_unread: number
  task_count: number
}

export interface CollectionAuditEntry {
  id: number
  action: string
  user_id?: number | null
  user_name?: string | null
  details?: Record<string, unknown> | null
  created_at: string
}

export interface CollectionAuditPage {
  items: CollectionAuditEntry[]
  total: number
  page: number
  page_size: number
}

export interface CollectionListFilters {
  /** Billing month, YYYY-MM (required by the server). */
  month: string
  status?: CollectionStatus[]
  project_id?: number | null
  collection_type?: CollectionType | null
  /** Honoured by the server for Admins only. */
  assignee_id?: number | null
  archived?: ArchivedFilter
  search?: string
}

export interface LedgerItemInput {
  subject: string
  amount: string
  sort_order?: number
}

export interface CollectionTaskCreateInput {
  title: string
  description?: string | null
  collection_type: CollectionType
  project_id: number
  billing_month: string
  assignee_ids: number[]
  initial_amount?: string
  items?: LedgerItemInput[]
}

export interface CollectionTaskUpdateInput {
  title?: string
  description?: string | null
  project_id?: number
  assignee_ids?: number[]
}

/** Drops empty optional filters so the query string only carries real ones. */
function listParams(filters: CollectionListFilters) {
  const params = new URLSearchParams({ month: filters.month })
  filters.status?.forEach((s) => params.append('status', s))
  if (filters.project_id != null) params.set('project_id', String(filters.project_id))
  if (filters.collection_type) params.set('collection_type', filters.collection_type)
  if (filters.assignee_id != null) params.set('assignee_id', String(filters.assignee_id))
  if (filters.archived) params.set('archived', filters.archived)
  if (filters.search?.trim()) params.set('search', filters.search.trim())
  return params
}

const BASE = '/collection-tasks'

export const CollectionAPI = {
  async list(filters: CollectionListFilters, page = 1, pageSize = 50): Promise<CollectionTaskPage> {
    const params = listParams(filters)
    params.set('page', String(page))
    params.set('page_size', String(pageSize))
    const { data } = await api.get<CollectionTaskPage>(`${BASE}/`, { params })
    return data
  },

  async summary(filters: CollectionListFilters): Promise<CollectionSummary> {
    const { data } = await api.get<CollectionSummary>(`${BASE}/summary`, { params: listParams(filters) })
    return data
  },

  async unreadSummary(): Promise<CollectionUnreadSummary> {
    const { data } = await api.get<CollectionUnreadSummary>(`${BASE}/unread-summary`)
    return data
  },

  async projectOptions(): Promise<CollectionProjectOption[]> {
    const { data } = await api.get<CollectionProjectOption[]>(`${BASE}/project-options`)
    return data
  },

  async create(input: CollectionTaskCreateInput): Promise<CollectionTaskDetail> {
    const { data } = await api.post<CollectionTaskDetail>(`${BASE}/`, input)
    return data
  },

  async get(taskId: number): Promise<CollectionTaskDetail> {
    const { data } = await api.get<CollectionTaskDetail>(`${BASE}/${taskId}`)
    return data
  },

  async history(taskId: number, page = 1, pageSize = 50): Promise<CollectionAuditPage> {
    const { data } = await api.get<CollectionAuditPage>(`${BASE}/${taskId}/history`, {
      params: { page, page_size: pageSize },
    })
    return data
  },

  async update(taskId: number, input: CollectionTaskUpdateInput): Promise<CollectionTaskDetail> {
    const { data } = await api.patch<CollectionTaskDetail>(`${BASE}/${taskId}`, input)
    return data
  },

  async moveMonth(taskId: number, billingMonth: string, reason?: string): Promise<CollectionTaskDetail> {
    const { data } = await api.post<CollectionTaskDetail>(`${BASE}/${taskId}/move-month`, {
      billing_month: billingMonth,
      reason: reason?.trim() || null,
    })
    return data
  },

  async setStatus(taskId: number, status: CollectionStatus): Promise<CollectionTaskDetail> {
    const { data } = await api.post<CollectionTaskDetail>(`${BASE}/${taskId}/status`, { status })
    return data
  },

  async archive(taskId: number): Promise<CollectionTaskDetail> {
    const { data } = await api.post<CollectionTaskDetail>(`${BASE}/${taskId}/archive`)
    return data
  },

  async unarchive(taskId: number): Promise<CollectionTaskDetail> {
    const { data } = await api.post<CollectionTaskDetail>(`${BASE}/${taskId}/unarchive`)
    return data
  },

  async addAdjustment(taskId: number, amount: string, note?: string) {
    const { data } = await api.post<{ adjustment: CollectionAdjustment; total_amount: string }>(
      `${BASE}/${taskId}/adjustments`,
      { amount, note: note?.trim() || null }
    )
    return data
  },

  async addLedgerItem(taskId: number, input: LedgerItemInput) {
    const { data } = await api.post<{ item: CollectionLedgerItem; total_amount: string }>(
      `${BASE}/${taskId}/ledger-items`,
      input
    )
    return data
  },

  async updateLedgerItem(taskId: number, itemId: number, input: Partial<LedgerItemInput>) {
    const { data } = await api.patch<{ item: CollectionLedgerItem; total_amount: string }>(
      `${BASE}/${taskId}/ledger-items/${itemId}`,
      input
    )
    return data
  },

  async archiveLedgerItem(taskId: number, itemId: number) {
    const { data } = await api.post<{ item: CollectionLedgerItem; total_amount: string }>(
      `${BASE}/${taskId}/ledger-items/${itemId}/archive`
    )
    return data
  },

  async uploadAttachment(taskId: number, file: File): Promise<TaskAttachmentType> {
    const formData = new FormData()
    formData.append('file', file)
    const { data } = await api.post<TaskAttachmentType>(`${BASE}/${taskId}/attachments`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return data
  },

  async deleteAttachment(taskId: number, attachmentId: number): Promise<void> {
    await api.delete(`${BASE}/${taskId}/attachments/${attachmentId}`)
  },
}
