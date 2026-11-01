import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import FundAndUnforeseenPanel from '../../../pages/ProjectDetail/components/FundAndUnforeseenPanel'

const fund = { current_balance: 1000, initial_total: 1500, total_deductions: 500, monthly_amount: 100, transactions: [] }
const noop = () => {}

function renderPanel(fundNotes?: React.ReactNode) {
  return render(
    <FundAndUnforeseenPanel
      fundData={fund}
      fundLoading={false}
      unforeseenTransactions={[]}
      unforeseenTransactionsLoading={false}
      onShowFundTransactionsModal={noop}
      onShowEditFundModal={noop}
      onShowUnforeseenTransactionsModal={noop}
      onShowCreateUnforeseenTransactionModal={noop}
      onResetUnforeseenForm={noop}
      fundNotes={fundNotes}
    />
  )
}

describe('fund documentation placement', () => {
  it('renders the fund notes directly below the fund card, before the unforeseen card', () => {
    const { container } = renderPanel(<section aria-label="תיעוד הקופה">board</section>)
    const panel = container.querySelector('.fund-unforeseen-panel')!
    const children = Array.from(panel.children)
    const fundCard = children.findIndex((el) => el.classList.contains('fund-panel-card'))
    const slot = children.findIndex((el) => el.classList.contains('fund-notes-slot'))
    const unforeseen = children.findIndex((el) => el.classList.contains('unforeseen-panel-card'))
    expect([fundCard, slot, unforeseen]).toEqual([0, 1, 2])
    expect(screen.getByRole('region', { name: 'תיעוד הקופה' })).toBeInTheDocument()
  })

  it('leaves the panel unchanged when no fund notes are given', () => {
    const { container } = renderPanel()
    expect(container.querySelector('.fund-notes-slot')).toBeNull()
    expect(container.querySelector('.fund-unforeseen-panel')!.children).toHaveLength(2)
  })
})
