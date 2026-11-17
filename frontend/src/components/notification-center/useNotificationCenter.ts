import { useCallback, useEffect, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../../store'
import api from '../../lib/api'
import { adjustUnread } from '../../store/slices/notificationsSlice'

export type CenterView = 'unread' | 'read' | 'all'
export const CENTER_VIEWS: CenterView[] = ['unread', 'read', 'all']
export const PAGE_SIZE = 30

/** A notification as the center receives it (GET /notifications/?scope=all):
 * no ``body`` — ``body_preview`` only, never a chat message's text. */
export interface CenterNotification {
  id: number
  type: string
  title: string
  body_preview: string | null
  from_user_id: number | null
  from_user_name: string | null
  task_id: number | null
  task_title: string | null
  task_kind: 'general' | 'collection' | null
  task_archived: boolean | null
  read_at: string | null
  created_at: string
}

/** Server timestamps carry no zone and are UTC. */
export const serverTime = (iso: string) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)

/** Newest first: created_at DESC, id DESC — the API's (and the indexes') order. */
const newerFirst = (a: CenterNotification, b: CenterNotification) =>
  serverTime(b.created_at) - serverTime(a.created_at) || b.id - a.id

const sorted = (list: CenterNotification[]) => [...list].sort(newerFirst)

/** Whether a notification belongs in a view, by its read state. */
export const inView = (view: CenterView, n: Pick<CenterNotification, 'read_at'>) =>
  view === 'all' || (view === 'unread') === (n.read_at == null)

