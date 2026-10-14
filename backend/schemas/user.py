from datetime import datetime
from pydantic import BaseModel, EmailStr, Field, ConfigDict, model_validator
from typing import Literal, Optional, Any


class UserBase(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=255)
    role: Literal["Admin", "Member"] = "Member"
    is_active: bool = True
    group_id: int | None = None


class UserCreate(UserBase):
    password: str = Field(min_length=8, max_length=128)


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=255)
    role: Literal["Admin", "Member"] | None = None
    is_active: bool | None = None
    group_id: int | None = None
    password: str | None = Field(default=None, min_length=8, max_length=128)
    calendar_color: str | None = Field(default=None, max_length=7)
    calendar_date_display: Literal["gregorian", "hebrew", "both"] | None = None
    show_jewish_holidays: bool | None = None
    show_islamic_holidays: bool | None = None


class UserOut(UserBase):
    id: int
    created_at: datetime
    calendar_color: str | None = None
    avatar_url: str | None = None
    phone: str | None = None
    calendar_date_display: str = "gregorian"
    show_jewish_holidays: bool = True
    show_islamic_holidays: bool = False

    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode="before")
    @classmethod
    def _pull_calendar_from_preferences(cls, data: Any) -> Any:
        """Read calendar fields from the nested user_preferences row when present."""
        if not hasattr(data, "preferences"):
            return data
        pref = getattr(data, "preferences", None)
        if pref is None:
            return data
        # Inject preference values so the fields above are populated
        data.__dict__.setdefault("calendar_color", pref.calendar_color)
        data.__dict__.setdefault("calendar_date_display", pref.calendar_date_display)
        data.__dict__.setdefault("show_jewish_holidays", pref.show_jewish_holidays)
        data.__dict__.setdefault("show_islamic_holidays", pref.show_islamic_holidays)
        # Override with actual preference values
        data.__dict__["calendar_color"] = pref.calendar_color
        data.__dict__["calendar_date_display"] = pref.calendar_date_display
        data.__dict__["show_jewish_holidays"] = pref.show_jewish_holidays
        data.__dict__["show_islamic_holidays"] = pref.show_islamic_holidays
        return data


class ArchivedUserOut(UserOut):
    """User moved to the archive - full details plus archive metadata."""
    archived_at: datetime
    last_login: datetime | None = None
    oauth_provider: str | None = None


class RestoreSkippedItem(BaseModel):
    """A grant from the archive snapshot that could not be restored."""
    kind: Literal["project_role", "resource_policy", "cems_warehouse"]
    item: Any
    reason: Literal["project_not_found", "resource_not_found", "warehouse_not_found", "already_exists"]


class UserRestoreReport(BaseModel):
    snapshot_found: bool
    restored_project_roles: list[dict[str, Any]]
    restored_resource_policies: list[dict[str, Any]]
    restored_cems_role: str | None = None
    restored_cems_warehouse_id: str | None = None
    skipped: list[RestoreSkippedItem]


class UserRestoreOut(BaseModel):
    """Result of restoring a user from the archive."""
    user: UserOut
    report: UserRestoreReport


class ProfileUpdate(BaseModel):
    """Schema for user updating their own profile (name, email, phone)."""
    full_name: str | None = Field(default=None, min_length=1, max_length=255)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=50)


class CalendarSettingsUpdate(BaseModel):
    """Only calendar-related settings; any user can update their own via PATCH /users/me."""
    calendar_color: str | None = Field(default=None, max_length=7)
    calendar_date_display: Literal["gregorian", "hebrew", "both"] | None = None
    show_jewish_holidays: bool | None = None
    show_islamic_holidays: bool | None = None


class AdminRegister(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=8, max_length=128)


class MemberRegister(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    group_id: int


class AdminCreateUser(BaseModel):
    """Schema for admin creating a new user - temporary password will be generated and sent via email"""
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=255)
    role: Literal["Admin", "Member"] = "Member"