"""
Anonymous (no-login) client for fetching a public Instagram profile's recent posts.

Deliberately does NOT log in to any Instagram account: an anonymous scrape only
risks the requesting IP getting flagged (which the proxy pool mitigates), whereas a
logged-in scrape risks that specific Instagram account being banned. Uses the same
public "web_profile_info" endpoint the instagram.com web client itself calls.

This endpoint (and its response shape) is not officially documented and can change
without notice -- that's an inherent fragility of scraping rather than something a
retry loop can paper over. Failures are surfaced as a typed FetchResult so the
caller (main_loop) can distinguish "temporarily blocked, back off" from "profile
genuinely doesn't have any posts".
"""

import logging
from dataclasses import dataclass, field
from typing import Optional

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from . import config

logger = logging.getLogger("meme_scraper.instagram_client")

WEB_PROFILE_INFO_URL = "https://www.instagram.com/api/v1/users/web_profile_info/"
# Public app id / asbd id the instagram.com web client sends on every request to
# this endpoint -- not secrets, just fixed values the public web app always sends.
IG_APP_ID = "936619743392459"
X_ASBD_ID = "198387"

_SEC_CH_UA_HEADERS = {
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
}


@dataclass
class MemeAsset:
    asset_type: str  # image | video | thumbnail
    position: int
    url: str
    width: Optional[int] = None
    height: Optional[int] = None
    duration_seconds: Optional[float] = None


@dataclass
class MemePost:
    shortcode: str
    post_type: str  # image | carousel | video
    caption: Optional[str]
    like_count: Optional[int]
    posted_at_epoch: Optional[int]
    assets: list = field(default_factory=list)


@dataclass
class FetchResult:
    ok: bool
    posts: list = field(default_factory=list)
    reason: Optional[str] = None  # rate_limited | blocked | not_found | network_error
    status_code: Optional[int] = None


class _RetryableNetworkError(Exception):
    """Raised for transient network errors worth retrying (timeouts, connection resets)."""


def _build_session(proxy_url: Optional[str]) -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": config.USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            **_SEC_CH_UA_HEADERS,
        }
    )
    if proxy_url:
        session.proxies.update({"http": proxy_url, "https": proxy_url})
    return session


@retry(
    reraise=True,
    retry=retry_if_exception_type(_RetryableNetworkError),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
)
def _get(session: requests.Session, url: str, params: dict, headers: Optional[dict] = None, timeout: int = 15) -> requests.Response:
    try:
        return session.get(url, params=params, headers=headers, timeout=timeout)
    except (requests.ConnectionError, requests.Timeout) as e:
        raise _RetryableNetworkError(str(e)) from e


def _extract_posts(user_node: dict, limit: int) -> list:
    posts = []
    edges = (
        user_node.get("edge_owner_to_timeline_media", {}).get("edges", [])
        or []
    )

    for edge in edges[:limit]:
        node = edge.get("node", {})
        shortcode = node.get("shortcode")
        if not shortcode:
            continue

        typename = node.get("__typename")
        caption_edges = node.get("edge_media_to_caption", {}).get("edges", [])
        caption = caption_edges[0]["node"]["text"] if caption_edges else None
        like_count = (
            node.get("edge_liked_by", {}).get("count")
            or node.get("edge_media_preview_like", {}).get("count")
        )
        posted_at = node.get("taken_at_timestamp")

        assets = []
        if typename == "GraphSidecar":
            post_type = "carousel"
            children = node.get("edge_sidecar_to_children", {}).get("edges", [])
            for i, child_edge in enumerate(children):
                child = child_edge.get("node", {})
                dims = child.get("dimensions") or {}
                if child.get("is_video"):
                    assets.append(
                        MemeAsset(
                            asset_type="video",
                            position=i,
                            url=child.get("video_url"),
                            width=dims.get("width"),
                            height=dims.get("height"),
                            duration_seconds=child.get("video_duration"),
                        )
                    )
                else:
                    assets.append(
                        MemeAsset(
                            asset_type="image",
                            position=i,
                            url=child.get("display_url"),
                            width=dims.get("width"),
                            height=dims.get("height"),
                        )
                    )
        elif typename == "GraphVideo":
            post_type = "video"
            dims = node.get("dimensions") or {}
            assets.append(
                MemeAsset(
                    asset_type="video",
                    position=0,
                    url=node.get("video_url"),
                    width=dims.get("width"),
                    height=dims.get("height"),
                    duration_seconds=node.get("video_duration"),
                )
            )
            if node.get("display_url"):
                assets.append(
                    MemeAsset(
                        asset_type="thumbnail",
                        position=0,
                        url=node.get("display_url"),
                        width=dims.get("width"),
                        height=dims.get("height"),
                    )
                )
        else:
            post_type = "image"
            dims = node.get("dimensions") or {}
            assets.append(
                MemeAsset(
                    asset_type="image",
                    position=0,
                    url=node.get("display_url"),
                    width=dims.get("width"),
                    height=dims.get("height"),
                )
            )

        # Drop any asset whose URL didn't resolve rather than downloading a "None".
        assets = [a for a in assets if a.url]
        if not assets:
            continue

        posts.append(
            MemePost(
                shortcode=shortcode,
                post_type=post_type,
                caption=caption,
                like_count=like_count,
                posted_at_epoch=posted_at,
                assets=assets,
            )
        )

    return posts


