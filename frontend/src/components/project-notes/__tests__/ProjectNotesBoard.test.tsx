import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ProjectNote } from '../../../lib/projectNotesApi'

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), history: vi.fn() }))
vi.mock('../../../lib/projectNotesApi', () => ({ ProjectNotesAPI: api }))
vi.mock('../../../lib/api', () => ({ default: {}, avatarUrl: (p: string | null) => p }))

import ProjectNotesBoard from '../ProjectNotesBoard'
import { formatNoteDate } from '../noteUtils'

const user = (id: number, full_name: string) => ({ id, full_name, avatar_url: null })

function note(id: number, overrides: Partial<ProjectNote> = {}): ProjectNote {
  return {
    id, project_id: 4, board: 'general', title: `רשומה ${id}`, content: `תוכן ${id}`,
    created_by: user(5, 'דנה'), created_at: '2026-11-01T08:15:00Z',
    updated_by: null, updated_at: null, can_modify: false, ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('ProjectNotesBoard', () => {
  it('shows each note as a card with its own author, date and time, and the editor when edited', async () => {
    api.list.mockResolvedValue({
      items: [
        note(2, { updated_by: user(7, 'יוסי'), updated_at: '2026-11-01T10:30:00Z' }),
        note(1, { created_at: '2026-10-28T16:05:00Z' }),
      ],
      next_before_id: null,
    })
    render(<ProjectNotesBoard projectId={4} board="general" />)

    const cards = await screen.findAllByRole('article')
    expect(cards).toHaveLength(2)
    const first = formatNoteDate('2026-11-01T08:15:00Z')
    expect(within(cards[0]).getByText('דנה')).toBeInTheDocument()
    expect(within(cards[0]).getByText(new RegExp(`${first.date} ${first.time}`))).toBeInTheDocument()
    expect(within(cards[0]).getByText(/נערך ע״י יוסי/)).toBeInTheDocument()
    const second = formatNoteDate('2026-10-28T16:05:00Z')
    expect(within(cards[1]).getByText(new RegExp(`${second.date} ${second.time}`))).toBeInTheDocument()
    expect(within(cards[1]).queryByText(/נערך/)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'תיעוד הפרויקט' })).toBeInTheDocument()
    expect(api.list).toHaveBeenCalledWith(4, 'general', { search: '', limit: 20 })
  })

  it('uses the board it is given (fund) for every call', async () => {
    api.list.mockResolvedValue({ items: [note(3, { board: 'fund', can_modify: true })], next_before_id: null })
    api.history.mockResolvedValue([])
    const u = userEvent.setup()
    render(<ProjectNotesBoard projectId={4} board="fund" embedded />)
    expect(await screen.findByRole('heading', { name: 'תיעוד הקופה' })).toBeInTheDocument()
    expect(api.list).toHaveBeenCalledWith(4, 'fund', expect.anything())
    await u.click(screen.getByRole('button', { name: /היסטוריה של/ }))
    await waitFor(() => expect(api.history).toHaveBeenCalledWith(4, 'fund', 3))
  })

  it('shows edit / delete only where the server allows it', async () => {
    api.list.mockResolvedValue({ items: [note(2, { can_modify: true }), note(1)], next_before_id: null })
    render(<ProjectNotesBoard projectId={4} board="general" />)
    const [mine, others] = await screen.findAllByRole('article')
    expect(within(mine).getByRole('button', { name: /עריכת/ })).toBeInTheDocument()
    expect(within(mine).getByRole('button', { name: /מחיקת/ })).toBeInTheDocument()
    expect(within(others).queryByRole('button', { name: /עריכת/ })).not.toBeInTheDocument()
    expect(within(others).queryByRole('button', { name: /מחיקת/ })).not.toBeInTheDocument()
  })

  it('searches (debounced) and loads older notes with the cursor', async () => {
    const u = userEvent.setup()
    api.list
      .mockResolvedValueOnce({ items: [note(3), note(2)], next_before_id: 2 })
      .mockResolvedValueOnce({ items: [note(1)], next_before_id: null })
      .mockResolvedValue({ items: [note(2)], next_before_id: null })
    render(<ProjectNotesBoard projectId={4} board="general" />)
    await screen.findByText('רשומה 3')

    await u.click(screen.getByRole('button', { name: 'טען עוד' }))
    await screen.findByText('רשומה 1')
    expect(api.list).toHaveBeenLastCalledWith(4, 'general', { search: '', beforeId: 2, limit: 20 })
    expect(screen.queryByRole('button', { name: 'טען עוד' })).not.toBeInTheDocument()

    await u.type(screen.getByRole('textbox', { name: /חיפוש/ }), 'מעלית')
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(4, 'general', { search: 'מעלית', limit: 20 }))
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1))
  })

  it('creates a note and reloads the first page', async () => {
    const u = userEvent.setup()
    api.list.mockResolvedValueOnce({ items: [], next_before_id: null })
      .mockResolvedValue({ items: [note(9, { title: 'פגישה' })], next_before_id: null })
    api.create.mockResolvedValue(note(9))
    render(<ProjectNotesBoard projectId={4} board="general" />)
    await screen.findByText('אין רשומות עדיין')

    await u.click(screen.getByRole('button', { name: /רשומה חדשה/ }))
    const dialogTitle = screen.getByText('כותרת').closest('label')!.querySelector('input')!
    await u.type(dialogTitle, '  פגישה  ')
    await u.type(screen.getByText('תוכן (לא חובה)').closest('label')!.querySelector('textarea')!, 'סוכם')
    await u.click(screen.getByRole('button', { name: 'שמירה' }))

    await waitFor(() => expect(api.create).toHaveBeenCalledWith(4, 'general', { title: 'פגישה', content: 'סוכם' }))
    expect(await screen.findByText('פגישה')).toBeInTheDocument()
  })

  it('edits by sending only the changed field, and deletes after confirmation', async () => {
    const u = userEvent.setup()
    api.list.mockResolvedValue({ items: [note(2, { can_modify: true })], next_before_id: null })
    api.update.mockResolvedValue(note(2, { can_modify: true, content: 'תוכן חדש', updated_by: user(5, 'דנה'), updated_at: '2026-11-01T09:00:00Z' }))
    api.remove.mockResolvedValue(undefined)
    render(<ProjectNotesBoard projectId={4} board="general" />)
    await screen.findByText('רשומה 2')

    await u.click(screen.getByRole('button', { name: /עריכת/ }))
    const content = screen.getByDisplayValue('תוכן 2')
    await u.clear(content)
    await u.type(content, 'תוכן חדש')
    await u.click(screen.getByRole('button', { name: 'שמירה' }))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(4, 'general', 2, { content: 'תוכן חדש' }))
    expect(await screen.findByText('תוכן חדש')).toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: /מחיקת/ }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(4, 'general', 2))
    await waitFor(() => expect(screen.queryAllByRole('article')).toHaveLength(0))
  })

  it('shows the server reason when the board is unavailable', async () => {
    api.list.mockRejectedValue({ response: { status: 409, data: { detail: { code: 'no_fund', message: 'x' } } } })
    render(<ProjectNotesBoard projectId={4} board="fund" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('לפרויקט אין קופה')
  })
})

