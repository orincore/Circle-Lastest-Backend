"""
The scraper's scheduler. Deliberately conservative: at most one source is scraped
at a time (no concurrency), with large jittered delays between sources and small
jittered delays between individual asset downloads within a post. The entire
point of this design is to never look like a burst of automated traffic --
throughput is intentionally sacrificed for not getting the proxy pool blocked.
"""

import logging
import random
import time

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from . import config, db, instagram_client, s3_uploader
from .proxy_pool import ProxyPool

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("meme_scraper.main_loop")


class _RetryableDownloadError(Exception):
    pass


@retry(
    reraise=True,
    retry=retry_if_exception_type(_RetryableDownloadError),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
)
def _download_asset(url: str, proxies: dict | None) -> bytes:
    try:
        resp = requests.get(
            url,
            proxies=proxies,
            headers={"User-Agent": config.USER_AGENT},
            timeout=30,
        )
    except (requests.ConnectionError, requests.Timeout) as e:
        raise _RetryableDownloadError(str(e)) from e

    if resp.status_code != 200:
        raise _RetryableDownloadError(f"HTTP {resp.status_code}")

    return resp.content


def _process_source(conn, pool: ProxyPool, source: dict) -> None:
    username = source["instagram_username"]
    proxy_url = pool.get_proxy()
    proxies = pool.as_requests_dict(proxy_url)

    logger.info("Scraping source '%s' (proxy=%s)", username, "yes" if proxy_url else "none")

    result = instagram_client.fetch_recent_posts(username, proxy_url=proxy_url)

    if not result.ok:
        if proxy_url and result.reason in ("rate_limited", "blocked", "network_error"):
            pool.report_failure(proxy_url)

        logger.warning("Fetch failed for '%s': %s (status=%s)", username, result.reason, result.status_code)
        db.mark_source_failure(conn, source["id"], source["consecutive_failures"], result.reason)
        return

    if proxy_url:
        pool.report_success(proxy_url)

    new_count = 0
    for post in result.posts:
        if db.shortcode_exists(conn, post.shortcode):
            # Feed is newest-first: once we hit a known post, everything after is
            # already ingested, so there's no point checking further.
            break

        uploaded_assets = []
        for asset in post.assets:
            time.sleep(random.uniform(config.ASSET_DELAY_MIN_SECONDS, config.ASSET_DELAY_MAX_SECONDS))
            try:
                data = _download_asset(asset.url, proxies)
                uploaded = s3_uploader.upload_asset(username, post.shortcode, asset.asset_type, asset.position, data)
                uploaded["asset_type"] = asset.asset_type
                uploaded["position"] = asset.position
                uploaded["width"] = asset.width
                uploaded["height"] = asset.height
                uploaded["duration_seconds"] = asset.duration_seconds
                uploaded_assets.append(uploaded)
            except Exception as e:
                logger.warning(
                    "Failed to download/upload asset (post=%s, type=%s, pos=%s): %s",
                    post.shortcode,
                    asset.asset_type,
                    asset.position,
                    e,
                )

        if not uploaded_assets:
            logger.warning("Skipping post %s: no assets could be downloaded", post.shortcode)
            continue

        meme_id = db.insert_meme(conn, source["id"], post, uploaded_assets)
        if meme_id:
            new_count += 1

    db.mark_source_success(conn, source["id"])
    logger.info("Finished '%s': %d new meme(s) ingested", username, new_count)


def run_once(pool: ProxyPool) -> bool:
    """Runs a single scheduler tick. Returns True if a source was processed."""
    conn = db.get_conn()
    try:
        source = db.fetch_due_source(conn)
        if not source:
            return False

        _process_source(conn, pool, source)
        return True
    finally:
        conn.close()


def main() -> None:
    pool = ProxyPool(proxies=config.PROXIES)
    if not pool.has_proxies():
        logger.warning(
            "No proxies configured (MEME_SCRAPER_PROXIES is empty) -- scraping directly "
            "from this server's IP. Fine for local testing, not recommended in production."
        )

    logger.info("Meme scraper starting (tick=%ds)", config.TICK_SECONDS)

    while True:
        try:
            did_work = run_once(pool)
        except Exception:
            logger.exception("Unhandled error during scraper tick")
            did_work = False

        if did_work:
            delay = random.uniform(config.SOURCE_DELAY_MIN_SECONDS, config.SOURCE_DELAY_MAX_SECONDS)
        else:
            delay = config.TICK_SECONDS

        time.sleep(delay)


if __name__ == "__main__":
    main()
