"""Schemas for user notifications (הודעות, הוראות, תזכורות)."""
from datetime import datetime
from pydantic import BaseModel

NOTIFICATION_TYPE_VALUES = ("instruction", "task_assignment", "task_reminder", "general", "task_message")


class NotificationOut(BaseModel):
    id: int
    user_id: int
    from_user_id: int | None
    task_id: int | None
    type: str
    title: str
    body: str | None
    read_at: datetime | None
    created_at: datetime
    from_user_name: str | None = None
    task_title: str | None = None
    # Notification center (additive): the related task's module, "general" /
    # "collection" (None without a task, or once the task is deleted), and a short
    # one-line summary of ``body`` for lists and toasts — None for a chat message,
    # whose content the center does not show.
    task_kind: str | None = None
    # Whether the related task is archived now (None without a task, or once it is
    # deleted): the center then shows the notification only, without the task.
    task_archived: bool | None = None
    body_preview: str | None = None


class NotificationCreate(BaseModel):
    """Admin sends a message to one or more users."""
    user_ids: list[int]
    type: str = "general"
    title: str
    body: str | None = None


class NotificationMarkRead(BaseModel):
    read: bool = True
