/**
 * The checklist inside TaskDetailModal is editable by whoever may edit the task
 * (canEditTask): Admin, the primary assignee, or a co-assignee — matching the
 * backend checklist endpoints (`_can_access_task`). Others see it read-only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import TaskDetailModal from '../TaskDetailModal'
import authSlice from '../../../store/slices/authSlice'
import permissionsSlice from '../../../store/slices/permissionsSlice'

const TASK = {
  id: 42,
  title: 'משימה עם כמה מוקצים',
  start_time: null,
  end_time: null,
  description: '',
  status: 'pending',
  event_type: 'task',
  assigned_to_user_id: 1,
  assigned_to_user_ids: [1, 2],
  assignees: [
    { user_id: 1, full_name: 'ראשי', avatar_url: null, color: '#888' },
    { user_id: 2, full_name: 'נוסף', avatar_url: null, color: '#888' },
  ],
  participants: [],
  labels: [],
  is_backlog: true,
  is_archived: false,
  unique_tag: '20260101000000-abcd1234',
  recurrence_rule: '',
  recurrence_interval: 1,
} as any

vi.mock('../../../lib/api', () => {
  const get = vi.fn((url: string) =>
    Promise.resolve({ data: url.includes('/messages') || url.includes('/checklist') ? [] : TASK }),
  )
  return {
    default: { get, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    avatarUrl: () => null,
    fileAttachmentUrl: () => null,
  }
})

function renderAs(me: { id: number; role: string }) {
  const store = configureStore({
    reducer: { auth: authSlice, permissions: permissionsSlice },
    preloadedState: { auth: { me: { ...me, full_name: 'x' } } as any },
  })
  render(
    <Provider store={store}>
      <TaskDetailModal taskId={42} initialTask={TASK} onClose={vi.fn()} />
    </Provider>,
  )
}

const EDITABLE_HINT = 'הוסף את הראשון.'

describe('TaskDetailModal checklist access', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lets a co-assignee edit the checklist', async () => {
    renderAs({ id: 2, role: 'Member' })
    expect(await screen.findByText(EDITABLE_HINT, { exact: false })).toBeInTheDocument()
  })

  it('still lets the primary assignee edit the checklist', async () => {
    renderAs({ id: 1, role: 'Member' })
    expect(await screen.findByText(EDITABLE_HINT, { exact: false })).toBeInTheDocument()
  })

  it('still lets an Admin edit the checklist', async () => {
    renderAs({ id: 9, role: 'Admin' })
    expect(await screen.findByText(EDITABLE_HINT, { exact: false })).toBeInTheDocument()
  })

  it('keeps the checklist read-only for a non-assignee', async () => {
    renderAs({ id: 3, role: 'Member' })
    expect(await screen.findByText('אין פריטים.', { exact: false })).toBeInTheDocument()
    expect(screen.queryByText(EDITABLE_HINT, { exact: false })).not.toBeInTheDocument()
  })
})
