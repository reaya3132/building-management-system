"""Task access rules shared by every kind of task (regular and collection).

Moved verbatim from ``api/v1/endpoints/tasks.py`` so both task modules apply one
implementation: Admin sees and edits everything; otherwise access follows the
task's assignees (and, for viewing, its participants).
"""
from __future__ import annotations

from backend.models.task import Task


def is_task_assignee(task: Task, user_id: int) -> bool:
    """True if the user is the primary assignee OR a member of the full set."""
    if task.assigned_to_user_id == user_id:
        return True
    return any(getattr(a, "id", None) == user_id for a in (getattr(task, "assignees", None) or []))


def can_access_task(task: Task, user) -> bool:
    """True if user can view/edit this task (Admin, any assignee, or participant)."""
    if user.role == "Admin":
        return True
    if is_task_assignee(task, user.id):
        return True
    participants = getattr(task, "participants", None) or []
    return any(getattr(p, "user_id", None) == user.id for p in participants)


def can_manage_task(task: Task, user) -> bool:
    """True if user may add/manage this task: Admin, any assignee, or the creator."""
    if user.role == "Admin":
        return True
    if is_task_assignee(task, user.id):
        return True
    return getattr(task, "created_by_user_id", None) == user.id
