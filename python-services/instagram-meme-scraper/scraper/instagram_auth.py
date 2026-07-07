"""
Authenticated session for the throwaway account used for deep-history backfill.

Logging in is itself a bot signal to Instagram if done repeatedly, so this module
is built around doing it as rarely as possible: the session's cookies are cached
to disk and reused across process runs, and a cached session is validated (cheap
request) before falling back to a fresh login.
"""

import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

import requests

from . import config

logger = logging.getLogger("meme_scraper.instagram_auth")

SESSION_CACHE_DIR = Path(__file__).resolve().parent.parent / "session_cache"

LOGIN_PAGE_URL = "https://www.instagram.com/accounts/login/"
LOGIN_AJAX_URL = "https://www.instagram.com/api/v1/web/accounts/login/ajax/"
IG_APP_ID = "936619743392459"


class LoginError(Exception):
    pass


class ChallengeRequiredError(LoginError):
    """Instagram wants extra verification (checkpoint / 2FA) we can't complete headlessly."""


def _cache_path(username: str) -> Path:
    return SESSION_CACHE_DIR / f"{username}.json"


def _save_session(username: str, session: requests.Session) -> None:
    SESSION_CACHE_DIR.mkdir(exist_ok=True)
    cookies = requests.utils.dict_from_cookiejar(session.cookies)
    with open(_cache_path(username), "w") as f:
        json.dump(cookies, f)


def _load_session(username: str, proxy_url: Optional[str]) -> Optional[requests.Session]:
    path = _cache_path(username)
    if not path.exists():
        return None

    with open(path) as f:
        cookies = json.load(f)

    session = requests.Session()
    session.headers.update({"User-Agent": config.USER_AGENT})
    if proxy_url:
        session.proxies.update({"http": proxy_url, "https": proxy_url})
    requests.utils.add_dict_to_cookiejar(session.cookies, cookies)
    return session


def _is_session_valid(session: requests.Session) -> bool:
    try:
        resp = session.get(
            "https://www.instagram.com/api/v1/web/accounts/login/ajax/",
            headers={"X-IG-App-ID": IG_APP_ID},
            timeout=15,
        )
        # Logged-in sessions get a JSON response here (usually 400 "please wait" or
        # similar to a GET, but crucially NOT a redirect to the login page); a dead
        # session gets bounced to login. Checking for valid JSON + status <500 is a
        # cheap enough proxy for "cookies still work" without hitting a real endpoint.
        return resp.status_code < 500 and "csrf" not in resp.url.lower()
    except requests.RequestException:
        return False


def _login(username: str, password: str, proxy_url: Optional[str]) -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": config.USER_AGENT, "Accept-Language": "en-US,en;q=0.9"})
    if proxy_url:
        session.proxies.update({"http": proxy_url, "https": proxy_url})

    logger.info("Logging in to Instagram as %s (fresh session)", username)
    resp = session.get(LOGIN_PAGE_URL, timeout=15)
    csrf_token = session.cookies.get("csrftoken")
    if not csrf_token:
        raise LoginError("Could not obtain csrftoken from login page")

    enc_password = f"#PWD_INSTAGRAM_BROWSER:0:{int(time.time())}:{password}"
    payload = {
        "username": username,
        "enc_password": enc_password,
        "queryParams": "{}",
        "optIntoOneTap": "false",
    }
    headers = {
        "X-CSRFToken": csrf_token,
        "X-IG-App-ID": IG_APP_ID,
        "X-Requested-With": "XMLHttpRequest",
        "Referer": LOGIN_PAGE_URL,
        "Origin": "https://www.instagram.com",
    }

    resp = session.post(LOGIN_AJAX_URL, data=payload, headers=headers, timeout=15)

    try:
        data = resp.json()
    except ValueError:
        raise LoginError(f"Non-JSON login response (status {resp.status_code})")

    if data.get("authenticated"):
        logger.info("Login succeeded for %s", username)
        _save_session(username, session)
        return session

    if data.get("checkpoint_required") or data.get("checkpoint_url"):
        raise ChallengeRequiredError(
            "Instagram requires a checkpoint/security challenge for this login -- "
            "cannot complete headlessly. Log in manually once from a browser to clear it."
        )
    if data.get("two_factor_required"):
        raise ChallengeRequiredError("Account requires 2FA, cannot complete headlessly.")

    raise LoginError(f"Login failed: {data}")


def get_authenticated_session(proxy_url: Optional[str] = None) -> requests.Session:
    username = os.getenv("IG_LOGIN_USERNAME")
    password = os.getenv("IG_LOGIN_PASSWORD")
    if not username or not password:
        raise LoginError("IG_LOGIN_USERNAME / IG_LOGIN_PASSWORD not set")

    cached = _load_session(username, proxy_url)
    if cached and _is_session_valid(cached):
        logger.info("Reusing cached Instagram session for %s", username)
        return cached

    logger.info("No valid cached session for %s, logging in fresh", username)
    return _login(username, password, proxy_url)
