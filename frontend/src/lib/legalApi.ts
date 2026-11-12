import api from './api'

/** API layer for legal proceedings — mirrors backend/api/v1/endpoints/legal.py. */

const BASE = '/legal'

export type ProceedingStatus = 'open' | 'closed'
export type PartyRole = 'tenant' | 'landlord' | 'supplier' | 'other'
export type StageStatus = 'pending' | 'completed' | 'skipped'

export interface Ref {
  id: number
  name: string | null
}

export interface LegalProgress {
  resolved: number
  total: number
  percent: number
  next_stage_key: string | null
}

export interface LegalProceedingListItem {
  id: number
  title: string
  status: ProceedingStatus
  party_role: PartyRole
  apartment_number: string | null
  total_amount: string
  contact: Ref
  linked_landlord: Ref | null
  project: Ref | null
  created_by: Ref
  opened_at: string
  closed_at: string | null
  progress: LegalProgress
  assignee_ids: number[]
}

export interface LegalProceedingPage {
  items: LegalProceedingListItem[]
  total: number
  page: number
  page_size: number
}

export interface LegalProceedingFilters {
  search?: string
  project_id?: number | null
  landlord_contact_id?: number | null
  status?: ProceedingStatus | null
  page?: number
  page_size?: number
}

export interface ContactSummary {
  id: number
  name: string
  phone: string
  phone_2: string | null
  email: string | null
  address: string | null
  apartment_number: string | null
}

export interface NewContactDetails {
  kind: 'person' | 'business'
  name: string
  phone: string
  phone_2?: string | null
  email?: string
  address?: string
  apartment_number?: string
}

/** Values for fields that are empty on an existing card. */
export interface ContactCompletion {
  phone?: string
  phone_2?: string
  email?: string
  address?: string
  apartment_number?: string
}

/** Exactly one: an existing contact (optionally completing its empty fields), or a new one. */
export type PartySelection = { contact_id: number; complete?: ContactCompletion } | { details: NewContactDetails }

export type LedgerItemType = 'base_amount' | 'addition'

export interface LegalLedgerItem {
  id: number
  item_type: LedgerItemType
  subject: string
  amount: string
  sort_order: number
}

export interface LedgerItemResult {
  item: LegalLedgerItem
  total_amount: string
}

export interface LegalProceedingCreateInput {
  party_role: PartyRole
  title: string
  contact: PartySelection
  landlord?: PartySelection
  project_id?: number | null
  base_items: Array<{ subject: string; amount: string }>
  claim_details?: string | null
  confirm_open_proceeding?: boolean
  confirm_duplicate_contact?: boolean
  /** Users assigned besides the creator (the primary owner). Optional; needs the assigning permission. */
  assignee_ids?: number[]
}

export interface LegalUserRef {
  id: number
  full_name: string
  avatar_url?: string | null
}

export interface LegalStage {
  key: string
  label: string
  description: string | null
  position: number
  requires_communication: boolean
  components: Array<{ key: string; label: string }>
  status: StageStatus
  resolved_at: string | null
  resolved_by: LegalUserRef | null
}

export type EntryType = 'note' | 'communication'
export type Channel = 'email' | 'whatsapp' | 'other'

export interface LegalDocument {
  id: number
  file_name: string | null
  download_url: string
  preview_url?: string | null
  uploaded_by: LegalUserRef | null
  uploaded_at: string | null
  stage_key: string | null
  component_key: string | null
  entry_id: number | null
}

export interface LegalEntry {
  id: number
  entry_type: EntryType
  stage_key: string | null
  context_key: string | null
  content: string | null
  channel: Channel | null
  occurred_at: string | null
  created_by: LegalUserRef | null
  created_at: string
  updated_at: string | null
  can_modify: boolean
  documents: LegalDocument[]
}

export interface LegalEntryPage {
  items: LegalEntry[]
  next_before_id: number | null
}

export interface EntryFilters {
  stage_key?: string
  general_only?: boolean
  context_key?: string
  entry_type?: EntryType
  before_id?: number
}

export interface NewEntry {
  entry_type: EntryType
  stage_key?: string | null
  context_key?: string | null
  content?: string | null
  channel?: Channel | null
  occurred_at?: string | null
  files?: File[]
}

