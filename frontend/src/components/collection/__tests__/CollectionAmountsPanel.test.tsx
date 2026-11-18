import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../../lib/collectionApi', () => ({
  CollectionAPI: {
    addAdjustment: vi.fn(async () => ({})),
    updateInitialAmount: vi.fn(async () => ({})),
  },
}))
vi.mock('../../../lib/api', () => ({
  default: { get: vi.fn() },
  avatarUrl: (p: string | null) => p,
  fileAttachmentUrl: (p: string | null) => p,
}))

import CollectionAmountsPanel from '../CollectionAmountsPanel'
import { CollectionAPI, type CollectionTaskDetail } from '../../../lib/collectionApi'

const task = {
  id: 7, title: 'דמי ניהול', status: 'open', collection_type: 'single', billing_month: '2026-10-01',
  project: { id: 2, name: 'כניסה 1' }, assignees: [], total_amount: '100.00', is_archived: false,
  unread_messages_count: 0, created_at: '', updated_at: '', description: null, initial_amount: '100.00',
  adjustments: [
    { id: 1, amount: '-30.00', note: 'הנחה', created_at: '2026-10-02T00:00:00Z' },
    { id: 2, amount: '30.00', note: 'קנס', created_at: '2026-10-03T00:00:00Z' },
  ],
  ledger_items: [], attachments: [], created_by_user_id: 5,
} as unknown as CollectionTaskDetail

function renderPanel(overrides: Partial<CollectionTaskDetail> = {}) {
  const onChanged = vi.fn()
  render(<CollectionAmountsPanel task={{ ...task, ...overrides }} canChange onChanged={onChanged} />)
  return { onChanged }
}

describe('CollectionAmountsPanel (single)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows reductions and additions with their detail and sign', () => {
    renderPanel()
    expect(screen.getByText('הנחה')).toBeInTheDocument()
    expect(screen.getByText('קנס')).toBeInTheDocument()
    expect(screen.getByText((t) => t.startsWith('−') && t.includes('30.00'))).toBeInTheDocument()
    expect(screen.getByText((t) => t.startsWith('+') && t.includes('30.00'))).toBeInTheDocument()
  })

  it('requires a non-blank detail before adding', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.type(screen.getByRole('textbox', { name: 'סכום התוספת' }), '10')
    const submit = screen.getByRole('button', { name: /הוסף תוספת/ })
    expect(submit).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'פירוט השינוי' }), '   ')
    expect(submit).toBeDisabled()
    expect(CollectionAPI.addAdjustment).not.toHaveBeenCalled()
  })

  it('sends a reduction as a negative amount with the trimmed detail', async () => {
    const user = userEvent.setup()
    const { onChanged } = renderPanel()
    await user.click(screen.getByRole('radio', { name: 'הפחתה' }))
    await user.type(screen.getByRole('textbox', { name: 'סכום ההפחתה' }), '40')
    await user.type(screen.getByRole('textbox', { name: 'פירוט השינוי' }), '  הנחת ותק  ')
    await user.click(screen.getByRole('button', { name: /הוסף הפחתה/ }))
    expect(CollectionAPI.addAdjustment).toHaveBeenCalledWith(7, '-40', 'הנחת ותק')
    expect(onChanged).toHaveBeenCalled()
  })

  it('blocks a reduction that would make the total negative (client pre-check)', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('radio', { name: 'הפחתה' }))
    await user.type(screen.getByRole('textbox', { name: 'סכום ההפחתה' }), '100.01')
    await user.type(screen.getByRole('textbox', { name: 'פירוט השינוי' }), 'יותר מדי')
    await user.click(screen.getByRole('button', { name: /הוסף הפחתה/ }))
    expect(await screen.findByText(/לא יכול להיות שלילי/)).toBeInTheDocument()
    expect(CollectionAPI.addAdjustment).not.toHaveBeenCalled()
  })

  it('edits the initial amount, and pre-checks it against reductions', async () => {
    const user = userEvent.setup()
    renderPanel({ total_amount: '20.00', adjustments: [{ id: 1, amount: '-80.00', note: 'הנחה', created_at: '' }] } as Partial<CollectionTaskDetail>)
    await user.click(screen.getByRole('button', { name: 'ערוך סכום התחלתי' }))
    const input = screen.getByRole('textbox', { name: 'סכום התחלתי חדש' })
    await user.clear(input)
    await user.type(input, '79.99')
    await user.click(screen.getByRole('button', { name: 'שמור סכום התחלתי' }))
    expect(await screen.findByText(/לא יכול להיות שלילי/)).toBeInTheDocument()
    expect(CollectionAPI.updateInitialAmount).not.toHaveBeenCalled()

    await user.clear(input)
    await user.type(input, '80')
    await user.click(screen.getByRole('button', { name: 'שמור סכום התחלתי' }))
    expect(CollectionAPI.updateInitialAmount).toHaveBeenCalledWith(7, '80')
  })
})
