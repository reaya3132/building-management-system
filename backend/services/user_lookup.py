"""Loading the users a record is assigned to — shared by every module that assigns
users (regular tasks, collection tasks, legal proceedings), so the rule for who can
be assigned is defined once.
"""
from __future__ import annotations

from collections.abc import Callable

from fastapi import HTTPException

from backend.models.user import User
from backend.repositories.user_repository import UserRepository


async def load_active_users(
    user_repo: UserRepository,
    user_ids: list[int],
    *,
    not_found: Callable[[int], Exception] | None = None,
) -> list[User]:
    """The User rows of ``user_ids``, in the same order, requiring each to exist
    and be active (archiving a user also deactivates it).

    The first missing or inactive id raises ``not_found(user_id)``; by default an
    ``HTTPException(404, "User not found")``, the regular tasks' error.
    """
    loaded: list[User] = []
    for user_id in user_ids:
        candidate = await user_repo.get_by_id(user_id)
        if not candidate or not candidate.is_active:
            raise not_found(user_id) if not_found else HTTPException(status_code=404, detail="User not found")
        loaded.append(candidate)
    return loaded
