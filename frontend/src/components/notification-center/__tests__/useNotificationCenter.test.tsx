/**
 * The notification center's list (3e-2a), against a small fake server that pages
 * like the API (newest first, 30 a page, X-Next-Cursor):
 *  - a poll refreshes the first page only; pages loaded below stay; merged by id;
 *  - the gap guard (no overlap): the list becomes the new page, its cursor next;
 *  - the selected notification stays shown through refreshes and view changes;
 *  - a refresh waits while a mark request is out (and a late answer is dropped);
 *  - marking is optimistic (list + counter), rolled back when the request fails;
 *  - switching views starts again from the first page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import type { ReactNode } from 'react'

import notificationsReducer, { pollNotifications, setUnreadCount } from '../../../store/slices/notificationsSlice'
import {
  PAGE_SIZE, mergeFirstPage, useNotificationCenter, type CenterNotification, type CenterView,
} from '../useNotificationCenter'

// ── a fake server ─────────────────────────────────────────────────────────────

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }))
vi.mock('../../../lib/api', () => ({ default: api }))

let rows: CenterNotification[] = []
let minute = 0
const iso = (m: number) => new Date(Date.UTC(2026, 10, 17, 8, 0) + m * 60_000).toISOString().slice(0, 19)

function make(id: number, extra: Partial<CenterNotification> = {}): CenterNotification {
  return {
    id, type: 'task_assignment', title: `n${id}`, body_preview: null, from_user_id: 2, from_user_name: 'שולחת',
    task_id: 1, task_title: 'משימה', task_kind: 'general', task_archived: false, read_at: null,
    created_at: iso(++minute), ...extra,
  }
}
const seed = (n: number, extra: Partial<CenterNotification> = {}) => {
  const made = Array.from({ length: n }, (_, i) => make(i + 1, extra))
  rows.push(...made)
  return made
}
const order = (list: CenterNotification[]) =>
  [...list].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)

function serve(_url: string, { params }: { params: { view: CenterView; limit: number; cursor?: string } }) {
  const inView = order(rows).filter((r) => params.view === 'all' || (params.view === 'unread') === (r.read_at == null))
  const start = params.cursor ? inView.findIndex((r) => `${r.created_at}|${r.id}` === params.cursor) + 1 : 0
  const page = inView.slice(start, start + params.limit)
  const more = start + params.limit < inView.length
  return Promise.resolve({
    data: page.map((r) => ({ ...r })),
    headers: more ? { 'x-next-cursor': `${page[page.length - 1].created_at}|${page[page.length - 1].id}` } : {},
  })
}

function patchOk(url: string, _body: unknown, { params }: { params: { read: boolean } }) {
  const id = Number(url.split('/')[2])
  const row = rows.find((r) => r.id === id)!
  row.read_at = params.read ? iso(500) : null
  return Promise.resolve({ data: { ...row } })
}

const lastGet = () => api.get.mock.calls[api.get.mock.calls.length - 1][1]
const firstPageCalls = () => api.get.mock.calls.filter(([, o]) => !o.params.cursor).length

// ── the store and the hook ────────────────────────────────────────────────────

function setup(view: CenterView = 'unread', unread = 0) {
  const store = configureStore({ reducer: { notifications: notificationsReducer } })
  store.dispatch(setUnreadCount(unread))
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>
  const hook = renderHook(({ v }) => useNotificationCenter(v), { wrapper, initialProps: { v: view } })
  return { store, ...hook }
}

/** What a poll that brought something does: lastChangeAt moves. */
let polls = 0
function polled(store: ReturnType<typeof setup>['store']) {
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + ++polls)
  act(() => {
    store.dispatch(pollNotifications.fulfilled({ count: 1000 + polls, latest: [] }, 'r'))
  })
  vi.mocked(Date.now).mockRestore()
}

const ids = (list: CenterNotification[]) => list.map((n) => n.id)

beforeEach(() => {
  vi.clearAllMocks()
  rows = []
  minute = 0
  api.get.mockImplementation(serve)
  api.patch.mockImplementation(patchOk)
})
afterEach(() => vi.restoreAllMocks())

// ── mergeFirstPage (pure) ─────────────────────────────────────────────────────

