/**
 * The real task panels inside the center (no stubs): a task the user may not open
 * (403) is reported inside the center — no navigation, no modal.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import authReducer from '../../../store/slices/authSlice'
import permissionsReducer from '../../../store/slices/permissionsSlice'
import NotificationSummary from '../NotificationSummary'
import type { CenterNotification } from '../useNotificationCenter'

const api = vi.hoisted(() => ({
  get: vi.fn(() => Promise.reject(Object.assign(new Error('403'), { response: { status: 403, data: { detail: 'Access denied' } } }))),
  post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
}))
vi.mock('../../../lib/api', () => ({ default: api, avatarUrl: () => null, fileAttachmentUrl: () => null }))
const collection = vi.hoisted(() => ({
  get: vi.fn(() => Promise.reject(Object.assign(new Error('403'), { response: { status: 403, data: { detail: 'Access denied' } } }))),
}))
vi.mock('../../../lib/collectionApi', () => ({
  CollectionAPI: { vatRate: vi.fn(async () => '0.1800'), get: collection.get, history: vi.fn(async () => ({ items: [], total: 0, page: 1, page_size: 30 })) },
}))
const navigate = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<any>()), useNavigate: () => navigate }))

const store = () => configureStore({
  reducer: { auth: authReducer, permissions: permissionsReducer },
  preloadedState: { auth: { me: { id: 5, role: 'Member', full_name: 'בודק' } } as any },
})

const n = (extra: Partial<CenterNotification>): CenterNotification => ({
  id: 1, type: 'task_assignment', title: 'משימה חדשה: סודית', body_preview: null, from_user_id: 2,
  from_user_name: 'השולחת', task_id: 42, task_title: 'סודית', task_kind: 'general', task_archived: false,
  read_at: '2026-11-17T09:00:00', created_at: '2026-11-17T08:00:00', ...extra,
})

function open(notification: CenterNotification) {
  render(
    <Provider store={store()}>
      <div data-testid="center">
        <NotificationSummary notification={notification} marking={false} onMarkUnread={vi.fn()}
          onBack={vi.fn()} onChanged={vi.fn()} onUpdate={vi.fn()} />
      </div>
    </Provider>,
  )
}

describe('a task the user cannot open', () => {
  it('regular task: reported inside the center', async () => {
    const user = userEvent.setup()
    open(n({}))
    expect(api.get).not.toHaveBeenCalled()                                   // nothing before the click
    await user.click(screen.getByRole('button', { name: /הצגת ההודעה/ }))
    // the real task panel is a large module: give its lazy load time
    expect(await screen.findByText('המשימה לא נמצאה.', undefined, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByTestId('center')).toContainElement(screen.getByText('המשימה לא נמצאה.'))
    expect(api.get).toHaveBeenCalledWith('/tasks/42')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('collection task: reported inside the center', async () => {
    const user = userEvent.setup()
    open(n({ task_kind: 'collection', task_id: 7 }))
    expect(collection.get).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /הצגת ההודעה/ }))
    expect(await screen.findByRole('alert', undefined, { timeout: 5000 })).toBeInTheDocument()
    expect(collection.get).toHaveBeenCalledWith(7)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })
})
