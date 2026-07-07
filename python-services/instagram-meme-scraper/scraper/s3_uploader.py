"""
Uploads scraped meme assets to the same S3 bucket the Node backend's S3Service
uses (Circle-Lastest-Backend/src/services/s3Service.ts), under a dedicated
`Circle/memes/` prefix. Public URL convention matches S3Service: the bucket name
*is* the custom domain, so a public object's URL is `https://{bucket}/{key}`.
"""

import io
import logging

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from . import config

logger = logging.getLogger("meme_scraper.s3_uploader")

_CONTENT_TYPES = {
    "image": "image/jpeg",
    "video": "video/mp4",
    "thumbnail": "image/jpeg",
}

_EXTENSIONS = {
    "image": "jpg",
    "video": "mp4",
    "thumbnail": "jpg",
}

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            region_name=config.AWS_REGION,
            aws_access_key_id=config.AWS_ACCESS_KEY_ID,
            aws_secret_access_key=config.AWS_SECRET_ACCESS_KEY,
        )
    return _client


def upload_asset(username: str, shortcode: str, asset_type: str, position: int, data: bytes) -> dict:
    """Uploads one asset's bytes to S3. Returns {s3_key, s3_url, file_size_bytes}."""
    ext = _EXTENSIONS.get(asset_type, "bin")
    key = f"{config.S3_PREFIX}/{username}/{shortcode}/{position}-{asset_type}.{ext}"
    content_type = _CONTENT_TYPES.get(asset_type, "application/octet-stream")

    client = _get_client()
    try:
        client.upload_fileobj(
            io.BytesIO(data),
            config.AWS_S3_BUCKET,
            key,
            ExtraArgs={"ContentType": content_type},
        )
    except (BotoCoreError, ClientError) as e:
        logger.error("S3 upload failed for %s: %s", key, e)
        raise

    return {
        "s3_key": key,
        "s3_url": f"https://{config.AWS_S3_BUCKET}/{key}",
        "file_size_bytes": len(data),
    }
