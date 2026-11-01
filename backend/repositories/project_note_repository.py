"""Queries for project documentation boards.

Every query is scoped by both ``project_id`` and ``board``: a note is never
reachable through another project or another board.
"""
from __future__ import annotations

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, contains_eager

from backend.models.audit_log import AuditLog
from backend.models.project import Project
from backend.models.project_note import PROJECT_NOTE_AUDIT_ENTITY, ProjectNote
from backend.models.user import User


def _escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class ProjectNoteRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    def _with_users(self):
        """Notes with their creator and last editor, joined in the same query."""
        creator = aliased(User, name="note_creator")
        editor = aliased(User, name="note_editor")
        return (
            select(ProjectNote)
            .join(creator, creator.id == ProjectNote.created_by_user_id)
            .outerjoin(editor, editor.id == ProjectNote.updated_by_user_id)
            .options(
                contains_eager(ProjectNote.created_by_user.of_type(creator)),
                contains_eager(ProjectNote.updated_by_user.of_type(editor)),
            )
        )

    async def get_project(self, project_id: int) -> Project | None:
        return await self.db.get(Project, project_id)

    async def get(self, project_id: int, board: str, note_id: int) -> ProjectNote | None:
        result = await self.db.execute(
            self._with_users().where(
                ProjectNote.id == note_id, ProjectNote.project_id == project_id, ProjectNote.board == board
            ).execution_options(populate_existing=True)  # fresh editor after an edit in this session
        )
        return result.scalar_one_or_none()

    async def list_page(
        self, project_id: int, board: str, *, search: str | None, before_id: int | None, limit: int
    ) -> tuple[list[ProjectNote], int | None]:
        """Newest first, keyset-paginated by id. Returns the page and the cursor
        for the next (older) page, or None when this is the last one."""
        q = self._with_users().where(ProjectNote.project_id == project_id, ProjectNote.board == board)
        if search and search.strip():
            pattern = f"%{_escape_like(search.strip())}%"
            q = q.where(or_(ProjectNote.title.ilike(pattern, escape="\\"),
                            ProjectNote.content.ilike(pattern, escape="\\")))
        if before_id is not None:
            q = q.where(ProjectNote.id < before_id)
        rows = list((await self.db.execute(q.order_by(ProjectNote.id.desc()).limit(limit + 1))).scalars().all())
        has_more = len(rows) > limit
        rows = rows[:limit]
        return rows, (rows[-1].id if has_more and rows else None)

    async def history(self, note_id: int, *, limit: int) -> list[tuple[AuditLog, str | None]]:
        rows = await self.db.execute(
            select(AuditLog, User.full_name)
            .outerjoin(User, User.id == AuditLog.user_id)
            .where(and_(AuditLog.entity == PROJECT_NOTE_AUDIT_ENTITY, AuditLog.entity_id == str(note_id)))
            .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
            .limit(limit)
        )
        return [(log, name) for log, name in rows.all()]

