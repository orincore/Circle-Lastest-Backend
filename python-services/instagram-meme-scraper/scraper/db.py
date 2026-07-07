"""
Postgres access for the meme scraper -- the same database the Node backend uses
(`meme_sources`, `memes`, `meme_assets`, created by
Circle-Lastest-Backend/migrations/create_memes_tables.sql). Deliberately plain
psycopg2 rather than an ORM: this is a small, standalone Python service and the
Node backend already owns the schema via Drizzle.
"""

import logging
from contextlib import contextmanager
from typing import Optional

import psycopg2
import psycopg2.extras

from . import config

logger = logging.getLogger("meme_scraper.db")

BASE_BACKOFF_SECONDS = 30 * 60  # 30 minutes
MAX_BACKOFF_SECONDS = 24 * 60 * 60  # 24 hours


def get_conn():
    return psycopg2.connect(config.DATABASE_URL)


@contextmanager
def cursor(conn):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def fetch_due_source(conn) -> Optional[dict]:
    """Returns the single most-overdue active source that's due for a scrape, or None."""
    with cursor(conn) as cur:
        cur.execute(
            """
            SELECT *
            FROM meme_sources
            WHERE is_active = true
              AND status != 'disabled'
              AND (backoff_until IS NULL OR backoff_until < now())
              AND (
                    last_scraped_at IS NULL
                    OR last_scraped_at < now() - (scrape_interval_minutes || ' minutes')::interval
                  )
            ORDER BY last_scraped_at ASC NULLS FIRST
            LIMIT 1
            """
        )
        return cur.fetchone()


def shortcode_exists(conn, shortcode: str) -> bool:
    with cursor(conn) as cur:
        cur.execute("SELECT 1 FROM memes WHERE instagram_shortcode = %s LIMIT 1", (shortcode,))
        return cur.fetchone() is not None


def insert_meme(conn, source_id: str, post, assets: list) -> Optional[str]:
    """
    Inserts a meme + its assets in one transaction. Returns the new meme id, or
    None if a meme with this shortcode already exists (idempotent no-op).
    `post` is an instagram_client.MemePost; `assets` is a list of dicts with keys
    asset_type/position/s3_key/s3_url/width/height/duration_seconds/file_size_bytes.
    """
    with cursor(conn) as cur:
        cur.execute(
            """
            INSERT INTO memes (source_id, instagram_shortcode, post_type, caption, like_count, posted_at)
            VALUES (%s, %s, %s, %s, %s, to_timestamp(%s))
            ON CONFLICT (instagram_shortcode) DO NOTHING
            RETURNING id
            """,
            (source_id, post.shortcode, post.post_type, post.caption, post.like_count, post.posted_at_epoch),
        )
        row = cur.fetchone()
        if not row:
            return None

        meme_id = row["id"]

        for asset in assets:
            cur.execute(
                """
                INSERT INTO meme_assets
                    (meme_id, asset_type, position, s3_key, s3_url, width, height, duration_seconds, file_size_bytes)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    meme_id,
                    asset["asset_type"],
                    asset["position"],
                    asset["s3_key"],
                    asset["s3_url"],
                    asset.get("width"),
                    asset.get("height"),
                    asset.get("duration_seconds"),
                    asset.get("file_size_bytes"),
                ),
            )

        return meme_id


def mark_source_success(conn, source_id: str) -> None:
    with cursor(conn) as cur:
        cur.execute(
            """
            UPDATE meme_sources
            SET last_scraped_at = now(),
                last_success_at = now(),
                consecutive_failures = 0,
                status = 'active',
                backoff_until = NULL,
                updated_at = now()
            WHERE id = %s
            """,
            (source_id,),
        )


def mark_source_failure(conn, source_id: str, current_consecutive_failures: int, reason: str) -> None:
    new_failures = current_consecutive_failures + 1
    disabled = new_failures >= config.MAX_CONSECUTIVE_FAILURES
    backoff_seconds = min(BASE_BACKOFF_SECONDS * (2 ** (new_failures - 1)), MAX_BACKOFF_SECONDS)

    if disabled:
        logger.warning(
            "Source %s hit %d consecutive failures (last reason: %s) -- disabling, needs admin review",
            source_id,
            new_failures,
            reason,
        )

    with cursor(conn) as cur:
        cur.execute(
            """
            UPDATE meme_sources
            SET last_scraped_at = now(),
                consecutive_failures = %s,
                status = %s,
                backoff_until = CASE WHEN %s THEN NULL ELSE now() + (%s || ' seconds')::interval END,
                updated_at = now()
            WHERE id = %s
            """,
            (new_failures, "disabled" if disabled else "backoff", disabled, backoff_seconds, source_id),
        )
