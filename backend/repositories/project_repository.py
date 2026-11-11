from sqlalchemy import exists, or_, select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from backend.models.project import Project
from backend.repositories.base import BaseRepository


class ProjectRepository(BaseRepository[Project]):
    model = Project

    async def list(self, include_archived: bool = False, only_archived: bool = False) -> list[Project]:
        stmt = select(Project)
        if only_archived:
            stmt = stmt.where(Project.is_active == False)  # noqa: E712
        elif not include_archived:
            stmt = stmt.where(Project.is_active == True)  # noqa: E712
        res = await self.db.execute(stmt)
        return list(res.scalars().all())

    async def project_options(self) -> "list[Project]":
        """Active projects, plus inactive parents that still have an active
        sub-project (shown only to group them; not selectable)."""
        child = aliased(Project)
        has_active_child = exists().where(child.relation_project == Project.id, child.is_active == True)  # noqa: E712
        result = await self.db.execute(
            select(Project)
            .where(or_(Project.is_active == True, has_active_child))  # noqa: E712
            .order_by(Project.name)
        )
        return list(result.scalars().all())

    async def archive(self, project: Project) -> Project:
        project.is_active = False
        return await self.update(project)

    async def restore(self, project: Project) -> Project:
        project.is_active = True
        return await self.update(project)

    async def get_payments_of_monthly_tenants(self, project_id: int) -> float:
        res = await self.db.execute(
            select(func.sum(Project.budget_monthly)).where(Project.id == project_id)
        )
        return res.scalar() or 0.0

    async def get_subprojects(self, project_id: int):
        """Get all subprojects for a given parent project"""
        stmt = select(Project).where(Project.relation_project == project_id, Project.is_active == True)
        res = await self.db.execute(stmt)
        return list(res.scalars().all())

    async def get_project_by_name(self, name: str, exclude_project_id: int | None = None) -> Project | None:
        """Get an active project by name (compare trimmed). Used to enforce unique names across all projects."""
        name_trimmed = (name or "").strip()
        if not name_trimmed:
            return None
        stmt = (
            select(Project)
            .where(Project.is_active == True, func.trim(Project.name) == name_trimmed)
        )
        if exclude_project_id is not None:
            stmt = stmt.where(Project.id != exclude_project_id)
        res = await self.db.execute(stmt)
        return res.scalar_one_or_none()

    async def get_parent_project_by_name(self, name: str, exclude_project_id: int | None = None) -> Project | None:
        """Get an active parent project by name (compare trimmed). Used to enforce unique names among parent projects."""
        name_trimmed = (name or "").strip()
        if not name_trimmed:
            return None
        stmt = (
            select(Project)
            .where(
                Project.is_parent_project == True,
                Project.is_active == True,
                func.trim(Project.name) == name_trimmed,
            )
        )
        if exclude_project_id is not None:
            stmt = stmt.where(Project.id != exclude_project_id)
        res = await self.db.execute(stmt)
        return res.scalar_one_or_none()
