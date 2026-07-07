"""
Rotates through a configured pool of proxies so the scraper never hammers Instagram
from a single IP. Proxies that fail repeatedly are retired for a cooldown period
instead of being retried immediately (which would just burn through requests on a
dead/blocked proxy).
"""

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger("meme_scraper.proxy_pool")

RETIRE_AFTER_CONSECUTIVE_FAILURES = 3
COOLDOWN_SECONDS = 15 * 60


@dataclass
class _ProxyState:
    url: str
    consecutive_failures: int = 0
    retired_until: float = 0.0


@dataclass
class ProxyPool:
    proxies: list = field(default_factory=list)

    def __post_init__(self):
        self._lock = threading.Lock()
        self._states = {url: _ProxyState(url=url) for url in self.proxies}
        self._rr_index = 0

    def has_proxies(self) -> bool:
        return len(self._states) > 0

    def get_proxy(self) -> Optional[str]:
        """Returns a proxy URL to use, or None if no proxies are configured/healthy."""
        if not self._states:
            return None

        with self._lock:
            now = time.time()
            healthy = [s for s in self._states.values() if s.retired_until <= now]

            if not healthy:
                # Everything is retired -- reluctantly reuse the one closest to
                # coming back rather than hard-failing the whole run.
                soonest = min(self._states.values(), key=lambda s: s.retired_until)
                logger.warning(
                    "All %d proxies are in cooldown; reusing %s early",
                    len(self._states),
                    soonest.url,
                )
                return soonest.url

            # Plain round-robin among healthy proxies.
            self._rr_index = (self._rr_index + 1) % len(healthy)
            return healthy[self._rr_index].url

    def report_success(self, proxy_url: str) -> None:
        with self._lock:
            state = self._states.get(proxy_url)
            if state:
                state.consecutive_failures = 0

    def report_failure(self, proxy_url: str) -> None:
        with self._lock:
            state = self._states.get(proxy_url)
            if not state:
                return
            state.consecutive_failures += 1
            if state.consecutive_failures >= RETIRE_AFTER_CONSECUTIVE_FAILURES:
                state.retired_until = time.time() + COOLDOWN_SECONDS
                logger.warning(
                    "Retiring proxy %s for %ds after %d consecutive failures",
                    proxy_url,
                    COOLDOWN_SECONDS,
                    state.consecutive_failures,
                )

    def as_requests_dict(self, proxy_url: Optional[str]) -> Optional[dict]:
        if not proxy_url:
            return None
        return {"http": proxy_url, "https": proxy_url}