describe('mergeFirstPage', () => {
  // Built per test (after the clock is reset), ids 10..5.
  const sortedByMinute = (_: unknown) => order(Array.from({ length: 6 }, (_, i) => make(10 - i)))
  const list = null

  it('keeps the loaded pages below the new first page, by id, no duplicates', () => {
    const ordered = sortedByMinute(list)
    const page = [make(11), ...ordered.slice(0, 2)]                       // a new one + the 2 newest
    const merged = mergeFirstPage(ordered, 'c1', page, 'c-page')
    expect(ids(merged.items)).toEqual([11, ...ids(ordered)])
    expect(merged.cursor).toBe('c1')                                        // loading more continues below
  })

  it('removes one that left the first page range (read elsewhere)', () => {
    const ordered = sortedByMinute(list)
    const page = [ordered[0], ordered[2]]                                   // ordered[1] is gone
    const merged = mergeFirstPage(ordered, 'c1', page, 'c-page')
    expect(ids(merged.items)).toEqual(ids(ordered).filter((id) => id !== ordered[1].id))
  })

  it('a merged one that moved to the top appears once', () => {
    const ordered = sortedByMinute(list)
    const moved = { ...ordered[4], created_at: iso(999) }
    const merged = mergeFirstPage(ordered, 'c1', [moved, ordered[0], ordered[1]], 'c-page')
    expect(ids(merged.items).filter((id) => id === moved.id)).toHaveLength(1)
    expect(merged.items[0].id).toBe(moved.id)
  })

  it('the gap guard: no overlap → exactly the new page and its cursor', () => {
    const ordered = sortedByMinute(list)
    const fresh = [make(30), make(31)]
    const page = order(fresh)
    const merged = mergeFirstPage(ordered, 'old-cursor', page, 'new-cursor')
    expect(ids(merged.items)).toEqual(ids(page))
    expect(merged.cursor).toBe('new-cursor')
  })

  it('a first page that is the whole view: exactly that page, nothing more to load', () => {
    const ordered = sortedByMinute(list)
    const merged = mergeFirstPage(ordered, 'c1', ordered.slice(0, 2), null)
    expect(ids(merged.items)).toEqual(ids(ordered.slice(0, 2)))
    expect(merged.cursor).toBeNull()
  })
})

// ── the hook ──────────────────────────────────────────────────────────────────

describe('loading', () => {
  it('starts with the first page of the unread view, loads more until there is no cursor', async () => {
    seed(70)
    const { result } = setup()
    await waitFor(() => expect(result.current.items).toHaveLength(PAGE_SIZE))
    expect(api.get).toHaveBeenCalledWith('/notifications/', { params: { scope: 'all', view: 'unread', limit: PAGE_SIZE } })
    expect(result.current.hasMore).toBe(true)
    await act(() => result.current.loadMore())
    await act(() => result.current.loadMore())
    expect(result.current.items).toHaveLength(70)
    expect(new Set(ids(result.current.items)).size).toBe(70)
    expect(result.current.hasMore).toBe(false)
    const calls = api.get.mock.calls.length
    await act(() => result.current.loadMore())
    expect(api.get.mock.calls.length).toBe(calls)                           // nothing more to ask
  })
})

