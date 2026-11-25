import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../../lib/collectionApi', () => ({
  CollectionAPI: {
    vatRate: vi.fn(async () => '0.1800'),
    addAdjustment: vi.fn(async () => ({})),
    updateInitialAmount: vi.fn(async () => ({})),
    updateAdjustmentVat: vi.fn(async () => ({})),
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
  initial_vat: { vat_included: true, vat_rate: '0.1800', net_amount: '84.75', vat_amount: '15.25', gross_amount: '100.00' },
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
    // The VAT choice defaults to "included" (the amount to pay is the amount typed).
    expect(CollectionAPI.addAdjustment).toHaveBeenCalledWith(7, '-40', 'הנחת ותק', true)
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

describe('CollectionAmountsPanel VAT display', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the amount to pay marked "כולל מע״מ", with no breakdown and nothing beside adjustments', () => {
    renderPanel({
      total_amount: '236.00',
      initial_amount: '200.00',
      initial_vat: { vat_included: false, vat_rate: '0.1800', net_amount: '200.00', vat_amount: '36.00', gross_amount: '236.00' },
      adjustments: [{ id: 1, amount: '10.00', note: 'קנס', created_at: '' }],
    } as Partial<CollectionTaskDetail>)
    // The initial amount to pay and the total, each marked; the adjustment is not.
    expect(screen.getAllByText(/236.00/, { selector: 'bdi' })).toHaveLength(2)
    expect(screen.getAllByText('כולל מע״מ', { selector: 'span' })).toHaveLength(2)
    expect(screen.queryByText(/לפני מע״מ/, { selector: 'span' })).not.toBeInTheDocument()
    expect(screen.queryByText(/18%/, { selector: 'span' })).not.toBeInTheDocument()
  })

  it('marks nothing for an amount saved before VAT support', () => {
    renderPanel({
      initial_vat: { vat_included: null, vat_rate: null, net_amount: null, vat_amount: null, gross_amount: '100.00' },
    } as Partial<CollectionTaskDetail>)
    expect(screen.queryByText('כולל מע״מ', { selector: 'span' })).not.toBeInTheDocument()
  })
})


describe('CollectionAmountsPanel adjustment VAT', () => {
  beforeEach(() => vi.clearAllMocks())

  const adjVat = (amount: string, gross: string, vat_included: boolean | null) => ({
    amount, gross_amount: gross, vat_included, vat_rate: vat_included == null ? null : '0.1800',
    net_amount: null, vat_amount: null,
  })

  it('shows each adjustment as its amount to pay, always marked "כולל מע״מ"', () => {
    renderPanel({
      total_amount: '1000.00',
      adjustments: [
        { id: 1, note: 'קנס', created_at: '', ...adjVat('100.00', '118.00', false) },
        { id: 2, note: 'דמי טיפול', created_at: '', ...adjVat('50.00', '50.00', true) },
        { id: 3, note: 'הנחה', created_at: '', ...adjVat('-100.00', '-118.00', false) },
        { id: 4, note: 'ישן', created_at: '', ...adjVat('20.00', '20.00', null) },
      ],
    } as Partial<CollectionTaskDetail>)
    expect(screen.getAllByText(/118\.00/, { selector: 'bdi' })).toHaveLength(2)
    expect(screen.queryByText('ללא מע״מ', { selector: 'span' })).not.toBeInTheDocument()
    // "כולל מע״מ": the initial amount, the total and adjustments 1-3 — never the old adjustment 4.
    expect(screen.getAllByText('כולל מע״מ', { selector: 'span' })).toHaveLength(5)
    expect(screen.queryByText(/18%|לפני מע״מ/, { selector: 'span' })).not.toBeInTheDocument()
  })

  it('adds an adjustment without VAT', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('radio', { name: 'ללא מע״מ' }))
    await user.type(screen.getByRole('textbox', { name: 'סכום התוספת' }), '100')
    await user.type(screen.getByRole('textbox', { name: 'פירוט השינוי' }), 'קנס איחור')
    await user.click(screen.getByRole('button', { name: /הוסף תוספת/ }))
    expect(CollectionAPI.addAdjustment).toHaveBeenCalledWith(7, '100', 'קנס איחור', false)
  })

  it('pre-checks a reduction by its amount to pay (VAT added)', async () => {
    const user = userEvent.setup()
    renderPanel({ total_amount: '110.00', adjustments: [] } as Partial<CollectionTaskDetail>)
    await user.click(screen.getByRole('radio', { name: 'הפחתה' }))
    await user.click(screen.getByRole('radio', { name: 'ללא מע״מ' }))
    await user.type(screen.getByRole('textbox', { name: 'סכום ההפחתה' }), '100')
    await user.type(screen.getByRole('textbox', { name: 'פירוט השינוי' }), 'הנחה')
    await user.click(screen.getByRole('button', { name: /הוסף הפחתה/ }))
    // -100 without VAT is -118 > 110.
    expect(await screen.findByText(/לא יכול להיות שלילי/)).toBeInTheDocument()
    expect(CollectionAPI.addAdjustment).not.toHaveBeenCalled()
  })

  it('offers no editing of an adjustment', () => {
    renderPanel({
      total_amount: '1050.00',
      adjustments: [{ id: 9, note: 'דמי טיפול', created_at: '', ...adjVat('50.00', '50.00', true) }],
    } as Partial<CollectionTaskDetail>)
    expect(screen.queryByRole('button', { name: 'ערוך מע״מ דמי טיפול' })).not.toBeInTheDocument()
  })
})
