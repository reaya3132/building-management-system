import { useCallback, useEffect, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  FileText,
  History,
  MessageCircle,
  Paperclip,
  Pencil,
  Trash2,
  Upload,
  Wallet,
} from 'lucide-react'
import type { RootState } from '../../store'
import { usePermission } from '../../hooks/usePermission'
import { fileAttachmentUrl } from '../../lib/api'
import { cn } from '../../lib/utils'
import { CollectionAPI, type CollectionStatus, type CollectionTaskDetail } from '../../lib/collectionApi'
import AssigneePicker from '../task-management/AssigneePicker'
import AttachmentView from '../task-management/AttachmentView'
import SearchableSelect from '../task-management/SearchableSelect'
import CollectionAmountsPanel from './CollectionAmountsPanel'
import CollectionChat from './CollectionChat'
import CollectionHistory from './CollectionHistory'
import CollectionModal, { ErrorBanner, Field, PrimaryButton, SecondaryButton } from './CollectionModal'
import {
  COLLECTION_STATUSES,
  COLLECTION_STATUS_CHIP,
  COLLECTION_STATUS_LABELS,
  COLLECTION_TYPE_LABELS,
  FIELD_CLASS,
  collectionErrorMessage,
  formatILS,
  formatMonth,
  toMonthKey,
} from './collectionUtils'
import { useCollectionLookups } from './useCollectionLookups'

type Tab = 'details' | 'amounts' | 'chat' | 'files' | 'history'

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'details', label: 'פרטים', icon: FileText },
  { id: 'amounts', label: 'סכומים', icon: Wallet },
  { id: 'chat', label: 'צ׳אט', icon: MessageCircle },
  { id: 'files', label: 'קבצים', icon: Paperclip },
  { id: 'history', label: 'היסטוריה', icon: History },
]

/**
 * What the current user may do on a task — mirrors the server rules so
 * unavailable actions are hidden (the server still enforces them):
 *  - edit / amounts / status / month: Admin or an assignee;
 *  - archive: Admin, an assignee or the creator;
 *  - unarchive: Admin; changing assignees: Admin;
 *  - archived → read-only; closed → amounts locked.
 */
export function collectionTaskAbilities(
  task: Pick<CollectionTaskDetail, 'assignees' | 'created_by_user_id' | 'is_archived' | 'status'>,
  me: { id: number; role: string } | null | undefined
) {
  const isAdmin = me?.role === 'Admin'
  const isAssignee = !!me && task.assignees.some((a) => a.id === me.id)
  const canEdit = isAdmin || isAssignee
  const active = !task.is_archived
  return {
    isAdmin,
    canEdit: canEdit && active,
    canChangeAmounts: canEdit && active && task.status !== 'closed',
    canChangeAssignees: isAdmin && active,
    canArchive: active && (canEdit || (!!me && task.created_by_user_id === me.id)),
    canUnarchive: isAdmin && !active,
  }
}

interface CollectionTaskDetailModalProps {
  taskId: number | null
  onClose: () => void
  /** Called after any change so the parent can refresh its lists. */
  onChanged: () => void
}

