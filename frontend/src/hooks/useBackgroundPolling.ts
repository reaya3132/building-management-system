import { useEffect } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../store'
import { pollNotifications, resetNotifications } from '../store/slices/notificationsSlice'

export const POLL_INTERVAL_MS = 30_000

/**
 * The app's one background poll: every 30s while signed in and the tab is
 * visible, and at once when the tab becomes visible again. Each round fetches the
 * notifications' unread count and newest unread items
 * (/notifications/unread-count?scope=all&latest=10) — the counter and the toasts.
 * A round never starts while the previous one is still out. Mount it once (App).
 */
export function useBackgroundPolling(): void {
  const dispatch = useDispatch<AppDispatch>()
  const me = useSelector((state: RootState) => state.auth.me)
  const userId = me?.id ?? null

  useEffect(() => {
    dispatch(resetNotifications())                    // a new session (or none) starts from scratch
    if (userId == null) return
    let active = true
    let inFlight = false
    // Aborted on sign-out / user change: a late answer must not become the next
    // user's baseline (an aborted thunk is rejected and changes nothing).
    let pending: { abort: () => void } | null = null

    const round = async () => {
      if (!active || inFlight || document.hidden) return
      inFlight = true
      const poll = dispatch(pollNotifications())
      pending = poll
      try {
        await poll
      } finally {
        pending = null
        inFlight = false
      }
    }

    void round()
    const interval = setInterval(() => { void round() }, POLL_INTERVAL_MS)
    const onVisible = () => { if (!document.hidden) void round() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      pending?.abort()
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [dispatch, userId])
}
