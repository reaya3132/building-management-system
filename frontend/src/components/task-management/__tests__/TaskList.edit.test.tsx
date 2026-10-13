/**
 * Regression test: tasks opened from TaskList must be editable.
 *
 * TaskDetailModal renders its "עריכה" button only when given an `onEdit`
 * callback; TaskList once opened it without one, so no task could be edited
 * from the list. These tests drive the list end to end: open a task, open the
 * shared TaskEditModal, save, and check the list is refreshed. Who may edit is
 * still decided by canEditTask (Admin or an assignee).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import TaskList from '../TaskList'
import authSlice from '../../../store/slices/authSlice'
import permissionsSlice from '../../../store/slices/permissionsSlice'
import api from '../../../lib/api'

const ADMIN = { id: 1, role: 'Admin', full_name: 'Admin' }
const ASSIGNEE = { id: 2, role: 'Member', full_name: 'Assignee' }
const OUTSIDER = { id: 3, role: 'Member', full_name: 'Outsider' }

// A no-date task assigned to user 2, so saving needs no date fields.
const TASK = {
  id: 42,
  title: 'משימה מהרשימה',
  start_time: null,
  end_time: null,
  description: '',
  status: 'pending',
  event_type: 'task',
  assigned_to_user_id: 2,
  assigned_to_user_ids: [2],
  assigned_user_name: 'Assignee',
  assignees: [{ user_id: 2, full_name: 'Assignee', avatar_url: null, color: '#888' }],
  participants: [],
  labels: [],
  is_backlog: false,
  is_archived: false,
  unique_tag: '20260101000000-abcd1234',
  recurrence_rule: '',
  recurrence_interval: 1,
} as any

let currentTasks: any[] = []

vi.mock('../../../lib/api', () => {
  const get = vi.fn((url: string) => {
    if (url.includes('/users/for-tasks')) {
      return Promise.resolve({ data: [{ id: 1, full_name: 'Admin' }, { id: 2, full_name: 'Assignee' }] })
    }
    if (url.includes('/tasks/labels')) return Promise.resolve({ data: [] })
    if (url.includes('/messages') || url.includes('/checklist')) return Promise.resolve({ data: [] })
    if (url === '/tasks/') return Promise.resolve({ data: currentTasks })
    return Promise.resolve({ data: currentTasks[0] })
  })
  const api = { get, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }
  return {
    default: api,
    avatarUrl: () => null,
    fileAttachmentUrl: () => null,
  }
})

const renderAs = (me: object) =>
  render(
    <Provider
      store={configureStore({
        reducer: { auth: authSlice, permissions: permissionsSlice },
        preloadedState: { auth: { me } as any },
      })}
    >
      <TaskList />
    </Provider>,
  )

const openTask = async () => {
  await userEvent.click(await screen.findByText(TASK.title))
}

describe('TaskList task editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentTasks = [TASK]
  })

  it('admin can open the shared edit modal from a task in the list', async () => {
    renderAs(ADMIN)
    await openTask()
    await userEvent.click(await screen.findByRole('button', { name: /עריכה/ }))
    expect(await screen.findByRole('button', { name: 'שמור שינויים' })).toBeTruthy()
  })

  it('an assignee (non-admin) can edit, per canEditTask', async () => {
    renderAs(ASSIGNEE)
    await openTask()
    expect(await screen.findByRole('button', { name: /עריכה/ })).toBeTruthy()
  })

  it('a member who is not an assignee gets no edit button, per canEditTask', async () => {
    renderAs(OUTSIDER)
    await openTask()
    await screen.findAllByText(TASK.title)
    expect(screen.queryByRole('button', { name: /עריכה/ })).toBeNull()
  })

  it('saving updates the task and refreshes the list', async () => {
    vi.mocked(api.put).mockImplementation(async () => {
      currentTasks = [{ ...TASK, title: 'כותרת מעודכנת' }]
      return { data: currentTasks[0] } as any
    })

    renderAs(ADMIN)
    await openTask()
    await userEvent.click(await screen.findByRole('button', { name: /עריכה/ }))
    const listFetchesBefore = vi.mocked(api.get).mock.calls.filter(([url]) => url === '/tasks/').length

    await userEvent.click(await screen.findByRole('button', { name: 'שמור שינויים' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/tasks/42', expect.objectContaining({ title: TASK.title })))
    await waitFor(() => {
      const listFetchesAfter = vi.mocked(api.get).mock.calls.filter(([url]) => url === '/tasks/').length
      expect(listFetchesAfter).toBeGreaterThan(listFetchesBefore)
    })
    expect(await screen.findByText('כותרת מעודכנת')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'שמור שינויים' })).toBeNull()
  })
})
