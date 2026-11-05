"""The fixed stages of a legal proceeding and the documentation components of each.

This module is the single source of truth for stage keys, their order, display
labels and components. Keys are stable internal identifiers stored in the DB
(``legal_proceeding_stages.stage_key``, ``legal_proceeding_entries.stage_key`` /
``context_key`` and ``documents.context_key``): never rename a key — change its
``label`` instead. Order is the position in ``STAGES``; nothing in the DB stores it.

Documentation rules (used for the non-blocking warning before completing a stage):
- A stage with ``requires_communication`` (stage 1) is documented once it has at
  least one communication entry with an attached document.
- Every component of a stage is documented once at least one document is
  attached to it. Notes never count as documents.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class StageComponent:
    key: str
    label: str


@dataclass(frozen=True)
class StageDefinition:
    key: str
    label: str
    description: str
    components: tuple[StageComponent, ...] = ()
    # Stage documented by recurring communication entries (each with a file).
    requires_communication: bool = False

    @property
    def component_keys(self) -> tuple[str, ...]:
        return tuple(c.key for c in self.components)

    def has_component(self, component_key: str) -> bool:
        return component_key in self.component_keys


# Stage 1 key. Also embedded in the ck_lpe_communication CHECK constraint
# (models/legal_proceeding.py and migrations/add_legal_proceedings.sql).
STAGE1_KEY = "collection_messages"

_DOOR_NOTICE_COMPONENTS = (
    StageComponent("door_placement", "תיעוד הדבקה על הדלת"),
    StageComponent("letter_file", "קובץ המכתב"),
    StageComponent("email_proof", "אסמכתת שליחה במייל"),
    StageComponent("whatsapp_proof", "אסמכתת שליחה בוואטסאפ"),
)

STAGES: tuple[StageDefinition, ...] = (
    StageDefinition(
        key=STAGE1_KEY,
        label="הודעות גבייה",
        description="תיעוד פניות הגבייה לדייר: מייל, וואטסאפ או ערוץ אחר.",
        requires_communication=True,
    ),
    StageDefinition(
        key="first_door_notice",
        label="הודעה ראשונה על הדלת",
        description="הדבקת מכתב ראשון על דלת הדירה ושליחתו בערוצים נוספים.",
        components=_DOOR_NOTICE_COMPONENTS,
    ),
    StageDefinition(
        key="second_door_notice",
        label="הודעה שנייה על הדלת",
        description="הדבקת מכתב שני על דלת הדירה ושליחתו בערוצים נוספים.",
        components=_DOOR_NOTICE_COMPONENTS,
    ),
    StageDefinition(
        key="lawyer_warning",
        label="מכתב התראה מעורך דין",
        description="מכתב התראה מעורך דין ושליחתו, כולל דואר רשום.",
        components=(
            StageComponent("lawyer_letter", "מכתב עורך הדין"),
            StageComponent("whatsapp_proof", "אסמכתת שליחה בוואטסאפ"),
            StageComponent("email_proof", "אסמכתת שליחה במייל"),
            StageComponent("registered_mail_proof", "אסמכתת משלוח דואר רשום"),
            StageComponent("registered_mail_signature", "אישור מסירה / חתימה בדואר רשום"),
        ),
    ),
    StageDefinition(
        key="supervisor_claim",
        label="תביעה למפקח על הבתים המשותפים",
        description="הגשת התביעה למפקח וקבלת החלטתו.",
        components=(
            StageComponent("claim_filing", "הגשת התביעה"),
            StageComponent("supervisor_decision", "החלטת המפקח"),
        ),
    ),
)

STAGE_KEYS: tuple[str, ...] = tuple(s.key for s in STAGES)
_STAGES_BY_KEY: dict[str, StageDefinition] = {s.key: s for s in STAGES}

# documents.context_key = "<stage_key>.<component_key>": component keys repeat
# across stages (email_proof in stages 2-4), so the stage is part of the key.
DOCUMENT_CONTEXT_SEPARATOR = "."


def get_stage(stage_key: str) -> StageDefinition | None:
    return _STAGES_BY_KEY.get(stage_key)


def stage_position(stage_key: str) -> int:
    """1-based position of the stage in the fixed order (display / sorting)."""
    return STAGE_KEYS.index(stage_key) + 1


def is_valid_component(stage_key: str | None, component_key: str | None) -> bool:
    """True when ``component_key`` is one of the components of ``stage_key``."""
    if not stage_key or not component_key:
        return False
    stage = get_stage(stage_key)
    return stage is not None and stage.has_component(component_key)


def document_context_key(stage_key: str, component_key: str) -> str:
    """The ``documents.context_key`` of a stage component."""
    return f"{stage_key}{DOCUMENT_CONTEXT_SEPARATOR}{component_key}"


def parse_document_context_key(context_key: str | None) -> tuple[str, str] | None:
    """Inverse of :func:`document_context_key`; None when not a valid component."""
    if not context_key or DOCUMENT_CONTEXT_SEPARATOR not in context_key:
        return None
    stage_key, component_key = context_key.split(DOCUMENT_CONTEXT_SEPARATOR, 1)
    return (stage_key, component_key) if is_valid_component(stage_key, component_key) else None


KEY_MAX_LENGTH = 50  # VARCHAR(50) of every column that stores a stage/context key


def _validate_catalogue() -> None:
    """Fail at import if the catalogue breaks its own invariants."""
    if len(STAGE_KEYS) != len(set(STAGE_KEYS)):
        raise ValueError("Legal stages: duplicate stage key")
    for stage in STAGES:
        if DOCUMENT_CONTEXT_SEPARATOR in stage.key or len(stage.key) > KEY_MAX_LENGTH:
            raise ValueError(f"Legal stages: invalid stage key {stage.key!r}")
        if len(stage.component_keys) != len(set(stage.component_keys)):
            raise ValueError(f"Legal stages: duplicate component in {stage.key!r}")
        for component_key in stage.component_keys:
            if len(document_context_key(stage.key, component_key)) > KEY_MAX_LENGTH:
                raise ValueError(f"Legal stages: context key too long for {stage.key}.{component_key}")


_validate_catalogue()
