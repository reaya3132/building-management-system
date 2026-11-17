"""Service for creating user notifications (e.g. on task assignment)."""
from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.user import User
from backend.models.user_notification import UserNotification, NotificationType
from backend.models.task import Task, TaskKind
from backend.repositories.notification_repository import NotificationRepository


async def create_task_assignment_notifications(
    db: AsyncSession,
    task: Task,
    from_user_id: int,
    *,
    for_new_assignee: bool = True,
    for_new_participants: bool = True,
) -> None:
    """
    Create 'task_assignment' notifications for the assignee and participants.
    Call after creating a task or after updating assignee/participants.
    """
    repo = NotificationRepository(db)
    title = f"משימה חדשה: {task.title}"
    body = task.description or None
    if task.start_time:
        from datetime import datetime
        body = (body or "") + f"\nתאריך: {task.start_time.strftime('%d/%m/%Y %H:%M')}" if body else f"תאריך: {task.start_time.strftime('%d/%m/%Y %H:%M')}"

    notified = set()
    if for_new_assignee:
        for assignee_id in _task_assignee_ids(task):
            if not assignee_id or assignee_id == from_user_id or assignee_id in notified:
                continue
            notified.add(assignee_id)
            n = UserNotification(
                user_id=assignee_id,
                from_user_id=from_user_id,
                task_id=task.id,
                type=NotificationType.TASK_ASSIGNMENT,
                title=title,
                body=body,
            )
            await repo.create(n)
    if for_new_participants:
        participants = getattr(task, "participants", None) or []
        for p in participants:
            uid = getattr(p, "user_id", None)
            if uid and uid != from_user_id and uid not in notified:
                notified.add(uid)
                n = UserNotification(
                    user_id=uid,
                    from_user_id=from_user_id,
                    task_id=task.id,
                    type=NotificationType.TASK_ASSIGNMENT,
                    title=f"הזמנה למשימה: {task.title}",
                    body=body,
                )
                await repo.create(n)
    await db.flush()


def _task_assignee_ids(task: Task) -> list[int]:
    """Ordered assignee ids for a task: the full co-owner set, primary first.

    Falls back to the single ``assigned_to_user_id`` for legacy rows whose
    ``assignees`` set has not been backfilled yet, so a task always has at least
    its primary assignee.
    """
    ordered: list[int] = []
    if task.assigned_to_user_id:
        ordered.append(task.assigned_to_user_id)
    for assignee in getattr(task, "assignees", None) or []:
        assignee_id = getattr(assignee, "id", None)
        if assignee_id and assignee_id not in ordered:
            ordered.append(assignee_id)
    return ordered


def _collect_task_recipient_ids(task: Task, exclude_user_id: int | None) -> set[int]:
    """User ids tied to a task — all assignees, participants and the task's
    creator (even when not assigned) — excluding the user who acted. An Admin is
    included only through one of these ties."""
    recipient_ids: set[int] = set(_task_assignee_ids(task))
    for participant in getattr(task, "participants", None) or []:
        participant_user_id = getattr(participant, "user_id", None)
        if participant_user_id:
            recipient_ids.add(participant_user_id)
    if task.created_by_user_id:
        recipient_ids.add(task.created_by_user_id)
    recipient_ids.discard(exclude_user_id)
    return recipient_ids


_ARCHIVE_KIND = {
    TaskKind.GENERAL: ("משימה", "משימה כללית"),
    TaskKind.COLLECTION: ("משימת גבייה", "משימת גבייה"),
}


async def create_task_archived_notifications(
    db: AsyncSession,
    task: Task,
    actor: User,
    archived_at: datetime,
) -> None:
    """Notify everyone tied to a manually archived task (general or collection),
    except the user who archived it.

    The notification carries everything it shows, as text, so it stays complete
    after the task or the archiving user is deleted (task_id / from_user_id are
    then set to NULL): the task's title and kind in ``title``, the kind and the
    archiving user's name in ``body``, the archiving time in ``created_at``.
    Call with the archived_at returned by ``TaskRepository.archive_if_active``,
    in the same transaction.
    """
    recipient_ids = _collect_task_recipient_ids(task, actor.id)
    if not recipient_ids:
        return
    short, label = _ARCHIVE_KIND.get(task.task_kind, _ARCHIVE_KIND[TaskKind.GENERAL])
    prefix = f"{short} אורכבה: "
    await NotificationRepository(db).create_archived(
        recipient_ids,
        task_id=task.id,
        from_user_id=actor.id,
        title=prefix + task.title[: 255 - len(prefix)],
        body=f"סוג: {label} · אורכבה על ידי {actor.full_name}",
        archived_at=archived_at,
    )


