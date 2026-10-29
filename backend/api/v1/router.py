from fastapi import APIRouter

from backend.api.v1.endpoints import transactions, auth, reports, suppliers, users, projects, financial_aggregation, \
    admin_invites, email_verification, recurring_transactions, oauth, member_invites, budgets, audit_logs, categories, \
    unforeseen_transactions, quote_structure, quote_projects, tasks, quote_subjects, outlook, group_transaction_drafts, \
    notifications, building_reception, assistant, collection_tasks

api_router = APIRouter()
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(oauth.router, prefix="/auth", tags=["auth"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(projects.router, prefix="/projects", tags=["projects"])
api_router.include_router(transactions.router, prefix="/transactions", tags=["transactions"])
api_router.include_router(recurring_transactions.router, prefix="/recurring-transactions", tags=["recurring-transactions"])
api_router.include_router(reports.router, prefix="/reports", tags=["reports"])
api_router.include_router(suppliers.router, prefix="/suppliers", tags=["suppliers"])
api_router.include_router(financial_aggregation.router, prefix="/financial-aggregation", tags=["financial-aggregation"])
api_router.include_router(admin_invites.router, prefix="/admin-invites", tags=["admin-invites"])
api_router.include_router(member_invites.router, prefix="/member-invites", tags=["member-invites"])
api_router.include_router(email_verification.router, prefix="/email-verification", tags=["email-verification"])
api_router.include_router(budgets.router, prefix="/budgets", tags=["budgets"])
api_router.include_router(audit_logs.router, prefix="/audit-logs", tags=["audit-logs"])
api_router.include_router(categories.router, prefix="/categories", tags=["categories"])
api_router.include_router(unforeseen_transactions.router, prefix="/unforeseen-transactions", tags=["unforeseen-transactions"])
api_router.include_router(quote_structure.router, prefix="/quote-structure", tags=["quote-structure"])
api_router.include_router(quote_subjects.router, prefix="/quote-subjects", tags=["quote-subjects"])
api_router.include_router(quote_projects.router, prefix="/quote-projects", tags=["quote-projects"])
api_router.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
api_router.include_router(collection_tasks.router, prefix="/collection-tasks", tags=["collection-tasks"])
api_router.include_router(outlook.router, prefix="/outlook", tags=["outlook"])
api_router.include_router(group_transaction_drafts.router, prefix="/group-transaction-drafts", tags=["group-transaction-drafts"])
api_router.include_router(notifications.router, prefix="/notifications", tags=["notifications"])
api_router.include_router(building_reception.router, prefix="/building-reception", tags=["building-reception"])
api_router.include_router(assistant.router, prefix="/assistant", tags=["assistant"])

# IAM - Identity & Access Management
from backend.iam.endpoints import router as iam_router
api_router.include_router(iam_router, prefix="/iam", tags=["iam"])

# CEMS - Company Equipment & Inventory Management System
from backend.api.v1.cems_router import cems_router
api_router.include_router(cems_router)