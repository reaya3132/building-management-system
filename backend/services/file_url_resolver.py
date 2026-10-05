"""Resolve a stored file path to a URL the browser can actually fetch.

Files are stored either in a private S3 bucket (an ``http(s)`` URL) or on local
disk (a relative path served under ``/uploads/``). S3 objects are private, so
the stored URL is signed at read time into a short-lived link. This is the
single source of truth shared by task attachments and CEMS documents, so the
signing/fallback behaviour cannot drift between features.
"""
from functools import lru_cache

from backend.core.config import settings
from backend.services.s3_service import S3Service


@lru_cache(maxsize=1)
def get_s3_service() -> S3Service:
    """Return a cached S3 client wrapper (building a boto3 client is expensive)."""
    return S3Service()


def _content_disposition(filename: str) -> str:
    """Build a Content-Disposition that forces a download under the original
    filename, stripping characters that could break the header."""
    safe = (filename or "file").replace('"', "").replace("\r", "").replace("\n", "")
    return f'attachment; filename="{safe}"'


def resolve_stored_file_url(
    stored_path: str | None, *, download_filename: str | None = None
) -> str:
    """Resolve a stored file path to a browser-fetchable URL."""
    path = stored_path or ""

    if not path:
        return ""

    # Absolute local path
    if path.startswith("/"):
        return path

    # S3 key
    if not settings.AWS_S3_BUCKET:
        return f"/uploads/{path}"

    if download_filename:
        return get_s3_service().generate_presigned_url(
            path,
            response_content_disposition=_content_disposition(download_filename),
        )

    return get_s3_service().generate_presigned_url(path)