describe('refresh after a poll', () => {
  it('fetches the first page only and keeps the pages loaded below', async () => {
    seed(70)
    const { result, store } = setup()
    await waitFor(() => expect(result.current.items).toHaveLength(PAGE_SIZE))
    await act(() => result.current.loadMore())
    expect(result.current.items).toHaveLength(60)
    rows.push(make(100))                                                      // a new one arrives
    const before = api.get.mock.calls.length
    polled(store)
    await waitFor(() => expect(result.current.items[0].id).toBe(100))
    expect(api.get.mock.calls.length - before).toBe(1)
    expect(lastGet().params.cursor).toBeUndefined()      // the first page
    expect(result.current.items).toHaveLength(61)                            // page 2 still there
    expect(new Set(ids(result.current.items)).size).toBe(61)
  })

  it('a merged one moves to the top, once; loading more afterwards adds no duplicate', async () => {
    seed(70)
    const { result, store } = setup()
    await waitFor(() => expect(result.current.items).toHaveLength(PAGE_SIZE))
    await act(() => result.current.loadMore())
    const deep = result.current.items[45]
    rows.find((r) => r.id === deep.id)!.created_at = iso(900)              // merged: newer time, same id
    polled(store)
    await waitFor(() => expect(result.current.items[0].id).toBe(deep.id))
    expect(ids(result.current.items).filter((id) => id === deep.id)).toHaveLength(1)
    await act(() => result.current.loadMore())
    expect(ids(result.current.items).filter((id) => id === deep.id)).toHaveLength(1)
    expect(new Set(ids(result.current.items)).size).toBe(result.current.items.length)
  })

  it('the gap guard keeps the selected one shown and continues from the new cursor', async () => {
    seed(40)
    const { result, store } = setup()
    await waitFor(() => expect(result.current.items).toHaveLength(PAGE_SIZE))
    const chosen = result.current.items[3]
    act(() => result.current.select(chosen))
    await waitFor(() => expect(result.current.patchingId).toBeNull())
    for (let i = 0; i < 35; i++) rows.push(make(200 + i))                   // a burst: more than a page
    polled(store)
    await waitFor(() => expect(result.current.items[0].id).toBe(234))
    expect(ids(result.current.items)).toEqual(ids(order(rows.filter((r) => r.read_at == null)).slice(0, PAGE_SIZE)))
    expect(result.current.selected?.id).toBe(chosen.id)                     // still shown
    await act(() => result.current.loadMore())                               // continues from the new page
    const unread = order(rows.filter((r) => r.read_at == null))
    expect(ids(result.current.items)).toEqual(ids(unread).slice(0, PAGE_SIZE * 2))
    expect(new Set(ids(result.current.items)).size).toBe(result.current.items.length)
  })

  it('keeps the selected one shown after it left the unread view', async () => {
    seed(5)
    const { result, store } = setup('unread', 5)
    await waitFor(() => expect(result.current.items).toHaveLength(5))
    const chosen = result.current.items[1]
    act(() => result.current.select(chosen))
    await waitFor(() => expect(result.current.patchingId).toBeNull())
    polled(store)
    await waitFor(() => expect(firstPageCalls()).toBe(2))
    expect(ids(result.current.items)).not.toContain(chosen.id)
    expect(result.current.selected?.id).toBe(chosen.id)
    expect(result.current.selected?.read_at).not.toBeNull()
  })
})

describe('refresh while a mark request is out', () => {
  it('waits, then runs once when it is done', async () => {
    seed(5)
    let release!: () => void
    api.patch.mockImplementationOnce((url: string, body: unknown, opts: any) =>
      new Promise((resolve) => { release = () => resolve(patchOk(url, body, opts)) }))
    const { result, store } = setup('unread', 5)
    await waitFor(() => expect(result.current.items).toHaveLength(5))
    act(() => result.current.select(result.current.items[0]))
    polled(store)
    polled(store)
    expect(firstPageCalls()).toBe(1)                                         // postponed
    await act(async () => { release(); await Promise.resolve() })
    await waitFor(() => expect(firstPageCalls()).toBe(2))                   // exactly one, after
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(firstPageCalls()).toBe(2)
  })

  it('drops a refresh answer that arrives after a mark started, and refreshes again after', async () => {
    seed(5)
    const { result, store } = setup('unread', 5)
    await waitFor(() => expect(result.current.items).toHaveLength(5))
    let answer!: () => void
    api.get.mockImplementationOnce((url: string, opts: any) => {
      const stale = serve(url, opts)                                          // taken now: the target still unread
      return new Promise((resolve) => { answer = () => resolve(stale) })
    })
    let release!: () => void
    api.patch.mockImplementationOnce((url: string, body: unknown, opts: any) =>
      new Promise((resolve) => { release = () => resolve(patchOk(url, body, opts)) }))
    polled(store)                                                             // refresh out
    const target = result.current.items[0]
    act(() => result.current.select(target))                                  // the mark starts meanwhile
    await act(async () => { answer(); await Promise.resolve(); await Promise.resolve() })
    expect(ids(result.current.items)).not.toContain(target.id)               // the stale answer was dropped
    expect(firstPageCalls()).toBe(2)
    await act(async () => { release(); await Promise.resolve() })
    await waitFor(() => expect(firstPageCalls()).toBe(3))                   // the postponed refresh, once
    await waitFor(() => expect(result.current.patchingId).toBeNull())
    expect(ids(result.current.items)).not.toContain(target.id)
  })
})

