/**
 * The board/list "new task" form (CreateEventModal) picks several assignees via
 * the shared AssigneePicker and sends the full ordered set — first is primary —
 * exactly like CreateTaskModal. Like a new collection task, the creator starts
 * as the (primary) assignee and can be removed. It creates a regular task only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import CreateEventModal from '../CreateEventModal'
import authSlice from '../../../store/slices/authSlice'

const USERS = [
  { id: 1, full_name: 'דנה' },
  { id: 2, full_name: 'יוסי' },
  { id: 3, full_name: 'רותם' },
]

vi.mock('../../../lib/api', () => {
  const get = vi.fn((url: string) => Promise.resolve({ data: url.includes('/users/for-tasks') ? USERS : [] }))
  const post = vi.fn(() => Promise.resolve({ data: { id: 99 } }))
  return { default: { get, post, put: vi.fn(), patch: vi.fn(), delete: vi.fn() }, avatarUrl: () => null }
})

import api from '../../../lib/api'

// The signed-in creator is דנה (id 1).
function renderModal(onCreated = vi.fn()) {
  const store = configureStore({
    reducer: { auth: authSlice },
    preloadedState: { auth: { me: { id: 1, role: 'Member', full_name: 'דנה' } } as any },
  })
  render(
    <Provider store={store}>
      <CreateEventModal isOpen onClose={vi.fn()} initialEventType="task" onCreated={onCreated} />
    </Provider>,
  )
  return onCreated
}

/** The picker's search input: the input sharing a box with the "מוקצים" label. */
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

describe('CreateEventModal assignees', () => {
  beforeEach(() => vi.clearAllMocks())

  it('starts with the creator as the primary assignee', async () => {
    renderModal()
    expect(await screen.findByRole('button', { name: 'הסר דנה' })).toBeInTheDocument()
    expect(screen.getByText('ראשי')).toBeInTheDocument()
  })

  it('sends the creator first plus every added assignee, as a regular task', async () => {
    const onCreated = renderModal()
    await screen.findByRole('button', { name: 'הסר דנה' })
    await userEvent.type(screen.getByLabelText('כותרת'), 'משימה משותפת')
    await addAssignee('יוסי')
    await addAssignee('רותם')
    await submit()

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tasks/', expect.objectContaining({
      event_type: 'task',
      assigned_to_user_id: 1,
      assigned_to_user_ids: [1, 2, 3],
    })))
    expect(onCreated).toHaveBeenCalled()
  })

  it('makes the next assignee primary once the creator is removed', async () => {
    renderModal()
    await screen.findByRole('button', { name: 'הסר דנה' })
    await userEvent.type(screen.getByLabelText('כותרת'), 'למישהו אחר')
    await addAssignee('יוסי')
    await addAssignee('רותם')
    await userEvent.click(screen.getByRole('button', { name: 'הסר דנה' }))
    await submit()

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tasks/', expect.objectContaining({
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
})
