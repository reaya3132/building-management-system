# [PermSys-Core-003]
"""Enumerations for the IAM subsystem.

These enums define the vocabulary of the permissions system: actions users
can perform, types of resources that can be protected, and role tiers at
both the global and project levels.

Extension point: To add a new action or resource type, add a member to the
relevant enum below. No other files need to change -- the engine matches
on string values.
"""

from __future__ import annotations

from enum import Enum


class Action(str, Enum):
    """Actions a subject can perform on a resource.

    Four canonical actions covering all operations:
    - READ:   view / list / export / download
    - WRITE:  create / add new items / invite
    - UPDATE: modify existing items
    - DELETE: delete / manage / approve / archive
    """

    READ = "read"
    WRITE = "write"
    UPDATE = "update"
    DELETE = "delete"


class ResourceType(str, Enum):
    """Types of resources protected by IAM.

    Adding a new resource type here is sufficient -- the engine resolves
    permissions by matching this string value against stored policies.
    """

    PROJECT = "project"
    TRANSACTION = "transaction"
    BUDGET = "budget"
    REPORT = "report"
    USER = "user"
    SUPPLIER = "supplier"
    TASK = "task"
    # Collection (גבייה) tasks. Deliberately separate from TASK and absent from
    # every project-role policy: access is granted only by global role or by an
    # explicit per-user grant, never derived from project permissions.
    COLLECTION_TASK = "collection_task"
    CATEGORY = "category"
    AUDIT_LOG = "audit_log"
    CONTRACT = "contract"
    QUOTE = "quote"
    MEMBER_INVITE = "member_invite"
    ADMIN_INVITE = "admin_invite"
    NOTIFICATION = "notification"
    DASHBOARD = "dashboard"
    BUILDING_RECEPTION = "building_reception"
    # Structural management of buildings and their projects (create / edit /
    # delete). Kept separate from BUILDING_RECEPTION so day-to-day desk work
    # (apartments, tenants, keys, deliveries) can stay open to desk operators
    # while only admins may add or remove whole buildings.
    BUILDING = "building"
    CEMS_WAREHOUSE = "cems_warehouse"
    CEMS_CONSUMABLE = "cems_consumable"
    CEMS_FIXED_ASSET = "cems_fixed_asset"
    CEMS_TRANSFER = "cems_transfer"
    CEMS_WAREHOUSE_RETURN = "cems_warehouse_return"
    CEMS_RETIREMENT = "cems_retirement"
    CEMS_DOCUMENT = "cems_document"
    CEMS_REPORT = "cems_report"


class GlobalRole(str, Enum):
    """System-wide roles that apply across all projects.

    These map directly to the existing ``UserRole`` enum in models/user.py
    and extend it with a SuperAdmin tier that is seeded at startup.
    """

    SUPER_ADMIN = "SuperAdmin"
    ADMIN = "Admin"
    MEMBER = "Member"


class ProjectRole(str, Enum):
    """Project-scoped roles assigned per project.

    A user can hold different project roles across different projects.
    """

    MANAGER = "ProjectManager"
    CONTRIBUTOR = "ProjectContributor"
    VIEWER = "ProjectViewer"