describe('read / unread', () => {
  it('selecting marks read at once: out of the unread view, counter down, still selected', async () => {
    seed(3)
    const { result, store } = setup('unread', 3)
    await waitFor(() => expect(result.current.items).toHaveLength(3))
    const chosen = result.current.items[0]
    act(() => result.current.select(chosen))
    expect(ids(result.current.items)).not.toContain(chosen.id)               // before the answer
    expect(store.getState().notifications.unreadCount).toBe(2)
    expect(result.current.selected?.id).toBe(chosen.id)
    await waitFor(() => expect(result.current.patchingId).toBeNull())
    expect(api.patch).toHaveBeenCalledWith(`/notifications/${chosen.id}/read`, null, { params: { read: true, scope: 'all' } })
    expect(result.current.selected?.read_at).toBe(iso(500))                 // the server's answer
  })

  it('a failed mark is rolled back: back in its place, counter restored, an error', async () => {
    seed(3)
    api.patch.mockRejectedValueOnce(new Error('500'))
    const { result, store } = setup('unread', 3)
    await waitFor(() => expect(result.current.items).toHaveLength(3))
    const before = ids(result.current.items)
    const chosen = result.current.items[1]
    act(() => result.current.select(chosen))
    await waitFor(() => expect(result.current.error).toBe('סימון ההתראה כנקראה נכשל'))
    expect(ids(result.current.items)).toEqual(before)
    expect(store.getState().notifications.unreadCount).toBe(3)
    expect(result.current.selected?.read_at).toBeNull()
  })

  it('mark unread: counter up, back in the unread view; failure rolls it back', async () => {
    seed(3, { read_at: iso(400) })
    const { result, store } = setup('all', 0)
    await waitFor(() => expect(result.current.items).toHaveLength(3))
    const chosen = result.current.items[0]
    act(() => result.current.select(chosen))                                 // already read: no request
    expect(api.patch).not.toHaveBeenCalled()
    await act(() => result.current.setRead(chosen, false))
    expect(store.getState().notifications.unreadCount).toBe(1)
    expect(result.current.selected?.read_at).toBeNull()

    api.patch.mockRejectedValueOnce(new Error('500'))
    const other = result.current.items[1]
    await act(() => result.current.setRead(other, false))
    expect(store.getState().notifications.unreadCount).toBe(1)               // restored
    expect(result.current.items.find((n) => n.id === other.id)?.read_at).not.toBeNull()
    expect(result.current.error).toBe('סימון ההתראה כלא נקראה נכשל')
  })

  it('one request per notification at a time', async () => {
    seed(2, { read_at: iso(400) })
    let release!: () => void
    api.patch.mockImplementationOnce((url: string, body: unknown, opts: any) =>
      new Promise((resolve) => { release = () => resolve(patchOk(url, body, opts)) }))
    const { result } = setup('all', 0)
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    const n = result.current.items[0]
    act(() => { void result.current.setRead(n, false) })
    act(() => { void result.current.setRead({ ...n, read_at: null }, true) })
    expect(api.patch).toHaveBeenCalledTimes(1)
    expect(result.current.patchingId).toBe(n.id)
    await act(async () => { release(); await Promise.resolve() })
  })
})

describe('switching views', () => {
  it('starts from the first page of the new view, ignores a late answer of the old one, keeps the selection', async () => {
    seed(4)
    rows.push(make(50, { read_at: iso(450) }))
    const { result, rerender } = setup('unread', 4)
    await waitFor(() => expect(result.current.items).toHaveLength(4))
    act(() => result.current.select(result.current.items[0]))
    await waitFor(() => expect(result.current.patchingId).toBeNull())
    const chosen = result.current.selected!

    let late!: () => void
    api.get.mockImplementationOnce((url: string, opts: any) =>
      new Promise((resolve) => { late = () => resolve(serve(url, opts)) }))
    rerender({ v: 'all' })                                                    // its answer is held back
    rerender({ v: 'read' })
    await waitFor(() => expect(ids(result.current.items)).toEqual(
      ids(order(rows.filter((r) => r.read_at != null)))))
    await act(async () => { late(); await Promise.resolve() })                // the 'all' answer, too late
    expect(result.current.items.every((n) => n.read_at != null)).toBe(true)
    expect(lastGet().params).toEqual({ scope: 'all', view: 'read', limit: PAGE_SIZE })
    expect(result.current.selected?.id).toBe(chosen.id)
  })
})
