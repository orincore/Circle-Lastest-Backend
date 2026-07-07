"""
One-off authenticated deep-history backfill -- NOT part of the pm2-managed
main_loop.py service. Run manually:

    python -m scraper.deep_backfill sarcasmhoes memesbakchodi__ ...

For each given source (must already exist in meme_sources), logs in once
(reusing a cached session if still valid), then pages back through that
profile's full post history via the private feed endpoint, skipping any
post whose shortcode is already in the DB (so re-running this, or overlap
with the shallow scraper's own runs, can never create a duplicate) and
downloading/uploading/inserting everything genuinely new, up to a per-source
post cap.
"""

import logging
import random
import sys
import time

from . import config, db, instagram_auth, instagram_deep, s3_uploader

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
logger = logging.getLogger("meme_scraper.deep_backfill")

MAX_POSTS_PER_SOURCE = 200
PAGE_DELAY_RANGE = (3, 8)
SOURCE_DELAY_RANGE = (30, 90)
ASSET_DELAY_RANGE = (config.ASSET_DELAY_MIN_SECONDS, config.ASSET_DELAY_MAX_SECONDS)


def _download_asset(session, url: str) -> bytes:
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    return resp.content


def _get_source_row(conn, username: str):
    with db.cursor(conn) as cur:
        cur.execute("SELECT * FROM meme_sources WHERE instagram_username = %s", (username,))
        return cur.fetchone()


def backfill_one(conn, session, username: str, max_posts: int) -> int:
    source = _get_source_row(conn, username)
    if not source:
        logger.warning("Source '%s' not found in meme_sources -- skipping (add it first)", username)
        return 0

    user_id = instagram_deep.get_user_id(session, username)
    if not user_id:
        logger.warning("Could not resolve user_id for '%s' -- skipping", username)
        db.mark_source_failure(conn, source["id"], source["consecutive_failures"], "not_found")
        return 0

    new_count = 0
    scanned = 0
    max_id = None
    more_available = True

    while more_available and new_count < max_posts:
        raw = instagram_deep.fetch_feed_page_raw(session, user_id, max_id=max_id, count=12)
        if raw is None:
            logger.warning("Page fetch failed for '%s' after %d new posts -- stopping this source", username, new_count)
            break

        items = raw.get("items", [])
        if not items:
            break

        for item in items:
            post = instagram_deep._parse_item(item)
            scanned += 1
            if not post:
                continue
            if db.shortcode_exists(conn, post.shortcode):
                continue

            uploaded_assets = []
            for asset in post.assets:
                time.sleep(random.uniform(*ASSET_DELAY_RANGE))
                try:
                    data = _download_asset(session, asset.url)
                    uploaded = s3_uploader.upload_asset(username, post.shortcode, asset.asset_type, asset.position, data)
                    uploaded["asset_type"] = asset.asset_type
                    uploaded["position"] = asset.position
                    uploaded["width"] = asset.width
                    uploaded["height"] = asset.height
                    uploaded["duration_seconds"] = asset.duration_seconds
                    uploaded_assets.append(uploaded)
                except Exception as e:
                    logger.warning("Asset download/upload failed for %s: %s", post.shortcode, e)

            if not uploaded_assets:
                continue

            meme_id = db.insert_meme(conn, source["id"], post, uploaded_assets)
            if meme_id:
                new_count += 1
                if new_count >= max_posts:
                    break

        more_available = raw.get("more_available", False)
        max_id = raw.get("next_max_id")
        logger.info("'%s': scanned %d, %d new so far (more_available=%s)", username, scanned, new_count, more_available)

        if more_available and new_count < max_posts:
            time.sleep(random.uniform(*PAGE_DELAY_RANGE))

    db.mark_source_success(conn, source["id"])
    logger.info("Finished deep backfill for '%s': %d new meme(s) ingested (scanned %d posts)", username, new_count, scanned)
    return new_count


def main(usernames: list) -> None:
    session = instagram_auth.get_authenticated_session(proxy_url=None)
    conn = db.get_conn()

    total_new = 0
    for i, username in enumerate(usernames):
        try:
            total_new += backfill_one(conn, session, username, MAX_POSTS_PER_SOURCE)
        except Exception:
            logger.exception("Unhandled error backfilling '%s'", username)

        if i < len(usernames) - 1:
            time.sleep(random.uniform(*SOURCE_DELAY_RANGE))

    conn.close()
    logger.info("Deep backfill complete: %d new meme(s) total across %d source(s)", total_new, len(usernames))


if __name__ == "__main__":
    main(sys.argv[1:])