def _build_message_preview(message_text: str, max_length: int = 120) -> str:
    """One-line preview of a chat message for the notification body."""
    preview = (message_text or "").strip()
    if len(preview) > max_length:
        preview = preview[:max_length].rstrip() + "…"
    return preview


async def create_task_message_notifications(
    db: AsyncSession,
    task: Task,
    from_user_id: int,
    message_text: str,
) -> None:
    """
    Notify everyone tied to the task (assignee + participants) about a new chat
    message, EXCEPT the message author. Keeps at most one UNREAD notification of
    type task_message per (user, task): if one exists it is bumped to 'now' and its
    body refreshed; otherwise a new one is created.
    """
    recipient_ids = _collect_task_recipient_ids(task, from_user_id)
    if not recipient_ids:
        return

    repo = NotificationRepository(db)
    title = f"הודעה חדשה במשימה: {task.title}"
    # An unread notification that absorbs another message says so, without a count.
    merged_title = f"הודעות חדשות במשימה: {task.title}"
    preview = _build_message_preview(message_text)

    for recipient_id in recipient_ids:
        existing = await repo.find_unread_for_task(
            recipient_id, task.id, NotificationType.TASK_MESSAGE
        )
        if existing:
            existing.title = merged_title
            existing.body = preview
            existing.from_user_id = from_user_id
            existing.created_at = datetime.now(timezone.utc).replace(tzinfo=None)
        else:
            notification = UserNotification(
                user_id=recipient_id,
                from_user_id=from_user_id,
                task_id=task.id,
                type=NotificationType.TASK_MESSAGE,
                title=title,
                body=preview,
            )
            await repo.create(notification)
    await db.flush()


async def create_task_reminder(
    db: AsyncSession,
    task: Task,
    from_user_id: int,
) -> None:
    """
    Create a 'task_reminder' notification for the task assignee.
    Used when someone clicks "הזכר" on a task – the assignee gets a message in הודעות.
    """
    if not task.assigned_to_user_id:
        return
    repo = NotificationRepository(db)
    title = f"תזכורת: {task.title}"
    body = task.description or None
    if task.start_time:
        body = (body or "") + f"\nתאריך: {task.start_time.strftime('%d/%m/%Y %H:%M')}" if body else f"תאריך: {task.start_time.strftime('%d/%m/%Y %H:%M')}"

    n = UserNotification(
        user_id=task.assigned_to_user_id,
        from_user_id=from_user_id,
        task_id=task.id,
        type=NotificationType.TASK_REMINDER,
        title=title,
        body=body,
    )
    await repo.create(n)
    await db.flush()


async def create_closure_approval_notification(
    db: AsyncSession,
    task: Task,
    requesting_user_id: int,
) -> None:
    """
    Notify all active admin users that a non-admin requested closure of a task.
    Called when a non-admin tries to complete a task with requires_closure_approval=True.
    """
    result = await db.execute(
        select(User).where(User.role == "Admin", User.is_active == True)
    )
    admins = list(result.scalars().all())
    if not admins:
        return

    requester = await db.get(User, requesting_user_id)
    requester_name = requester.full_name if requester else f"משתמש #{requesting_user_id}"

    repo = NotificationRepository(db)
    for admin in admins:
        n = UserNotification(
            user_id=admin.id,
            from_user_id=requesting_user_id,
            task_id=task.id,
            type=NotificationType.TASK_ASSIGNMENT,
            title=f"בקשת סגירת משימה: {task.title}",
            body=f"העובד {requester_name} ביקש לסגור את המשימה. ממתין לאישורך.",
        )
        await repo.create(n)
    await db.flush()