export interface MissingDocumentation {
  key: string
  label: string
}

export interface LegalProceedingDetail {
  id: number
  title: string
  status: ProceedingStatus
  party_role: PartyRole
  claim_details: string | null
  total_amount: string
  ledger_items: LegalLedgerItem[]
  contact: ContactSummary
  linked_landlord: ContactSummary | null
  project: Ref | null
  opened_at: string
  closed_at: string | null
  close_reason: string | null
  progress: LegalProgress
  stages: LegalStage[]
  permissions: { can_update: boolean; can_assign: boolean; can_delete_others: boolean }
}

export interface LegalProjectSummary {
  project_id: number | null
  project_name: string | null
}

export interface LegalProjectOption {
  id: number
  name: string
  parent_name: string | null
}

export interface LegalAssignee {
  user: LegalUserRef
  assigned_by: LegalUserRef | null
  assigned_at: string
}

/** The creator (primary owner, never in ``assignees``) and the assigned users. */
export interface LegalTeam {
  owner: LegalUserRef | null
  assignees: LegalAssignee[]
}

/** Outcome of {@link LegalAPI.saveAssignees}: who was added and removed, and the server's team afterwards. */
export interface SaveAssigneesResult {
  added: number[]
  removed: number[]
  team: LegalTeam
}

