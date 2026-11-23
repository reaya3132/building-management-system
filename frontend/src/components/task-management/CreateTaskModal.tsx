import { useState, useEffect, useRef, useCallback } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '../../store'
import api from '../../lib/api'
import Modal from '../Modal'
import { Paperclip, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import type {
  Task,
  TaskStatus,
  TaskLabelType,
  RecurrenceRule,
  MonthlyMode,
  RecurrenceEndMode,
  UserForTask,
} from '../../pages/TaskCalendar'
import {
  buildRecurrencePayload,
  RecurrenceEditor,
  TASK_STATUS_LABELS,
} from '../../pages/TaskCalendar'
import type { Apartment, BuildingListItem, BuildingProjectListItem } from '../../types/api'
import RecordButton from './RecordButton'
import ParticipantPicker from './ParticipantPicker'
import AssigneePicker from './AssigneePicker'
import LabelPicker from './LabelPicker'
import SearchableSelect from './SearchableSelect'
import type { ComboOption } from './SearchableMultiSelect'

/**
 * The three mutually-exclusive scheduling shapes a task can take, mirroring the
 * Task Calendar's own create form:
 *  - meeting: a timed event (start/end datetime)
 *  - all_day: a date-only task (00:00–23:59 of one day)
 *  - no_date: a backlog task with no date at all
 */
type TaskTypeOption = 'meeting' | 'all_day' | 'no_date'

/** Local shape of the create form — identical to the calendar's inline form. */
interface CreateTaskForm {
  title: string
  date: string
  start_time: string
  end_time: string
  description: string
  status: TaskStatus
  /** Ordered assignee ids — the first is the primary assignee. */
  assigned_to_user_ids: number[]
  label_ids: number[]
  participant_ids: number[]
  recurrence_rule: RecurrenceRule
  recurrence_interval: number
  recurrence_weekdays: number[]
  recurrence_monthly_mode: MonthlyMode
  recurrence_end_mode: RecurrenceEndMode
  recurrence_end_date: string
  recurrence_count: string
  requires_closure_approval: boolean
}

const EMPTY_FORM: CreateTaskForm = {
  title: '',
  date: '',
  start_time: '',
  end_time: '',
  description: '',
  status: 'pending',
  assigned_to_user_ids: [],
  label_ids: [],
  participant_ids: [],
  recurrence_rule: '',
  recurrence_interval: 1,
  recurrence_weekdays: [],
  recurrence_monthly_mode: 'day_of_month',
  recurrence_end_mode: 'never',
  recurrence_end_date: '',
  recurrence_count: '',
  requires_closure_approval: false,
}

const DEFAULT_TASK_DURATION_MINUTES = 30

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatLocalDateTime(date: Date): string {
  return `${formatLocalDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function addMinutesToLocalDateTime(localDateTime: string, minutes: number): string {
  if (!localDateTime) return ''
  const parsed = new Date(localDateTime)
  if (Number.isNaN(parsed.getTime())) return ''
  parsed.setMinutes(parsed.getMinutes() + minutes)
  return formatLocalDateTime(parsed)
}

/** Default meeting window: today 09:00 → 09:30. */
function defaultMeetingTimes(): { start_time: string; end_time: string } {
  const now = new Date()
  const start = new Date(now)
  start.setHours(9, 0, 0, 0)
  const end = new Date(start)
  end.setMinutes(start.getMinutes() + DEFAULT_TASK_DURATION_MINUTES)
  return { start_time: formatLocalDateTime(start), end_time: formatLocalDateTime(end) }
}

/**
 * Optional initial configuration used to pre-fill the form when the modal
 * opens — e.g. the calendar opening a "new meeting" at a selected time slot.
 * Any field left undefined falls back to the modal's own sensible defaults.
 */
export interface CreateTaskDefaults {
  taskType?: TaskTypeOption
  /** datetime-local string (YYYY-MM-DDTHH:mm) for meeting start. */
  startTime?: string
  /** datetime-local string (YYYY-MM-DDTHH:mm) for meeting end. */
  endTime?: string
  /** date string (YYYY-MM-DD) for an all-day task. */
  date?: string
}

export interface CreateTaskModalProps {
  isOpen: boolean
  onClose: () => void
  /** Assignee directory (mirrors /users/for-tasks). */
  users: UserForTask[]
  /** Existing labels; the modal can also create new ones. */
  taskLabels: TaskLabelType[]
  /** Pre-fill configuration applied when the modal opens. */
  defaults?: CreateTaskDefaults
  /**
   * Building-reception linkage. When both `projects` and `buildings` are
   * provided, a cascading פרויקט → בניין → דירה selector is rendered and the
   * chosen `building_id`/`apartment_id` are included in the create payload.
   * Omit for the Task Calendar, which has no reception context.
   */
  projects?: BuildingProjectListItem[]
  buildings?: BuildingListItem[]
  /** Loads a building's apartments on demand for the cascade's final step. */
  loadApartments?: (buildingId: number) => Promise<Apartment[]>
  /** Pre-select this project when the modal opens (reception desk context). */
  defaultProjectId?: number | null
  /** Pre-select this building when the modal opens (reception desk context). */
  defaultBuildingId?: number | null
  /** Pre-select this apartment when the modal opens (reception desk context). */
  defaultApartmentId?: number | null
  /** Pre-select this assignee when the modal opens. */
  defaultAssigneeId?: number | null
  /** Open the form pre-configured for a no-date backlog task. */
  defaultBacklog?: boolean
  /** Called after a task is created successfully (parent refetches). */
  onCreated: () => void
  /** Called when the label set changed (create/delete) so the parent can refetch. */
  onLabelsChanged?: () => void
}

/**
 * Shared "create task" modal used by BOTH the Task Calendar and the Building
 * Reception Desk. It owns its own form/recurrence/attachment state and performs
 * the create request itself (POST /tasks/), keeping the two call sites free of
 * duplicated task-creation logic (DRY / Single Responsibility).
 *
 * The only difference between the two contexts is the optional apartment
 * linkage dropdown, which appears only when `apartments` is supplied.
 */
export default function CreateTaskModal({
  isOpen,
  onClose,
  users,
  taskLabels,
  defaults,
  projects,
  buildings,
  loadApartments,
  defaultProjectId,
  defaultBuildingId,
  defaultApartmentId,
  defaultAssigneeId,
  defaultBacklog,
  onCreated,
  onLabelsChanged,
}: CreateTaskModalProps) {
  const meId = useSelector((s: RootState) => s.auth.me?.id)
  const [createForm, setCreateForm] = useState<CreateTaskForm>({ ...EMPTY_FORM })
  const [taskType, setTaskType] = useState<TaskTypeOption>('meeting')
  // Building-reception linkage cascade: פרויקט → בניין → דירה (apartment optional).
  const [projectId, setProjectId] = useState<number | null>(defaultProjectId ?? null)
  const [buildingId, setBuildingId] = useState<number | null>(defaultBuildingId ?? null)
  const [apartmentId, setApartmentId] = useState<number | null>(defaultApartmentId ?? null)
  const [buildingApartments, setBuildingApartments] = useState<Apartment[]>([])
  const [loadingApartments, setLoadingApartments] = useState(false)
  const [createSaving, setCreateSaving] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createPendingFiles, setCreatePendingFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const showLinkage = Array.isArray(buildings) && Array.isArray(projects)

  // Reset the whole form each time the modal opens, honoring the provided
  // defaults (apartment, assignee, backlog).
  useEffect(() => {
    if (!isOpen) return
    setCreateError(null)
    setCreatePendingFiles([])
    if (fileInputRef.current) fileInputRef.current.value = ''
    setProjectId(defaultProjectId ?? null)
    setBuildingId(defaultBuildingId ?? null)
    setApartmentId(defaultApartmentId ?? null)

    // Like a new collection task: the creator is the default (primary) assignee,
    // unless the caller pre-selects someone explicitly.
    const assigneeId = defaultAssigneeId ?? meId
    const assignees = assigneeId != null ? [assigneeId] : []
    const resolvedType: TaskTypeOption = defaultBacklog ? 'no_date' : (defaults?.taskType ?? 'meeting')
    setTaskType(resolvedType)

    if (resolvedType === 'no_date') {
      setCreateForm({ ...EMPTY_FORM, assigned_to_user_ids: assignees })
    } else if (resolvedType === 'all_day') {
      setCreateForm({
        ...EMPTY_FORM,
        assigned_to_user_ids: assignees,
        date: defaults?.date ?? formatLocalDate(new Date()),
      })
    } else {
      const times = defaultMeetingTimes()
      setCreateForm({
        ...EMPTY_FORM,
        assigned_to_user_ids: assignees,
        start_time: defaults?.startTime ?? times.start_time,
        end_time: defaults?.endTime ?? times.end_time,
      })
    }
  }, [
    isOpen,
    defaultProjectId,
    defaultBuildingId,
    defaultApartmentId,
    defaultAssigneeId,
    meId,
    defaultBacklog,
    defaults?.taskType,
    defaults?.startTime,
    defaults?.endTime,
    defaults?.date,
  ])

  // Load the selected building's apartments for the cascade's final step. The
  // list resets whenever the chosen building changes (or clears).
  useEffect(() => {
    if (!isOpen || !showLinkage || buildingId == null || !loadApartments) {
      setBuildingApartments([])
      return
    }
    let cancelled = false
    setLoadingApartments(true)
    loadApartments(buildingId)
      .then((list) => { if (!cancelled) setBuildingApartments(list) })
      .catch(() => { if (!cancelled) setBuildingApartments([]) })
      .finally(() => { if (!cancelled) setLoadingApartments(false) })
    return () => { cancelled = true }
  }, [isOpen, showLinkage, buildingId, loadApartments])

  const setTaskTypeWithDefaults = useCallback((type: TaskTypeOption) => {
    setTaskType(type)
    if (type === 'meeting') {
      const times = defaultMeetingTimes()
      setCreateForm((form) => ({ ...form, ...times }))
    } else if (type === 'all_day') {
      setCreateForm((form) => ({ ...form, date: formatLocalDate(new Date()), start_time: '', end_time: '' }))
    }
  }, [])

  // Reception-cascade dropdown options (empty for the calendar, which has no linkage).
  const projectOptions: ComboOption[] = (projects ?? []).map((project) => ({ id: project.id, label: project.name }))
  const buildingOptions: ComboOption[] = (buildings ?? [])
    .filter((building) => building.project_id === projectId)
    .map((building) => ({ id: building.id, label: building.name }))
  const apartmentOptions: ComboOption[] = buildingApartments.map((apartment) => ({
    id: apartment.id,
    label: apartmentOptionLabel(apartment),
  }))

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    setCreateError(null)
    if (!createForm.title.trim() || createForm.assigned_to_user_ids.length === 0) {
      setCreateError('נא למלא את כל השדות החובה')
      return
    }
    if (showLinkage && (projectId == null || buildingId == null)) {
      setCreateError('יש לבחור פרויקט ובניין למשימה')
      return
    }

    let start_time: string | undefined
    let end_time: string | undefined
    if (taskType === 'no_date') {
      start_time = undefined
      end_time = undefined
    } else if (taskType === 'all_day' && createForm.date) {
      start_time = `${createForm.date}T00:00:00`
      end_time = `${createForm.date}T23:59:59`
    } else if (taskType === 'meeting') {
      if (!createForm.start_time?.trim() || !createForm.end_time?.trim()) {
        setCreateError('לפגישה יש למלא תאריך ומשעה עד שעה')
        return
      }
      let startStr = createForm.start_time.trim()
      let endStr = createForm.end_time.trim()
      if (startStr.length === 16) startStr += ':00'
      if (endStr.length === 16) endStr += ':00'
      start_time = startStr
      end_time = endStr
      if (new Date(start_time) >= new Date(end_time)) {
        setCreateError('שעת הסיום (עד שעה) חייבת להיות אחרי שעת ההתחלה (משעה)')
        return
      }
    } else {
      setCreateError('נא למלא תאריך או שעות לפי סוג')
      return
    }

    setCreateSaving(true)
    try {
      // No-date tasks can't recur; otherwise use the chosen recurrence settings.
      const recurrence = taskType === 'no_date'
        ? buildRecurrencePayload({ ...createForm, recurrence_rule: '' })
        : buildRecurrencePayload(createForm)
      const { data: created } = await api.post<Task>('/tasks/', {
        title: createForm.title.trim(),
        start_time: start_time ?? null,
        end_time: end_time ?? null,
        description: createForm.description.trim() || undefined,
        status: createForm.status,
        event_type: 'task',
        assigned_to_user_id: createForm.assigned_to_user_ids[0],
        assigned_to_user_ids: createForm.assigned_to_user_ids,
        label_ids: createForm.label_ids,
        participant_ids: createForm.participant_ids,
        ...recurrence,
        requires_closure_approval: createForm.requires_closure_approval,
        is_backlog: !!defaultBacklog && taskType === 'no_date',
        ...(showLinkage ? { building_id: buildingId, apartment_id: apartmentId } : {}),
      })
      for (const file of createPendingFiles) {
        const formData = new FormData()
        formData.append('file', file)
        await api.post(`/tasks/${created.id}/attachments`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
      }
      setCreatePendingFiles([])
      if (fileInputRef.current) fileInputRef.current.value = ''
      onCreated()
      onClose()
    } catch (err: any) {
      setCreateError(err.response?.data?.detail ?? 'שגיאה ביצירת משימה')
    } finally {
      setCreateSaving(false)
    }
  }

  const handleClose = () => {
    setCreatePendingFiles([])
    onClose()
  }

  if (!isOpen) return null

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={defaultBacklog ? 'משימה חדשה ל-Backlog' : 'משימה חדשה'}>
      <form onSubmit={handleCreate} className="space-y-2">
        {createError && <p className="text-sm text-red-600 dark:text-red-400">{createError}</p>}

        <div>
          <label htmlFor="create-title" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-0.5">כותרת</label>
          <input
            id="create-title"
            name="create-title"
            type="text"
            value={createForm.title}
            onChange={(e) => setCreateForm((f) => ({ ...f, title: e.target.value }))}
            className={cn(
              'w-full px-3 py-1.5 border rounded-lg text-sm',
              'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
            )}
            required
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-0.5">קבצים / תמונות / סרטון / הקלטה</label>
          <input
            id="create-files"
            name="create-files"
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.zip"
            onChange={(e) => {
              const files = e.target.files ? Array.from(e.target.files) : []
              setCreatePendingFiles((prev) => [...prev, ...files])
            }}
            className="hidden"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600"
            >
              <Paperclip className="w-3.5 h-3.5" /> הוסף קבצים
            </button>
            <RecordButton onRecorded={(file) => setCreatePendingFiles((prev) => [...prev, file])} />
            {createPendingFiles.map((file, index) => (
              <span key={index} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-600 text-xs">
                {file.name}
                <button
                  type="button"
                  onClick={() => setCreatePendingFiles((prev) => prev.filter((_, position) => position !== index))}
                  className="p-0.5 rounded hover:bg-gray-300 dark:hover:bg-gray-500"
                  aria-label="הסר"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-0.5">סוג</label>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              <label className="flex items-center gap-1.5 cursor-pointer text-sm">
                <input type="radio" name="taskType" checked={taskType === 'meeting'} onChange={() => setTaskTypeWithDefaults('meeting')} />
                <span>עם שעה</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer text-sm">
                <input type="radio" name="taskType" checked={taskType === 'all_day'} onChange={() => setTaskTypeWithDefaults('all_day')} />
                <span>משימה (בלי שעה)</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer text-sm">
                <input type="radio" name="taskType" checked={taskType === 'no_date'} onChange={() => setTaskType('no_date')} />
                <span>משימה (בלי תאריך)</span>
              </label>
            </div>
          </div>
          <div>
            <label htmlFor="create-status" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-0.5">מצב</label>
            <select
              id="create-status"
              name="create-status"
              value={createForm.status}
              onChange={(e) => setCreateForm((f) => ({ ...f, status: e.target.value as TaskStatus }))}
              className={cn(
                'w-full px-2 py-1.5 border rounded-lg text-sm',
                'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
              )}
            >
              {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => (
                <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
        </div>

        <AssigneePicker
          users={users}
          selectedIds={createForm.assigned_to_user_ids}
          onChange={(ids) =>
            setCreateForm((f) => ({
              ...f,
              assigned_to_user_ids: ids,
              // A user is never both an assignee and a participant.
              participant_ids: f.participant_ids.filter((id) => !ids.includes(id)),
            }))
          }
        />

        <ParticipantPicker
          users={users}
          selectedIds={createForm.participant_ids}
          assigneeIds={createForm.assigned_to_user_ids}
          onChange={(ids) => setCreateForm((f) => ({ ...f, participant_ids: ids }))}
        />

        {showLinkage && (
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-0.5">שיוך: פרויקט ← בניין ← דירה</label>
            <div className="grid grid-cols-3 gap-2">
              <SearchableSelect
                ariaLabel="פרויקט"
                options={projectOptions}
                value={projectId}
                onChange={(value) => {
                  setProjectId(value)
                  setBuildingId(null)
                  setApartmentId(null)
                }}
                placeholder="בחר פרויקט"
              />
              <SearchableSelect
                ariaLabel="בניין"
                options={buildingOptions}
                value={buildingId}
                disabled={projectId == null}
                onChange={(value) => {
                  setBuildingId(value)
                  setApartmentId(null)
                }}
                placeholder="בחר בניין"
              />
              <SearchableSelect
                ariaLabel="דירה (אופציונלי)"
                options={apartmentOptions}
                value={apartmentId}
                disabled={buildingId == null}
                loading={loadingApartments}
                onChange={setApartmentId}
                placeholder="ללא דירה"
                clearLabel="ללא דירה"
              />
            </div>
          </div>
        )}

        <LabelPicker
          labels={taskLabels}
          selectedIds={createForm.label_ids}
          onChange={(ids) => setCreateForm((f) => ({ ...f, label_ids: ids }))}
          onLabelsChanged={onLabelsChanged}
        />

        {taskType === 'all_day' && (
          <div className="p-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg border border-emerald-200 dark:border-emerald-800">
            <label htmlFor="create-date" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-0.5">תאריך *</label>
            <input
              id="create-date"
              name="create-date"
              type="date"
              value={createForm.date}
              onChange={(e) => setCreateForm((f) => ({ ...f, date: e.target.value }))}
              className={cn(
                'w-full px-2 py-1.5 border rounded-lg text-sm',
                'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
              )}
            />
          </div>
        )}
        {taskType === 'meeting' && (
          <div className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="create-start-time" className="block text-xs text-gray-700 dark:text-gray-300 mb-0.5">משעה *</label>
                <input
                  id="create-start-time"
                  name="create-start-time"
                  type="datetime-local"
                  value={createForm.start_time}
                  onChange={(e) => {
                    const newStart = e.target.value
                    setCreateForm((f) => ({ ...f, start_time: newStart, end_time: newStart ? addMinutesToLocalDateTime(newStart, DEFAULT_TASK_DURATION_MINUTES) : f.end_time }))
                  }}
                  required={taskType === 'meeting'}
                  className={cn(
                    'w-full px-2 py-1.5 border rounded-lg text-sm',
                    'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                  )}
                />
              </div>
              <div>
                <label htmlFor="create-end-time" className="block text-xs text-gray-700 dark:text-gray-300 mb-0.5">עד שעה *</label>
                <input
                  id="create-end-time"
                  name="create-end-time"
                  type="datetime-local"
                  value={createForm.end_time}
                  onChange={(e) => setCreateForm((f) => ({ ...f, end_time: e.target.value }))}
                  required={taskType === 'meeting'}
                  className={cn(
                    'w-full px-2 py-1.5 border rounded-lg text-sm',
                    'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                  )}
                />
              </div>
            </div>
          </div>
        )}
        {(taskType === 'meeting' || taskType === 'all_day') && (
          <RecurrenceEditor
            idPrefix="create"
            value={createForm}
            onChange={(patch) => setCreateForm((f) => ({ ...f, ...patch }))}
            startDate={
              taskType === 'meeting' && createForm.start_time
                ? new Date(createForm.start_time)
                : taskType === 'all_day' && createForm.date
                  ? new Date(`${createForm.date}T00:00:00`)
                  : null
            }
          />
        )}
        {taskType === 'all_day' && (
          <p className="text-xs text-gray-600 dark:text-gray-400">משימה בלי שעה – תופיע תחת משימות ביומן (ובלוח החודש בתא הנבחר).</p>
        )}
        {taskType === 'no_date' && (
          <p className="text-xs text-gray-600 dark:text-gray-400">משימה בלי תאריך – תופיע תחת משימות (רשימת משימות בלי תאריך).</p>
        )}

        <div>
          <label htmlFor="create-description" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-0.5">תיאור</label>
          <textarea
            id="create-description"
            name="create-description"
            value={createForm.description}
            onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
            rows={2}
            className={cn(
              'w-full px-3 py-1.5 border rounded-lg text-sm',
              'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
            )}
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="create-requires-closure"
            checked={createForm.requires_closure_approval}
            onChange={(e) => setCreateForm((f) => ({ ...f, requires_closure_approval: e.target.checked }))}
            className="w-4 h-4 rounded border-gray-300 dark:border-gray-600"
          />
          <label htmlFor="create-requires-closure" className="text-sm text-gray-700 dark:text-gray-300">
            דורש אישור מנהל לסגירה
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
          >
            ביטול
          </button>
          <button
            type="submit"
            disabled={createSaving}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50"
          >
            {createSaving ? 'שומר...' : 'צור משימה'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Human label for an apartment option: "דירה 4" / free label / "שטח משותף". */
function apartmentOptionLabel(apartment: Apartment): string {
  if (apartment.is_common_area) return apartment.label ?? 'שטח משותף'
  return apartment.label ?? `דירה ${apartment.unit_number}`
}
