/**
 * refreshOnFocus — the embedded collection panel (notification center) only.
 *
 * Coming back to the tab / window reloads the task from the server, so the panel
 * does not keep showing data another screen has since changed. It never loads
 * while the tab is hidden, and never re-bases what the user is editing: with an
 * open form or a typed draft the refresh is skipped — also when the user starts
 * editing while the request is out. The regular modal does not refresh on focus.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
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
// What another screen saved meanwhile.
const changedElsewhere: CollectionTaskDetail = {
  ...ledger, title: 'הוצאות ינואר (עודכן)', total_amount: '300.00',
  ledger_items: [{ ...ledger.ledger_items[0], amount: '300.00' }],
}

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }))
vi.mock('../../../lib/collectionApi', () => ({
  CollectionAPI: {
    get: api.get,
    update: api.update,
    projectOptions: vi.fn(async () => [{ id: 2, name: 'כניסה 1', parent_name: 'בניין א' }]),
    history: vi.fn(async () => ({ items: [], total: 0, page: 1, page_size: 30 })),
  },
}))
vi.mock('../../../lib/api', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: [] }) },
  avatarUrl: (p: string | null) => p,
  fileAttachmentUrl: (p: string | null) => p,
}))

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

let hidden = false
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })

async function returnToTab() {
  hidden = false
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })
}

const heading = (title: string) => screen.findByRole('heading', { name: `כרטסת - ${title}` })

beforeEach(() => {
  vi.clearAllMocks()
  hidden = false
  api.get.mockResolvedValue(ledger)
})

describe('embedded panel: refresh on return', () => {
  it('reloads from the server when the user comes back, once per return', async () => {
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await heading('הוצאות ינואר')
    expect(api.get).toHaveBeenCalledTimes(1)

    api.get.mockResolvedValue(changedElsewhere)
    await returnToTab()                                      // focus + visibilitychange together
    expect(await heading('הוצאות ינואר (עודכן)')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledTimes(2)                 // one request, not two
  })

  it('does not load while the tab is hidden', async () => {
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await heading('הוצאות ינואר')
    hidden = true
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it('keeps an open edit form and its unsaved changes, and sends only what the user changed', async () => {
    const user = userEvent.setup()
    api.update.mockResolvedValue({ ...ledger, description: 'הערה חדשה' })
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await heading('הוצאות ינואר')
    await user.click(screen.getByRole('button', { name: /עריכה/ }))
    const description = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA')!
    await user.type(description, 'הערה חדשה')

    api.get.mockResolvedValue(changedElsewhere)
    await returnToTab()
    expect(api.get).toHaveBeenCalledTimes(1)                 // skipped: the form is open
    expect(description).toHaveValue('הערה חדשה')             // nothing lost
    expect(screen.getByDisplayValue('הוצאות ינואר')).toBeInTheDocument()   // the form's base is unchanged

    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(7, { description: 'הערה חדשה' }))
  })

  it('does not re-base a form that is open but not yet typed into', async () => {
    const user = userEvent.setup()
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await heading('הוצאות ינואר')
    await user.click(screen.getByRole('button', { name: /עריכה/ }))
    api.get.mockResolvedValue(changedElsewhere)
    await returnToTab()
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(screen.getByDisplayValue('הוצאות ינואר')).toBeInTheDocument()
  })

  it('drops a refresh that returns after the user started editing', async () => {
    const user = userEvent.setup()
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await heading('הוצאות ינואר')
    let resolve!: (t: CollectionTaskDetail) => void
    api.get.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    await returnToTab()                                      // request out
    await user.click(screen.getByRole('button', { name: /עריכה/ }))   // the user opens the form meanwhile
    await act(async () => resolve(changedElsewhere))
    expect(screen.getByDisplayValue('הוצאות ינואר')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'כרטסת - הוצאות ינואר (עודכן)' })).not.toBeInTheDocument()
  })

  it('refreshes again once the form is closed', async () => {
    const user = userEvent.setup()
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await heading('הוצאות ינואר')
    await user.click(screen.getByRole('button', { name: /עריכה/ }))
    await returnToTab()
    expect(api.get).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'ביטול' }))
    api.get.mockResolvedValue(changedElsewhere)
    await returnToTab()
    expect(await heading('הוצאות ינואר (עודכן)')).toBeInTheDocument()
  })

  it('a typed ledger draft blocks the refresh; an empty one does not', async () => {
    const user = userEvent.setup()
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await heading('הוצאות ינואר')
    await user.click(screen.getByRole('tab', { name: /סכומים/ }))
    const subject = await screen.findByPlaceholderText(/נושא/)
    await user.type(subject, 'חניה')
    api.get.mockResolvedValue(changedElsewhere)
    await returnToTab()
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(subject).toHaveValue('חניה')

    await user.clear(subject)
    await returnToTab()
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
  })
})

describe('embedded panel: every kind of edit blocks the refresh', () => {
  async function blocked() {
    api.get.mockResolvedValue(changedElsewhere)
    await returnToTab()
    expect(api.get).toHaveBeenCalledTimes(1)
  }

  it('the move-month form (month picker), open and untouched', async () => {
    const user = userEvent.setup()
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await heading('הוצאות ינואר')
    await user.click(screen.getByRole('button', { name: /העברת חודש/ }))
    await blocked()
  })

  it('the edit form even with every text field emptied (only pickers changed)', async () => {
    const user = userEvent.setup()
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await heading('הוצאות ינואר')
    await user.click(screen.getByRole('button', { name: /עריכה/ }))
    await user.clear(screen.getByDisplayValue('הוצאות ינואר'))
    await blocked()
  })

  it('a ledger row in edit mode, untouched and with its fields emptied', async () => {
    const user = userEvent.setup()
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await heading('הוצאות ינואר')
    await user.click(screen.getByRole('tab', { name: /סכומים/ }))
    await user.click(await screen.findByRole('button', { name: 'ערוך ועד' }))
    await blocked()
    await user.clear(screen.getByRole('textbox', { name: 'נושא' }))
    await user.clear(screen.getByRole('textbox', { name: 'סכום' }))
    await blocked()
  })

  it('a typed adjustment amount on a single-amount task', async () => {
    const user = userEvent.setup()
    const single = { ...ledger, collection_type: 'single', initial_amount: '100.00', ledger_items: [] } as CollectionTaskDetail
    api.get.mockResolvedValue(single)
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await screen.findByRole('heading', { name: 'הוצאות ינואר' })
    await user.click(screen.getByRole('tab', { name: /סכומים/ }))
    await user.type(await screen.findByRole('textbox', { name: 'סכום התוספת' }), '25')
    await blocked()
  })

  it('a status change in flight (it saves at once; no stale response replaces it)', async () => {
    const user = userEvent.setup()
    const setStatus = vi.fn(() => new Promise<CollectionTaskDetail>(() => {}))   // still saving
    const { CollectionAPI } = await import('../../../lib/collectionApi')
    ;(CollectionAPI as any).setStatus = setStatus
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await heading('הוצאות ינואר')
    const statusButtons = screen.getAllByRole('button').filter((b) => /סגור|סגירה|נסגר/.test(b.textContent ?? ''))
    await user.click(statusButtons[0])
    expect(setStatus).toHaveBeenCalled()
    await blocked()
  })
})

describe('the regular modal', () => {
  it('does not refresh on focus', async () => {
    withStore(<CollectionTaskDetailModal taskId={7} onClose={() => {}} onChanged={() => {}} />)
    await heading('הוצאות ינואר')
    await returnToTab()
    expect(api.get).toHaveBeenCalledTimes(1)
  })
})
