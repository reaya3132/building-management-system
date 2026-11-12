import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ default: { get: vi.fn(), patch: vi.fn() } }))

import api from '../api'
import { LegalAPI } from '../legalApi'

const http = api as unknown as { get: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> }
const user = (id: number) => ({ id, full_name: `משתמש ${id}` })
const team = (...ids: number[]) => ({
  owner: user(1),
  assignees: ids.map((id) => ({ user: user(id), assigned_by: user(1), assigned_at: '2026-11-12T00:00:00Z' })),
})

describe('LegalAPI.saveAssignees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    http.patch.mockResolvedValue({ data: {} })
  })

  it('sends the full set in one PATCH and reports the difference from the team the server returns', async () => {
    http.get.mockResolvedValueOnce({ data: team(2, 3) }).mockResolvedValueOnce({ data: team(3, 4) })

    const result = await LegalAPI.saveAssignees(7, [3, 4, 4])

    expect(http.patch).toHaveBeenCalledTimes(1)
    expect(http.patch).toHaveBeenCalledWith('/legal/proceedings/7', { assignee_ids: [3, 4] })
    expect(result).toEqual({ added: [4], removed: [2], team: team(3, 4) })
  })

  it('never sends the creator, and [] removes everyone', async () => {
    http.get.mockResolvedValueOnce({ data: team(3) }).mockResolvedValueOnce({ data: team() })

    const result = await LegalAPI.saveAssignees(7, [1])

    expect(http.patch).toHaveBeenCalledWith('/legal/proceedings/7', { assignee_ids: [] })
    expect(result.removed).toEqual([3])
  })

  it('is all or nothing: a rejected PATCH is thrown to the caller', async () => {
    const refusal = { response: { status: 422, data: { detail: { code: 'user_not_assignable' } } } }
    http.get.mockResolvedValue({ data: team(2) })
    http.patch.mockRejectedValueOnce(refusal)
    await expect(LegalAPI.saveAssignees(7, [2, 5])).rejects.toBe(refusal)
  })

  it('sends nothing when the current team cannot be read', async () => {
    http.get.mockRejectedValue(new Error('offline'))
    await expect(LegalAPI.saveAssignees(7, [4])).rejects.toThrow('offline')
    expect(http.patch).not.toHaveBeenCalled()
  })
})
