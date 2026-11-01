"""Project documentation boards — /api/v1/projects/{project_id}/notes/{board}.

Every route requires the existing ``project:read`` permission on the project
(IAM decorator: explicit grant, project role or Admin); the service applies
the board rules (non-parent project, fund present) and the edit/delete policy.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query, Response

from backend.core.deps import DBSessionDep
from backend.iam.decorators import require_permission
from backend.models.project_note import ProjectNote
from backend.schemas.project_note import (
    NoteBoardLiteral,
    NoteCreate,
    NoteHistoryEntry,
    NoteOut,
    NotePage,
    NoteUpdate,
    NoteUser,
)
from backend.services.project_note_service import ProjectNoteService

router = APIRouter()

# View permission on the project in the path.
project_viewer = require_permission("read", "project", resource_id_param="project_id", project_id_param="project_id")


def _user(user) -> NoteUser | None:
    return NoteUser(id=user.id, full_name=user.full_name, avatar_url=user.avatar_url) if user else None


async def _out(service: ProjectNoteService, note: ProjectNote) -> NoteOut:
    return NoteOut(
        id=note.id, project_id=note.project_id, board=note.board, title=note.title, content=note.content,
        created_by=_user(note.created_by_user), created_at=note.created_at,
        updated_by=_user(note.updated_by_user), updated_at=note.updated_at,
        can_modify=await service.can_modify(note),
    )


@router.get("/{project_id}/notes/{board}", response_model=NotePage)
async def list_notes(
    project_id: int,
    board: NoteBoardLiteral,
    db: DBSessionDep,
    user=Depends(project_viewer),
    search: str | None = Query(None, max_length=255),
    before_id: int | None = Query(None, ge=1, description="Cursor: id of the last note already shown"),
    limit: int = Query(20, ge=1, le=50),
):
    service = ProjectNoteService(db, user)
    notes, next_before_id = await service.list_page(project_id, board, search=search, before_id=before_id, limit=limit)
    return NotePage(items=[await _out(service, n) for n in notes], next_before_id=next_before_id)


@router.post("/{project_id}/notes/{board}", response_model=NoteOut, status_code=201)
async def create_note(project_id: int, board: NoteBoardLiteral, data: NoteCreate, db: DBSessionDep,
                      user=Depends(project_viewer)):
    service = ProjectNoteService(db, user)
    note_id = await service.create(project_id, board, data)
    return await _out(service, await service.get(project_id, board, note_id))


@router.patch("/{project_id}/notes/{board}/{note_id}", response_model=NoteOut)
async def update_note(project_id: int, board: NoteBoardLiteral, note_id: int, data: NoteUpdate,
                      db: DBSessionDep, user=Depends(project_viewer)):
    service = ProjectNoteService(db, user)
    await service.update(project_id, board, note_id, data)
    return await _out(service, await service.get(project_id, board, note_id))


@router.delete("/{project_id}/notes/{board}/{note_id}", status_code=204)
async def delete_note(project_id: int, board: NoteBoardLiteral, note_id: int, db: DBSessionDep,
                      user=Depends(project_viewer)):
    await ProjectNoteService(db, user).delete(project_id, board, note_id)
    return Response(status_code=204)


@router.get("/{project_id}/notes/{board}/{note_id}/history", response_model=list[NoteHistoryEntry])
async def note_history(project_id: int, board: NoteBoardLiteral, note_id: int, db: DBSessionDep,
                       user=Depends(project_viewer), limit: int = Query(50, ge=1, le=200)):
    rows = await ProjectNoteService(db, user).history(project_id, board, note_id, limit=limit)
    return [
        NoteHistoryEntry(id=log.id, action=log.action, user_id=log.user_id, user_name=name,
                         details=json.loads(log.details) if log.details else None, created_at=log.created_at)
        for log, name in rows
    ]