async function fetchPage(view: CenterView, cursor: string | null) {
  const response = await api.get<CenterNotification[]>('/notifications/', {
    params: { scope: 'all', view, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
  })
  return { page: response.data, next: (response.headers?.['x-next-cursor'] as string | undefined) ?? null }
}

/** The first page fetched again, merged into what is loaded (by id, no duplicates):
 *  - the new first page replaces what it covers;
 *  - the pages loaded below it stay as they are (they are not fetched again);
 *  - the first page is all there is (no next cursor): the list is exactly that page;
 *  - no overlap at all with the list (a burst of new ones): the gap guard — the list
 *    becomes that page and its cursor, the deeper pages are dropped (scroll again). */
export function mergeFirstPage(
  list: CenterNotification[], cursor: string | null, page: CenterNotification[], next: string | null,
): { items: CenterNotification[]; cursor: string | null } {
  if (next == null) return { items: page, cursor: null }
  const loaded = new Set(list.map((n) => n.id))
  if (!page.some((n) => loaded.has(n.id))) return { items: page, cursor: next }
  const onPage = new Set(page.map((n) => n.id))
  const last = page[page.length - 1]
  const below = list.filter((n) => !onPage.has(n.id) && newerFirst(last, n) < 0)
  return { items: sorted([...page, ...below]), cursor }
}

/**
 * The notification center's list: one view at a time, progressive loading, the
 * selected notification, mark read / unread.
 *
 * Kept simple on purpose:
 *  - a poll that brought something (``lastChangeAt``) re-fetches the first page only;
 *  - while a mark-read/unread request is out, that refresh waits and runs once after;
 *  - marking is optimistic (list + counter) and rolled back if the request fails;
 *  - switching views starts again from the first page; the selected one stays shown.
 */
export function useNotificationCenter(view: CenterView) {
  const dispatch = useDispatch<AppDispatch>()
  const lastChangeAt = useSelector((state: RootState) => state.notifications.lastChangeAt)

  const [items, setItems] = useState<CenterNotification[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<CenterNotification | null>(null)
  const [patchingId, setPatchingId] = useState<number | null>(null)

  // One counter for the whole list: answers to an earlier view are ignored.
  const loadId = useRef(0)
  const viewRef = useRef(view)
  viewRef.current = view
  const listRef = useRef({ items, cursor })
  listRef.current = { items, cursor }
  const patching = useRef(0)
  const patchingIds = useRef(new Set<number>())
  const refreshQueued = useRef(false)
  const refreshing = useRef(false)

  // ── loading ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const id = ++loadId.current
    setItems([])
    setCursor(null)
    setLoading(true)
    setError(null)
    fetchPage(view, null)
      .then(({ page, next }) => {
        if (id !== loadId.current) return
        setItems(page)
        setCursor(next)
      })
      .catch(() => { if (id === loadId.current) setError('טעינת העדכונים נכשלה') })
      .finally(() => { if (id === loadId.current) setLoading(false) })
  }, [view])

  const loadMore = useCallback(async () => {
    const { cursor: from } = listRef.current
    if (!from || loadingMore) return
    const id = loadId.current
    setLoadingMore(true)
    try {
      const { page, next } = await fetchPage(viewRef.current, from)
      if (id !== loadId.current) return
      setItems((list) => {
        const loaded = new Set(list.map((n) => n.id))
        return sorted([...list, ...page.filter((n) => !loaded.has(n.id))])
      })
      setCursor(next)
    } catch {
      if (id === loadId.current) setError('טעינת עדכונים נוספים נכשלה')
    } finally {
      if (id === loadId.current) setLoadingMore(false)
    }
  }, [loadingMore])

  const refresh = useCallback(async () => {
    if (patching.current > 0 || refreshing.current) { refreshQueued.current = true; return }
    refreshing.current = true
    const id = loadId.current
    try {
      const { page, next } = await fetchPage(viewRef.current, null)
      if (id !== loadId.current) return
      if (patching.current > 0) { refreshQueued.current = true; return }   // a mark started meanwhile
      const merged = mergeFirstPage(listRef.current.items, listRef.current.cursor, page, next)
      setItems(merged.items)
      setCursor(merged.cursor)
      setSelected((current) => (current && page.find((n) => n.id === current.id)) || current)
    } catch {
      /* a background refresh failing keeps the list; the next poll tries again */
    } finally {
      refreshing.current = false
      if (refreshQueued.current && patching.current === 0) {
        refreshQueued.current = false
        void refresh()
      }
    }
  }, [])

  const seenChange = useRef(lastChangeAt)
  useEffect(() => {
    if (lastChangeAt === seenChange.current) return
    seenChange.current = lastChangeAt
    void refresh()
  }, [lastChangeAt, refresh])

  // ── read / unread ──────────────────────────────────────────────────────────

  /** Put a notification in the list as its read state and the view say. */
  const place = useCallback((n: CenterNotification) => {
    setItems((list) => {
      const rest = list.filter((x) => x.id !== n.id)
      return inView(viewRef.current, n) ? sorted([...rest, n]) : rest
    })
  }, [])

  const setRead = useCallback(async (n: CenterNotification, read: boolean) => {
    if (read === (n.read_at != null)) return
    if (patchingIds.current.has(n.id)) return              // one request per notification at a time
    const optimistic = { ...n, read_at: read ? new Date().toISOString() : null }
    place(optimistic)
    setSelected((current) => (current?.id === n.id ? optimistic : current))
    dispatch(adjustUnread(read ? -1 : 1))
    patching.current += 1
    patchingIds.current.add(n.id)
    setPatchingId(n.id)
    setError(null)
    try {
      const { data } = await api.patch<CenterNotification>(`/notifications/${n.id}/read`, null, {
        params: { read, scope: 'all' },
      })
      place(data)
      setSelected((current) => (current?.id === n.id ? data : current))
    } catch {
      place(n)                                           // back as it was, in its place
      setSelected((current) => (current?.id === n.id ? n : current))
      dispatch(adjustUnread(read ? 1 : -1))
      setError(read ? 'סימון ההתראה כנקראה נכשל' : 'סימון ההתראה כלא נקראה נכשל')
    } finally {
      patching.current -= 1
      patchingIds.current.delete(n.id)
      setPatchingId((current) => (current === n.id ? null : current))
      if (patching.current === 0 && refreshQueued.current) {
        refreshQueued.current = false
        void refresh()
      }
    }
  }, [dispatch, place, refresh])

  /** Selecting a notification shows it and marks it read. */
  const select = useCallback((n: CenterNotification) => {
    setSelected(n)
    setPinned((p) => (p?.id === n.id ? null : p))
    if (n.read_at == null) void setRead(n, true)
  }, [setRead])

  const clearSelection = useCallback(() => setSelected(null), [])

  // ── focus from a toast (?id=): highlight only — no selection, no mark read ─

  const [highlightedId, setHighlightedId] = useState<number | null>(null)
  /** The focused one when it is not in the loaded list: fetched alone, shown above it. */
  const [pinned, setPinned] = useState<CenterNotification | null>(null)
  const [focusMissing, setFocusMissing] = useState(false)

  const focus = useCallback(async (id: number) => {
    setFocusMissing(false)
    if (listRef.current.items.some((n) => n.id === id)) {
      setPinned(null)
      setHighlightedId(id)
      return
    }
    try {
      const { data } = await api.get<CenterNotification>(`/notifications/${id}`, { params: { scope: 'all' } })
      setPinned(data)
      setHighlightedId(id)
    } catch {
      setPinned(null)
      setHighlightedId(null)
      setFocusMissing(true)                              // not found (or not this user's)
    }
  }, [])
  const clearHighlight = useCallback(() => setHighlightedId(null), [])

  /** Facts learnt from the task panel (archived / deleted there) before the list
   * refreshes: applied to the selected one and its row. */
  const updateSelected = useCallback((patch: Partial<CenterNotification>) => {
    setSelected((current) => {
      if (!current) return current
      const next = { ...current, ...patch }
      setItems((list) => list.map((n) => (n.id === next.id ? { ...n, ...patch } : n)))
      return next
    })
  }, [])

  return {
    items, loading, loadingMore, error, hasMore: cursor != null,
    loadMore, selected, select, clearSelection, updateSelected, setRead, patchingId, refresh,
    focus, highlightedId, clearHighlight, focusMissing,
    // shown only while it is not in the list itself
    pinned: pinned && !items.some((n) => n.id === pinned.id) ? pinned : null,
  }
}
