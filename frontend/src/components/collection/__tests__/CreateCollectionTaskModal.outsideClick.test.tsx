import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import authReducer from '../../../store/slices/authSlice'
import { Wallet } from 'lucide-react'

vi.mock('../../../lib/collectionApi', () => ({
  CollectionAPI: {
    projectOptions: vi.fn(async () => []),
    create: vi.fn(),
  },
}))
vi.mock('../../../lib/api', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: [] }) },
  avatarUrl: (p: string | null) => p,
  fileAttachmentUrl: (p: string | null) => p,
}))

import CreateCollectionTaskModal from '../CreateCollectionTaskModal'
import CollectionModal from '../CollectionModal'

const backdrop = () => document.querySelector('.fixed.inset-0') as HTMLElement

function renderCreate(onClose = vi.fn()) {
  const store = configureStore({
    reducer: { auth: authReducer },
    preloadedState: { auth: { me: { id: 5, role: 'Member', full_name: 'בודק' } } as any },
  })
  render(
    <Provider store={store}>
      <CreateCollectionTaskModal isOpen onClose={onClose} defaultMonth="2026-10-01" onCreated={vi.fn()} />
    </Provider>
  )
  return onClose
}

describe('CreateCollectionTaskModal outside click', () => {
  it('keeps the dialog open and the entered data when clicking the backdrop', async () => {
    const onClose = renderCreate()
    const title = screen.getByPlaceholderText('לדוגמה: דמי ניהול')
    await userEvent.type(title, 'דמי ניהול נובמבר')

    await userEvent.click(backdrop())
    await userEvent.click(backdrop())

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('משימת גבייה חדשה')).toBeInTheDocument()
    expect(title).toHaveValue('דמי ניהול נובמבר')
  })

  it('still closes via the X button', async () => {
    const onClose = renderCreate()
    await userEvent.click(screen.getByRole('button', { name: 'סגירה' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('still closes via the cancel button', async () => {
    const onClose = renderCreate()
    await userEvent.click(screen.getByRole('button', { name: 'ביטול' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('CollectionModal default behaviour (other dialogs)', () => {
  it('still closes on backdrop click by default', async () => {
    const onClose = vi.fn()
    render(<CollectionModal isOpen onClose={onClose} icon={Wallet} title="אחר">תוכן</CollectionModal>)
    await userEvent.click(backdrop())
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('does not close when clicking inside the dialog', async () => {
    const onClose = vi.fn()
    render(<CollectionModal isOpen onClose={onClose} icon={Wallet} title="אחר">תוכן</CollectionModal>)
    await userEvent.click(screen.getByText('תוכן'))
    expect(onClose).not.toHaveBeenCalled()
  })
})
