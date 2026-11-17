/**
 * 3e-3 — the notification center in the app:
 *  - /notifications is the center; the old messages tab is gone and its links
 *    (?tab=messages) land in the center;
 *  - the sidebar item, right after "לוח בקרה", with the unread count (999+); the
 *    task-chat badge unchanged;
 *  - ?id= from a toast highlights the notification only (no selection, no PATCH);
 *    one not on the page is fetched (GET /{id}?scope=all); an unknown one is reported.
 */
import appSource from '../../../App.tsx?raw'
import taskManagementSource from '../../../pages/TaskManagement.tsx?raw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'

import authReducer from '../../../store/slices/authSlice'
import permissionsReducer from '../../../store/slices/permissionsSlice'
import notificationsReducer, { setTaskChatUnread, setUnreadCount } from '../../../store/slices/notificationsSlice'
import NotificationCenter, { HIGHLIGHT_MS } from '../../../pages/NotificationCenter'
import type { CenterNotification } from '../useNotificationCenter'

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn() }))
vi.mock('../../../lib/api', () => ({ default: api, avatarUrl: () => null, fileAttachmentUrl: () => null }))

window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as any

const row = (id: number, extra: Partial<CenterNotification> = {}): CenterNotification => ({
  id, type: 'task_assignment', title: `עדכון ${id}`, body_preview: null, from_user_id: 2, from_user_name: 'השולחת',
  task_id: 1, task_title: 'משימה', task_kind: 'general', task_archived: false, read_at: null,
  created_at: `2026-11-17T08:0${id % 10}:00`, ...extra,
})

function Where() {
  const l = useLocation()
  return <span data-testid="where">{l.pathname + l.search}</span>
}

const makeStore = () => configureStore({
  reducer: { auth: authReducer, permissions: permissionsReducer, notifications: notificationsReducer },
  preloadedState: { auth: { me: { id: 1, role: 'Admin', full_name: 'Admin' } } as any },
})

function center(path: string) {
  const store = makeStore()
  store.dispatch(setUnreadCount(3))
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/notifications" element={<><NotificationCenter /><Where /></>} /></Routes>
      </MemoryRouter>
    </Provider>,
  )
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((url: string) => {
    if (url === '/notifications/') return Promise.resolve({ data: [row(3), row(2), row(1)], headers: {} })
    if (url === '/notifications/77') return Promise.resolve({ data: row(77, { title: 'ישנה יותר', read_at: '2026-11-01T08:00:00' }) })
    return Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } }))
  })
  api.patch.mockImplementation((url: string, _b: unknown, { params }: any) =>
    Promise.resolve({ data: row(Number(url.split('/')[2]), { read_at: params.read ? '2026-11-17T09:00:00' : null }) }))
})
afterEach(() => vi.useRealTimers())

// ── routes ────────────────────────────────────────────────────────────────────