def _classify_failure(response: requests.Response) -> Optional[FetchResult]:
    """Returns a FetchResult if the response indicates failure, else None (success)."""
    if response.status_code == 429:
        return FetchResult(ok=False, reason="rate_limited", status_code=429)

    if response.status_code in (401, 403):
        return FetchResult(ok=False, reason="blocked", status_code=response.status_code)

    if response.status_code == 404:
        return FetchResult(ok=False, reason="not_found", status_code=404)

    if response.status_code != 200:
        return FetchResult(ok=False, reason="unknown_error", status_code=response.status_code)

    return None


def _warm_up(session: requests.Session, username: str) -> Optional[FetchResult]:
    """
    Loads the public profile's HTML page first, exactly like a real browser
    would before its JS makes the web_profile_info XHR call. This is what
    populates session cookies (csrftoken, mid, ig_did, datr) that the
    subsequent API call presents -- an API call with zero cookie history looks
    far more like a bare script than one following a normal page load.
    """
    profile_url = f"https://www.instagram.com/{username}/"
    try:
        response = session.get(
            profile_url,
            headers={"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"},
            timeout=15,
        )
    except (requests.ConnectionError, requests.Timeout) as e:
        logger.warning("Warm-up network error for %s: %s", username, e)
        return FetchResult(ok=False, reason="network_error")

    return _classify_failure(response)


def fetch_recent_posts(username: str, proxy_url: Optional[str] = None, limit: Optional[int] = None) -> FetchResult:
    limit = limit or config.POSTS_PER_RUN

    # Pin to one exit IP for this whole fetch so the warm-up's cookies and the
    # API call that uses them come from the same address.
    session = _build_session(proxy_url)

    warm_up_failure = _warm_up(session, username)
    if warm_up_failure:
        return warm_up_failure

    profile_url = f"https://www.instagram.com/{username}/"
    api_headers = {
        "X-IG-App-ID": IG_APP_ID,
        "X-ASBD-ID": X_ASBD_ID,
        "X-Requested-With": "XMLHttpRequest",
        "Referer": profile_url,
        "Origin": "https://www.instagram.com",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    }
    csrf_token = session.cookies.get("csrftoken")
    if csrf_token:
        api_headers["X-CSRFToken"] = csrf_token

    try:
        response = _get(session, WEB_PROFILE_INFO_URL, params={"username": username}, headers=api_headers)
    except _RetryableNetworkError as e:
        logger.warning("Network error fetching %s: %s", username, e)
        return FetchResult(ok=False, reason="network_error")

    failure = _classify_failure(response)
    if failure:
        return failure

    content_type = response.headers.get("Content-Type", "")
    if "application/json" not in content_type:
        # Instagram returned an HTML page instead of JSON -- almost always a login
        # wall or a challenge/checkpoint interstitial.
        return FetchResult(ok=False, reason="blocked", status_code=response.status_code)

    try:
        payload = response.json()
    except ValueError:
        return FetchResult(ok=False, reason="blocked", status_code=response.status_code)

    user_node = (payload or {}).get("data", {}).get("user")
    if not user_node:
        return FetchResult(ok=False, reason="not_found", status_code=200)

    posts = _extract_posts(user_node, limit)
    return FetchResult(ok=True, posts=posts)
