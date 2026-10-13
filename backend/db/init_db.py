"""
Database initialization - creates all tables, enums, and indexes.
All database schema is defined in the SQLAlchemy models in backend/models/
and backend/cems/models/.

This file creates missing tables via create_all (which never alters existing
tables). A small set of *additive, idempotent* column migrations that create_all
cannot apply to pre-existing tables are applied explicitly on startup — see
``_apply_additive_migrations``. Larger schema changes still go through the SQL
scripts in backend/migrations/.
"""
import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from backend.db.base import Base

logger = logging.getLogger(__name__)

# Additive, idempotent statements that bring an already-provisioned schema up to
# date for columns create_all cannot add to existing tables. Every statement is
# guarded with IF NOT EXISTS so it is safe to run on every startup. PostgreSQL
# only — on SQLite (tests) create_all already includes these columns.
_ADDITIVE_MIGRATIONS: tuple[str, ...] = (
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS apartment_id INTEGER REFERENCES apartments(id)",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS building_id INTEGER REFERENCES buildings(id)",
    "CREATE INDEX IF NOT EXISTS ix_tasks_apartment_id ON tasks (apartment_id)",
    "CREATE INDEX IF NOT EXISTS ix_tasks_building_id ON tasks (building_id)",
    # Reception-desk projects grouping buildings (buildings table pre-exists).
    "ALTER TABLE buildings ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES building_projects(id)",
    "CREATE INDEX IF NOT EXISTS ix_buildings_project_id ON buildings (project_id)",
    # WhatsApp-style chat: "edited" timestamp on a task message (task_messages pre-exists).
    # The task_message_reads table itself is a NEW table, so create_all provisions it.
    "ALTER TABLE task_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP",
    # Apartment personal area (אזור אישי) — private fields on the pre-existing apartments table.
    # The apartment_documents table itself is NEW, so create_all provisions it.
    "ALTER TABLE apartments ADD COLUMN IF NOT EXISTS private_details TEXT",
    "ALTER TABLE apartments ADD COLUMN IF NOT EXISTS private_notes TEXT",
    # Parking/storage numbers + owner email and a 2nd owner contact (apartments pre-exist).
    "ALTER TABLE apartments ADD COLUMN IF NOT EXISTS parking_number VARCHAR(50)",
    "ALTER TABLE apartments ADD COLUMN IF NOT EXISTS storage_number VARCHAR(50)",
    "ALTER TABLE apartments ADD COLUMN IF NOT EXISTS owner_email VARCHAR(255)",
    "ALTER TABLE apartments ADD COLUMN IF NOT EXISTS owner_name_2 VARCHAR(255)",
    "ALTER TABLE apartments ADD COLUMN IF NOT EXISTS owner_phone_2 VARCHAR(50)",
    "ALTER TABLE apartments ADD COLUMN IF NOT EXISTS owner_email_2 VARCHAR(255)",
    # Second contact person on a tenant (tenants pre-exist).
    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS name_2 VARCHAR(255)",
    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone_2 VARCHAR(50)",
    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email_2 VARCHAR(255)",
    # Optional unit price on a consumable item (cems_consumable_items pre-exists).
    "ALTER TABLE cems_consumable_items ADD COLUMN IF NOT EXISTS unit_price NUMERIC(12, 2)",
    # User archive (replaces hard delete); null = not archived (users pre-exist).
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP",
    "CREATE INDEX IF NOT EXISTS ix_users_archived_at ON users (archived_at)",
)

# ── Main application models ──────────────────────────────────────────────────
from backend.models import (  # noqa: F401
    User,
    Project,
    Subproject,
    Transaction,
    AuditLog,
    Supplier,
    Document,
    Invite,
    EmailVerification,
    RecurringTransactionTemplate,
    Budget,
    UnforeseenTransaction,
    UnforeseenTransactionLine,
    QuoteStructureItem,
    QuoteSubject,
    QuoteProject,
    QuoteLine,
    Task,
    TaskAttachment,
    TaskMessage,
    UserNotification,
    GroupTransactionDraft,
    GroupTransactionDraftDocument,
)

# ── CEMS models (same Base, so the same create_all covers them) ───────────────
from backend.models.cems_models import (  # noqa: F401
    Warehouse,
    ManagerHistory,
    AssetCategory,
    Project as CemsProject,
    FixedAsset,
    AssetHistory,
    ConsumableItem,
    ConsumptionLog,
    StockAlert,
    ConsumableMovementLog,
    Transfer,
    WarehouseReturn,
    AssetRetirement,
    ReorderRequest,
    Signature,
    Document as CemsDocument,
)


async def _apply_additive_migrations(conn: AsyncConnection) -> None:
    """Apply the idempotent additive column migrations on PostgreSQL.

    create_all never alters an existing ``tasks`` table, so the nullable
    building-reception columns must be added explicitly on already-provisioned
    databases. Each statement uses IF NOT EXISTS and is therefore safe to run on
    every startup. Skipped on non-PostgreSQL backends (SQLite tests build the
    columns from the model). Failures are logged but never abort startup, so a
    migration hiccup degrades only the reception-desk feature, not the whole app.
    """
    if conn.dialect.name != "postgresql":
        return
    for statement in _ADDITIVE_MIGRATIONS:
        try:
            await conn.execute(text(statement))
        except Exception:
            logger.warning("Additive migration failed: %s", statement, exc_info=True)


async def init_database(engine: AsyncEngine):
    """
    Initialize database — create all tables, enums, and indexes from SQLAlchemy models,
    then apply the idempotent additive column migrations.

    create_all only creates tables/columns that do not yet exist and never alters an
    existing table; ``_apply_additive_migrations`` fills that gap for a small set of
    additive columns. Larger schema changes still run from backend/migrations/ manually.
    """
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _apply_additive_migrations(conn)

    print("Database initialization completed successfully")