export default function CollectionTaskDetailModal({ taskId, onClose, onChanged }: CollectionTaskDetailModalProps) {
  const me = useSelector((s: RootState) => s.auth.me)
  const canWriteFiles = usePermission('write', 'collection_task')
  const canUpdateFiles = usePermission('update', 'collection_task')

  const [task, setTask] = useState<CollectionTaskDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('details')
  const [busy, setBusy] = useState(false)
  const [historyKey, setHistoryKey] = useState(0)

  const load = useCallback(async (id: number) => {
    setLoading(true)
    try {
      setTask(await CollectionAPI.get(id))
      setError(null)
    } catch (err) {
      setError(collectionErrorMessage(err, 'שגיאה בטעינת המשימה'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (taskId == null) { setTask(null); return }
    setTab('details')
    void load(taskId)
  }, [taskId, load])

  const refresh = useCallback(() => {
    if (taskId == null) return
    void load(taskId)
    setHistoryKey((k) => k + 1)
    onChanged()
  }, [taskId, load, onChanged])

  /** Runs an action that returns the updated task. */
  const apply = async (action: () => Promise<CollectionTaskDetail>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      setTask(await action())
      setHistoryKey((k) => k + 1)
      onChanged()
      return true
    } catch (err) {
      setError(collectionErrorMessage(err, fallback))
      return false
    } finally {
      setBusy(false)
    }
  }

  const can = task ? collectionTaskAbilities(task, me) : null
  const lockReason = task?.is_archived
    ? 'המשימה בארכיון — יש לשחזר אותה כדי לבצע שינויים.'
    : task?.status === 'closed'
      ? 'המשימה סגורה — יש לפתוח אותה מחדש כדי לשנות סכומים.'
      : null

  return (
    <CollectionModal
      isOpen={taskId != null}
      onClose={onClose}
      icon={Wallet}
      title={task?.title ?? 'משימת גבייה'}
      subtitle={task && (
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{task.project.parent_name ? `${task.project.parent_name} › ` : ''}{task.project.name}</span>
          <span>·</span>
          <span>{formatMonth(task.billing_month)}</span>
          {task.is_archived && <span className="px-1.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200">בארכיון</span>}
        </span>
      )}
      maxWidth="max-w-3xl"
    >
      <ErrorBanner message={error} />

      {loading && !task ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">טוען...</p>
      ) : !task || !can ? null : (
        <>
          <div role="tablist" className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition-colors',
                  tab === id
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
                {id === 'files' && task.attachments.length > 0 && <span className="text-xs opacity-80">({task.attachments.length})</span>}
              </button>
            ))}
          </div>

          {tab === 'details' && (
            <DetailsTab task={task} can={can} busy={busy} apply={apply} />
          )}
          {tab === 'amounts' && (
            <CollectionAmountsPanel task={task} canChange={can.canChangeAmounts} lockReason={lockReason} onChanged={refresh} />
          )}
          {tab === 'chat' && <CollectionChat taskId={task.id} />}
          {tab === 'files' && (
            <FilesTab
              task={task}
              canUpload={canWriteFiles && can.canArchive}
              canDelete={canUpdateFiles && can.canEdit}
              onChanged={refresh}
              setError={setError}
            />
          )}
          {tab === 'history' && <CollectionHistory taskId={task.id} refreshKey={historyKey} />}
        </>
      )}
    </CollectionModal>
  )
}

// ── details tab ──────────────────────────────────────────────────────────────

interface DetailsTabProps {
  task: CollectionTaskDetail
  can: ReturnType<typeof collectionTaskAbilities>
  busy: boolean
  apply: (action: () => Promise<CollectionTaskDetail>, fallback: string) => Promise<boolean>
}

