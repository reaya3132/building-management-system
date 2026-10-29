import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
    get: vi.fn(async () => ({ ...task, description: null, initial_amount: '1500.00', adjustments: [], ledger_items: [], attachments: [], created_by_user_id: 5 })),
    setStatus: vi.fn(async () => ({ ...task, status: 'in_progress', description: null, initial_amount: '1500.00', adjustments: [], ledger_items: [], attachments: [], created_by_user_id: 5 })),
    history: vi.fn(async () => ({ items: [], total: 0, page: 1, page_size: 30 })),
    monthCounts: vi.fn(async (year: number) => Array.from({ length: 12 }, (_, i) => ({
      month: `${year}-${String(i + 1).padStart(2, '0')}-01`, count: i === 9 ? 3 : 0,
    }))),
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

describe('month navigator counts', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads counts once per year, independent of filters, and navigates by month', async () => {
    const user = userEvent.setup()
    renderPage(['read'])
    await screen.findByText('דמי ניהול')
    expect(CollectionAPI.monthCounts).toHaveBeenCalledTimes(1)
    expect(CollectionAPI.monthCounts).toHaveBeenCalledWith(2026)
    expect(await screen.findByRole('button', { name: /2026: 3 פתוחות/ })).toHaveAttribute('aria-current', 'date')

    // Another month of the same year: list reloads, counts come from the cache.
    await user.click(screen.getAllByRole('button', { name: /2026:/ })[2])
    expect(CollectionAPI.list).toHaveBeenLastCalledWith(expect.objectContaining({ month: '2026-03' }), 1, 200)
    expect(CollectionAPI.monthCounts).toHaveBeenCalledTimes(1)

    // A filter change does not refetch the counts.
    await user.click(screen.getByRole('button', { name: /סינון/ }))
    await user.click(screen.getByRole('button', { name: /בטיפול/ }))
    expect(CollectionAPI.monthCounts).toHaveBeenCalledTimes(1)

    // A new year is one more request.
    await user.click(screen.getByRole('button', { name: 'השנה הבאה' }))
    expect(CollectionAPI.monthCounts).toHaveBeenLastCalledWith(2027)
    expect(CollectionAPI.monthCounts).toHaveBeenCalledTimes(2)
  })
})

describe('month counts refresh', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refetches the year counts after a status change in the task window', async () => {
    const user = userEvent.setup()
    renderPage(['read'], '/collection-tasks?month=2026-10&task=7')
    await screen.findByRole('heading', { name: 'דמי ניהול' })
    expect(CollectionAPI.monthCounts).toHaveBeenCalledTimes(1)
    const statusButtons = screen.getAllByRole('button', { name: 'בטיפול' })
    await user.click(statusButtons[statusButtons.length - 1])
    await waitFor(() => expect(CollectionAPI.setStatus).toHaveBeenCalledWith(7, 'in_progress'))
    await waitFor(() => expect(CollectionAPI.monthCounts).toHaveBeenCalledTimes(2))
  })
})