describe('routes', () => {
  const app = appSource

  it('/notifications is the notification center (signed in), the old page is gone', () => {
    expect(app).toContain('<Route path="/notifications" element={<RequireAuth><NotificationCenter /></RequireAuth>} />')
    expect(app).toContain("React.lazy(() => import('./pages/NotificationCenter'))")
    expect(app).not.toMatch(/pages\/Notifications['"]/)
    expect(app).not.toContain('tab=messages')
  })

  it('the old messages tab sends its links to the center', async () => {
    const { default: TaskManagement } = await import('../../../pages/TaskManagement')
    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/task-management?tab=messages']}>
          <Routes>
            <Route path="/task-management" element={<TaskManagement />} />
            <Route path="/notifications" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    )
    expect(await screen.findByTestId('where')).toHaveTextContent(/^\/notifications$/)
  })

  it('the task screens no longer have a messages tab', () => {
    const page = taskManagementSource
    expect(page).not.toContain("label: 'הודעות'")
    expect(page).not.toContain('<Notifications')
  })
})

// ── sidebar ───────────────────────────────────────────────────────────────────

describe('the sidebar', () => {
  async function sidebar(unread: number, chat: number) {
    const { Sidebar, MobileSidebar } = await import('../../ui/Sidebar')
    const { ThemeProvider } = await import('../../../contexts/ThemeContext')
    const { InventorySettingsProvider } = await import('../../../contexts/InventorySettingsContext')
    const store = makeStore()
    store.dispatch(setUnreadCount(unread))
    store.dispatch(setTaskChatUnread(chat))
    render(
      <Provider store={store}>
        <ThemeProvider><InventorySettingsProvider><MemoryRouter>
          <div data-testid="desktop"><Sidebar isCollapsed={false} onToggle={() => {}} /></div>
          <div data-testid="mobile"><MobileSidebar isOpen onClose={() => {}} /></div>
        </MemoryRouter></InventorySettingsProvider></ThemeProvider>
      </Provider>,
    )
  }

  it('has "מרכז עדכונים" right after "לוח בקרה", in both sidebars', async () => {
    await sidebar(0, 0)
    for (const id of ['desktop', 'mobile']) {
      const links = within(screen.getByTestId(id)).getAllByRole('link').map((a) => a.getAttribute('href'))
      const i = links.indexOf('/dashboard')
      expect(i).toBeGreaterThanOrEqual(0)
      expect(links[i + 1]).toBe('/notifications')
    }
  })

  it('shows the unread count (999+ above 999), none at zero; the chat badge as before', async () => {
    const { navBadge } = await import('../../ui/Sidebar')
    expect(navBadge('/notifications', 0, 0)).toBeNull()
    expect(navBadge('/notifications', 0, 12)).toBe('12')
    expect(navBadge('/notifications', 0, 999)).toBe('999')
    expect(navBadge('/notifications', 0, 1000)).toBe('999+')
    expect(navBadge('/task-management', 5, 1000)).toBe('5')
    expect(navBadge('/task-management', 150, 0)).toBe('99+')
    expect(navBadge('/task-management', 0, 50)).toBeNull()
    expect(navBadge('/projects', 5, 5)).toBeNull()

    await sidebar(1000, 7)
    const desktop = screen.getByTestId('desktop')
    const item = within(desktop).getAllByRole('link').find((a) => a.getAttribute('href') === '/notifications')!
    expect(item).toHaveTextContent('999+')
    const tasks = within(desktop).getAllByRole('link').find((a) => a.getAttribute('href') === '/task-management')
    if (tasks) expect(tasks).toHaveTextContent('7')
  })
})

// ── ?id= from a toast ─────────────────────────────────────────────────────────

describe('?id= from a toast: highlight only', () => {
  const highlighted = () => document.querySelector('[data-highlighted="true"]')

  it('highlights a loaded one without selecting it or marking it read; a click does', async () => {
    const user = userEvent.setup()
    const store = center('/notifications?id=2')
    await waitFor(() => expect(highlighted()?.getAttribute('data-notification-id')).toBe('2'))
    expect(screen.queryByTestId('selected-notification')).not.toBeInTheDocument()
    expect(api.patch).not.toHaveBeenCalled()
    expect(store.getState().notifications.unreadCount).toBe(3)
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/notifications$/)       // handled: id dropped

    await user.click(highlighted() as HTMLElement)
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/notifications/2/read', null,
      { params: { read: true, scope: 'all' } }))
    expect(screen.getByTestId('selected-notification')).toBeInTheDocument()
  })

  it('one not on the loaded page is fetched alone and shown above the list, highlighted', async () => {
    center('/notifications?id=77')
    expect(await screen.findByText('ישנה יותר')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith('/notifications/77', { params: { scope: 'all' } })
    const pinned = screen.getByRole('list', { name: 'ההתראה שנפתחה' })
    expect(within(pinned).getByText('ישנה יותר').closest('button')).toHaveAttribute('data-highlighted', 'true')
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('an unknown (or another user\'s) id says so, and nothing else happens', async () => {
    center('/notifications?id=999')
    expect(await screen.findByText('ההתראה לא נמצאה')).toBeInTheDocument()
    expect(highlighted()).toBeNull()
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('the highlight fades after a few seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })                 // the timer starts on this clock
    center('/notifications?id=3')
    await waitFor(() => expect(highlighted()).not.toBeNull())
    await act(async () => { vi.advanceTimersByTime(HIGHLIGHT_MS - 500) })
    expect(highlighted()).not.toBeNull()
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(highlighted()).toBeNull()
  })
})
