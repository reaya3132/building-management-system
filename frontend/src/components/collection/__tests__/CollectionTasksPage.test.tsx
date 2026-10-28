import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import authReducer from '../../../store/slices/authSlice'
import permissionsReducer from '../../../store/slices/permissionsSlice'

const task = {
  id: 7, title: 'דמי ניהול', status: 'open', collection_type: 'single', billing_month: '2026-10-01',
  project: { id: 2, name: 'כניסה 1', parent_name: 'בניין א' }, assignees: [{ id: 5, full_name: 'בודק' }],
  total_amount: '1500.00', is_archived: false, unread_messages_count: 2,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
}

vi.mock('../../../lib/collectionApi', () => ({
  CollectionAPI: {
    list: vi.fn(async () => ({ items: [task], total: 1, page: 1, page_size: 200 })),
    summary: vi.fn(async () => ({
      by_status: {
        open: { count: 1, total_amount: '1500.00' },
        in_progress: { count: 0, total_amount: '0.00' },
        closed: { count: 0, total_amount: '0.00' },
      },
      count: 1,
      total_amount: '1500.00',
    })),
    unreadSummary: vi.fn(async () => ({ total_unread: 2, task_count: 1 })),
    projectOptions: vi.fn(async () => []),
  },
}))
vi.mock('../../../lib/api', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: [] }) },
  avatarUrl: (p: string | null) => p,
  fileAttachmentUrl: (p: string | null) => p,
}))

import CollectionTasks from '../../../pages/CollectionTasks'
import { CollectionAPI } from '../../../lib/collectionApi'

function renderPage(actions: string[], route = '/collection-tasks?month=2026-10') {
  const store = configureStore({
    reducer: { auth: authReducer, permissions: permissionsReducer },
    preloadedState: {
      auth: { me: { id: 5, role: 'Member', full_name: 'בודק' } } as any,
      permissions: {
        permissions: actions.map((action) => ({ resource_type: 'collection_task', action, source: 'resource_policy' })),
        loading: false, loaded: true, error: null,
      },
    } as any,
  })
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[route]}>
        <CollectionTasks />
      </MemoryRouter>
    </Provider>
  )
}

describe('CollectionTasks page', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads the month from the URL and shows the task on the board', async () => {
    renderPage(['read'])
    expect(await screen.findByText('דמי ניהול')).toBeInTheDocument()
    expect(screen.getByText('בניין א › כניסה 1')).toBeInTheDocument()
    expect(CollectionAPI.list).toHaveBeenCalledWith(expect.objectContaining({ month: '2026-10', archived: 'false' }), 1, 200)
  })

  it('hides "new task" without write', async () => {
    renderPage(['read'])
    await screen.findByText('דמי ניהול')
    expect(screen.queryByRole('button', { name: /משימת גבייה חדשה/ })).not.toBeInTheDocument()
  })

  it('shows "new task" to a user with write', async () => {
    renderPage(['read', 'write'])
    expect(await screen.findByRole('button', { name: /משימת גבייה חדשה/ })).toBeInTheDocument()
  })

  it('moves to the next month and switches to the paged list', async () => {
    const user = userEvent.setup()
    renderPage(['read'])
    await screen.findByText('דמי ניהול')
    await user.click(screen.getByRole('button', { name: 'החודש הבא' }))
    expect(CollectionAPI.list).toHaveBeenLastCalledWith(expect.objectContaining({ month: '2026-11' }), 1, 200)
    await user.click(screen.getByRole('tab', { name: /רשימה/ }))
    expect(CollectionAPI.list).toHaveBeenLastCalledWith(expect.objectContaining({ month: '2026-11' }), 1, 50)
  })
})
