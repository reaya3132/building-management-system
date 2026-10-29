"""Stage 2 of the collection-tasks module: models, constraints and permissions.

Only the data layer and the IAM policy are covered here — there is no
collection service or API yet. Rows are written directly through ``test_db``
(SQLite). PostgreSQL-only parts (the billing-month CHECK, CONCURRENTLY indexes)
are exercised by the migration dry run, not here.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import inspect, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.iam.engine import PermissionsEngine
from backend.iam.enums import Action, GlobalRole, ProjectRole, ResourceType
from backend.iam.repository import _GLOBAL_ROLE_POLICIES, _PROJECT_ROLE_POLICIES
from backend.models.collection_task import (
    CollectionAmountAdjustment,
    CollectionLedgerItem,
    CollectionTaskDetails,
    CollectionType,
)
from backend.models.project import Project
from backend.models.task import Task, TaskKind
from backend.models.user import User

COLLECTION = ResourceType.COLLECTION_TASK.value


async def _project(db: AsyncSession, name: str = "collection-project") -> Project:
    project = Project(name=name)
    db.add(project)
    await db.flush()
    return project


async def _collection_task(db: AsyncSession, user: User, title: str = "collection") -> Task:
    task = Task(title=title, task_kind=TaskKind.COLLECTION, assigned_to_user_id=user.id)
    db.add(task)
    await db.flush()
    return task


async def _expect_integrity_error(db: AsyncSession, obj) -> None:
    db.add(obj)
    with pytest.raises(IntegrityError):
        await db.flush()
    await db.rollback()


@pytest.mark.asyncio
class TestCollectionModels:
    async def test_single_task_with_adjustments(self, test_db: AsyncSession, admin_user: User):
        project = await _project(test_db)
        task = await _collection_task(test_db, admin_user)
        test_db.add(CollectionTaskDetails(
            task_id=task.id, collection_type=CollectionType.SINGLE, project_id=project.id,
            billing_month=date(2026, 10, 1), initial_amount=Decimal("1000.50"),
        ))
        test_db.add_all([
            CollectionAmountAdjustment(task_id=task.id, amount=Decimal("0.10"), created_by_user_id=admin_user.id),
            CollectionAmountAdjustment(task_id=task.id, amount=Decimal("0.20"), note="fee",
                                       created_by_user_id=admin_user.id),
        ])
        await test_db.commit()

        details = await test_db.get(CollectionTaskDetails, task.id)
        assert details.initial_amount == Decimal("1000.50")
        assert details.created_at is not None and details.updated_at is not None
        amounts = (await test_db.execute(
            select(CollectionAmountAdjustment.amount).where(CollectionAmountAdjustment.task_id == task.id)
        )).scalars().all()
        assert sum(amounts, Decimal("0")) == Decimal("0.30")

    async def test_ledger_task_with_items(self, test_db: AsyncSession, admin_user: User):
        project = await _project(test_db)
        task = await _collection_task(test_db, admin_user)
        test_db.add(CollectionTaskDetails(
            task_id=task.id, collection_type=CollectionType.LEDGER, project_id=project.id,
            billing_month=date(2026, 10, 1),
        ))
        test_db.add_all([
            CollectionLedgerItem(task_id=task.id, subject="ועד", amount=Decimal("250.00"),
                                 created_by_user_id=admin_user.id),
            CollectionLedgerItem(task_id=task.id, subject="חניה", amount=Decimal("80.00"),
                                 created_by_user_id=admin_user.id),
        ])
        await test_db.commit()

        items = (await test_db.execute(
            select(CollectionLedgerItem).where(CollectionLedgerItem.task_id == task.id)
        )).scalars().all()
        assert {i.sort_order for i in items} == {0}
        assert all(i.archived_at is None for i in items)
        assert sum((i.amount for i in items), Decimal("0")) == Decimal("330.00")

    @pytest.mark.parametrize(
        "collection_type,initial_amount",
        [
            ("other", None),                              # unknown type
            (CollectionType.SINGLE, None),                # single needs an amount
            (CollectionType.SINGLE, Decimal("0")),        # ... a positive one
            (CollectionType.SINGLE, Decimal("-5")),
            (CollectionType.LEDGER, Decimal("10")),       # ledger has no initial amount
        ],
    )
    async def test_details_constraints(
        self, test_db: AsyncSession, admin_user: User, collection_type, initial_amount
    ):
        project = await _project(test_db)
        task = await _collection_task(test_db, admin_user)
        await _expect_integrity_error(test_db, CollectionTaskDetails(
            task_id=task.id, collection_type=collection_type, project_id=project.id,
            billing_month=date(2026, 10, 1), initial_amount=initial_amount,
        ))

    @pytest.mark.parametrize("amount", [Decimal("0"), Decimal("-1.00")])
    async def test_adjustment_amount_must_be_positive(
        self, test_db: AsyncSession, admin_user: User, amount
    ):
        task = await _collection_task(test_db, admin_user)
        await _expect_integrity_error(test_db, CollectionAmountAdjustment(
            task_id=task.id, amount=amount, created_by_user_id=admin_user.id,
        ))

    @pytest.mark.parametrize("amount", [Decimal("0"), Decimal("-1.00")])
    async def test_ledger_item_amount_must_be_positive(
        self, test_db: AsyncSession, admin_user: User, amount
    ):
        task = await _collection_task(test_db, admin_user)
        await _expect_integrity_error(test_db, CollectionLedgerItem(
            task_id=task.id, subject="x", amount=amount, created_by_user_id=admin_user.id,
        ))

    async def test_schema_shape(self, test_engine):
        """Tables, FK delete rules and indexes match the spec (and the SQL migration)."""
        def _inspect(sync_conn):
            insp = inspect(sync_conn)
            fks = {
                table: {(fk["constrained_columns"][0], fk["referred_table"], fk["options"].get("ondelete"))
                        for fk in insp.get_foreign_keys(table)}
                for table in ("collection_task_details", "collection_amount_adjustments",
                              "collection_ledger_items")
            }
            indexes = {
                table: {ix["name"] for ix in insp.get_indexes(table)}
                for table in ("collection_task_details", "collection_amount_adjustments",
                              "collection_ledger_items", "tasks")
            }
            return fks, indexes

        async with test_engine.connect() as conn:
            fks, indexes = await conn.run_sync(_inspect)

        assert fks["collection_task_details"] == {
            ("task_id", "tasks", "RESTRICT"), ("project_id", "projects", "RESTRICT"),
        }
        assert fks["collection_amount_adjustments"] == {
            ("task_id", "tasks", "RESTRICT"), ("created_by_user_id", "users", "RESTRICT"),
        }
        assert fks["collection_ledger_items"] == {
            ("task_id", "tasks", "RESTRICT"), ("created_by_user_id", "users", "RESTRICT"),
            ("updated_by_user_id", "users", "RESTRICT"), ("archived_by_user_id", "users", "RESTRICT"),
        }
        assert indexes["collection_task_details"] >= {
            "ix_ctd_billing_month_project_id", "ix_ctd_billing_month", "ix_ctd_project_id",
        }
        assert indexes["collection_amount_adjustments"] >= {"ix_caa_task_id"}
        assert indexes["collection_ledger_items"] >= {"ix_cli_task_id", "ix_cli_task_id_active"}
        assert "ix_tasks_task_kind" in indexes["tasks"]


class TestCollectionPolicies:
    """Collection permissions per the spec: Admin/SuperAdmin automatically,
    Members only by explicit grant, never derived from project roles."""

    def test_admin_has_read_write_update_but_no_delete(self):
        actions = _GLOBAL_ROLE_POLICIES[GlobalRole.ADMIN.value][COLLECTION]
        assert actions == {Action.READ.value, Action.WRITE.value, Action.UPDATE.value}

    def test_super_admin_has_collection_access(self):
        actions = _GLOBAL_ROLE_POLICIES[GlobalRole.SUPER_ADMIN.value][COLLECTION]
        assert {Action.READ.value, Action.WRITE.value, Action.UPDATE.value} <= actions

    def test_member_has_nothing_by_default(self):
        assert _GLOBAL_ROLE_POLICIES[GlobalRole.MEMBER.value][COLLECTION] == set()

    def test_no_project_role_grants_collection(self):
        for role in ProjectRole:
            assert COLLECTION not in _PROJECT_ROLE_POLICIES[role.value], role

    def test_regular_task_resource_does_not_imply_collection(self):
        member = _GLOBAL_ROLE_POLICIES[GlobalRole.MEMBER.value]
        assert member[ResourceType.TASK.value] == {Action.WRITE.value}
        assert member[COLLECTION] == set()


@pytest.mark.asyncio
class TestCollectionPermissionEngine:
    async def test_admin_allowed_member_denied(
        self, test_db: AsyncSession, admin_user: User, member_user: User
    ):
        engine = PermissionsEngine(test_db)
        for action in (Action.READ, Action.WRITE, Action.UPDATE):
            assert await engine.has_permission(admin_user.id, action.value, COLLECTION)
            assert not await engine.has_permission(member_user.id, action.value, COLLECTION)
        assert not await engine.has_permission(admin_user.id, Action.DELETE.value, COLLECTION)

    async def test_member_explicit_grant(
        self, test_db: AsyncSession, admin_user: User, member_user: User
    ):
        engine = PermissionsEngine(test_db)
        await engine.grant_resource_permission(
            member_user.id, COLLECTION, "*", Action.READ.value, actor_user_id=admin_user.id
        )
        await test_db.commit()
        assert await engine.has_permission(member_user.id, Action.READ.value, COLLECTION)
        assert not await engine.has_permission(member_user.id, Action.UPDATE.value, COLLECTION)

    async def test_project_manager_role_grants_nothing(
        self, test_db: AsyncSession, admin_user: User, member_user: User
    ):
        project = await _project(test_db, "pm-project")
        engine = PermissionsEngine(test_db)
        await engine.grant_project_role(
            member_user.id, project.id, ProjectRole.MANAGER.value, actor_user_id=admin_user.id
        )
        await test_db.commit()
        assert await engine.has_permission(
            member_user.id, Action.READ.value, ResourceType.TASK.value, project_id=project.id
        )
        for action in Action:
            assert not await engine.has_permission(
                member_user.id, action.value, COLLECTION, project_id=project.id
            )
