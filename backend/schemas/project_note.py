"""Schemas for project documentation boards."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_serializer, model_validator

from backend.schemas.task import to_utc_z

NoteBoardLiteral = Literal["general", "fund"]
CONTENT_MAX_LENGTH = 10_000


def _strip(value: Any) -> Any:
    return value.strip() if isinstance(value, str) else value


NoteTitle = Annotated[str, BeforeValidator(_strip), Field(min_length=1, max_length=255)]
def _optional_text(value: Any) -> Any:
    """Content is optional: missing, null and blank all mean "no content" ("")."""
    return "" if value is None else _strip(value)


# Optional free text; "no content" is always stored as "" (the column stays NOT NULL).
NoteContent = Annotated[str, BeforeValidator(_optional_text), Field(max_length=CONTENT_MAX_LENGTH)]


class NoteCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: NoteTitle
    content: NoteContent = ""


class NoteUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: NoteTitle | None = None
    # Sending null (or "") clears the content; leaving it out keeps it.
    content: NoteContent | None = None

    @model_validator(mode="after")
    def _not_empty(self):
        if not self.model_fields_set:
            raise ValueError("at least one field must be provided")
        if "title" in self.model_fields_set and self.title is None:
            raise ValueError("title cannot be null")
        if "content" in self.model_fields_set and self.content is None:
            self.content = ""
        return self


class NoteUser(BaseModel):
    id: int
    full_name: str
    avatar_url: str | None = None


class NoteOut(BaseModel):
    id: int
    project_id: int
    board: NoteBoardLiteral
    title: str
    content: str
    created_by: NoteUser | None = None
    created_at: datetime
    updated_by: NoteUser | None = None
    updated_at: datetime | None = None
    # Whether the current user may edit / delete this note (the server enforces it).
    can_modify: bool = False

    _serialize_created_at = field_serializer("created_at")(staticmethod(to_utc_z))
    _serialize_updated_at = field_serializer("updated_at")(staticmethod(to_utc_z))


class NotePage(BaseModel):
    items: list[NoteOut]
    # Pass as ``before_id`` to load the next (older) page; null when there is none.
    next_before_id: int | None = None


class NoteHistoryEntry(BaseModel):
    id: int
    action: str
    user_id: int | None = None
    user_name: str | None = None
    details: dict | None = None
    created_at: datetime

    _serialize_created_at = field_serializer("created_at")(staticmethod(to_utc_z))

