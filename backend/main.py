"""
Application entry point.

Responsibilities (SRP):
  - Assemble the FastAPI application
  - Wire middleware, routers, and static file serving
  - Start the lifespan context (DB init, seed, background schedulers)

All other concerns are delegated:
  - Exception handlers  -> core.exception_handlers
  - Background jobs     -> core.schedulers
  - CORS origin checks  -> core.cors
"""

import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.openapi.utils import get_openapi
import re
import os
import asyncio
from contextlib import asynccontextmanager

from starlette.types import ASGIApp, Receive, Scope, Send

# Import all models to ensure Base.metadata is populated
from backend.models import (  # noqa: F401
    User, Project, Subproject, Transaction, AuditLog,
    Supplier, Document, Invite, EmailVerification,
    RecurringTransactionTemplate, Task, TaskAttachment, TaskMessage,
    UserNotification,
)
from backend.db import base_models  # noqa: F401

from backend.api.v1.router import api_router
from backend.core.config import settings
from backend.core.cors import is_origin_allowed
from backend.core.exception_handlers import register_exception_handlers
from backend.core.schedulers import (
    run_recurring_transactions_scheduler,
    run_contract_renewal_scheduler,
    run_task_archive_scheduler,
    run_client_visit_expiry_scheduler,
)
from backend.core.log_alert_handler import setup_whatsapp_log_handler, setup_console_log_handler
from backend.db.session import engine
from backend.db.base import Base
from backend.db.init_db import init_database


class PreflightCORSMiddleware:
    """ASGI middleware that handles CORS preflight (OPTIONS) requests.

    Must be added last so it runs first (outermost). Delegates origin
    validation to the shared ``is_origin_allowed`` function.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "")
        headers = scope.get("headers") or []
        headers_dict = {k.decode().lower(): v.decode() for k, v in headers}
        raw_origin = (headers_dict.get("origin") or "").strip()
        origin_normalized = raw_origin.rstrip("/") if raw_origin else ""
        acrm = headers_dict.get("access-control-request-method")
        acrh = headers_dict.get("access-control-request-headers", "")

        if method == "OPTIONS" and acrm:
            if not is_origin_allowed(raw_origin or origin_normalized):
                await self._send_response(send, 403, [], b"CORS origin not allowed")
                return
            allow_origin = origin_normalized or raw_origin
            if not allow_origin:
                await self._send_response(send, 400, [], b"Missing Origin")
                return
            cors_headers = [
                (b"access-control-allow-origin", allow_origin.encode("utf-8")),
                (b"access-control-allow-methods", b"GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD"),
                (b"access-control-allow-headers", (acrh or "*").encode()),
                (b"access-control-max-age", b"3600"),
                (b"access-control-allow-credentials", b"true"),
            ]
            await self._send_response(send, 204, cors_headers, b"")
            return
        await self.app(scope, receive, send)

    @staticmethod
    async def _send_response(send: Send, status: int, headers: list, body: bytes) -> None:
        await send({
            "type": "http.response.start",
            "status": status,
            "headers": headers,
        })
        await send({"type": "http.response.body", "body": body})


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup and shutdown events."""
    await init_database(engine)

    from backend.core.seed import create_super_admin
    await create_super_admin()

    # Set up logging handlers (must run before background schedulers)
    setup_console_log_handler()
    setup_whatsapp_log_handler()

    asyncio.create_task(run_recurring_transactions_scheduler())
    asyncio.create_task(run_contract_renewal_scheduler())
    asyncio.create_task(run_task_archive_scheduler())
    asyncio.create_task(run_client_visit_expiry_scheduler())

    yield


