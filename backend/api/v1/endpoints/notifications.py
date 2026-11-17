"""API for user notifications (הודעות, הוראות, תזכורות)."""
import base64
import binascii
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from backend.core.deps import DBSessionDep, get_current_user
from backend.models.task import TaskKind
from backend.repositories.notification_repository import NotificationRepository
from backend.repositories.user_repository import UserRepository
from backend.schemas.notification import (
    NotificationOut,
    NotificationCreate,
    NOTIFICATION_TYPE_VALUES,
)
from backend.models.user_notification import UserNotification, NotificationType

router = APIRouter()

# scope=general: the existing meaning (no collection notifications).
# scope=all: every module, collection included (the notification center).
Scope = Literal["general", "all"]
NEXT_CURSOR_HEADER = "X-Next-Cursor"
# On a single notification scope does not filter by module (any of the user's
# notifications is found, as before); scope=all answers like the center's list:
# body_preview only, so a chat message's text is not sent.
SINGLE_SCOPE_HELP = "general: כמו תמיד (כולל body); all: כמו מרכז העדכונים (body_preview בלבד)"
PREVIEW_LENGTH = 140
# unread-count?scope=all counts at most this many (the badge shows "999+").
UNREAD_COUNT_CAP = 1000


def _task_kind(scope: Scope) -> str | None:
    return None if scope == "all" else TaskKind.GENERAL


def _preview(n: UserNotification) -> str | None:
    """One line of the body; nothing for a chat message (its content is not shown)."""
    if n.type == NotificationType.TASK_MESSAGE or not n.body:
        return None
    text = " ".join(n.body.split())
    return text if len(text) <= PREVIEW_LENGTH else text[:PREVIEW_LENGTH].rstrip() + "…"


def _to_out(n: UserNotification, *, with_body: bool = True) -> dict:
    """``with_body=False`` (scope=all): the center gets ``body_preview`` only, so a
    chat message's text is not sent at all."""
    from_user = getattr(n, "from_user", None)
    task = getattr(n, "task", None)
    return {
        "id": n.id,
        "user_id": n.user_id,
        "from_user_id": n.from_user_id,
        "task_id": n.task_id,
        "type": n.type,
        "title": n.title,
        "body": n.body if with_body else None,
        "read_at": n.read_at,
        "created_at": n.created_at,
        "from_user_name": from_user.full_name if from_user else None,
        "task_title": task.title if task else None,
        "task_kind": task.task_kind if task else None,
        "task_archived": task.is_archived if task else None,
        "body_preview": _preview(n),
    }


def _encode_cursor(n: UserNotification) -> str:
    raw = f"{n.created_at.isoformat(timespec='microseconds')}|{n.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, int]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        created_at, notification_id = raw.split("|")
        return datetime.fromisoformat(created_at), int(notification_id)
    except (ValueError, binascii.Error, UnicodeDecodeError):
        raise HTTPException(status_code=422, detail="cursor לא תקין")


@router.get("/", response_model=list[NotificationOut])
async def list_my_notifications(
    response: Response,
    db: DBSessionDep,
    user=Depends(get_current_user),
    unread_only: bool = Query(False, description="רק הודעות שלא נקראו"),
    type_filter: str | None = Query(None, description="סינון לפי סוג"),
    limit: int = Query(100, ge=1, le=200),
    offset: int = Query(0, ge=0),
    scope: Scope = Query("general", description="general: ללא גבייה (כמו תמיד); all: כל המודולים"),
    view: Literal["unread", "read", "all"] | None = Query(
        None, description="לא נקראו / נקראו / הכול (גובר על unread_only)"),
    cursor: str | None = Query(None, description=f"העמוד הבא: הערך מהכותרת {NEXT_CURSOR_HEADER}"),
):
    """רשימת ההודעות של המשתמש המחובר, מהחדשה לישנה.

    Paging: when more items follow, the response carries ``X-Next-Cursor``; pass it
    back as ``cursor`` for the next page. No header — the last page. The body stays a
    list, as before."""
    if type_filter and type_filter not in NOTIFICATION_TYPE_VALUES:
        type_filter = None
    before = _decode_cursor(cursor) if cursor else None
    repo = NotificationRepository(db)
    items = await repo.list_for_user(
        user.id, unread_only=unread_only, view=view, type_filter=type_filter,
        limit=limit + 1, offset=offset, before=before, task_kind=_task_kind(scope),
    )
    if len(items) > limit:
        items = items[:limit]
        response.headers[NEXT_CURSOR_HEADER] = _encode_cursor(items[-1])
    with_body = scope == "general"
    return [_to_out(n, with_body=with_body) for n in items]


