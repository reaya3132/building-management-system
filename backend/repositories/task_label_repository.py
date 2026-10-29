"""Task label repository."""
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.task import Task, TaskKind, TaskLabel, task_task_labels


class TaskLabelRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_all(self) -> list[TaskLabel]:
        result = await self.db.execute(select(TaskLabel).order_by(TaskLabel.name))
        return list(result.scalars().all())

    async def get_by_id(self, label_id: int) -> TaskLabel | None:
        result = await self.db.execute(select(TaskLabel).where(TaskLabel.id == label_id))
        return result.scalar_one_or_none()

    async def get_by_ids(self, ids: list[int]) -> list[TaskLabel]:
        if not ids:
            return []
        result = await self.db.execute(select(TaskLabel).where(TaskLabel.id.in_(ids)))
        return list(result.scalars().all())

    async def count_tasks_for_label(self, label_id: int) -> int:
        """Count how many regular tasks are tagged with this label (via the association table)."""
        result = await self.db.execute(
            select(func.count())
            .select_from(task_task_labels)
            .join(Task, Task.id == task_task_labels.c.task_id)
            .where(task_task_labels.c.task_label_id == label_id)
            .where(Task.task_kind == TaskKind.GENERAL)
        )
        return result.scalar_one()

    async def create(self, label: TaskLabel) -> TaskLabel:
        self.db.add(label)
        await self.db.flush()
        await self.db.refresh(label)
        return label

    async def update(self, label: TaskLabel) -> TaskLabel:
        await self.db.flush()
        await self.db.refresh(label)
        return label

    async def delete(self, label: TaskLabel) -> None:
        await self.db.delete(label)
        await self.db.flush()
