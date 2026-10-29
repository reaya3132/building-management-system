"""Task schemas for Task Management Calendar."""
from datetime import date, datetime, timezone
from pydantic import BaseModel, ConfigDict, field_serializer

from backend.schemas.task_label import TaskLabelOut


def to_utc_z(value: datetime | None) -> str | None:
    """Serialize a datetime as UTC ISO-8601 with a 'Z' suffix.

    Backend timestamps are stored as UTC (often naive). Naive values are
    assumed UTC; aware values are converted to UTC. Emitting an explicit 'Z'
    lets clients convert to local time correctly and consistently.
    """
    if value is None:
        return None
    value = (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )
    return value.isoformat().replace("+00:00", "Z")


def to_wall_clock_iso(value: datetime | None) -> str | None:
    """Serialize a user-entered wall-clock datetime WITHOUT a timezone marker.

    Task ``start_time``/``end_time`` are scheduling values entered by the user
    and stored as naive *local* (Israel) wall-clock times — NOT UTC. They must
    be emitted exactly as stored (no 'Z'/offset) so the frontend's
    ``new Date(...)`` parses them as local time without shifting the hours.
    Using `to_utc_z` here would shift e.g. an all-day task's 00:00–23:59 to
    03:00–02:59 local, which breaks all-day detection and shows a bogus time
    range on tasks that have no time range.
    """
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.replace(tzinfo=None)
    return value.isoformat()


TASK_STATUS_VALUES = ("pending", "in_progress", "completed", "pending_closure")

PARTICIPANT_RESPONSE_VALUES = ("pending", "accepted", "declined")

RECURRENCE_RULE_VALUES = ("", "daily", "weekly", "monthly", "yearly")

RECURRENCE_MONTHLY_MODE_VALUES = ("day_of_month", "day_of_week")


class TaskParticipantOut(BaseModel):
    user_id: int
    full_name: str
    response_status: str  # pending, accepted, declined
    avatar_url: str | None = None


class TaskAssigneeOut(BaseModel):
    """A single co-owner assignee of a task (part of the full assignee set)."""
    user_id: int
    full_name: str
    avatar_url: str | None = None
    color: str | None = None


class TaskMessageAttachmentOut(BaseModel):
    id: int
    file_name: str
    """URL path to download the file (e.g. /uploads/task_message_attachments/...)"""
    file_url: str


class TaskMessageOut(BaseModel):
    id: int
    task_id: int
    user_id: int
    full_name: str
    avatar_url: str | None = None
    message: str
    created_at: datetime
    # Set once the author edits the message; drives the "נערך" label.
    edited_at: datetime | None = None
    # True when every OTHER recipient (assignees + participants) has read this
    # message; drives the blue double-check (✓✓) on the author's own messages.
    read_by_all: bool = False
    attachments: list[TaskMessageAttachmentOut] = []

    _serialize_created_at = field_serializer("created_at")(staticmethod(to_utc_z))
    _serialize_edited_at = field_serializer("edited_at")(staticmethod(to_utc_z))


class TaskUnreadSummaryOut(BaseModel):
    """Global unread task-chat summary for the current user (drives the nav badge)."""
    total_unread: int = 0
    task_count: int = 0


class TaskMessageCreate(BaseModel):
    message: str


class TaskMessageUpdate(BaseModel):
    """Payload to edit an existing chat message (text only)."""
    message: str


class TaskAttachmentOut(BaseModel):
    id: int
    file_name: str
    """URL path to download the file (e.g. /uploads/task_attachments/...)"""
    file_url: str


class TaskChecklistItemCreate(BaseModel):
    text: str


class TaskChecklistItemUpdate(BaseModel):
    is_completed: bool | None = None
    text: str | None = None
    assigned_to_user_id: int | None = None
    clear_assignment: bool = False


class TaskChecklistItemOut(BaseModel):
    id: int
    task_id: int
    text: str
    is_completed: bool
    sort_order: int
    created_at: datetime
    assigned_to_user_id: int | None = None
    assigned_user_name: str | None = None
    assigned_user_avatar: str | None = None
    assigned_user_color: str | None = None
    handled_by_user_id: int | None = None
    handled_by_user_name: str | None = None
    handled_by_user_avatar: str | None = None
    handled_by_user_color: str | None = None
    handled_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)

    _serialize_dt = field_serializer("created_at", "handled_at")(staticmethod(to_utc_z))


