"""
Pytest configuration and fixtures for backend tests.
Uses in-memory SQLite so no real PostgreSQL connection is needed.
"""
import os

os.environ.setdefault("ENVIRONMENT", "test")  # before any backend import: no external alerts

import pytest
import pytest_asyncio
from typing import AsyncGenerator
from unittest.mock import AsyncMock, patch

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.pool import StaticPool
from httpx import AsyncClient, ASGITransport

from backend.db.base import Base
from backend.models.user import User, UserRole
from backend.models.category import Category
from backend.models.supplier import Supplier
from backend.core.security import hash_password

# Import CEMS models so their tables (e.g. cems_warehouses) are registered on
# the shared metadata before create_all(). User.cems_warehouse_id has a FK to
# cems_warehouses.id; without this import the table is missing and metadata
# resolution raises NoReferencedTableError.
import backend.models.cems_models  # noqa: F401,E402

# ── SQLite compatibility ────────────────────────────────────────────────────────
# PostgreSQL-specific JSONB has no native SQLite equivalent.
# Teach SQLite's DDL compiler to render it as TEXT so create_all() works.
from sqlalchemy.dialects.sqlite.base import SQLiteTypeCompiler as _SQLiteTC

if not hasattr(_SQLiteTC, "visit_JSONB"):
    _SQLiteTC.visit_JSONB = lambda self, type_, **kw: "TEXT"

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    """Clear the in-memory rate limiter before and after every test so
    repeated login calls in different tests don't trigger 429."""
    from backend.core.rate_limit import _limiter
    _limiter._requests.clear()
    yield
    _limiter._requests.clear()


@pytest_asyncio.fixture
async def test_engine():
    """Create in-memory SQLite engine with all tables."""
    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        echo=False,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def test_db(test_engine) -> AsyncGenerator[AsyncSession, None]:
    """Provide a fresh async session for each test."""
    async_session = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with async_session() as session:
        yield session
        await session.rollback()


@pytest_asyncio.fixture
async def test_client(test_db: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """
    HTTP test client with:
    - DB dependency overridden to use in-memory SQLite session
    - Startup hooks (init_database, create_super_admin, schedulers) mocked out
    """
    from backend.main import create_app
    from backend.db.session import get_db

    app = create_app()

    async def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db

    with (
        patch("backend.main.init_database", new=AsyncMock(return_value=None)),
        patch("backend.core.seed.create_super_admin", new=AsyncMock(return_value=None)),
        patch(
            "backend.main.run_recurring_transactions_scheduler",
            new=AsyncMock(return_value=None),
        ),
        patch(
            "backend.main.run_contract_renewal_scheduler",
            new=AsyncMock(return_value=None),
        ),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            yield client

    app.dependency_overrides.clear()


# ── Users ──────────────────────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def admin_user(test_db: AsyncSession) -> User:
    """Create and persist an admin user."""
    user = User(
        email="admin@test.com",
        password_hash=hash_password("testpass123"),
        full_name="Test Admin",
        role=UserRole.ADMIN.value,
        is_active=True,
        email_verified=True,
    )
    test_db.add(user)
    await test_db.commit()
    await test_db.refresh(user)
    return user


@pytest_asyncio.fixture
async def member_user(test_db: AsyncSession) -> User:
    """Create and persist a member user."""
    user = User(
        email="member@test.com",
        password_hash=hash_password("testpass123"),
        full_name="Test Member",
        role=UserRole.MEMBER.value,
        is_active=True,
        email_verified=True,
    )
    test_db.add(user)
    await test_db.commit()
    await test_db.refresh(user)
    return user


# ── Auth tokens ────────────────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def admin_token(test_client: AsyncClient, admin_user: User) -> str:
    """JWT access token for the admin user."""
    response = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "admin@test.com", "password": "testpass123"},
    )
    assert response.status_code == 200, f"Admin login failed: {response.text}"
    return response.json()["access_token"]


@pytest_asyncio.fixture
async def member_token(test_client: AsyncClient, member_user: User) -> str:
    """JWT access token for the member user."""
    response = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "member@test.com", "password": "testpass123"},
    )
    assert response.status_code == 200, f"Member login failed: {response.text}"
    return response.json()["access_token"]


# ── Supporting data ────────────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def default_category(test_db: AsyncSession) -> int:
    """Create a default Category and return its ID."""
    category = Category(name="Test Category", is_active=True, parent_id=None)
    test_db.add(category)
    await test_db.commit()
    await test_db.refresh(category)
    return category.id


@pytest_asyncio.fixture
async def test_supplier(test_db: AsyncSession) -> Supplier:
    """Create a test Supplier."""
    supplier = Supplier(name="Test Supplier", is_active=True)
    test_db.add(supplier)
    await test_db.commit()
    await test_db.refresh(supplier)
    return supplier


# ── Convenience fixture: project ───────────────────────────────────────────────

@pytest_asyncio.fixture
async def test_project(test_client: AsyncClient, admin_token: str) -> dict:
    """Create a project via the API and return the response JSON."""
    response = await test_client.post(
        "/api/v1/projects",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={
            "name": "Fixture Project",
            "description": "Created by conftest fixture",
            "start_date": "2024-01-01",
            "end_date": "2024-12-31",
            "budget_monthly": 0.0,
            "budget_annual": 50000.0,
        },
    )
    assert response.status_code == 200, f"Fixture project creation failed: {response.text}"
    return response.json()
