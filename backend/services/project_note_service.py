"""Business rules for project documentation boards.

Access (checked on every action, server side):
- the route requires the existing ``project:read`` permission (decorator);
- boards exist only on non-parent projects (``is_parent_project = false``);
- the fund board is available only while the project has a fund — its notes
  are kept when the fund is deleted and return with a new fund;
- anyone who may view the project may read and add notes; the author may edit
  and delete their own notes, and ``project:update`` holders (incl. Admin) any.

History goes to ``audit_logs`` through the shared ``AuditService``; a delete
first writes a full snapshot, then removes the row.
"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.iam.engine import PermissionsEngine
from backend.iam.enums import Action, ResourceType
from backend.models.fund import Fund
from backend.models.project_note import PROJECT_NOTE_AUDIT_ENTITY, NoteBoard, NoteEvent, ProjectNote, _now
from backend.repositories.project_note_repository import ProjectNoteRepository
from backend.schemas.project_note import NoteCreate, NoteUpdate
from backend.schemas.task import to_utc_z
from backend.services.audit_service import AuditService


def note_error(status_code: int, code: str, message: str) -> HTTPException:
    """Business-rule errors carry a stable ``code`` the client can translate."""
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _snapshot(note: ProjectNote) -> dict:
    return {
        "project_id": note.project_id,
        "board": note.board,
        "title": note.title,
        "content": note.content,
        "created_by_user_id": note.created_by_user_id,
        "created_at": to_utc_z(note.created_at),
        "updated_by_user_id": note.updated_by_user_id,
        "updated_at": to_utc_z(note.updated_at),
    }


class ProjectNoteService:
    def __init__(self, db: AsyncSession, user):
        self.db = db
        self.user = user
        self.repo = ProjectNoteRepository(db)
        self._can_moderate: dict[int, bool] = {}

    # ── access ───────────────────────────────────────────────────────────────

    async def ensure_board(self, project_id: int, board: str) -> None:
        """The board exists for this project (project:read is checked by the route)."""
        if board not in NoteBoard.ALL:
            raise HTTPException(status_code=404, detail="Board not found")
        project = await self.repo.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        if project.is_parent_project:
            raise note_error(409, "parent_project", "Documentation boards are not available on parent projects")
        if board == NoteBoard.FUND:
            has_fund = (await self.db.execute(
                select(Fund.id).where(Fund.project_id == project_id)
            )).scalar_one_or_none() is not None
            if not has_fund:
                raise note_error(409, "no_fund", "The project has no fund")

    async def can_moderate(self, project_id: int) -> bool:
        """``project:update`` (project manager, explicit grant or Admin)."""
        if project_id not in self._can_moderate:
            self._can_moderate[project_id] = await PermissionsEngine(self.db).has_permission(
                self.user.id, Action.UPDATE.value, ResourceType.PROJECT.value,
                resource_id=project_id, project_id=project_id,
            )
        return self._can_moderate[project_id]

    async def can_modify(self, note: ProjectNote) -> bool:
        return note.created_by_user_id == self.user.id or await self.can_moderate(note.project_id)

    async def _load(self, project_id: int, board: str, note_id: int) -> ProjectNote:
        await self.ensure_board(project_id, board)
        note = await self.repo.get(project_id, board, note_id)
        if note is None:
            raise HTTPException(status_code=404, detail="Note not found")
        return note

    async def _load_for_modify(self, project_id: int, board: str, note_id: int) -> ProjectNote:
        note = await self._load(project_id, board, note_id)
        if not await self.can_modify(note):
            raise HTTPException(status_code=403, detail="Only the author or a project manager can change this note")
        return note

    # ── reads ────────────────────────────────────────────────────────────────

    async def list_page(self, project_id: int, board: str, *, search: str | None, before_id: int | None, limit: int):
        await self.ensure_board(project_id, board)
        return await self.repo.list_page(project_id, board, search=search, before_id=before_id, limit=limit)

    async def get(self, project_id: int, board: str, note_id: int) -> ProjectNote:
        return await self._load(project_id, board, note_id)

    async def history(self, project_id: int, board: str, note_id: int, *, limit: int):
        await self._load(project_id, board, note_id)
        return await self.repo.history(note_id, limit=limit)

    # ── writes ───────────────────────────────────────────────────────────────

    async def _log(self, note_id: int, event: str, details: dict) -> None:
        await AuditService(self.db).log_action(self.user.id, event, PROJECT_NOTE_AUDIT_ENTITY, str(note_id), details)

    async def create(self, project_id: int, board: str, data: NoteCreate) -> int:
        await self.ensure_board(project_id, board)
        note = ProjectNote(project_id=project_id, board=board, title=data.title, content=data.content,
                           created_by_user_id=self.user.id)
        self.db.add(note)
        await self.db.flush()
        await self._log(note.id, NoteEvent.CREATED, _snapshot(note))
        return note.id

    async def update(self, project_id: int, board: str, note_id: int, data: NoteUpdate) -> int:
        note = await self._load_for_modify(project_id, board, note_id)
        before, after = {}, {}
        for field in ("title", "content"):
            value = getattr(data, field)
            if field in data.model_fields_set and value != getattr(note, field):
                before[field], after[field] = getattr(note, field), value
                setattr(note, field, value)
        if not after:
            return note.id  # nothing changed: no edit stamp, no history entry
        note.updated_by_user_id = self.user.id
        note.updated_at = _now()
        await self.db.flush()
        await self._log(note.id, NoteEvent.UPDATED, {
            "project_id": project_id, "board": board, "before": before, "after": after,
        })
        return note.id

    async def delete(self, project_id: int, board: str, note_id: int) -> None:
        note = await self._load_for_modify(project_id, board, note_id)
        await self._log(note.id, NoteEvent.DELETED, {
            **_snapshot(note), "deleted_by_user_id": self.user.id, "deleted_at": to_utc_z(_now()),
        })
        await self.db.delete(note)
        await self.db.flush()
