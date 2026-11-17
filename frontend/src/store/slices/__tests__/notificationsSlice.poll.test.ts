/**
 * The background poll's notification logic (pure reducer): what becomes a toast.
 *  - the first poll is the baseline: nothing that was already unread is toasted;
 *  - a new notification is toasted once; the same one on the next poll is not;
 *  - a merged chat notification (same id, new created_at) is toasted once more;
 *  - an old unread one that enters the window because newer ones were read is not;
 *  - many at once (more than 4): the 3 newest, then one summary toast without a
 *    number; reads happening meanwhile change nothing of that.
 */
import { describe, expect, it } from 'vitest'
import reducer, {
  MAX_TOASTS_PER_POLL, POLL_LATEST, pollNotifications, resetNotifications, toastDone,
  type NotificationBrief,
} from '../notificationsSlice'

type State = ReturnType<typeof reducer>

let t0 = Date.parse('2026-11-17T08:00:00')
const at = (min: number) => new Date(t0 + min * 60_000).toISOString().slice(0, 19)

const n = (id: number, min: number, extra: Partial<NotificationBrief> = {}): NotificationBrief => ({
  id, type: 'task_assignment', title: `n${id}`, body_preview: null, from_user_name: 'שולחת',
  task_title: 'משימה', task_kind: 'general', created_at: at(min), ...extra,
})

/** latest is newest first, like the API. */
const poll = (state: State, latest: NotificationBrief[], count = latest.length) =>
  reducer(state, pollNotifications.fulfilled({ count, latest }, 'r'))

const ids = (s: State) => s.toastQueue.map((t) => (t.kind === 'notification' ? t.notification.id : 'more'))
const base = (latest: NotificationBrief[], count?: number) => poll(reducer(undefined, { type: 'init' }), latest, count)

describe('baseline', () => {
  it('toasts nothing that was unread before the first poll', () => {
    const s = base([n(3, 3), n(2, 2), n(1, 1)])
    expect(s.baselineReady).toBe(true)
    expect(s.toastQueue).toEqual([])
    expect(s.unreadCount).toBe(3)
  })

  it('toasts nothing for an empty baseline either', () => {
    expect(base([]).toastQueue).toEqual([])
  })
})

describe('new notifications', () => {
  it('toasts a new one once, and not again on the next polls', () => {
    let s = base([n(1, 1)])
    s = poll(s, [n(2, 2), n(1, 1)])
    expect(ids(s)).toEqual([2])
    s = poll(reducer(s, toastDone()), [n(2, 2), n(1, 1)])
    s = poll(s, [n(2, 2), n(1, 1)])
    expect(s.toastQueue).toEqual([])
  })

  it('a merged chat notification (same id, newer time) is a new update, toasted once', () => {
    let s = base([n(1, 1, { type: 'task_message' })])
    s = poll(s, [n(1, 5, { type: 'task_message' })])
    expect(ids(s)).toEqual([1])
    s = poll(reducer(s, toastDone()), [n(1, 5, { type: 'task_message' })])
    expect(s.toastQueue).toEqual([])
  })

  it('a new one that was read before the next poll is never toasted', () => {
    let s = base([n(1, 1)])
    s = poll(s, [n(1, 1)])                               // n2 came and was read in between
    expect(s.toastQueue).toEqual([])
  })

  it('queues several in the order they happened', () => {
    let s = base([n(1, 1)])
    s = poll(s, [n(4, 4), n(3, 3), n(2, 2), n(1, 1)])
    expect(ids(s)).toEqual([2, 3, 4])
  })
})

describe('old notifications are not shown as new', () => {
  it('an old unread one entering a full window after newer ones were read', () => {
    const full = Array.from({ length: POLL_LATEST }, (_, i) => n(100 - i, 100 - i))   // 100..91
    let s = base(full, 25)                              // 15 more, older, below the window
    expect(s.windowFull).toBe(true)
    // The user read the 3 newest elsewhere: 3 older unread ones (88..90) slide in.
    const slid = [...full.slice(3), n(90, 90), n(89, 89), n(88, 88)]
    s = poll(s, slid, 22)
    expect(s.toastQueue).toEqual([])
  })

  it('a genuinely new one still shows when old ones slide in at the same time', () => {
    const full = Array.from({ length: POLL_LATEST }, (_, i) => n(100 - i, 100 - i))
    let s = base(full, 25)
    const next = [n(200, 200), ...full.slice(2), n(90, 90)]
    s = poll(s, next, 24)
    expect(ids(s)).toEqual([200])
  })
})