export const LegalAPI = {
  async list(filters: LegalProceedingFilters): Promise<LegalProceedingPage> {
    const params: Record<string, string | number> = {}
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') params[key] = value
    }
    const { data } = await api.get<LegalProceedingPage>(`${BASE}/proceedings`, { params })
    return data
  },

  async get(id: number): Promise<LegalProceedingDetail> {
    const { data } = await api.get<LegalProceedingDetail>(`${BASE}/proceedings/${id}`)
    return data
  },

  async create(input: LegalProceedingCreateInput): Promise<void> {
    await api.post(`${BASE}/proceedings`, input)
  },

  async close(id: number, reason: string): Promise<void> {
    await api.post(`${BASE}/proceedings/${id}/close`, { reason })
  },

  async reopen(id: number, reason?: string): Promise<void> {
    await api.post(`${BASE}/proceedings/${id}/reopen`, { reason: reason || null })
  },

  async landlords(): Promise<Ref[]> {
    const { data } = await api.get<Ref[]>(`${BASE}/landlords`)
    return data
  },

  async projects(): Promise<LegalProjectSummary[]> {
    const { data } = await api.get<LegalProjectSummary[]>(`${BASE}/projects/summary`)
    return data
  },

  async projectOptions(): Promise<LegalProjectOption[]> {
    const { data } = await api.get<LegalProjectOption[]>(`${BASE}/project-options`)
    return data
  },

  async addLedgerItem(id: number, data: { subject: string; amount: string }): Promise<LedgerItemResult> {
    const { data: result } = await api.post<LedgerItemResult>(`${BASE}/proceedings/${id}/ledger-items`, data)
    return result
  },

  async updateLedgerItem(id: number, itemId: number, patch: { subject?: string; amount?: string }): Promise<LedgerItemResult> {
    const { data } = await api.patch<LedgerItemResult>(`${BASE}/proceedings/${id}/ledger-items/${itemId}`, patch)
    return data
  },

  async archiveLedgerItem(id: number, itemId: number): Promise<LedgerItemResult> {
    const { data } = await api.post<LedgerItemResult>(`${BASE}/proceedings/${id}/ledger-items/${itemId}/archive`)
    return data
  },

  async completeStage(id: number, stageKey: string, confirm = false): Promise<LegalProceedingDetail> {
    const { data } = await api.post<LegalProceedingDetail>(`${BASE}/proceedings/${id}/stages/${stageKey}/complete`, { confirm })
    return data
  },

  async skipStage(id: number, stageKey: string, reason?: string): Promise<LegalProceedingDetail> {
    const { data } = await api.post<LegalProceedingDetail>(`${BASE}/proceedings/${id}/stages/${stageKey}/skip`, { reason: reason || null })
    return data
  },

  async reopenStage(id: number, stageKey: string, reason?: string): Promise<LegalProceedingDetail> {
    const { data } = await api.post<LegalProceedingDetail>(`${BASE}/proceedings/${id}/stages/${stageKey}/reopen`, { reason: reason || null })
    return data
  },

  async entries(id: number, filters: EntryFilters): Promise<LegalEntryPage> {
    const { data } = await api.get<LegalEntryPage>(`${BASE}/proceedings/${id}/entries`, { params: filters })
    return data
  },

  /** Multipart, so a communication record is created together with its files. */
  async createEntry(id: number, entry: NewEntry): Promise<LegalEntry> {
    const form = new FormData()
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'files') continue
      if (value !== undefined && value !== null && value !== '') form.append(key, String(value))
    }
    for (const file of entry.files ?? []) form.append('files', file)
    const { data } = await api.post<LegalEntry>(`${BASE}/proceedings/${id}/entries`, form)
    return data
  },

  async updateEntry(id: number, entryId: number, patch: { content?: string | null; channel?: Channel; occurred_at?: string }): Promise<LegalEntry> {
    const { data } = await api.patch<LegalEntry>(`${BASE}/proceedings/${id}/entries/${entryId}`, patch)
    return data
  },

  async deleteEntry(id: number, entryId: number): Promise<void> {
    await api.delete(`${BASE}/proceedings/${id}/entries/${entryId}`)
  },

  async uploadEntryDocuments(id: number, entryId: number, files: File[]): Promise<LegalDocument[]> {
    const form = new FormData()
    for (const file of files) form.append('files', file)
    const { data } = await api.post<LegalDocument[]>(`${BASE}/proceedings/${id}/entries/${entryId}/documents`, form)
    return data
  },

  async deleteEntryDocument(id: number, entryId: number, documentId: number): Promise<void> {
    await api.delete(`${BASE}/proceedings/${id}/entries/${entryId}/documents/${documentId}`)
  },

  async documents(id: number): Promise<LegalDocument[]> {
    const { data } = await api.get<LegalDocument[]>(`${BASE}/proceedings/${id}/documents`)
    return data
  },

  /** A general document (no keys) or a stage component document (both keys). */
  async uploadDocuments(id: number, files: File[], target?: { stage_key: string; component_key: string }): Promise<LegalDocument[]> {
    const form = new FormData()
    for (const file of files) form.append('files', file)
    if (target) { form.append('stage_key', target.stage_key); form.append('component_key', target.component_key) }
    const { data } = await api.post<LegalDocument[]>(`${BASE}/proceedings/${id}/documents`, form)
    return data
  },

  async deleteDocument(id: number, documentId: number): Promise<void> {
    await api.delete(`${BASE}/proceedings/${id}/documents/${documentId}`)
  },

  // ── team (primary owner + assigned users) ──────────────────────────────────

  async team(id: number): Promise<LegalTeam> {
    const { data } = await api.get<LegalTeam>(`${BASE}/proceedings/${id}/team`)
    return data
  },

  /**
   * Replaces the proceeding's assigned users with exactly ``userIds`` (``[]``
   * removes everyone) — the collection pattern: the full set in one ``PATCH``,
   * all or nothing. Independent of any screen, so a proceeding edit form can use
   * it, or send ``assignee_ids`` within its own update. The server checks the
   * users and the permission and writes an audit entry per user added or removed.
   * The creator is the primary owner and is never sent.
   */
  async saveAssignees(id: number, userIds: number[]): Promise<SaveAssigneesResult> {
    const before = await LegalAPI.team(id)
    const wanted = [...new Set(userIds)].filter((userId) => userId !== before.owner?.id)
    await api.patch(`${BASE}/proceedings/${id}`, { assignee_ids: wanted })
    const team = await LegalAPI.team(id)
    const beforeIds = new Set(before.assignees.map((a) => a.user.id))
    const afterIds = new Set(team.assignees.map((a) => a.user.id))
    return {
      added: [...afterIds].filter((userId) => !beforeIds.has(userId)),
      removed: [...beforeIds].filter((userId) => !afterIds.has(userId)),
      team,
    }
  },

  async searchContacts(search: string): Promise<ContactSummary[]> {
    const { data } = await api.get<ContactSummary[]>(`${BASE}/contacts`, { params: { search, limit: 20 } })
    return data
  },
}
