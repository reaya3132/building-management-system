import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MonthStrip from '../MonthStrip'

describe('MonthStrip', () => {
  it('shows the 12 months with their counts and marks the selected one', () => {
    render(<MonthStrip month="2026-10" counts={{ '2026-03': 4, '2026-10': 2 }} onSelect={() => {}} />)
    const months = screen.getAllByRole('button', { name: /2026:/ })
    expect(months).toHaveLength(12)
    expect(screen.getByRole('button', { name: /2026: 4 פתוחות/ })).toHaveTextContent('4')
    const selected = months.find((b) => b.getAttribute('aria-current') === 'date')
    expect(selected).toHaveAccessibleName(/2026: 2 פתוחות/)
  })

  it('selects a month and moves between years', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<MonthStrip month="2026-10" counts={{}} onSelect={onSelect} />)
    await user.click(screen.getAllByRole('button', { name: /2026:/ })[2])
    expect(onSelect).toHaveBeenLastCalledWith('2026-03')
    await user.click(screen.getByRole('button', { name: 'השנה הבאה' }))
    expect(onSelect).toHaveBeenLastCalledWith('2027-10')
  })
})