describe('many at once', () => {
  it(`more than ${MAX_TOASTS_PER_POLL}: the 3 newest, then one summary toast`, () => {
    let s = base([n(1, 1)])
    const six = [7, 6, 5, 4, 3, 2].map((id) => n(id, id))
    s = poll(s, [...six, n(1, 1)], 7)
    expect(ids(s)).toEqual([5, 6, 7, 'more'])
    expect(s.toastQueue).toHaveLength(MAX_TOASTS_PER_POLL)
    expect(s.toastQueue[3]).not.toHaveProperty('count')                 // no number
  })

  it('exactly the limit: all individually, no summary', () => {
    let s = base([n(1, 1)])
    s = poll(s, [n(5, 5), n(4, 4), n(3, 3), n(2, 2), n(1, 1)], 5)
    expect(ids(s)).toEqual([2, 3, 4, 5])
  })

  it('15 new while 5 old ones were read meanwhile: 3 toasts and the summary, nothing else', () => {
    const old = Array.from({ length: POLL_LATEST }, (_, i) => n(100 - i, 100 - i))   // 100..91 unread
    let s = base(old, 20)
    const window = Array.from({ length: POLL_LATEST }, (_, i) => n(300 - i, 300 - i)) // the 10 newest of 15
    s = poll(s, window, 30)                                // +15 new −5 read: the count rose by 10 only
    expect(ids(s)).toEqual([298, 299, 300, 'more'])
    // next round: nothing new, more old ones read — no toast at all
    s = poll(reducer(reducer(reducer(reducer(s, toastDone()), toastDone()), toastDone()), toastDone()), window, 22)
    expect(s.toastQueue).toEqual([])
  })

  it('reads alone (the count drops, nothing new) never produce a toast', () => {
    let s = base([n(3, 3), n(2, 2), n(1, 1)], 3)
    s = poll(s, [n(3, 3), n(1, 1)], 2)
    s = poll(s, [n(1, 1)], 1)
    s = poll(s, [], 0)
    expect(s.toastQueue).toEqual([])
  })

  it('a summary round still shows each new one only once afterwards', () => {
    let s = base([n(1, 1)])
    const six = [7, 6, 5, 4, 3, 2].map((id) => n(id, id))
    s = poll(s, [...six, n(1, 1)], 7)
    for (let i = 0; i < 4; i++) s = reducer(s, toastDone())
    s = poll(s, [...six, n(1, 1)], 7)                      // the same ones again: none is new
    expect(s.toastQueue).toEqual([])
    s = poll(s, [n(8, 8), ...six, n(1, 1)], 8)
    expect(ids(s)).toEqual([8])
  })
})

describe('queue and session', () => {
  it('toastDone moves to the next one', () => {
    let s = base([])
    s = poll(s, [n(2, 2), n(1, 1)])
    expect(ids(reducer(s, toastDone()))).toEqual([2])
  })

  it('reset (sign-out) starts a new baseline', () => {
    let s = poll(base([n(1, 1)]), [n(2, 2), n(1, 1)])
    s = reducer(s, resetNotifications())
    expect(s.baselineReady).toBe(false)
    expect(s.toastQueue).toEqual([])
    expect(poll(s, [n(3, 3), n(2, 2)]).toastQueue).toEqual([])
  })

  it('a failed poll changes nothing', () => {
    const s = base([n(1, 1)])
    expect(reducer(s, pollNotifications.rejected(null, 'r'))).toEqual(s)
  })

  it('lastChangeAt moves only when something changed', () => {
    let s = base([n(1, 1)])
    const before = s.lastChangeAt
    s = poll(s, [n(1, 1)])
    expect(s.lastChangeAt).toBe(before)
    s = poll(s, [n(2, 2), n(1, 1)], 2)
    expect(s.lastChangeAt).toBeGreaterThanOrEqual(before)
    expect(s.lastChangeAt).not.toBe(0)
  })
})
