/**
 * The task chat refreshes in the background (every 8s and when the window gets
 * focus back). Files in S3 come back with a newly signed URL every time; an open
 * PDF must not be reloaded by that, and a new file must still show with its URL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import { TaskDetailPanel } from '../TaskDetailModal'
import authSlice from '../../../store/slices/authSlice'
import permissionsSlice from '../../../store/slices/permissionsSlice'
import { keepFileUrls, signedUrlExpiresAt, URL_RENEW_MARGIN_MS } from '../../../lib/stableFileUrls'

const TASK = {
  id: 42, title: 'לתקן מעלית', start_time: null, end_time: null, description: '', status: 'pending',
  event_type: 'task', assigned_to_user_id: 1, assigned_to_user_ids: [1],
  assignees: [{ user_id: 1, full_name: 'Admin', avatar_url: null, color: '#888' }], participants: [], labels: [],
  is_backlog: false, is_archived: false, unique_tag: 't', recurrence_rule: '', recurrence_interval: 1,
} as any

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
vi.mock('../../../lib/api', () => ({
  default: api, avatarUrl: () => null, fileAttachmentUrl: (p: string | null) => p || null,
}))
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<any>()), useNavigate: () => vi.fn() }))

/** A SigV4-style signed URL, signed at `at`, valid for `ttl` seconds. */
function signed(key: string, at: number, ttl = 3600, sig = String(at)) {
  const d = new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return `https://bucket.s3.amazonaws.com/${key}?X-Amz-Date=${d}&X-Amz-Expires=${ttl}&X-Amz-Signature=${sig}`
}

const msg = (id: number, attachments: { id: number; file_name: string; file_url: string }[]) => ({
  id, task_id: 42, user_id: 2, full_name: 'דנה', message: `הודעה ${id}`,
  created_at: '2026-11-18T08:00:00', attachments,
})

let messageCalls = 0
let extraMessage: ReturnType<typeof msg> | null = null

// jsdom has no scrollTo (the chat scrolls to its newest message).
Element.prototype.scrollTo = function () {} as any

beforeEach(() => {
  vi.clearAllMocks()
  messageCalls = 0
  extraMessage = null
  api.get.mockImplementation((url: string) => {
    if (url.includes('/messages')) {
      messageCalls += 1
      // Every response signs the same file anew: a different URL each time.
      const list = [msg(1, [{ id: 7, file_name: 'report.pdf', file_url: signed('report.pdf', Date.now(), 3600, `s${messageCalls}`) }])]
      if (extraMessage) list.push(extraMessage)
      return Promise.resolve({ data: list })
    }
    if (url.includes('/checklist')) return Promise.resolve({ data: [] })
    return Promise.resolve({ data: TASK })
  })
})

const store = () => configureStore({
  reducer: { auth: authSlice, permissions: permissionsSlice },
  preloadedState: { auth: { me: { id: 1, role: 'Admin', full_name: 'Admin' } } as any },
})

const pdfFrame = () => document.querySelector('iframe')

async function refreshChat() {
  const before = messageCalls
  await act(async () => { fireEvent.focus(window) })          // the window gets focus back
  await waitFor(() => expect(messageCalls).toBeGreaterThan(before))
}

describe('the chat refresh and an open document', () => {
  it('does not reload an open PDF; a new file shows with its own URL', async () => {
    const user = userEvent.setup()
    render(<Provider store={store()}><TaskDetailPanel taskId={42} initialTask={TASK} onClose={vi.fn()} embedded /></Provider>)

    await user.click(await screen.findByRole('button', { name: /report\.pdf/ }))
    await waitFor(() => expect(pdfFrame()).not.toBeNull())
    const src = pdfFrame()?.getAttribute('src')
    expect(src).toContain('report.pdf')

    await refreshChat()
    await refreshChat()
    expect(pdfFrame()?.getAttribute('src')).toBe(src)               // same document, not reloaded

    // A new message with a new file arrives on the next refresh.
    extraMessage = msg(2, [{ id: 8, file_name: 'invoice.pdf', file_url: signed('invoice.pdf', Date.now(), 3600, 'new') }])
    await refreshChat()
    expect(await screen.findByText('הודעה 2')).toBeInTheDocument()
    expect(pdfFrame()?.getAttribute('src')).toBe(src)               // still untouched

    // Close the viewer and open the new file: it uses the URL the server sent.
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(pdfFrame()).toBeNull())
    await user.click(screen.getByRole('button', { name: /invoice\.pdf/ }))
    await waitFor(() => expect(pdfFrame()).not.toBeNull())
    expect(pdfFrame()?.getAttribute('src')).toContain('invoice.pdf')
    expect(pdfFrame()?.getAttribute('src')).toContain('X-Amz-Signature=new')
  })
})

