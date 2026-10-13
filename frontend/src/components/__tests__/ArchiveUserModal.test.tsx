/**
 * Tests for ArchiveUserModal
 */
import type { ComponentProps } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ArchiveUserModal from '../ArchiveUserModal'

const renderModal = (props: Partial<ComponentProps<typeof ArchiveUserModal>> = {}) => {
  const onClose = vi.fn()
  const onConfirm = vi.fn()
  render(
    <ArchiveUserModal open userName="Dana" onClose={onClose} onConfirm={onConfirm} {...props} />
  )
  return { onClose, onConfirm }
}

describe('ArchiveUserModal', () => {
  it('renders nothing when closed', () => {
    renderModal({ open: false })
    expect(screen.queryByText('אישור העברה לארכיון')).toBeNull()
  })

  it('shows the archive message with the user name', () => {
    renderModal()
    expect(screen.getByText('האם להעביר את המשתמש Dana לארכיון?')).toBeTruthy()
    expect(screen.getByText('המשתמש לא יוכל להתחבר למערכת וכל הרשאותיו יבוטלו.')).toBeTruthy()
    expect(screen.getByText('פרטיו ונתוניו יישמרו.')).toBeTruthy()
  })

  it('cancel calls onClose only', async () => {
    const { onClose, onConfirm } = renderModal()
    await userEvent.click(screen.getByText('ביטול'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirm calls onConfirm', async () => {
    const { onClose, onConfirm } = renderModal()
    await userEvent.click(screen.getByText('אישור העברה לארכיון'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('disables both buttons while loading', () => {
    renderModal({ loading: true })
    expect((screen.getByText('מעביר לארכיון...') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('ביטול') as HTMLButtonElement).disabled).toBe(true)
  })
})
