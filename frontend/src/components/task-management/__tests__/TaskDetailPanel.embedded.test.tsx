/**
 * TaskDetailPanel: the task detail content extracted from TaskDetailModal so the
 * notification center can show it inline. The modal keeps its behaviour (its own
 * tests run unchanged); the embedded panel shows the same task and actions inside
 * the page — no modal frame, no editing (the edit form opens a modal of the task
 * screens), and nothing that navigates away.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import TaskDetailModal, { TaskDetailPanel } from '../TaskDetailModal'
import authSlice from '../../../store/slices/authSlice'
import permissionsSlice from '../../../store/slices/permissionsSlice'

const TASK = {
  id: 42, title: 'לתקן מעלית', start_time: null, end_time: null, description: 'קומה 3', status: 'completed',
  event_type: 'task', assigned_to_user_id: 1, assigned_to_user_ids: [1],
  assignees: [{ user_id: 1, full_name: 'Admin', avatar_url: null, color: '#888' }], participants: [], labels: [],
  is_backlog: false, is_archived: false, unique_tag: 't', recurrence_rule: '', recurrence_interval: 1,
} as any

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
vi.mock('../../../lib/api', () => ({ default: api, avatarUrl: () => null, fileAttachmentUrl: () => null }))

const navigate = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<any>()), useNavigate: () => navigate }))

const store = () => configureStore({
  reducer: { auth: authSlice, permissions: permissionsSlice },
  preloadedState: { auth: { me: { id: 1, role: 'Admin', full_name: 'Admin' } } as any },
})

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((url: string) =>
    Promise.resolve({ data: url.includes('/messages') || url.includes('/checklist') ? [] : TASK }))
  api.post.mockResolvedValue({ data: {} })
})

function renderPanel(props: Partial<React.ComponentProps<typeof TaskDetailPanel>> = {}) {
  const onClose = vi.fn()
  const onEdit = vi.fn()
  render(
    <Provider store={store()}>
      <div data-testid="center">
        <TaskDetailPanel taskId={42} initialTask={TASK} onClose={onClose} onEdit={onEdit} embedded {...props} />
      </div>
    </Provider>,
  )
  return { onClose, onEdit }
}

describe('TaskDetailPanel embedded', () => {
  it('renders the task inline, with no modal frame', async () => {
    renderPanel()
    expect(await screen.findByText('לתקן מעלית')).toBeInTheDocument()
    expect(screen.getByTestId('center')).toContainElement(screen.getByText('לתקן מעלית'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('פרטי משימה')).not.toBeInTheDocument()       // the modal's title
  })

  it('does not offer editing even when onEdit is given', async () => {
    renderPanel()
    await screen.findByText('לתקן מעלית')
    expect(screen.queryByRole('button', { name: /עריכה/ })).not.toBeInTheDocument()
  })

  it('keeps the task actions (remind, archive, delete) and never navigates', async () => {
    const user = userEvent.setup()
    const { onClose } = renderPanel()
    await screen.findByText('לתקן מעלית')
    for (const name of [/הזכר/, /ארכב/, /מחק/]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    await user.click(screen.getByRole('button', { name: /ארכב/ }))
    expect(api.post).toHaveBeenCalledWith('/tasks/42/archive')
    expect(onClose).toHaveBeenCalled()                                     // back to the summary
    expect(navigate).not.toHaveBeenCalled()
  })

  it('loads nothing without a task', () => {
    render(<Provider store={store()}><TaskDetailPanel taskId={null} onClose={vi.fn()} embedded /></Provider>)
    expect(api.get).not.toHaveBeenCalled()
  })
})

describe('TaskDetailModal (unchanged)', () => {
  it('still shows its frame and the edit button', async () => {
    render(
      <Provider store={store()}>
        <TaskDetailModal taskId={42} initialTask={TASK} onClose={vi.fn()} onEdit={vi.fn()} />
      </Provider>,
    )
    expect(await screen.findByText('פרטי משימה')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /עריכה/ })).toBeInTheDocument()
  })

  it('renders nothing without a task', () => {
    const { container } = render(
      <Provider store={store()}><TaskDetailModal taskId={null} onClose={vi.fn()} /></Provider>)
    expect(container).toBeEmptyDOMElement()
  })
})
