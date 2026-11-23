/**
 * The "מוקצה למשתמש/ים" row of TaskDetailModal lists every user in
 * `task.assignees`, marks the primary one, and follows a newer copy of the task
 * handed down by the parent (e.g. after the assignee set was edited).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import TaskDetailModal from '../TaskDetailModal'
import authSlice from '../../../store/slices/authSlice'
import permissionsSlice from '../../../store/slices/permissionsSlice'

const person = (id: number, name: string) => ({ user_id: id, full_name: name, avatar_url: null, color: '#888' })

const baseTask = (assignees: ReturnType<typeof person>[]) => ({
  id: 42,
  title: 'משימה',
  start_time: null,
  end_time: null,
  description: '',
  status: 'pending',
  event_type: 'task',
  assigned_to_user_id: assignees[0].user_id,
  assigned_to_user_ids: assignees.map((a) => a.user_id),
  assigned_user_name: assignees[0].full_name,
  assignees,
  participants: [],
  labels: [],
  is_backlog: true,
  is_archived: false,
  unique_tag: '20260101000000-abcd1234',
  recurrence_rule: '',
  recurrence_interval: 1,
}) as any

// What GET /tasks/42 answers; each test sets it to the task it renders.
let serverTask: any

vi.mock('../../../lib/api', () => ({
  default: {
    get: vi.fn((url: string) =>
      Promise.resolve({ data: url.includes('/messages') || url.includes('/checklist') ? [] : serverTask }),
    ),
    post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
  },
  avatarUrl: () => null,
  fileAttachmentUrl: () => null,
}))

const store = () =>
  configureStore({
    reducer: { auth: authSlice, permissions: permissionsSlice },
    preloadedState: { auth: { me: { id: 1, role: 'Admin', full_name: 'Admin' } } as any },
  })

function renderTask(task: any) {
  serverTask = task
  const s = store()
  const utils = render(
    <Provider store={s}>
      <TaskDetailModal taskId={42} initialTask={task} onClose={vi.fn()} />
    </Provider>,
  )
  const rerenderWith = (next: any) => {
    serverTask = next
    utils.rerender(
      <Provider store={s}>
        <TaskDetailModal taskId={42} initialTask={next} onClose={vi.fn()} />
      </Provider>,
    )
  }
  return { rerenderWith }
}

describe('TaskDetailModal assignees row', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists every assignee and marks the primary one', async () => {
    renderTask(baseTask([person(1, 'דנה'), person(2, 'יוסי'), person(3, 'רותם')]))
    expect(await screen.findByText('מוקצה למשתמשים:', { exact: false })).toBeInTheDocument()
    for (const name of ['דנה', 'יוסי', 'רותם']) expect(screen.getByText(name)).toBeInTheDocument()
    const primary = screen.getByText('ראשי')
    expect(primary.parentElement).toHaveTextContent('דנה')
    expect(screen.getAllByText('ראשי')).toHaveLength(1)
  })

  it('shows a single assignee without a primary badge', async () => {
    renderTask(baseTask([person(1, 'דנה')]))
    expect(await screen.findByText('מוקצה למשתמש:', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('דנה')).toBeInTheDocument()
    expect(screen.queryByText('ראשי')).not.toBeInTheDocument()
  })

  it('handles many assignees', async () => {
    const many = Array.from({ length: 8 }, (_, i) => person(i + 1, `משתמש ${i + 1}`))
    renderTask(baseTask(many))
    for (const a of many) expect(await screen.findByText(a.full_name)).toBeInTheDocument()
    expect(screen.getAllByText('ראשי')).toHaveLength(1)
  })

  it('follows a newer copy of the task after its assignees changed', async () => {
    const { rerenderWith } = renderTask(baseTask([person(1, 'דנה')]))
    expect(await screen.findByText('דנה')).toBeInTheDocument()

    rerenderWith(baseTask([person(2, 'יוסי'), person(3, 'רותם')]))

    await waitFor(() => expect(screen.getByText('יוסי')).toBeInTheDocument())
    expect(screen.getByText('רותם')).toBeInTheDocument()
    expect(screen.queryByText('דנה')).not.toBeInTheDocument()
    expect(screen.getByText('ראשי').parentElement).toHaveTextContent('יוסי')
  })
})
