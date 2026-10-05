import logging
import boto3
from botocore.config import Config
from backend.core.config import settings
from uuid import uuid4
from typing import BinaryIO

logger = logging.getLogger(__name__)


class S3Service:
    def __init__(self) -> None:
        # Basic validation so שנדע מיד אם חסר קונפיגורציה
        if not settings.AWS_S3_BUCKET:
            raise ValueError(
                "AWS_S3_BUCKET is not configured. Please set AWS_S3_BUCKET in your environment/.env file."
            )

        session = boto3.session.Session(
            aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
            aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
            region_name=settings.AWS_REGION,
        )
        self._s3 = session.client(
            "s3",
            config=Config(s3={"addressing_style": "virtual"}),
            
        )
        self._bucket = settings.AWS_S3_BUCKET

    def _build_key(self, prefix: str, filename: str) -> str:
        filename = filename or ""
        ext = ""
        if "." in filename:
            ext = "." + filename.split(".")[-1]
        return f"{prefix.rstrip('/')}/{uuid4().hex}{ext}"

    def upload_file(self, *, prefix: str, file_obj: BinaryIO, filename: str | None = None, content_type: str | None = None) -> str:
        key = self._build_key(prefix, filename or "")
        extra_args = {}
        if content_type:
            extra_args["ContentType"] = content_type

        # self._s3.upload_fileobj(
        #     Fileobj=file_obj,
        #     Bucket=self._bucket,
        #     Key=key,
        #     ExtraArgs=extra_args or None,
        # )
        try:
             self._s3.upload_fileobj(
            Fileobj=file_obj,
            Bucket=self._bucket,
            Key=key,
            ExtraArgs=extra_args or None,
        )

        except Exception as e:
            logger.error("העלאת קובץ ל-S3 נכשלה: %s", e, exc_info=True)
            raise

        return key

    def generate_presigned_url(
        self,
        file_key: str,
        expires_in: int | None = None,
        response_content_disposition: str | None = None,
    ) -> str:
        """Return a short-lived signed URL for a stored object.

        Bucket objects are private, so the plain URL kept in the DB is not
        fetchable by a browser. Callers sign it at read time instead, which keeps
        links time-limited rather than permanently public. Signing is a local
        computation (no network call).

        When ``response_content_disposition`` is given, the signed URL carries it
        as a response-header override (e.g. to force a download under the
        original filename rather than the opaque S3 key).

        Falls back to the input URL when the key can't be derived (legacy local
        paths) or when signing fails, so a signing problem degrades one link
        instead of failing the whole response.
        """
        key = file_key
        if not key:
            return file_key

        ttl = expires_in if expires_in is not None else settings.AWS_S3_PRESIGNED_URL_TTL_SECONDS
        params = {"Bucket": self._bucket, "Key": key}
        
        if response_content_disposition:
            params["ResponseContentDisposition"] = response_content_disposition
        try:
            return self._s3.generate_presigned_url(
                ClientMethod="get_object",
                Params=params,
                ExpiresIn=ttl,
            )
        except Exception as e:
            logger.error("יצירת קישור חתום ל-S3 נכשלה (key=%s): %s", key, e, exc_info=True)
            return file_key

    def delete_file(self, file_key: str) -> None:
        """Delete a file from S3 given its URL"""
        key = file_key
        if not key:
            # In this case, we can't delete from S3, so we'll just skip
            return

        try:
            self._s3.delete_object(Bucket=self._bucket, Key=key)
        except Exception as e:
            logger.error("מחיקת קובץ מ-S3 נכשלה (key=%s): %s", key, e, exc_info=True)

    def get_file_content(self, file_key: str) -> bytes | None:
        if not file_key:
            return None

        try:
            response = self._s3.get_object(
            Bucket=self._bucket,
            Key=file_key,
            )
            return response["Body"].read()

        except Exception as e:
            logger.error(
            "הורדת קובץ מ-S3 נכשלה (key=%s): %s",
            file_key,
            e,
            exc_info=True,
            )
            return None

def copy_file(self, *, source_key: str, dest_prefix: str) -> str:
    if not source_key:
        raise ValueError("source_key is required")

    dest_key = self._build_key(dest_prefix, source_key)

    try:
        self._s3.copy_object(
            Bucket=self._bucket,
            Key=dest_key,
            CopySource={
                "Bucket": self._bucket,
                "Key": source_key,
            },
        )

    except Exception as e:
        logger.error(
            "העתקת קובץ ב-S3 נכשלה (source_key=%s, dest_key=%s): %s",
            source_key,
            dest_key,
            e,
            exc_info=True,
        )
        raise

    return dest_key
    # def copy_file(self, *, source_url: str, dest_prefix: str) -> str:
    #     """Server-side copy of an existing S3 object to a new key under dest_prefix. Returns new URL."""
    #     src_key = self._url_to_key(source_url)
    #     if not src_key:
    #         raise ValueError(f"Cannot extract S3 key from URL: {source_url}")
    #     dest_key = self._build_key(dest_prefix, src_key)
    #     self._s3.copy_object(
    #         Bucket=self._bucket,
    #         Key=dest_key,
    #         CopySource={"Bucket": self._bucket, "Key": src_key},
    #     )
    #     if self._base_url:
    #         return f"{self._base_url}/{dest_key}"
    #     return f"https://{self._bucket}.s3.{settings.AWS_REGION}.amazonaws.com/{dest_key}"