describe('an open document while its URL is renewed', () => {
  it('stays as it is; the links and the next opening use the renewed, valid URL', async () => {
    const user = userEvent.setup()
    // The first URL is about to expire: the next refresh renews it.
    let renewed = false
    api.get.mockImplementation((url: string) => {
      if (url.includes('/messages')) {
        messageCalls += 1
        const fileUrl = renewed
          ? signed('report.pdf', Date.now(), 3600, 'renewed')
          : signed('report.pdf', Date.now() - 3600_000 + 60_000, 3600, 'expiring')
        return Promise.resolve({ data: [msg(1, [{ id: 7, file_name: 'report.pdf', file_url: fileUrl }])] })
      }
      if (url.includes('/checklist')) return Promise.resolve({ data: [] })
      return Promise.resolve({ data: TASK })
    })
    render(<Provider store={store()}><TaskDetailPanel taskId={42} initialTask={TASK} onClose={vi.fn()} embedded /></Provider>)

    await user.click(await screen.findByRole('button', { name: /report\.pdf/ }))
    await waitFor(() => expect(pdfFrame()).not.toBeNull())
    const src = pdfFrame()!.getAttribute('src')
    expect(src).toContain('X-Amz-Signature=expiring')

    renewed = true
    await refreshChat()
    const download = () => screen.getByRole('link', { name: /הורד/ })
    await waitFor(() => expect(download().getAttribute('href')).toContain('X-Amz-Signature=renewed'))
    expect(pdfFrame()!.getAttribute('src')).toBe(src)               // the open document is not reloaded

    // Opened again: with the renewed, valid URL.
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(pdfFrame()).toBeNull())
    await user.click(screen.getByRole('button', { name: /report\.pdf/ }))
    await waitFor(() => expect(pdfFrame()).not.toBeNull())
    expect(pdfFrame()!.getAttribute('src')).toContain('X-Amz-Signature=renewed')
  })
})

describe('keepFileUrls', () => {
  const now = Date.UTC(2026, 10, 18, 10, 0, 0)
  const list = (url: string) => [msg(1, [{ id: 7, file_name: 'a.pdf', file_url: url }])]

  it('reads the expiry from a signed URL; a local path has none', () => {
    expect(signedUrlExpiresAt(signed('a.pdf', now, 600))).toBe(now + 600_000)
    expect(signedUrlExpiresAt('https://b.s3.amazonaws.com/a.pdf?Expires=1800000000&Signature=x')).toBe(1_800_000_000_000)
    expect(signedUrlExpiresAt('/uploads/task_attachments/a.pdf')).toBeNull()
  })

  it('keeps a still-valid URL for the same file', () => {
    const old = signed('a.pdf', now - 60_000)
    const out = keepFileUrls(list(old), list(signed('a.pdf', now, 3600, 'fresh')), now)
    expect(out[0].attachments![0].file_url).toBe(old)
  })

  it('takes the new URL when the current one is near its expiry (recovers, no dead link)', () => {
    const old = signed('a.pdf', now - 3600_000 + URL_RENEW_MARGIN_MS - 1000)   // under the margin left
    const fresh = signed('a.pdf', now, 3600, 'fresh')
    expect(keepFileUrls(list(old), list(fresh), now)[0].attachments![0].file_url).toBe(fresh)
  })

  it('a new file takes its URL; the rest of the refresh comes through as sent', () => {
    const prev = list(signed('a.pdf', now))
    const next = [...list(signed('a.pdf', now, 3600, 'x')), msg(2, [{ id: 8, file_name: 'b.pdf', file_url: 'u8' }])]
    const out = keepFileUrls(prev, next, now)
    expect(out[1]).toBe(next[1])
    expect(out).toHaveLength(2)
  })
})
