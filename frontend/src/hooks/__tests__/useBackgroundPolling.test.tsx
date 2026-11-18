/**
 * The app's one background poll: the notifications request each round, every 30s,
 * only while signed in and the tab is visible, at once on returning to the tab,
 * never two rounds at a time; the task-chat summary is no longer fetched; both
 * sidebars read the count without polling themselves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'

import authReducer from '../../store/slices/authSlice'
import permissionsReducer from '../../store/slices/permissionsSlice'
import notificationsReducer from '../../store/slices/notificationsSlice'
import { POLL_INTERVAL_MS, useBackgroundPolling } from '../useBackgroundPolling'

const api = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../lib/api', () => ({ default: api, avatarUrl: () => null, fileAttachmentUrl: () => null }))

const ME = { id: 1, role: 'Admin', full_name: 'Admin' }
const makeStore = (me: unknown = ME) => configureStore({
  reducer: { auth: authReducer, permissions: permissionsReducer, notifications: notificationsReducer },
  preloadedState: { auth: { me } as any },
})

let hidden = false
// jsdom has no matchMedia (the theme provider asks for the system theme).
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as any
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })

function Poller() {
  useBackgroundPolling()
  return null
}

const calls = (path: string) => api.get.mock.calls.filter(([url]) => url === path).length
const SUMMARY = '/tasks/unread-summary'
const NOTIFS = '/notifications/unread-count'

function answer() {
  api.get.mockImplementation(() => Promise.resolve({
    data: { count: 2, latest: [] },
  }))
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  hidden = false
  answer()
})
afterEach(() => vi.useRealTimers())

describe('useBackgroundPolling', () => {
  it('fetches the notifications at once, then every 30 seconds', async () => {
    const store = makeStore()
    render(<Provider store={store}><Poller /></Provider>)
    await flush()
    expect([calls(SUMMARY), calls(NOTIFS)]).toEqual([0, 1])   // no task-chat summary
    expect(api.get).toHaveBeenCalledWith(NOTIFS, { params: { scope: 'all', latest: 10 } })
    expect(store.getState().notifications.unreadCount).toBe(2)

    await act(async () => { vi.advanceTimersByTime(POLL_INTERVAL_MS) })
    await flush()
    expect([calls(SUMMARY), calls(NOTIFS)]).toEqual([0, 2])
  })

  it('does not poll while the tab is hidden, and polls at once when it comes back', async () => {
    render(<Provider store={makeStore()}><Poller /></Provider>)
    await flush()
    hidden = true
    await act(async () => { vi.advanceTimersByTime(POLL_INTERVAL_MS * 3) })
    expect(calls(NOTIFS)).toBe(1)
    hidden = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(calls(NOTIFS)).toBe(2)
  })

  it('never starts a round while the previous one is still out', async () => {
    let release!: () => void
    api.get.mockImplementation(() => new Promise((r) => { release = () => r({ data: { count: 0, latest: [], total_unread: 0 } }) }))
    render(<Provider store={makeStore()}><Poller /></Provider>)
    await act(async () => { vi.advanceTimersByTime(POLL_INTERVAL_MS * 2) })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(calls(NOTIFS)).toBe(1)                       // still waiting for the first
    await act(async () => { release() })
  })

  it('does nothing when signed out', async () => {
    render(<Provider store={makeStore(null)}><Poller /></Provider>)
    await act(async () => { vi.advanceTimersByTime(POLL_INTERVAL_MS * 2) })
    expect(api.get).not.toHaveBeenCalled()
  })

  it('stops on unmount (sign-out)', async () => {
    const { unmount } = render(<Provider store={makeStore()}><Poller /></Provider>)
    await flush()
    unmount()
    await act(async () => { vi.advanceTimersByTime(POLL_INTERVAL_MS * 3) })
    expect(calls(NOTIFS)).toBe(1)
  })
})

describe('the sidebars', () => {
  it('show the notification count from the one poll, no task badge, and do not poll themselves', async () => {
    const { Sidebar, MobileSidebar } = await import('../../components/ui/Sidebar')
    const { ThemeProvider } = await import('../../contexts/ThemeContext')
    const { InventorySettingsProvider } = await import('../../contexts/InventorySettingsContext')
    const store = makeStore()
    render(
      <Provider store={store}>
        <ThemeProvider>
          <InventorySettingsProvider>
            <MemoryRouter>
              <Poller />
              <Sidebar isCollapsed={false} onToggle={() => {}} />
              <MobileSidebar isOpen onClose={() => {}} />
            </MemoryRouter>
          </InventorySettingsProvider>
        </ThemeProvider>
      </Provider>,
    )
    await flush()
    expect(calls(NOTIFS)).toBe(1)                       // once — not once per sidebar
    expect(calls(SUMMARY)).toBe(0)
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1)
  })
})
