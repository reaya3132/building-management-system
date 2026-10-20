from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
import logging
import re
from backend.services.s3_service import S3Service

from backend.core.deps import DBSessionDep, require_roles, get_current_user
from backend.iam.decorators import require_permission
from backend.repositories.transaction_repository import TransactionRepository
from backend.repositories.project_repository import ProjectRepository
from backend.repositories.contract_period_repository import ContractPeriodRepository
from backend.repositories.supplier_repository import SupplierRepository
from backend.repositories.document_repository import DocumentRepository
from backend.repositories.category_repository import CategoryRepository
from backend.repositories.user_repository import UserRepository
from backend.models.document import Document
from backend.models.group_transaction_draft import GroupTransactionDraft, GroupTransactionDraftDocument
from backend.schemas.transaction import TransactionCreate, TransactionOut, TransactionUpdate, TransactionBatchCreate
from backend.services.transaction_service import TransactionService, normalize_payment_method_for_db
from backend.services.audit_service import AuditService
from backend.services.mappers import transaction_to_dict, transaction_to_dict_with_user
from backend.services.validators import resolve_category
from backend.services.s3_service import S3Service
from backend.core.config import settings

logger = logging.getLogger(__name__)


class _AttachFromDraftBody(BaseModel):
    draft_document_id: int

router = APIRouter()


def sanitize_filename(name: str) -> str:
    """Sanitize supplier name to be used as directory name"""
    sanitized = re.sub(r'[<>:"/\\|?*]', '_', name)
    sanitized = sanitized.strip(' .')
    sanitized = re.sub(r'[\s_]+', '_', sanitized)
    if not sanitized:
        sanitized = 'supplier'
    return sanitized


@router.get("/project/{project_id}", response_model=list[TransactionOut])
async def list_transactions(project_id: int, db: DBSessionDep, user=Depends(get_current_user)):
    transactions_data = await TransactionService(db).list_by_project(project_id, user_id=user.id)
    from backend.schemas.transaction import TransactionOut
    result = []
    for tx_dict in transactions_data:
        try:
            tx_dict.setdefault('category', None)
            result.append(TransactionOut.model_validate(tx_dict))
        except Exception:
            logger.warning("דילוג על עסקה לא תקינה בפרויקט %s", project_id, exc_info=True)
            continue

    return result