function DetailsTab({ task, can, busy, apply }: DetailsTabProps) {
  const [editing, setEditing] = useState(false)
  const [moving, setMoving] = useState(false)

  const setStatus = (status: CollectionStatus) => {
    if (status === task.status) return
    void apply(() => CollectionAPI.setStatus(task.id, status), 'עדכון הסטטוס נכשל')
  }

  const archive = () => {
    if (!window.confirm('להעביר את המשימה לארכיון?')) return
    void apply(() => CollectionAPI.archive(task.id), 'העברה לארכיון נכשלה')
  }

  if (editing) {
    return <EditForm task={task} canChangeAssignees={can.canChangeAssignees} busy={busy} apply={apply} onDone={() => setEditing(false)} />
  }

  return (
    <div className="space-y-4">
      <div>
        <span className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1.5">סטטוס</span>
        <div className="grid grid-cols-3 gap-2">
          {COLLECTION_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatus(status)}
              disabled={!can.canEdit || busy}
              aria-pressed={task.status === status}
              className={cn(
                'rounded-xl border px-2 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed',
                task.status === status
                  ? COLLECTION_STATUS_CHIP[status]
                  : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 enabled:hover:bg-gray-50 dark:enabled:hover:bg-gray-700'
              )}
            >
              {COLLECTION_STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <InfoItem label="סכום לגבייה" value={<span className="font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">{formatILS(task.total_amount)}</span>} />
        <InfoItem label="סוג גבייה" value={COLLECTION_TYPE_LABELS[task.collection_type]} />
        <InfoItem label="חודש חיוב" value={formatMonth(task.billing_month)} />
        <InfoItem
          label="פרויקט"
          value={task.project.parent_name ? `${task.project.parent_name} › ${task.project.name}` : task.project.name}
        />
        <InfoItem
          label="מוקצים"
          value={task.assignees.map((a, i) => (i === 0 ? `${a.full_name} (ראשי)` : a.full_name)).join(', ') || '—'}
        />
      </dl>

      {task.description && (
        <div>
          <span className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1">תיאור</span>
          <p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">{task.description}</p>
        </div>
      )}

      {moving && <MoveMonthForm task={task} busy={busy} apply={apply} onDone={() => setMoving(false)} />}

      <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-100 dark:border-gray-700">
        {can.canEdit && (
          <ActionButton icon={Pencil} onClick={() => setEditing(true)} disabled={busy}>עריכה</ActionButton>
        )}
        {can.canEdit && !moving && (
          <ActionButton icon={CalendarClock} onClick={() => setMoving(true)} disabled={busy}>העברת חודש</ActionButton>
        )}
        {can.canArchive && (
          <ActionButton icon={Archive} onClick={archive} disabled={busy}>העבר לארכיון</ActionButton>
        )}
        {can.canUnarchive && (
          <ActionButton icon={ArchiveRestore} onClick={() => void apply(() => CollectionAPI.unarchive(task.id), 'השחזור נכשל')} disabled={busy}>
            שחזור מארכיון
          </ActionButton>
        )}
      </div>
    </div>
  )
}

function InfoItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-gray-50 dark:bg-gray-900/40 px-3 py-2">
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-sm text-gray-900 dark:text-white mt-0.5 break-words">{value}</dd>
    </div>
  )
}

function ActionButton({
  icon: Icon,
  onClick,
  disabled,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-xl border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-60"
    >
      <Icon className="w-4 h-4" />
      {children}
    </button>
  )
}

function MoveMonthForm({ task, busy, apply, onDone }: Omit<DetailsTabProps, 'can'> & { onDone: () => void }) {
  const [month, setMonth] = useState(toMonthKey(task.billing_month))
  const [reason, setReason] = useState('')

  const submit = async () => {
    if (!/^\d{4}-\d{2}$/.test(month) || month === toMonthKey(task.billing_month)) { onDone(); return }
    if (await apply(() => CollectionAPI.moveMonth(task.id, month, reason), 'העברת החודש נכשלה')) onDone()
  }

  return (
    <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10 p-3 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="חודש חיוב חדש" required>
          <input type="month" className={FIELD_CLASS} value={month} onChange={(e) => setMonth(e.target.value)} />
        </Field>
        <Field label="סיבה">
          <input className={FIELD_CLASS} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="לא חובה" />
        </Field>
      </div>
      <div className="flex gap-2">
        <PrimaryButton onClick={submit} disabled={busy}>העבר</PrimaryButton>
        <SecondaryButton onClick={onDone} disabled={busy}>ביטול</SecondaryButton>
      </div>
    </div>
  )
}

