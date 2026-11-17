/**
 * CollectionTaskDetailPanel: the collection task view inline, for the notification
 * center. It shares its state, tabs and actions with CollectionTaskDetailModal
 * (useCollectionTaskDetail + CollectionTaskDetailBody); only the frame differs, and
 * the PDF statement export (its own modal) is not offered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import type { ReactElement } from 'react'
import authReducer from '../../../store/slices/authSlice'
import permissionsReducer from '../../../store/slices/permissionsSlice'
import type { CollectionTaskDetail } from '../../../lib/collectionApi'

const ledger: CollectionTaskDetail = {
  id: 7, title: 'הוצאות ינואר', status: 'open', collection_type: 'ledger', billing_month: '2026-10-01',
  project: { id: 2, name: 'כניסה 1', parent_name: 'בניין א' }, assignees: [{ id: 5, full_name: 'בודק' }],
  total_amount: '250.00', is_archived: false, unread_messages_count: 0,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  description: null, initial_amount: null, adjustments: [], attachments: [], created_by_user_id: 5,
  ledger_items: [{ id: 1, subject: 'ועד', amount: '250.00', sort_order: 0, created_by_user_id: 5, created_at: '', updated_at: '' }],
}

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }))
vi.mock('../../../lib/collectionApi', () => ({
  CollectionAPI: {
    get: api.get,
    update: api.update,
    projectOptions: vi.fn(async () => []),
    history: vi.fn(async () => ({ items: [], total: 0, page: 1, page_size: 30 })),
    messages: vi.fn(async () => []),
    markRead: vi.fn(async () => undefined),
  },
}))
vi.mock('../../../lib/api', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: [] }) },
  avatarUrl: (p: string | null) => p,
  fileAttachmentUrl: (p: string | null) => p,
}))
const navigate = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<any>()), useNavigate: () => navigate }))

import CollectionTaskDetailModal, { CollectionTaskDetailPanel } from '../CollectionTaskDetailModal'

function withStore(ui: ReactElement) {
  const store = configureStore({
    reducer: { auth: authReducer, permissions: permissionsReducer },
    preloadedState: {
      auth: { me: { id: 5, role: 'Member', full_name: 'בודק' } } as any,
      permissions: {
        permissions: [{ resource_type: 'collection_task', action: 'read', source: 'resource_policy' }],
        loading: false, loaded: true, error: null,
      } as any,
    },
  })
  return render(<Provider store={store}>{ui}</Provider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockResolvedValue(ledger)
})

describe('CollectionTaskDetailPanel', () => {
  it('shows the task inline with its header and the same tabs', async () => {
    withStore(<div data-testid="center"><CollectionTaskDetailPanel taskId={7} /></div>)
    const heading = await screen.findByRole('heading', { name: 'כרטסת - הוצאות ינואר' })
    expect(screen.getByTestId('center')).toContainElement(heading)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getAllByText('בניין א › כניסה 1').length).toBeGreaterThan(0)   // header subtitle (+ details)
    expect(screen.getAllByRole('tab').length).toBeGreaterThanOrEqual(4)
    expect(api.get).toHaveBeenCalledWith(7)
  })

  it('does not offer the PDF statement export, but keeps editing', async () => {
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await screen.findByRole('heading', { name: 'כרטסת - הוצאות ינואר' })
    expect(screen.queryByRole('button', { name: /ייצוא ל־PDF/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /עריכה/ })).toBeInTheDocument()
  })

  it('edits in place and reports the change, without navigating', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    api.update.mockResolvedValue({ ...ledger, title: 'הוצאות פברואר' })
    withStore(<CollectionTaskDetailPanel taskId={7} onChanged={onChanged} />)
    await screen.findByRole('heading', { name: 'כרטסת - הוצאות ינואר' })
    await user.click(screen.getByRole('button', { name: /עריכה/ }))
    const title = screen.getByDisplayValue('הוצאות ינואר')
    await user.clear(title)
    await user.type(title, 'הוצאות פברואר')
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    expect(await screen.findByRole('heading', { name: 'כרטסת - הוצאות פברואר' })).toBeInTheDocument()
    expect(onChanged).toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('CollectionTaskDetailModal (unchanged)', () => {
  it('still offers the PDF export for a ledger', async () => {
    withStore(<CollectionTaskDetailModal taskId={7} onClose={() => {}} onChanged={() => {}} />)
    expect(await screen.findByRole('button', { name: /ייצוא ל־PDF/ })).toBeInTheDocument()
  })
})