@router.post("/", response_model=TransactionOut)
async def create_transaction(db: DBSessionDep, data: TransactionCreate, user=Depends(require_permission("write", "transaction", project_id_param=None))):
    """Create transaction - accessible to all authenticated users"""
    project = await ProjectRepository(db).get_by_id(data.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Validate supplier if provided
    # Supplier is required only for Expense transactions (not for Income or fund transactions or when category is "אחר")

    # Check if category is "Other"
    is_other_category = False
    category_obj = None
    if data.category_id:
        category_obj = await CategoryRepository(db).get(data.category_id)
        if category_obj and category_obj.name == 'אחר':
            is_other_category = True

    if data.supplier_id is not None:
        supplier = await SupplierRepository(db).get(data.supplier_id)
        if not supplier:
            raise HTTPException(status_code=404, detail="Supplier not found")
    elif data.type == 'Expense' and not data.from_fund and not is_other_category:
        # Supplier is required for Expense transactions (not for Income, fund transactions, or when category is "אחר")
        raise HTTPException(status_code=400, detail="Supplier is required for expense transactions")

    # Add user_id to transaction data
    transaction_data = data.model_dump()
    transaction_data['created_by_user_id'] = user.id

    # Handle fund operations if from_fund is True.
    # commit=False: the balance change is only flushed here and commits together with
    # the transaction creation below - if creation fails, the fund change rolls back too.
    if data.from_fund:
        from backend.services.fund_service import FundService
        fund_service = FundService(db)
        fund = await fund_service.get_fund_by_project(data.project_id)
        if not fund:
            raise HTTPException(status_code=400, detail="Fund not found for this project")

        if data.type == 'Expense':
            # Deduct from fund for expenses
            await fund_service.deduct_from_fund(data.project_id, data.amount, commit=False)
        elif data.type == 'Income':
            # Add to fund for income
            await fund_service.add_to_fund(data.project_id, data.amount, commit=False)

    logger.info("יוצר עסקה עם created_by_user_id=%s, user=%s", user.id, user.full_name)

    try:
        transaction = await TransactionService(db).create(**transaction_data)
    except ValueError as e:
        logger.exception("שגיאה ביצירת עסקה")
        raise HTTPException(status_code=400, detail=str(e))

    logger.info("עסקה נוצרה עם id=%s, created_by_user_id=%s", transaction.id, transaction.created_by_user_id)

    # Get project name for audit log
    project_name = project.name if project else f"פרויקט {transaction.project_id}"

    # Log create action with full details
    await AuditService(db).log_transaction_action(
        user_id=user.id,
        action='create',
        transaction_id=transaction.id,
        details={
            'project_id': transaction.project_id,
            'project_name': project_name,
            'type': transaction.type,
            'amount': str(transaction.amount),
            'category': transaction.category.name if transaction.category else None,
            'description': transaction.description,
            'tx_date': str(transaction.tx_date),
            'supplier_id': transaction.supplier_id,
            'payment_method': transaction.payment_method,
            'notes': transaction.notes,
            'is_exceptional': transaction.is_exceptional,
            'is_generated': transaction.is_generated,
            'file_path': transaction.file_path
        }
    )

    # Convert to dict with user info using shared mapper
    user_repo = UserRepository(db)
    result = await transaction_to_dict_with_user(transaction, user_repo)
    # Fallback category name from the validated category_obj if relationship not loaded
    if result.get('category') is None and category_obj:
        result['category'] = category_obj.name

    return result


@router.post("/batch", response_model=list[TransactionOut])
async def create_transactions_batch(
    db: DBSessionDep,
    data: TransactionBatchCreate,
    user=Depends(require_permission("write", "transaction", project_id_param=None)),
):
    """Atomically create multiple transactions for a single project (all-or-nothing)."""
    rows = data.transactions

    project_ids = {r.project_id for r in rows}
    if len(project_ids) != 1:
        raise HTTPException(status_code=400, detail="כל העסקאות בבאץ' חייבות להיות לאותו פרויקט")
    project_id = next(iter(project_ids))

    project = await ProjectRepository(db).get_by_id(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Per-row pre-service checks (supplier existence/active, supplier-required-for-Expense rule)
    supplier_repo = SupplierRepository(db)
    category_repo = CategoryRepository(db)
    category_cache: dict[int, object] = {}
    supplier_cache: dict[int, object] = {}

    fund_delta_expense = 0.0
    fund_delta_income = 0.0

    for idx, row in enumerate(rows, start=1):
        is_other_category = False
        if row.category_id is not None:
            cat = category_cache.get(row.category_id)
            if cat is None:
                cat = await category_repo.get(row.category_id)
                category_cache[row.category_id] = cat
            if cat and cat.name == 'אחר':
                is_other_category = True

        if row.supplier_id is not None:
            sup = supplier_cache.get(row.supplier_id)
            if sup is None:
                sup = await supplier_repo.get(row.supplier_id)
                supplier_cache[row.supplier_id] = sup
            if not sup:
                raise HTTPException(status_code=404, detail=f"שורה {idx}: ספק לא נמצא")
        elif row.type == 'Expense' and not row.from_fund and not is_other_category:
            raise HTTPException(status_code=400, detail=f"שורה {idx}: ספק הוא שדה חובה לעסקאות הוצאה")

        if row.from_fund:
            if row.type == 'Expense':
                fund_delta_expense += float(row.amount)
            elif row.type == 'Income':
                fund_delta_income += float(row.amount)

    # One fund call per direction (not N). commit=False keeps the balance change in the
    # same DB transaction as the batch insert - all-or-nothing including the fund.
    if fund_delta_expense > 0 or fund_delta_income > 0:
        from backend.services.fund_service import FundService
        fund_service = FundService(db)
        fund = await fund_service.get_fund_by_project(project_id)
        if not fund:
            raise HTTPException(status_code=400, detail="Fund not found for this project")
        if fund_delta_expense > 0:
            await fund_service.deduct_from_fund(project_id, fund_delta_expense, commit=False)
        if fund_delta_income > 0:
            await fund_service.add_to_fund(project_id, fund_delta_income, commit=False)

    rows_data = []
    for row in rows:
        row_dict = row.model_dump()
        row_dict['created_by_user_id'] = user.id
        rows_data.append(row_dict)

    try:
        transactions = await TransactionService(db).create_batch(rows_data)
    except ValueError as e:
        logger.exception("שגיאה ביצירת באץ' עסקאות")
        raise HTTPException(status_code=400, detail=str(e))

    project_name = project.name
    audit = AuditService(db)
    for tx in transactions:
        await audit.log_transaction_action(
            user_id=user.id,
            action='create',
            transaction_id=tx.id,
            details={
                'project_id': tx.project_id,
                'project_name': project_name,
                'type': tx.type,
                'amount': str(tx.amount),
                'category': tx.category.name if tx.category else None,
                'description': tx.description,
                'tx_date': str(tx.tx_date),
                'supplier_id': tx.supplier_id,
                'payment_method': tx.payment_method,
                'notes': tx.notes,
                'is_exceptional': tx.is_exceptional,
                'is_generated': tx.is_generated,
                'file_path': tx.file_path,
            }
        )

    user_repo = UserRepository(db)
    results = []
    for tx in transactions:
        item = await transaction_to_dict_with_user(tx, user_repo)
        if item.get('category') is None and tx.category_id is not None:
            cat = category_cache.get(tx.category_id)
            if cat:
                item['category'] = cat.name
        results.append(item)

    return results


@router.get("/{tx_id}/documents", response_model=list[dict])
async def get_transaction_documents(tx_id: int, db: DBSessionDep, user=Depends(get_current_user)):
    """Get all documents for a transaction - accessible to all authenticated users"""
    tx = await TransactionRepository(db).get_by_id(tx_id)
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")

    # Get all documents for this transaction
    docs = await DocumentRepository(db).get_by_transaction_id(tx_id)

    result = []
    s3_service = S3Service()
    for doc in docs:
        file_path = doc.file_path

        if file_path and not file_path.startswith(("http://", "https://", "/")):
            file_path = s3_service.generate_presigned_url(file_path)

        result.append({
        "id": doc.id,
        "transaction_id": doc.transaction_id or doc.entity_id,
        "file_path": file_path,
        "description": doc.description,
        "uploaded_at": doc.uploaded_at.isoformat() if doc.uploaded_at else None
        })

    # Fallback: include legacy file_path stored directly on the transaction row
    if tx.file_path:
        existing_paths = {d["file_path"] for d in result}
        if tx.file_path not in existing_paths:
            result.append({
                "id": None,
                "transaction_id": tx_id,
                "file_path": (
    s3_service.generate_presigned_url(tx.file_path)
    if tx.file_path
    and not tx.file_path.startswith(("http://", "https://", "/"))
    else tx.file_path
),
                "description": None,
                "uploaded_at": None
            })

    return result


@router.put("/{tx_id}/documents/{doc_id}", response_model=dict)
async def update_transaction_document(
        tx_id: int,
        doc_id: int,
        db: DBSessionDep,
        description: str | None = Form(None),
        user=Depends(require_permission("update", "transaction", resource_id_param="tx_id"))
):
    """Update document description for a transaction"""
    # Verify transaction exists
    tx = await TransactionRepository(db).get_by_id(tx_id)
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")

    # Get the document
    doc_repo = DocumentRepository(db)
    doc = await doc_repo.get_by_id(doc_id)

    if not doc or doc.entity_type != "transaction" or doc.entity_id != tx_id:
        raise HTTPException(status_code=404, detail="Document not found")

    # Update description
    doc.description = description.strip() if description and description.strip() else None
    await doc_repo.update(doc)

    return {
        "id": doc.id,
        "transaction_id": doc.entity_id,
        "description": doc.description,
        "file_path": doc.file_path
    }


@router.post("/{tx_id}/supplier-document", response_model=dict)
async def upload_supplier_document(
    tx_id: int,
    db: DBSessionDep,
    file: UploadFile = File(...),
    user=Depends(require_permission("read", "transaction", resource_id_param="tx_id")),
):
    """Upload document for transaction - allowed to anyone who can read transactions"""
    tx = await TransactionRepository(db).get_by_id(tx_id)
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")

    # Prepare upload prefix
    s3 = S3Service()
    prefix = "transactions"
    supplier_id = tx.supplier_id

    # Upload to S3 (using thread to avoid blocking loop)
    # Reset file pointer
    await file.seek(0)

    import asyncio

    file_url = await asyncio.to_thread(
        s3.upload_file,
        prefix=prefix,
        file_obj=file.file,
        filename=file.filename or "supplier-document",
        content_type=file.content_type,
    )

    # Create document linked to transaction
    doc = Document(
        transaction_id=tx_id,
        entity_type="transaction",
        entity_id=tx_id,
        supplier_id=supplier_id,
        file_path=file_url,
        source_table="transaction",
        source_id=tx_id,
    )
    await DocumentRepository(db).create(doc)

    return {
        "id": doc.id,
        "file_path": file_url,
        "supplier_id": supplier_id,
        "transaction_id": tx_id,
        "description": doc.description
    }


@router.post("/{tx_id}/documents/from-draft", response_model=dict)
async def attach_draft_document_to_transaction(
    tx_id: int,
    body: _AttachFromDraftBody,
    db: DBSessionDep,
    user=Depends(require_permission("read", "transaction", resource_id_param="tx_id")),
):
    """Attach a draft document to a transaction by S3 server-side copy (no re-upload)."""
    import asyncio
    from sqlalchemy import select

    tx = await TransactionRepository(db).get_by_id(tx_id)
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")

    result = await db.execute(
        select(GroupTransactionDraftDocument).where(
            GroupTransactionDraftDocument.id == body.draft_document_id
        )
    )
    draft_doc = result.scalar_one_or_none()
    if not draft_doc:
        raise HTTPException(status_code=404, detail="Draft document not found")

    draft_result = await db.execute(
        select(GroupTransactionDraft).where(GroupTransactionDraft.id == draft_doc.draft_id)
    )
    draft = draft_result.scalar_one_or_none()
    if not draft or draft.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not allowed to use this draft document")

    s3 = S3Service()
    file_url = await asyncio.to_thread(
        s3.copy_file,
        source_url=draft_doc.file_path,
        dest_prefix="transactions",
    )

    doc = Document(
        transaction_id=tx_id,
        entity_type="transaction",
        entity_id=tx_id,
        supplier_id=tx.supplier_id,
        file_path=file_url,
        source_table="transaction",
        source_id=tx_id,
    )
    await DocumentRepository(db).create(doc)

    return {
        "id": doc.id,
        "file_path": file_url,
        "supplier_id": tx.supplier_id,
        "transaction_id": tx_id,
        "description": doc.description,
    }


@router.delete("/{tx_id}/documents/{doc_id}")
async def delete_transaction_document(
        tx_id: int,
        doc_id: int,
        db: DBSessionDep,
        user=Depends(require_permission("update", "transaction", resource_id_param="tx_id"))
):
    """Delete document from transaction"""
    import asyncio

    # Verify transaction exists
    tx = await TransactionRepository(db).get_by_id(tx_id)
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")

    # Get the document
    doc_repo = DocumentRepository(db)
    doc = await doc_repo.get_by_id(doc_id)

    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if doc.entity_type != "transaction" or doc.entity_id != tx_id:
        raise HTTPException(status_code=400, detail="Document does not belong to this transaction")

    # Store file path before deletion
    file_path = doc.file_path

    # Delete the document from database
    await doc_repo.delete(doc)

    # Try to delete from S3 if file_path is an S3 URL
    if file_path and (
            "s3" in file_path.lower() or "amazonaws.com" in file_path or settings.AWS_S3_BASE_URL and file_path.startswith(
        settings.AWS_S3_BASE_URL)):
        try:
            s3 = S3Service()
            # Run in thread to avoid blocking
            await asyncio.to_thread(s3.delete_file, file_path)
        except Exception as e:
            # Log but don't fail - document is already deleted from DB
            logger.warning("מחיקת קובץ מ-S3 נכשלה", exc_info=True)

    return {"ok": True}


@router.put("/{tx_id}", response_model=TransactionOut)
async def update_transaction(tx_id: int, db: DBSessionDep, data: TransactionUpdate, user=Depends(require_permission("update", "transaction", resource_id_param="tx_id"))):
    """Update transaction - accessible to all authenticated users"""
    repo = TransactionRepository(db)
    tx = await repo.get_by_id(tx_id)
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")

    # Get project name for audit log
    project = await ProjectRepository(db).get_by_id(tx.project_id)
    project_name = project.name if project else f"פרויקט {tx.project_id}"

    # Store old values for audit log
    old_values = {
        'amount': str(tx.amount),
        'type': tx.type,
        'category': tx.category.name if tx.category else '',
        'description': tx.description or '',
        'tx_date': str(tx.tx_date),
        'supplier_id': tx.supplier_id,
        'payment_method': tx.payment_method or '',
        'notes': tx.notes or '',
        'is_exceptional': tx.is_exceptional,
        'is_generated': tx.is_generated,
        'file_path': tx.file_path or ''
    }

    # Validate supplier if provided
    if data.supplier_id is not None:
        supplier = await SupplierRepository(db).get(data.supplier_id)
        if not supplier:
            raise HTTPException(status_code=404, detail="Supplier not found")

    update_data = data.model_dump(exclude_unset=True)

    # Validate category if being updated (unless it's a cash register transaction)
    from_fund = update_data.get('from_fund', tx.from_fund if hasattr(tx, 'from_fund') else False)
    category_name = update_data.pop('category', None) if 'category' in update_data else None
    category_id = update_data.get('category_id') if 'category_id' in update_data else None

    if category_id is not None or category_name is not None:
        resolved_category = await resolve_category(
            db,
            category_id=category_id,
            category_name=category_name,
            allow_missing=from_fund
        )
        update_data['category_id'] = resolved_category.id if resolved_category else None
    elif ('category' in data.model_dump(exclude_unset=False) and category_name is None) or (
            'category_id' in update_data and update_data['category_id'] is None):
        if not from_fund:
            raise HTTPException(
                status_code=400,
                detail="לא ניתן להסיר קטגוריה מעסקה רגילה. רק עסקאות קופה יכולות להיות ללא קטגוריה."
            )

    # Normalize payment_method: API may send enum name (e.g. CENTRALIZED_YEAR_END); DB expects enum value (Hebrew)
    if "payment_method" in update_data:
        update_data["payment_method"] = normalize_payment_method_for_db(update_data.get("payment_method"))

    for k, v in update_data.items():
        setattr(tx, k, v)

    updated_tx = await repo.update(tx)

    # Log update action with full details
    new_values = {k: str(v) for k, v in update_data.items()}
    await AuditService(db).log_transaction_action(
        user_id=user.id,
        action='update',
        transaction_id=tx_id,
        details={
            'project_id': tx.project_id,
            'project_name': project_name,
            'old_values': old_values,
            'new_values': new_values
        }
    )

    # Convert to dict with user info using shared mapper
    user_repo = UserRepository(db)
    return await transaction_to_dict_with_user(updated_tx, user_repo)


@router.post("/{tx_id}/rollback")
async def rollback_transaction(tx_id: int, db: DBSessionDep, user=Depends(get_current_user)):
    """Rollback a transaction created by the current user with no documents (e.g. group transaction when document upload failed)."""
    repo = TransactionRepository(db)
    tx = await repo.get_by_id(tx_id)
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if tx.created_by_user_id is None:
        raise HTTPException(
            status_code=403,
            detail="Cannot rollback: transaction has no creator (legacy). Use delete instead."
        )
    if tx.created_by_user_id != user.id:
        raise HTTPException(status_code=403, detail="Only the creator can rollback this transaction")
    if len(tx.documents) > 0:
        raise HTTPException(
            status_code=400,
            detail="Cannot rollback transaction that has documents; use delete instead"
        )
    # Reverse the fund effect in both directions; commit=False so the balance change
    # commits atomically with the delete below.
    if getattr(tx, "from_fund", False):
        from backend.services.fund_service import FundService
        fund_service = FundService(db)
        if tx.type == "Expense":
            await fund_service.refund_to_fund(tx.project_id, tx.amount, commit=False)
        elif tx.type == "Income":
            await fund_service.deduct_from_fund(tx.project_id, tx.amount, commit=False)
    await repo.delete(tx)
    return {"ok": True}


@router.delete("/{tx_id}")
async def delete_transaction(tx_id: int, db: DBSessionDep, user=Depends(require_permission("delete", "transaction", resource_id_param="tx_id"))):
    """Delete transaction - Admin only"""
    repo = TransactionRepository(db)
    tx = await repo.get_by_id(tx_id)
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")

    # Restore fund balance if this was a fund transaction (both directions);
    # commit=False so the balance change commits atomically with the delete below.
    if getattr(tx, 'from_fund', False):
        from backend.services.fund_service import FundService
        fund_service = FundService(db)
        if tx.type == 'Expense':
            await fund_service.refund_to_fund(tx.project_id, tx.amount, commit=False)
        elif tx.type == 'Income':
            await fund_service.deduct_from_fund(tx.project_id, tx.amount, commit=False)

    # Get project name for audit log
    project = await ProjectRepository(db).get_by_id(tx.project_id)
    project_name = project.name if project else f"פרויקט {tx.project_id}"

    # Store transaction details for audit log
    tx_details = {
        'project_id': tx.project_id,
        'project_name': project_name,
        'type': tx.type,
        'amount': str(tx.amount),
        'category': tx.category.name if tx.category else None,
        'description': tx.description,
        'tx_date': str(tx.tx_date),
        'supplier_id': tx.supplier_id,
        'payment_method': tx.payment_method,
        'notes': tx.notes,
        'is_exceptional': tx.is_exceptional,
        'is_generated': tx.is_generated,
        'file_path': tx.file_path
    }

    await repo.delete(tx)

    # Log delete action
    await AuditService(db).log_transaction_action(
        user_id=user.id,
        action='delete',
        transaction_id=tx_id,
        details=tx_details
    )

    return {"ok": True}