function EditForm({
  task,
  canChangeAssignees,
  busy,
  apply,
  onDone,
}: Omit<DetailsTabProps, 'can'> & { canChangeAssignees: boolean; onDone: () => void }) {
  const { projectOptions, users, loading } = useCollectionLookups()
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  const [projectId, setProjectId] = useState<number | null>(task.project.id)
  const [assigneeIds, setAssigneeIds] = useState<number[]>(task.assignees.map((a) => a.id))
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!title.trim()) { setError('יש להזין כותרת'); return }
    if (projectId == null) { setError('יש לבחור פרויקט'); return }
    if (assigneeIds.length === 0) { setError('יש לבחור לפחות מוקצה אחד'); return }
    const patch: Parameters<typeof CollectionAPI.update>[1] = {}
    if (title.trim() !== task.title) patch.title = title.trim()
    if ((description.trim() || null) !== (task.description ?? null)) patch.description = description.trim() || null
    if (projectId !== task.project.id) patch.project_id = projectId
    const sameAssignees =
      assigneeIds.length === task.assignees.length && assigneeIds.every((id, i) => id === task.assignees[i].id)
    if (canChangeAssignees && !sameAssignees) patch.assignee_ids = assigneeIds
    if (Object.keys(patch).length === 0) { onDone(); return }
    if (await apply(() => CollectionAPI.update(task.id, patch), 'שמירת השינויים נכשלה')) onDone()
  }

  // The current project stays selectable even if it has since become inactive.
  const options = projectOptions.some((o) => o.id === task.project.id)
    ? projectOptions
    : [{ id: task.project.id, label: task.project.name }, ...projectOptions]

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} />
      <Field label="כותרת" required>
        <input className={FIELD_CLASS} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} />
      </Field>
      <div>
        <span className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1.5">פרויקט</span>
        <SearchableSelect options={options} value={projectId} onChange={setProjectId} placeholder="בחר פרויקט..." ariaLabel="פרויקט" loading={loading} />
      </div>
      {canChangeAssignees && <AssigneePicker users={users} selectedIds={assigneeIds} onChange={setAssigneeIds} />}
      <Field label="תיאור">
        <textarea className={FIELD_CLASS} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <PrimaryButton onClick={submit} disabled={busy}>{busy ? 'שומר...' : 'שמירה'}</PrimaryButton>
        <SecondaryButton onClick={onDone} disabled={busy}>ביטול</SecondaryButton>
      </div>
    </div>
  )
}

// ── files tab ────────────────────────────────────────────────────────────────

function FilesTab({
  task,
  canUpload,
  canDelete,
  onChanged,
  setError,
}: {
  task: CollectionTaskDetail
  canUpload: boolean
  canDelete: boolean
  onChanged: () => void
  setError: (message: string | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const upload = async (files: File[]) => {
    setBusy(true)
    setError(null)
    try {
      for (const file of files) await CollectionAPI.uploadAttachment(task.id, file)
    } catch (err) {
      setError(collectionErrorMessage(err, 'העלאת הקובץ נכשלה'))
    } finally {
      setBusy(false)
      onChanged()
    }
  }

  const remove = async (attachmentId: number) => {
    if (!window.confirm('למחוק קובץ זה?')) return
    setBusy(true)
    setError(null)
    try {
      await CollectionAPI.deleteAttachment(task.id, attachmentId)
      onChanged()
    } catch (err) {
      setError(collectionErrorMessage(err, 'מחיקת הקובץ נכשלה'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {task.attachments.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-6">אין קבצים מצורפים</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {task.attachments.map((att) => (
            <li key={att.id} className="inline-flex items-center gap-1 rounded-xl border border-gray-200 dark:border-gray-700 px-2 py-1">
              <AttachmentView fileName={att.file_name} fileUrl={fileAttachmentUrl(att.file_url)} />
              {canDelete && (
                <button
                  type="button"
                  onClick={() => void remove(att.id)}
                  disabled={busy}
                  className="p-1 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                  aria-label={`מחק ${att.file_name}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canUpload && (
        <>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files ? Array.from(e.target.files) : []
              e.target.value = ''
              if (files.length) void upload(files)
            }}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 py-3 text-sm font-medium text-gray-600 dark:text-gray-300 hover:border-blue-400 hover:text-blue-600 disabled:opacity-60"
          >
            <Upload className="w-4 h-4" /> {busy ? 'מעלה...' : 'העלאת קובץ'}
          </button>
        </>
      )}
    </div>
  )
}