describe('optional content', () => {
  it('saves a note with a title only and shows it without a body', async () => {
    const u = userEvent.setup()
    api.list.mockResolvedValueOnce({ items: [], next_before_id: null })
      .mockResolvedValue({ items: [note(11, { title: 'רק כותרת', content: '' })], next_before_id: null })
    api.create.mockResolvedValue(note(11, { title: 'רק כותרת', content: '' }))
    render(<ProjectNotesBoard projectId={4} board="fund" />)
    await screen.findByText('אין רשומות עדיין')

    await u.click(screen.getByRole('button', { name: /רשומה חדשה/ }))
    await u.type(screen.getByText('כותרת').closest('label')!.querySelector('input')!, 'רק כותרת')
    await u.click(screen.getByRole('button', { name: 'שמירה' }))

    await waitFor(() => expect(api.create).toHaveBeenCalledWith(4, 'fund', { title: 'רק כותרת', content: '' }))
    const card = await screen.findByRole('article')
    expect(within(card).getByText('רק כותרת')).toBeInTheDocument()
    expect(card.querySelector('p.whitespace-pre-wrap')).toBeNull()
  })
})

describe('height and scrolling', () => {
  it('is compact with no notes, and capped with an inner-scrolling list once notes exist', async () => {
    const u = userEvent.setup()
    api.list.mockResolvedValueOnce({ items: [], next_before_id: null })
      .mockResolvedValue({ items: [note(1, { can_modify: true })], next_before_id: null })
    api.create.mockResolvedValue(note(1))
    api.remove.mockResolvedValue(undefined)
    render(<ProjectNotesBoard projectId={4} board="general" />)

    const board = screen.getByRole('region', { name: 'תיעוד הפרויקט' })
    await screen.findByText('אין רשומות עדיין')
    expect(board.className).not.toContain('max-h-[32rem]')
    expect(screen.queryByTestId('notes-scroll')).toBeNull()

    // After adding a note: capped card, only the list scrolls, header and search outside it.
    await u.click(screen.getByRole('button', { name: /רשומה חדשה/ }))
    await u.type(screen.getByText('כותרת').closest('label')!.querySelector('input')!, 'ראשונה')
    await u.click(screen.getByRole('button', { name: 'שמירה' }))
    const list = await screen.findByTestId('notes-scroll')
    expect(board.className).toContain('max-h-[32rem]')
    expect(list.className).toContain('overflow-y-auto')
    expect(list).not.toContainElement(screen.getByRole('heading', { name: 'תיעוד הפרויקט' }))
    expect(list).not.toContainElement(screen.getByRole('textbox', { name: /חיפוש/ }))
    expect(list).not.toContainElement(screen.getByRole('button', { name: /רשומה חדשה/ }))

    // Deleting the last note returns to the compact card.
    await u.click(within(list).getByRole('button', { name: /מחיקת/ }))
    await screen.findByText('אין רשומות עדיין')
    expect(board.className).not.toContain('max-h-[32rem]')
    expect(screen.queryByTestId('notes-scroll')).toBeNull()
  })
})
