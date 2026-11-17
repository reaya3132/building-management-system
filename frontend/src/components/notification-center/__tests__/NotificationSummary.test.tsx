/**
 * The details panel (3e-2b): a summary from the notification alone; the task's full
 * content only on "הצגת ההודעה", through the existing 3c panels (stubbed here to
 * see when and how they are loaded); archive notifications and notifications on an
 * archived or deleted task never load a task.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { CenterNotification } from '../useNotificationCenter'

const loaded = vi.hoisted(() => ({ task: 0, collection: 0, taskProps: null as any, collectionProps: null as any }))
vi.mock('../../task-management/TaskDetailModal', () => {
  loaded.task += 1
  return {
    TaskDetailPanel: (props: any) => {
      loaded.taskProps = props
      return (
        <div data-testid="task-panel">
          <button onClick={props.onClose}>סגור</button>
          <button onClick={() => { props.onTaskArchived(); props.onClose() }}>ארכב</button>
          <button onClick={() => { props.onTaskDeleted(); props.onClose() }}>מחק</button>
        </div>
      )
    },
  }
})
vi.mock('../../collection/CollectionTaskDetailModal', () => {
  loaded.collection += 1
  return {
    CollectionTaskDetailPanel: (props: any) => {
      loaded.collectionProps = props
      return <div data-testid="collection-panel"><button onClick={props.onChanged}>שמירה</button></div>
    },
  }
})
const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn() }))
vi.mock('../../../lib/api', () => ({ default: api }))

import NotificationSummary from '../NotificationSummary'
import NotificationContent, { canShowContent, taskStatusNote } from '../NotificationContent'

const n = (extra: Partial<CenterNotification> = {}): CenterNotification => ({
  id: 1, type: 'task_assignment', title: 'משימה חדשה: לתקן מעלית', body_preview: 'קומה 3',
  from_user_id: 2, from_user_name: 'השולחת', task_id: 42, task_title: 'לתקן מעלית', task_kind: 'general',
  task_archived: false, read_at: '2026-11-17T09:00:00', created_at: '2026-11-17T08:00:00', ...extra,
})

function show(notification: CenterNotification) {
  const handlers = { onMarkUnread: vi.fn(), onBack: vi.fn(), onChanged: vi.fn(), onUpdate: vi.fn() }
  const view = render(<NotificationSummary notification={notification} marking={false} {...handlers} />)
  return { ...handlers, ...view }
}

const button = () => screen.queryByRole('button', { name: /הצגת ההודעה/ })

beforeEach(() => {
  vi.clearAllMocks()
  loaded.taskProps = null
  loaded.collectionProps = null
})

describe('summary from the notification itself', () => {
  it('chat message: who, where and when — never its content; nothing fetched', () => {
    show(n({ type: 'task_message', title: 'הודעות חדשות במשימה: לתקן מעלית', body_preview: null }))
    expect(screen.getByText('השולחת')).toBeInTheDocument()
    expect(screen.getByText('לתקן מעלית')).toBeInTheDocument()
    expect(screen.getByText('נשלח על ידי:')).toBeInTheDocument()
    expect(screen.queryByTestId('task-panel')).not.toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('new task: title, who assigned it, the task, the short description', () => {
    show(n())
    expect(screen.getByRole('heading', { name: 'משימה חדשה: לתקן מעלית' })).toBeInTheDocument()
    expect(screen.getByText('מאת:')).toBeInTheDocument()
    expect(screen.getByText('קומה 3')).toBeInTheDocument()
    expect(button()).toBeInTheDocument()
  })

  it('collection: marked as a collection task', () => {
    show(n({ task_kind: 'collection', title: 'משימת גבייה חדשה: גביית ועד', task_title: 'גביית ועד', body_preview: null }))
    expect(screen.getByText('משימת גבייה:')).toBeInTheDocument()
    expect(screen.getByText('גביית ועד')).toBeInTheDocument()
  })

  it('admin message without a task: no content button', () => {
    show(n({ type: 'general', task_id: null, task_title: null, task_kind: null, task_archived: null, title: 'הודעה מהנהלה' }))
    expect(screen.getByText('קומה 3')).toBeInTheDocument()
    expect(button()).not.toBeInTheDocument()
    expect(screen.queryByText(/אינה זמינה/)).not.toBeInTheDocument()       // it never had a task
  })

  it('"סמן כלא נקראה" for a read one', async () => {
    const user = userEvent.setup()
    const { onMarkUnread } = show(n())
    await user.click(screen.getByRole('button', { name: 'סמן כלא נקראה' }))
    expect(onMarkUnread).toHaveBeenCalled()
  })
})

describe('full content only on "הצגת ההודעה"', () => {
  it('a regular task: the existing panel, embedded, loaded on the click', async () => {
    const user = userEvent.setup()
    const before = loaded.task
    show(n())
    expect(screen.queryByTestId('task-panel')).not.toBeInTheDocument()
    expect(loaded.task).toBe(before)                                            // not even imported yet
    await user.click(button()!)
    expect(await screen.findByTestId('task-panel')).toBeInTheDocument()
    expect(loaded.taskProps).toMatchObject({ taskId: 42, embedded: true })     // no onEdit: no editing
    expect(loaded.taskProps.onEdit).toBeUndefined()
    expect(button()).not.toBeInTheDocument()
  })

  it('a collection task: the existing collection panel', async () => {
    const user = userEvent.setup()
    const { onChanged } = show(n({ task_kind: 'collection', task_id: 7 }))
    await user.click(button()!)
    expect(await screen.findByTestId('collection-panel')).toBeInTheDocument()
    expect(loaded.collectionProps.taskId).toBe(7)
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    expect(onChanged).toHaveBeenCalled()                                        // the list refreshes
  })

  it('closing returns to the summary', async () => {
    const user = userEvent.setup()
    show(n())
    await user.click(button()!)
    await user.click(await screen.findByRole('button', { name: 'סגור' }))
    expect(screen.queryByTestId('task-panel')).not.toBeInTheDocument()
    expect(button()).toBeInTheDocument()
  })

  it('archiving or deleting from the panel: back to the summary, marked, refreshed', async () => {
    const user = userEvent.setup()
    const archived = show(n())
    await user.click(button()!)
    await user.click(await screen.findByRole('button', { name: 'ארכב' }))
    expect(archived.onUpdate).toHaveBeenCalledWith({ task_archived: true })
    expect(archived.onChanged).toHaveBeenCalled()
    expect(screen.queryByTestId('task-panel')).not.toBeInTheDocument()
    archived.unmount()

    const deleted = show(n())
    await user.click(button()!)
    await user.click(await screen.findByRole('button', { name: 'מחק' }))
    expect(deleted.onUpdate).toHaveBeenCalledWith({ task_id: null, task_archived: null, task_kind: null })
  })
})

describe('archived or deleted tasks: the notification only, no task loaded', () => {
  const cases: [string, Partial<CenterNotification>, string | null][] = [
    ['archive notification (general)', { type: 'task_archived', title: 'משימה אורכבה: לתקן מעלית',
      body_preview: 'סוג: משימה כללית · אורכבה על ידי השולחת', task_archived: true }, null],
    ['archive notification (collection), task and archiver deleted', { type: 'task_archived',
      title: 'משימת גבייה אורכבה: גביית ועד', body_preview: 'סוג: משימת גבייה · אורכבה על ידי השולחת',
      task_id: null, task_kind: null, task_archived: null, task_title: null, from_user_name: null, from_user_id: null }, null],
    ['assignment on an archived general task', { task_archived: true }, 'המשימה אורכבה'],
    ['assignment on an archived collection task', { task_archived: true, task_kind: 'collection' }, 'המשימה אורכבה'],
    ['chat on an archived task', { type: 'task_message', body_preview: null, task_archived: true }, 'המשימה אורכבה'],
    ['assignment on a deleted task', { task_id: null, task_kind: null, task_archived: null, task_title: null },
      'המשימה אינה זמינה עוד'],
    ['reminder on a deleted task', { type: 'task_reminder', task_id: null, task_kind: null, task_archived: null },
      'המשימה אינה זמינה עוד'],
  ]

  it.each(cases)('%s', (_label, extra, note) => {
    const before = { ...loaded }
    const notification = n(extra)
    show(notification)
    expect(button()).not.toBeInTheDocument()
    expect(canShowContent(notification)).toBe(false)
    expect(taskStatusNote(notification)).toBe(note)
    if (note) expect(screen.getByText(note)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: notification.title })).toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()
    expect([loaded.task, loaded.collection]).toEqual([before.task, before.collection])
  })

  it('the archive snapshot shows its kept text, with neither task nor archiver', () => {
    show(n(cases[1][1]))
    expect(screen.getByText('סוג: משימת גבייה · אורכבה על ידי השולחת')).toBeInTheDocument()
    expect(screen.queryByText('מאת:')).not.toBeInTheDocument()
  })

  it('NotificationContent itself renders nothing for them (the second guard)', () => {
    for (const [, extra] of cases) {
      const { container, unmount } = render(
        <NotificationContent notification={n(extra)} onClose={vi.fn()} onChanged={vi.fn()}
          onTaskArchived={vi.fn()} onTaskDeleted={vi.fn()} />)
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
    expect(loaded.taskProps).toBeNull()
    expect(loaded.collectionProps).toBeNull()
  })
})