@router.get("/unread-count")
async def get_unread_count(
    db: DBSessionDep,
    user=Depends(get_current_user),
    scope: Scope = Query("general", description="general: ללא גבייה (כמו תמיד); all: כל המודולים"),
    latest: int = Query(0, ge=0, le=20, description="גם N ההודעות האחרונות שלא נקראו (לחלוניות)"),
):
    """מספר ההודעות שלא נקראו (להצגת badge).

    Without parameters: ``{"count"}`` exactly as before. ``scope=all``: every module,
    counted up to 1000. ``latest=N``: also the N newest unread notifications, with
    what a toast shows (sender, task, kind, preview) — the background poll's one call.
    """
    repo = NotificationRepository(db)
    task_kind = _task_kind(scope)
    cap = UNREAD_COUNT_CAP if scope == "all" else None
    out: dict = {"count": await repo.count_unread(user.id, task_kind, cap=cap)}
    if latest:
        items = await repo.list_for_user(user.id, view="unread", limit=latest, task_kind=task_kind)
        out["latest"] = [
            NotificationOut(**_to_out(n, with_body=scope == "general")).model_dump(mode="json") for n in items
        ]
    return out


@router.get("/{notification_id}", response_model=NotificationOut)
async def get_notification(
    notification_id: int,
    db: DBSessionDep,
    user=Depends(get_current_user),
    scope: Scope = Query("general", description=SINGLE_SCOPE_HELP),
):
    """פרטי הודעה אחת (רק של המשתמש המחובר)."""
    repo = NotificationRepository(db)
    n = await repo.get_by_id(notification_id, user.id)
    if not n:
        raise HTTPException(status_code=404, detail="הודעה לא נמצאה")
    return _to_out(n, with_body=scope == "general")


@router.patch("/{notification_id}/read", response_model=NotificationOut)
async def mark_notification_read(
    notification_id: int,
    db: DBSessionDep,
    user=Depends(get_current_user),
    read: bool = True,
    scope: Scope = Query("general", description=SINGLE_SCOPE_HELP),
):
    """סמן הודעה כנקראה או כלא נקראה."""
    repo = NotificationRepository(db)
    n = await repo.get_by_id(notification_id, user.id)
    if not n:
        raise HTTPException(status_code=404, detail="הודעה לא נמצאה")
    if read:
        n = await repo.mark_read(n)
    else:
        n = await repo.mark_unread(n)
    return _to_out(n, with_body=scope == "general")


@router.post("/send", response_model=list[NotificationOut])
async def send_notifications(
    data: NotificationCreate,
    db: DBSessionDep,
    user=Depends(get_current_user),
):
    """שליחת הודעה למשתמשים (מנהל בלבד)."""
    if user.role != "Admin":
        raise HTTPException(status_code=403, detail="רק מנהל יכול לשלוח הודעות למשתמשים")
    if not data.user_ids:
        raise HTTPException(status_code=400, detail="יש לבחור לפחות משתמש אחד")
    ntype = data.type if data.type in NOTIFICATION_TYPE_VALUES else NotificationType.GENERAL
    user_repo = UserRepository(db)
    repo = NotificationRepository(db)
    created_list = []
    for uid in data.user_ids:
        u = await user_repo.get_by_id(uid)
        if not u or not u.is_active:
            continue
        n = UserNotification(
            user_id=uid,
            from_user_id=user.id,
            task_id=None,
            type=ntype,
            title=data.title.strip(),
            body=(data.body or "").strip() or None,
        )
        n = await repo.create(n)
        created_list.append(n)
    # Reload with relations for output
    out = []
    for n in created_list:
        nn = await repo.get_by_id(n.id, n.user_id)
        out.append(_to_out(nn))
    return out
