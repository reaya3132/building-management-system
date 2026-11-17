/**
 * The notification toasts: bottom left, one at a time, 5 seconds each, in order;
 * a click opens the notification in the center and does not mark it as read; a
 * chat message's content is never shown; collection and archive toasts say what
 * they are; the summary ("עדכונים נוספים ממתינים לך", no number) opens the center.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'

import notificationsReducer, { pollNotifications, type NotificationBrief } from '../../../store/slices/notificationsSlice'
import NotificationToastQueue, { MORE_UPDATES_TEXT, TOAST_DURATION_MS, toastMessage } from '../NotificationToastQueue'

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn() }))
vi.mock('../../../lib/api', () => ({ default: api }))

const brief = (id: number, extra: Partial<NotificationBrief> = {}): NotificationBrief => ({
  id, type: 'task_assignment', title: `משימה חדשה ${id}`, body_preview: 'לבדוק את המעלית',
  from_user_name: 'השולחת', task_title: 'משימה רגילה', task_kind: 'general',
  created_at: `2026-11-17T08:0${id}:00`, ...extra,
})

function Where() {
  const location = useLocation()
  return <div data-testid="where">{location.pathname + location.search}</div>
}

function setup(newOnes: NotificationBrief[], count?: number) {
  const store = configureStore({ reducer: { notifications: notificationsReducer } })
  store.dispatch(pollNotifications.fulfilled({ count: 0, latest: [] }, 'r'))        // the baseline
  store.dispatch(pollNotifications.fulfilled({ count: count ?? newOnes.length, latest: newOnes }, 'r'))
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <NotificationToastQueue />
        <Routes><Route path="*" element={<Where />} /></Routes>
      </MemoryRouter>
    </Provider>,
  )
  return store
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
afterEach(() => vi.useRealTimers())

describe('NotificationToastQueue', () => {
  it('shows one toast at a time, bottom left, for 5 seconds, then the next', async () => {
    const store = setup([brief(2), brief(1)])
    const queue = () => store.getState().notifications.toastQueue.length
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByText('משימה חדשה 1')).toBeInTheDocument()          // the older one first
    expect(screen.queryByText('משימה חדשה 2')).not.toBeInTheDocument()     // waits its turn
    expect(screen.getByRole('status').className).toContain('bottom-4 left-4')
    await act(async () => { vi.advanceTimersByTime(TOAST_DURATION_MS - 100) })
    expect(queue()).toBe(2)                                                 // still the first
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(queue()).toBe(1)
    expect(screen.getByText('משימה חדשה 2')).toBeInTheDocument()
    await act(async () => { vi.advanceTimersByTime(TOAST_DURATION_MS + 100) })
    expect(queue()).toBe(0)                                                 // (the exit animation may linger)
  })

  it('a click opens the notification in the center and does not mark it as read', async () => {
    const store = setup([brief(7)])
    fireEvent.click(screen.getByText('משימה חדשה 7'))
    expect(screen.getByTestId('where')).toHaveTextContent('/notifications?id=7')
    expect(api.patch).not.toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalled()
    expect(store.getState().notifications.toastQueue).toEqual([])        // and it is gone
  })

  it('closing it moves on without navigating', async () => {
    setup([brief(2), brief(1)])
    fireEvent.click(screen.getByRole('button', { name: 'סגירה' }))
    expect(screen.getByText('משימה חדשה 2')).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/dashboard')
  })

  it('many at once: the summary opens the center', async () => {
    setup([6, 5, 4, 3, 2, 1].map((id) => brief(id)))
    for (let i = 0; i < 3; i++) await act(async () => { vi.advanceTimersByTime(TOAST_DURATION_MS + 10) })
    expect(MORE_UPDATES_TEXT).toBe('עדכונים נוספים ממתינים לך')
    const summary = screen.getByText('עדכונים נוספים ממתינים לך')
    expect(summary.closest('[role="status"]')?.textContent).not.toMatch(/d/)   // no number
    fireEvent.click(summary)
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/notifications$/)
  })
})

describe('what a toast says', () => {
  it('chat message: who and where, never the content', () => {
    expect(toastMessage(brief(1, { type: 'task_message', body_preview: 'סוד' }))).toBe('השולחת · משימה רגילה')
    expect(toastMessage(brief(1, { type: 'task_message', task_kind: 'collection', task_title: 'גביית ועד' })))
      .toBe('גבייה · השולחת · גביית ועד')
  })

  it('regular: the short description', () => {
    expect(toastMessage(brief(1))).toBe('לבדוק את המעלית')
    expect(toastMessage(brief(1, { body_preview: null }))).toBe('השולחת · משימה רגילה')
  })

  it('collection: marked as such', () => {
    expect(toastMessage(brief(1, { task_kind: 'collection', body_preview: null, task_title: 'גביית ועד' })))
      .toBe('גבייה · השולחת · גביית ועד')
  })

  it('archive: its stored text (kind and who archived), even with the task gone', () => {
    const archived = brief(1, {
      type: 'task_archived', title: 'משימת גבייה אורכבה: גביית ועד', task_kind: null, task_title: null,
      from_user_name: null, body_preview: 'סוג: משימת גבייה · אורכבה על ידי השולחת',
    })
    expect(toastMessage(archived)).toBe('סוג: משימת גבייה · אורכבה על ידי השולחת')
  })
})