class TaskChecklistSummary(BaseModel):
    total: int
    completed: int
    progress_pct: float


class TaskBase(BaseModel):
    title: str
    start_time: datetime | None = None
    end_time: datetime | None = None
    description: str | None = None
    status: str = "pending"
    event_type: str = "task"
    assigned_to_user_id: int
    recurrence_rule: str = ""
    recurrence_end_date: date | None = None
    recurrence_interval: int = 1
    recurrence_weekdays: str | None = None
    recurrence_monthly_mode: str | None = None
    recurrence_count: int | None = None
    requires_closure_approval: bool = False
    is_super_task: bool = False
    is_backlog: bool = False
    # Building Reception Desk linkage (optional)
    apartment_id: int | None = None
    building_id: int | None = None


class TaskCreate(TaskBase):
    label_ids: list[int] = []
    participant_ids: list[int] = []  # users to invite (like Outlook)
    # Additional co-owner assignees beyond the primary `assigned_to_user_id`.
    # The effective assignee set is the ordered-unique union of
    # [assigned_to_user_id] + assigned_to_user_ids (primary first).
    assigned_to_user_ids: list[int] = []


class TaskUpdate(BaseModel):
    title: str | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    description: str | None = None
    status: str | None = None
    event_type: str | None = None
    assigned_to_user_id: int | None = None
    # Full co-owner assignee set to replace (admin-gated, same as the scalar).
    # When provided, the primary becomes its first element.
    assigned_to_user_ids: list[int] | None = None
    label_ids: list[int] | None = None
    recurrence_rule: str | None = None
    recurrence_end_date: date | None = None
    recurrence_interval: int | None = None
    recurrence_weekdays: str | None = None
    recurrence_monthly_mode: str | None = None
    recurrence_count: int | None = None
    participant_ids: list[int] | None = None
    requires_closure_approval: bool | None = None
    is_super_task: bool | None = None
    is_backlog: bool | None = None


class TaskOut(BaseModel):
    id: int
    title: str
    start_time: datetime | None = None
    end_time: datetime | None = None
    description: str | None = None
    status: str
    event_type: str
    assigned_to_user_id: int
    unique_tag: str
    recurrence_rule: str = ""
    recurrence_end_date: date | None = None
    recurrence_interval: int = 1
    recurrence_weekdays: str | None = None
    recurrence_monthly_mode: str | None = None
    recurrence_count: int | None = None
    created_at: datetime
    updated_at: datetime
    assignee_acknowledged_at: datetime | None = None
    assignee_viewed_at: datetime | None = None
    is_archived: bool = False
    archived_at: datetime | None = None
    completed_at: datetime | None = None
    requires_closure_approval: bool = False
    is_super_task: bool = False
    is_backlog: bool = False
    apartment_id: int | None = None
    building_id: int | None = None
    # True when the current user has unread chat replies on this task (WhatsApp-style dot).
    has_unread_messages: bool = False
    # How many chat messages on this task the current user hasn't read (badge count).
    unread_messages_count: int = 0
    task_kind: str = "general"
    assigned_user_name: str | None = None
    assigned_user_color: str | None = None
    assigned_user_avatar: str | None = None
    # Full co-owner assignee set (primary + additional). `assigned_to_user_ids`
    # is the ordered id list; `assignees` carries display info per member.
    assigned_to_user_ids: list[int] = []
    assignees: list[TaskAssigneeOut] = []
    labels: list[TaskLabelOut] = []
    participants: list[TaskParticipantOut] = []
    attachments: list[TaskAttachmentOut] = []
    checklist_summary: TaskChecklistSummary | None = None

    model_config = ConfigDict(from_attributes=True)

    # Backend-generated audit timestamps are stored as naive UTC → emit with 'Z'.
    _serialize_utc_dt = field_serializer(
        "created_at",
        "updated_at",
        "assignee_acknowledged_at",
        "assignee_viewed_at",
        "archived_at",
        "completed_at",
    )(staticmethod(to_utc_z))

    # User-scheduled times are naive local wall-clock → emit without a tz marker.
    _serialize_wall_clock_dt = field_serializer(
        "start_time",
        "end_time",
    )(staticmethod(to_wall_clock_iso))


ARCHIVED_PRESET_VALUES = ("last_week", "last_month", "last_3_months")


class ArchivedTasksFilter(BaseModel):
    date_from: datetime | None = None
    date_to: datetime | None = None
    preset: str | None = None
