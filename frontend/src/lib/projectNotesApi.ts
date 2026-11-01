import api from './api'

/**
 * API layer for project documentation boards — mirrors
 * backend/api/v1/endpoints/project_notes.py. One API for every board; the
 * board is part of the path, so boards never mix.
 */

export type NoteBoard = 'general' | 'fund'

export interface NoteUser {
  id: number
  full_name: string
  avatar_url?: string | null
}

export interface ProjectNote {
  id: number
  project_id: number
  board: NoteBoard
  title: string
  content: string
  created_by: NoteUser | null
  created_at: string
  updated_by: NoteUser | null
  updated_at: string | null
  /** Whether the current user may edit / delete it (author or project manager). */
  can_modify: boolean
}

export interface NotePage {
  items: ProjectNote[]
  /** Cursor for the next (older) page; null on the last page. */
  next_before_id: number | null
}

export interface NoteHistoryEntry {
  id: number
  action: 'created' | 'updated' | 'deleted' | string
  user_id: number | null
  user_name: string | null
  details: {
    before?: Partial<Pick<ProjectNote, 'title' | 'content'>>
    after?: Partial<Pick<ProjectNote, 'title' | 'content'>>
    [key: string]: unknown
  } | null
  created_at: string
}

export interface NoteInput {
  title: string
  content: string
}

const base = (projectId: number, board: NoteBoard) => `/projects/${projectId}/notes/${board}`

export const ProjectNotesAPI = {
  async list(projectId: number, board: NoteBoard, opts: { search?: string; beforeId?: number | null; limit?: number } = {}): Promise<NotePage> {
    const params: Record<string, string | number> = { limit: opts.limit ?? 20 }
    if (opts.search?.trim()) params.search = opts.search.trim()
    if (opts.beforeId != null) params.before_id = opts.beforeId
    const { data } = await api.get<NotePage>(base(projectId, board), { params })
    return data
  },

  async create(projectId: number, board: NoteBoard, input: NoteInput): Promise<ProjectNote> {
    const { data } = await api.post<ProjectNote>(base(projectId, board), input)
    return data
  },

  async update(projectId: number, board: NoteBoard, noteId: number, input: Partial<NoteInput>): Promise<ProjectNote> {
    const { data } = await api.patch<ProjectNote>(`${base(projectId, board)}/${noteId}`, input)
    return data
  },

  async remove(projectId: number, board: NoteBoard, noteId: number): Promise<void> {
    await api.delete(`${base(projectId, board)}/${noteId}`)
  },

  async history(projectId: number, board: NoteBoard, noteId: number): Promise<NoteHistoryEntry[]> {
    const { data } = await api.get<NoteHistoryEntry[]>(`${base(projectId, board)}/${noteId}/history`)
    return data
  },
}