def create_app() -> FastAPI:
    tags_metadata = [
        {"name": "auth", "description": "אימות משתמשים והנפקת טוקנים"},
        {"name": "users", "description": "ניהול משתמשים והרשאות"},
        {"name": "projects", "description": "ניהול פרויקטים ותקציבים"},
        {"name": "transactions", "description": "תיעוד הכנסות/הוצאות והעלאות קבצים"},
        {"name": "reports", "description": "דוחות רווחיות והשוואה לתקציב"},
    ]

    # Validate security settings
    try:
        settings.validate_security()
    except ValueError as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.critical("Security validation failed: %s", e)
        if settings.is_production:
            raise SystemExit(f"SECURITY ERROR: {e}")

    app = FastAPI(
        title="BMS Backend",
        version="1.0.0",
        description="מערכת ניהול תקציב לבנייה (BMS) עם FastAPI",
        openapi_url="/openapi.json",
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_tags=tags_metadata,
        redirect_slashes=False,
        lifespan=lifespan,
    )

    # --- Exception handlers (delegated to dedicated module) ---
    register_exception_handlers(app)

    # --- CORS middleware ---
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"],
        allow_headers=[
            "Authorization", "Content-Type", "Accept", "Origin",
            "X-Requested-With", "Cache-Control", "Pragma",
        ],
        # X-Next-Cursor: the notification list's next page (read by the frontend).
        expose_headers=["Content-Disposition", "X-Next-Cursor"],
        max_age=3600,
    )
    app.add_middleware(PreflightCORSMiddleware)

    # --- HTTP middleware ---
    @app.middleware("http")
    async def resolve_trailing_slash(request, call_next):
        """Ensure routes defined with a trailing slash still work without one."""
        path = request.scope.get("path", "")
        if path and not path.endswith("/"):
            alt_path = f"{path}/"
            available_paths = {
                getattr(route, "path", None)
                for route in app.router.routes
                if getattr(route, "path", None)
            }
            if alt_path in available_paths:
                request.scope["path"] = alt_path
        return await call_next(request)

    @app.middleware("http")
    async def add_security_headers(request, call_next):
        """Add security headers and ensure CORS headers for allowed origins."""
        origin = request.headers.get("origin")
        response = await call_next(request)

        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

        if origin and is_origin_allowed(origin):
            origin_normalized = origin.strip().rstrip("/")
            if "Access-Control-Allow-Origin" not in response.headers:
                response.headers["Access-Control-Allow-Origin"] = origin_normalized
            if "Access-Control-Allow-Credentials" not in response.headers:
                response.headers["Access-Control-Allow-Credentials"] = "true"

        return response

    # --- OpenAPI customization ---
    def custom_openapi():
        if app.openapi_schema:
            return app.openapi_schema
        openapi_schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        openapi_schema.setdefault("components", {}).setdefault("securitySchemes", {}).update({
            "bearerAuth": {
                "type": "http",
                "scheme": "bearer",
                "bearerFormat": "JWT",
            }
        })
        openapi_schema["security"] = [{"bearerAuth": []}]
        app.openapi_schema = openapi_schema
        return app.openapi_schema

    app.openapi = custom_openapi  # type: ignore[assignment]

    # --- IAM exception handlers ---
    from backend.iam.middleware import register_iam_exception_handlers
    register_iam_exception_handlers(app)

    # --- Router ---
    app.include_router(api_router, prefix=settings.API_V1_STR)


    # --- Static files ---
    if os.path.isabs(settings.FILE_UPLOAD_DIR):
        uploads_dir = settings.FILE_UPLOAD_DIR
    else:
        backend_dir = os.path.dirname(os.path.abspath(__file__))
        uploads_dir = os.path.abspath(os.path.join(backend_dir, settings.FILE_UPLOAD_DIR))

    os.makedirs(uploads_dir, exist_ok=True)
    for subdir in ("projects", "suppliers", "avatars", "task_attachments"):
        os.makedirs(os.path.join(uploads_dir, subdir), exist_ok=True)

    try:
        app.mount("/uploads", StaticFiles(directory=uploads_dir), name="uploads")
    except Exception:
        raise

    @app.get("/health")
    async def health_check():
        return {"status": "healthy", "message": "Project Management System is running"}

    # --- Serve Frontend SPA in Production/Docker ---
    possible_static_dirs = [
        "/app/static",
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "dist"),
    ]

    static_dir = None
    for d in possible_static_dirs:
        if os.path.exists(d) and os.path.exists(os.path.join(d, "index.html")):
            static_dir = d
            break

    if static_dir:
        if os.path.exists(os.path.join(static_dir, "assets")):
            app.mount("/assets", StaticFiles(directory=os.path.join(static_dir, "assets")), name="assets")

        @app.get("/")
        async def serve_root():
            return FileResponse(os.path.join(static_dir, "index.html"))

        @app.get("/{full_path:path}")
        async def serve_frontend(full_path: str):
            file_path = os.path.join(static_dir, full_path)
            if os.path.exists(file_path) and os.path.isfile(file_path):
                return FileResponse(file_path)

            if full_path.startswith("api/") or full_path.startswith("docs") or full_path.startswith("openapi.json"):
                return JSONResponse(status_code=404, content={"detail": "Not Found"})

            return FileResponse(os.path.join(static_dir, "index.html"))

    return app


app = create_app()

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
