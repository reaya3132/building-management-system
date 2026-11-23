/**
 * CreateTaskModal (calendar, backlog, reception desk) — like a new collection
 * task, the creator starts as the primary assignee, can be removed (the next one
 * becomes primary), and at least one assignee is still required. A caller's
 * explicit `defaultAssigneeId` keeps precedence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import CreateTaskModal from '../CreateTaskModal'
import authSlice from '../../../store/slices/authSlice'

vi.mock('../../../lib/api', () => {
  const post = vi.fn(() => Promise.resolve({ data: { id: 99 } }))
  return {
    default: { get: vi.fn(() => Promise.resolve({ data: [] })), post, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    avatarUrl: () => null,
  }
})

import api from '../../../lib/api'

const USERS = [
  { id: 1, full_name: 'דנה' },
  { id: 2, full_name: 'יוסי' },
  { id: 3, full_name: 'רותם' },
]

// The signed-in creator is דנה (id 1). A no-date (backlog) task skips the date fields.
function renderModal(props: { defaultAssigneeId?: number | null } = {}) {
  const store = configureStore({
    reducer: { auth: authSlice },
    preloadedState: { auth: { me: { id: 1, role: 'Member', full_name: 'דנה' } } as any },
  })
  render(
    <Provider store={store}>
      <CreateTaskModal isOpen onClose={vi.fn()} users={USERS} taskLabels={[]} defaultBacklog onCreated={vi.fn()} {...props} />
    </Provider>,
  )
}

function assigneeInput(): HTMLInputElement {
  let el: HTMLElement | null = screen.getByText('מוקצים')
  while (el && !el.querySelector('input')) el = el.parentElement
  return el!.querySelector('input')!
}

async function addAssignee(name: string) {
  await userEvent.click(assigneeInput())
  await userEvent.click(await screen.findByRole('button', { name }))
}

const submit = () => userEvent.click(screen.getByRole('button', { name: 'צור משימה' }))

describe('CreateTaskModal default assignee', () => {
  beforeEach(() => vi.clearAllMocks())

  it('starts with the creator as the primary assignee', async () => {
    renderModal()
    expect(await screen.findByRole('button', { name: 'הסר דנה' })).toBeInTheDocument()
    expect(screen.getByText('ראשי')).toBeInTheDocument()
  })

  it('makes the next assignee primary once the creator is removed', async () => {
    renderModal()
    await userEvent.type(screen.getByLabelText('כותרת'), 'למישהו אחר')
    await addAssignee('יוסי')
    await addAssignee('רותם')
    await userEvent.click(screen.getByRole('button', { name: 'הסר דנה' }))
    await submit()

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tasks/', expect.objectContaining({
      event_type: 'task',
      assigned_to_user_id: 2,
      assigned_to_user_ids: [2, 3],
    })))
  })

  it('still requires at least one assignee', async () => {
    renderModal()
    await userEvent.click(await screen.findByRole('button', { name: 'הסר דנה' }))
    await userEvent.type(screen.getByLabelText('כותרת'), 'בלי מוקצה')
    await submit()
    expect(await screen.findByText('נא למלא את כל השדות החובה')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('keeps an explicit defaultAssigneeId from the caller', async () => {
    renderModal({ defaultAssigneeId: 3 })
    expect(await screen.findByRole('button', { name: 'הסר רותם' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'הסר דנה' })).not.toBeInTheDocument()
  })
})
