/**
 * Tests for RestoreUserModal
 */
import type { ComponentProps } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RestoreUserModal from '../RestoreUserModal'

const renderModal = (props: Partial<ComponentProps<typeof RestoreUserModal>> = {}) => {
  const onClose = vi.fn()
  const onConfirm = vi.fn()
  render(
    <RestoreUserModal open userName="Dana" onClose={onClose} onConfirm={onConfirm} {...props} />
  )
  return { onClose, onConfirm }
}

describe('RestoreUserModal', () => {
  it('renders nothing when closed', () => {
    renderModal({ open: false })
    expect(screen.queryByText('אישור שחזור')).toBeNull()
  })

  it('shows the restore message with the user name', () => {
    renderModal()
    expect(screen.getByText('האם לשחזר את המשתמש Dana מהארכיון?')).toBeTruthy()
  })

  it('cancel calls onClose only', async () => {
    const { onClose, onConfirm } = renderModal()
    await userEvent.click(screen.getByText('ביטול'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirm calls onConfirm', async () => {
    const { onClose, onConfirm } = renderModal()
    await userEvent.click(screen.getByText('אישור שחזור'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('disables both buttons while loading', () => {
    renderModal({ loading: true })
    expect((screen.getByText('משחזר...') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('ביטול') as HTMLButtonElement).disabled).toBe(true)
  })
})
