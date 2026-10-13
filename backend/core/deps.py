from typing import Annotated
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
import sqlalchemy.exc

from backend.db.session import get_db
from backend.core.security import decode_token
from backend.repositories.user_repository import UserRepository
from backend.models.user import UserRole


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/token")
oauth2_scheme_optional = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/token", auto_error=False)


DBSessionDep = Annotated[AsyncSession, Depends(get_db)]


async def get_current_user(db: DBSessionDep, token: Annotated[str, Depends(oauth2_scheme)]):
    try:
        payload = decode_token(token)
        if not payload or "sub" not in payload:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
        user_id = int(payload["sub"])
        user = await UserRepository(db).get_by_id(user_id)
        if not user or not user.is_active:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Inactive user")
        return user
    except HTTPException:
        raise
    except (ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    except Exception as e:
        # DB/connection errors must not return 401 - otherwise frontend clears token and "logs out" the user
        if isinstance(e, (sqlalchemy.exc.DBAPIError, sqlalchemy.exc.OperationalError, ConnectionError, OSError)):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Service temporarily unavailable. Please try again.",
            ) from e
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="An error occurred. Please try again.",
        ) from e


async def get_current_user_with_details(db: DBSessionDep, token: Annotated[str, Depends(oauth2_scheme)]):
    """Get current user with role and group_id for RBAC"""
    user = await get_current_user(db, token)
    return {
        "id": user.id,
        "email": user.email,
        "role": user.role,
        "group_id": user.group_id,
        "is_active": user.is_active,
        "user": user
    }


def require_roles(*roles: UserRole | str):
    async def _role_dep(user = Depends(get_current_user)):
        allowed = {r.value if hasattr(r, "value") else r for r in roles}
        if allowed and user.role not in allowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role")
        return user
    return _role_dep


def require_role(required_role: str):
    """Require specific role (Admin or Member)"""
    async def _role_dep(user_details = Depends(get_current_user_with_details)):
        if user_details["role"] != required_role:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, 
                detail=f"Access denied. Required role: {required_role}"
            )
        return user_details["user"]
    return _role_dep


def require_group_access():
    """Require group access - Admin bypasses, Members must match group_id"""
    async def _group_dep(user_details = Depends(get_current_user_with_details)):
        # Admin always has access
        if user_details["role"] == "Admin":
            return user_details["user"]
        
        # For Members, we need to check group_id in the request
        # This will be implemented in the specific endpoints
        return user_details["user"]
    return _group_dep


def require_admin():
    """Require Admin (or the higher SuperAdmin) role."""
    async def _admin_dep(user = Depends(get_current_user)):
        if user.role not in ("Admin", "SuperAdmin"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied. Admin role required"
            )
        return user
    return _admin_dep


async def get_outlook_connect_user_id(
    request: Request,
    db: DBSessionDep,
    token_header: Annotated[str | None, Depends(oauth2_scheme_optional)] = None,
):
    """For Outlook connect: user id from ?token= JWT or Authorization header. The user must be active."""
    query_token = request.query_params.get("token")
    token = query_token or token_header
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token required")
    payload = decode_token(token)
    if not payload or "sub" not in payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    try:
        user_id = int(payload["sub"])
    except (ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    user = await UserRepository(db).get_by_id(user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Inactive user")
    return user_id
