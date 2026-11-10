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
  apartment_number: string
  claim_amount: string | null
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
}

export interface NewContactDetails {
  kind: 'person' | 'business'
  name: string
  phone: string
  phone_2?: string | null
  email: string
  address: string
}

/** Exactly one: an existing contact, used as it is, or the details of a new one. */
export type PartySelection = { contact_id: number } | { details: NewContactDetails }

export interface LegalProceedingCreateInput {
  party_role: PartyRole
  apartment_number: string
  title: string
  contact: PartySelection
  landlord?: PartySelection
  project_id?: number | null
  claim_amount?: string | null
  claim_details?: string | null
  confirm_open_proceeding?: boolean
  confirm_duplicate_contact?: boolean
}

export interface LegalStage {
  key: string
  label: string
  position: number
  status: StageStatus
}

export interface LegalProceedingDetail {
  id: number
  title: string
  status: ProceedingStatus
  party_role: PartyRole
  apartment_number: string
  claim_details: string | null
  claim_amount: string | null
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

  async searchContacts(search: string): Promise<ContactSummary[]> {
    const { data } = await api.get<ContactSummary[]>(`${BASE}/contacts`, { params: { search, limit: 20 } })
    return data
  },
}
