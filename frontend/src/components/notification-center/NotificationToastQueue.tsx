import { useCallback, useMemo } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import type { AppDispatch, RootState } from '../../store'
import ToastNotification, { type Toast } from '../ToastNotification'
import { toastDone, type NotificationBrief, type NotificationToast } from '../../store/slices/notificationsSlice'

export const TOAST_DURATION_MS = 5000
export const NOTIFICATION_CENTER_PATH = '/notifications'
/** The summary toast after the first few of many new notifications. */
export const MORE_UPDATES_TEXT = 'עדכונים נוספים ממתינים לך'

/** The toast's second line. A chat message's content is never shown: who and where. */
export function toastMessage(n: NotificationBrief): string {
  const kind = n.task_kind === 'collection' ? 'גבייה' : null
  const where = [n.from_user_name, n.task_title].filter(Boolean).join(' · ')
  if (n.type === 'task_message') return [kind, where].filter(Boolean).join(' · ') || 'הודעה חדשה'
  // An archive notification keeps its kind and who archived it in the text itself.
  const text = n.body_preview || where
  return [kind && n.type !== 'task_archived' ? kind : null, text].filter(Boolean).join(' · ')
}

function toToast(item: NotificationToast, open: (path: string) => void): Toast {
  if (item.kind === 'more') {
    return {
      id: item.key, type: 'info', duration: TOAST_DURATION_MS,
      message: MORE_UPDATES_TEXT,
      onClick: () => open(NOTIFICATION_CENTER_PATH),
    }
  }
  const n = item.notification
  return {
    id: item.key, type: 'info', duration: TOAST_DURATION_MS,
    title: n.title,
    message: toastMessage(n),
    // Opens the notification in the center; showing or clicking a toast does not
    // mark it as read — selecting it there does.
    onClick: () => open(`${NOTIFICATION_CENTER_PATH}?id=${n.id}`),
  }
}

/** New notifications as small toasts, bottom left: one at a time, 5 seconds each,
 * in the order they arrived. Mounted once in the app shell. */
export default function NotificationToastQueue() {
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const current = useSelector((state: RootState) => state.notifications.toastQueue[0] ?? null)

  const done = useCallback(() => { dispatch(toastDone()) }, [dispatch])
  const toast = useMemo(() => current && toToast(current, (path) => {
    navigate(path)
    dispatch(toastDone())
  }), [current, navigate, dispatch])

  return <ToastNotification toast={toast} onClose={done} position="bottom-left" />
}
