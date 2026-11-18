/**
 * The collection module: files in S3 come back with a newly signed URL on every
 * response. An open document must not be reloaded by
 *   - the collection chat's refresh (every 8s and on window focus), or
 *   - the embedded panel's (notification center) reload on returning to the tab,
 * while new chat messages and their files still show at once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import type { ReactElement } from 'react'
import authReducer from '../../../store/slices/authSlice'
import permissionsReducer from '../../../store/slices/permissionsSlice'
import type { CollectionTaskDetail } from '../../../lib/collectionApi'

/** A SigV4-style signed URL, signed now, valid for an hour. */
function signed(key: string, sig: string) {
  const d = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return `https://bucket.s3.amazonaws.com/${key}?X-Amz-Date=${d}&X-Amz-Expires=3600&X-Amz-Signature=${sig}`
}

let calls = 0
let extra: any = null

const task = (): CollectionTaskDetail => ({
  id: 7, title: 'הוצאות ינואר', status: 'open', collection_type: 'ledger', billing_month: '2026-10-01',
  project: { id: 2, name: 'כניסה 1', parent_name: 'בניין א' }, assignees: [{ id: 5, full_name: 'בודק' }],
  total_amount: '0.00', is_archived: false, unread_messages_count: 0,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  description: null, initial_amount: null, adjustments: [], created_by_user_id: 5, ledger_items: [],
  attachments: [{ id: 3, file_name: 'statement.pdf', file_url: signed('statement.pdf', `t${++calls}`) }],
} as any)

const message = (id: number, attId: number, name: string, sig: string) => ({
  id, task_id: 7, user_id: 6, full_name: 'דנה', message: `הודעה ${id}`, created_at: '2026-11-18T08:00:00',
  attachments: [{ id: attId, file_name: name, file_url: signed(name, sig) }],
})

const collection = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../../lib/collectionApi', () => ({
  CollectionAPI: {
    get: collection.get,
    projectOptions: vi.fn(async () => []),
    history: vi.fn(async () => ({ items: [], total: 0, page: 1, page_size: 30 })),
  },
}))
const api = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../../lib/api', () => ({
  default: api,
  avatarUrl: (p: string | null) => p,
  fileAttachmentUrl: (p: string | null) => p,
}))

import CollectionChat from '../CollectionChat'
import { CollectionTaskDetailPanel } from '../CollectionTaskDetailModal'

// jsdom has no scrollTo (the chat scrolls to its newest message).
Element.prototype.scrollTo = function () {} as any

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

const pdfFrame = () => document.querySelector('iframe')

async function returnToWindow() {
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  calls = 0
  extra = null
  api.get.mockImplementation(() => {
    calls += 1
    const list: any[] = [message(1, 9, 'invoice.pdf', `m${calls}`)]
    if (extra) list.push(extra)
    return Promise.resolve({ data: list })
  })
  collection.get.mockImplementation(async () => task())
})

describe('CollectionChat', () => {
  it('a refresh does not reload an open PDF; a new message and its file show at once', async () => {
    const user = userEvent.setup()
    withStore(<CollectionChat taskId={7} />)
    await user.click(await screen.findByRole('button', { name: /invoice\.pdf/ }))
    await waitFor(() => expect(pdfFrame()).not.toBeNull())
    const src = pdfFrame()!.getAttribute('src')

    extra = message(2, 10, 'receipt.pdf', 'new')
    const before = calls
    await returnToWindow()
    await waitFor(() => expect(calls).toBeGreaterThan(before))
    expect(await screen.findByText('הודעה 2')).toBeInTheDocument()
    expect(pdfFrame()!.getAttribute('src')).toBe(src)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(pdfFrame()).toBeNull())
    await user.click(screen.getByRole('button', { name: /receipt\.pdf/ }))
    await waitFor(() => expect(pdfFrame()).not.toBeNull())
    expect(pdfFrame()!.getAttribute('src')).toContain('X-Amz-Signature=new')
  })
})

describe('CollectionTaskDetailPanel (notification center)', () => {
  it('reloading on return to the tab does not reload an open file', async () => {
    const user = userEvent.setup()
    withStore(<CollectionTaskDetailPanel taskId={7} />)
    await user.click(await screen.findByRole('tab', { name: /קבצים/ }))
    await user.click(await screen.findByRole('button', { name: /statement\.pdf/ }))
    await waitFor(() => expect(pdfFrame()).not.toBeNull())
    const src = pdfFrame()!.getAttribute('src')

    const loads = collection.get.mock.calls.length
    await returnToWindow()
    await waitFor(() => expect(collection.get.mock.calls.length).toBeGreaterThan(loads))
    expect(pdfFrame()!.getAttribute('src')).toBe(src)
  })
})
