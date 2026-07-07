"""
Authenticated deep-history pagination -- walks a profile's full post history via
the private-API-style feed endpoint (only reachable once logged in; the anonymous
web_profile_info endpoint used by instagram_client.py only ever returns the
newest page for a logged-in session, and doesn't paginate at all for anonymous
ones). Uses the same requests.Session the caller already has authenticated via
instagram_auth.get_authenticated_session().
"""

import logging
from typing import Optional

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from .instagram_client import FetchResult, MemeAsset, MemePost

logger = logging.getLogger("meme_scraper.instagram_deep")

WEB_PROFILE_INFO_URL = "https://www.instagram.com/api/v1/users/web_profile_info/"
IG_APP_ID = "936619743392459"


class _RetryableNetworkError(Exception):
    pass


@retry(
    reraise=True,
    retry=retry_if_exception_type(_RetryableNetworkError),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
)
def _get(session: requests.Session, url: str, params: dict, timeout: int = 20) -> requests.Response:
    try:
        return session.get(url, params=params, headers={"X-IG-App-ID": IG_APP_ID, "X-Requested-With": "XMLHttpRequest"}, timeout=timeout)
    except (requests.ConnectionError, requests.Timeout) as e:
        raise _RetryableNetworkError(str(e)) from e


def get_user_id(session: requests.Session, username: str) -> Optional[str]:
    try:
        resp = _get(session, WEB_PROFILE_INFO_URL, params={"username": username})
    except _RetryableNetworkError:
        return None

    if resp.status_code != 200:
        return None
    try:
        user = resp.json()["data"]["user"]
    except (ValueError, KeyError, TypeError):
        return None
    return user.get("id") if user else None


def _asset_from_candidate(asset_type: str, position: int, candidate: dict) -> MemeAsset:
    return MemeAsset(
        asset_type=asset_type,
        position=position,
        url=candidate.get("url"),
        width=candidate.get("width"),
        height=candidate.get("height"),
    )


def _parse_item(item: dict) -> Optional[MemePost]:
    shortcode = item.get("code")
    if not shortcode:
        return None

    media_type = item.get("media_type")  # 1=image, 2=video, 8=carousel
    caption = ((item.get("caption") or {}).get("text")) or None
    like_count = item.get("like_count")
    posted_at = item.get("taken_at")

    assets = []
    if media_type == 8 and item.get("carousel_media"):
        post_type = "carousel"
        for i, child in enumerate(item["carousel_media"]):
            if child.get("media_type") == 2 and child.get("video_versions"):
                assets.append(_asset_from_candidate("video", i, child["video_versions"][0]))
            elif child.get("image_versions2", {}).get("candidates"):
                assets.append(_asset_from_candidate("image", i, child["image_versions2"]["candidates"][0]))
    elif media_type == 2 and item.get("video_versions"):
        post_type = "video"
        assets.append(_asset_from_candidate("video", 0, item["video_versions"][0]))
        if item.get("image_versions2", {}).get("candidates"):
            assets.append(_asset_from_candidate("thumbnail", 0, item["image_versions2"]["candidates"][0]))
    elif item.get("image_versions2", {}).get("candidates"):
        post_type = "image"
        assets.append(_asset_from_candidate("image", 0, item["image_versions2"]["candidates"][0]))
    else:
        return None

    assets = [a for a in assets if a.url]
    if not assets:
        return None

    return MemePost(
        shortcode=shortcode,
        post_type=post_type,
        caption=caption,
        like_count=like_count,
        posted_at_epoch=posted_at,
        assets=assets,
    )


def fetch_feed_page(session: requests.Session, user_id: str, max_id: Optional[str] = None, count: int = 12) -> FetchResult:
    """Returns FetchResult with .posts for this page; caller checks response metadata
    via fetch_feed_page_raw if it needs next_max_id/more_available."""
    raw = fetch_feed_page_raw(session, user_id, max_id=max_id, count=count)
    if raw is None:
        return FetchResult(ok=False, reason="network_error")
    posts = [p for p in (_parse_item(item) for item in raw.get("items", [])) if p]
    return FetchResult(ok=True, posts=posts)


def fetch_feed_page_raw(session: requests.Session, user_id: str, max_id: Optional[str] = None, count: int = 12) -> Optional[dict]:
    params = {"count": count}
    if max_id:
        params["max_id"] = max_id

    try:
        resp = _get(session, f"https://www.instagram.com/api/v1/feed/user/{user_id}/", params=params)
    except _RetryableNetworkError as e:
        logger.warning("Network error fetching feed page for user_id=%s: %s", user_id, e)
        return None

    if resp.status_code != 200:
        logger.warning("Feed page fetch failed for user_id=%s: status=%s", user_id, resp.status_code)
        return None

    try:
        return resp.json()
    except ValueError:
        return None
