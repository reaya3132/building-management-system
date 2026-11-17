/**
 * The notification center page (3e-2a): the three views in the URL, the list rows
 * (never a chat message's content), selecting marks read, "סמן כלא נקראה".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'

import notificationsReducer, { setUnreadCount } from '../../../store/slices/notificationsSlice'
import NotificationCenter from '../../../pages/NotificationCenter'
import type { CenterNotification } from '../useNotificationCenter'
import { notificationSubline } from '../NotificationListItem'

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }))
vi.mock('../../../lib/api', () => ({ default: api }))

const row = (id: number, extra: Partial<CenterNotification> = {}): CenterNotification => ({
  id, type: 'task_assignment', title: `עדכון ${id}`, body_preview: 'תקציר', from_user_id: 2,
  from_user_name: 'השולחת', task_id: 1, task_title: 'משימה רגילה', task_kind: 'general', task_archived: false,
  read_at: null, created_at: `2026-11-17T08:0${id}:00`, ...extra,
})

function Where() {
  const l = useLocation()
  return <span data-testid="where">{l.pathname + l.search}</span>
}

function renderPage(path = '/notifications') {
  const store = configureStore({ reducer: { notifications: notificationsReducer } })
  store.dispatch(setUnreadCount(2))
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
  api.get.mockImplementation((_u: string, { params }: any) => Promise.resolve({
    data: params.view === 'read'
      ? [row(1, { read_at: '2026-11-17T09:00:00' })]
      : [row(3, { type: 'task_message', body_preview: null, title: 'הודעות חדשות במשימה: משימה רגילה' }), row(2)],
    headers: {},
  }))
  api.patch.mockImplementation((url: string, _b: unknown, { params }: any) =>
    Promise.resolve({ data: row(Number(url.split('/')[2]), { read_at: params.read ? '2026-11-17T09:30:00' : null }) }))
})

describe('NotificationCenter page', () => {
  it('opens on "לא נקראו" and keeps the view in the URL', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByText('עדכון 2')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'לא נקראו' })).toHaveAttribute('aria-selected', 'true')
    expect(api.get).toHaveBeenLastCalledWith('/notifications/', { params: { scope: 'all', view: 'unread', limit: 30 } })
    await user.click(screen.getByRole('tab', { name: 'נקראו' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/notifications?view=read')
    expect(await screen.findByText('עדכון 1')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'לא נקראו' }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/notifications$/)
  })

  it('opens the view named in the URL', async () => {
    renderPage('/notifications?view=all')
    await screen.findByText('עדכון 2')
    expect(screen.getByRole('tab', { name: 'הכול' })).toHaveAttribute('aria-selected', 'true')
  })

  it('selecting marks it read, takes it out of "לא נקראו" and shows it', async () => {
    const user = userEvent.setup()
    const store = renderPage()
    await user.click(await screen.findByText('עדכון 2'))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/notifications/2/read', null,
      { params: { read: true, scope: 'all' } }))
    const list = screen.getByRole('list', { name: 'עדכונים' })
    expect(within(list).queryByText('עדכון 2')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('selected-notification')).getByText('עדכון 2')).toBeInTheDocument()
    expect(store.getState().notifications.unreadCount).toBe(1)
  })

  it('"סמן כלא נקראה" marks it unread again', async () => {
    const user = userEvent.setup()
    const store = renderPage()
    await user.click(await screen.findByText('עדכון 2'))
    await user.click(await screen.findByRole('button', { name: 'סמן כלא נקראה' }))
    await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith('/notifications/2/read', null,
      { params: { read: false, scope: 'all' } }))
    expect(store.getState().notifications.unreadCount).toBe(2)
    expect(await within(screen.getByRole('list', { name: 'עדכונים' })).findByText('עדכון 2')).toBeInTheDocument()
  })

  it('a row never shows a chat message\'s content', async () => {
    renderPage()
    const chat = (await screen.findByText('הודעות חדשות במשימה: משימה רגילה')).closest('button')!
    expect(chat).toHaveTextContent('השולחת · משימה רגילה')
    expect(notificationSubline(row(9, { type: 'task_message', body_preview: 'סוד' }))).toBe('השולחת · משימה רגילה')
  })

  it('an empty view says so', async () => {
    api.get.mockResolvedValue({ data: [], headers: {} })
    renderPage()
    expect(await screen.findByText('אין עדכונים שלא נקראו')).toBeInTheDocument()
  })
})
