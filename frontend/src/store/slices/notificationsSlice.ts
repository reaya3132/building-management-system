import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import api from '../../lib/api'

/** What a toast shows — the API's unread-count?latest=N items carry it all. */
export interface NotificationBrief {
  id: number
  type: string
  title: string
  body_preview: string | null
  from_user_name: string | null
  task_title: string | null
  task_kind: 'general' | 'collection' | null
  created_at: string
}

export type NotificationToast =
  | { kind: 'notification'; key: string; notification: NotificationBrief }
  /** "עדכונים נוספים ממתינים לך" — no number; the center holds them all. */
  | { kind: 'more'; key: string }

/** The background poll asks for this many of the newest unread notifications. */
export const POLL_LATEST = 10
/** At most this many toasts per poll; beyond it: the newest ones and one summary toast. */
export const MAX_TOASTS_PER_POLL = 4
const SHOWN_KEYS_LIMIT = 500

interface NotificationsState {
  /** Unread notifications of every module (capped by the server at 1000). */
  unreadCount: number
  /** False until the first poll: what is unread then is the baseline, never toasted. */
  baselineReady: boolean
  /** `id:created_at` of everything already seen. A merged chat notification gets a
   * new created_at, so it counts as new once; nothing is toasted twice. */
  shownKeys: string[]
  /** The previous poll's window: whether it was full, and its oldest item. An unseen
   * item older than that, appearing once newer ones were read, is an old one
   * resurfacing — not new. */
  windowFull: boolean
  windowOldest: string | null
  toastQueue: NotificationToast[]
  /** Bumped when something new arrived (the notification center refreshes on it). */
  lastChangeAt: number
}

const initialState: NotificationsState = {
  unreadCount: 0,
  baselineReady: false,
  shownKeys: [],
  windowFull: false,
  windowOldest: null,
  toastQueue: [],
  lastChangeAt: 0,
}

export const notificationKey = (n: Pick<NotificationBrief, 'id' | 'created_at'>) => `${n.id}:${n.created_at}`
const time = (iso: string) => Date.parse(iso)

export const fetchUnreadCount = createAsyncThunk(
  'notifications/fetchUnreadCount',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await api.get<{ count: number }>('/notifications/unread-count', { params: { scope: 'all' } })
      return data.count
    } catch {
      return rejectWithValue(0)
    }
  }
)

/** One round of the background poll for notifications: the unread count of every
 * module and the newest unread ones, in a single light request. */
export const pollNotifications = createAsyncThunk(
  'notifications/poll',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await api.get<{ count: number; latest: NotificationBrief[] }>(
        '/notifications/unread-count', { params: { scope: 'all', latest: POLL_LATEST } })
      return data
    } catch {
      return rejectWithValue(null)
    }
  }
)

const notificationsSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {
    setUnreadCount(state, action: PayloadAction<number>) {
      state.unreadCount = action.payload
    },
    /** The notification center marked one read (−1) / unread (+1) — optimistically,
     * and back on failure. The next poll brings the server's exact count. */
    adjustUnread(state, action: PayloadAction<number>) {
      state.unreadCount = Math.max(0, state.unreadCount + action.payload)
    },
    /** The toast on screen is done (timed out, closed or clicked). */
    toastDone(state) {
      state.toastQueue.shift()
    },
    /** Signed out: the next session starts with a fresh baseline. */
    resetNotifications() {
      return initialState
    },
  },
  extraReducers: (builder) => {
    builder.addCase(fetchUnreadCount.fulfilled, (state, action) => {
      state.unreadCount = action.payload
    })
    builder.addCase(fetchUnreadCount.rejected, (state) => {
      state.unreadCount = 0
    })
    builder.addCase(pollNotifications.fulfilled, (state, action) => {
      const { count, latest } = action.payload
      const previousCount = state.unreadCount
      state.unreadCount = count
      const seen = new Set(state.shownKeys)
      const fresh = state.baselineReady
        ? latest.filter((n) => !seen.has(notificationKey(n)) &&
            !(state.windowFull && state.windowOldest && time(n.created_at) < time(state.windowOldest)))
        : []                                                    // the baseline: nothing is new
      state.baselineReady = true
      state.windowFull = latest.length >= POLL_LATEST
      state.windowOldest = latest.length ? latest[latest.length - 1].created_at : null
      state.shownKeys = [...latest.map(notificationKey).filter((k) => !seen.has(k)), ...state.shownKeys]
        .slice(0, SHOWN_KEYS_LIMIT)
      if (count !== previousCount || fresh.length) state.lastChangeAt = Date.now()
      if (!fresh.length) return

      // Oldest first, so the queue reads in the order things happened. More than the
      // limit: the newest ones, then one summary toast — without a number (the
      // center holds them all).
      const ordered = [...fresh].reverse()
      const overflow = ordered.length > MAX_TOASTS_PER_POLL
      const individual = overflow ? ordered.slice(ordered.length - (MAX_TOASTS_PER_POLL - 1)) : ordered
      for (const n of individual) {
        state.toastQueue.push({ kind: 'notification', key: notificationKey(n), notification: n })
      }
      if (overflow) state.toastQueue.push({ kind: 'more', key: `more:${Date.now()}` })
    })
  },
})

export const { setUnreadCount, adjustUnread, toastDone, resetNotifications } = notificationsSlice.actions
export default notificationsSlice.reducer
