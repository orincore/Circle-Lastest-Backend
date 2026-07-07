import os
from dotenv import load_dotenv

load_dotenv()


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


DATABASE_URL = os.getenv("DATABASE_URL", "")

AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
AWS_S3_BUCKET = os.getenv("AWS_S3_BUCKET", "")
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID", "")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY", "")

# Comma-separated list of proxy URLs, e.g. "http://user:pass@host:port,http://..."
PROXIES = [p.strip() for p in os.getenv("MEME_SCRAPER_PROXIES", "").split(",") if p.strip()]

TICK_SECONDS = _int_env("MEME_SCRAPER_TICK_SECONDS", 60)
SOURCE_DELAY_MIN_SECONDS = _int_env("MEME_SCRAPER_SOURCE_DELAY_MIN_SECONDS", 45)
SOURCE_DELAY_MAX_SECONDS = _int_env("MEME_SCRAPER_SOURCE_DELAY_MAX_SECONDS", 180)
ASSET_DELAY_MIN_SECONDS = _int_env("MEME_SCRAPER_ASSET_DELAY_MIN_SECONDS", 2)
ASSET_DELAY_MAX_SECONDS = _int_env("MEME_SCRAPER_ASSET_DELAY_MAX_SECONDS", 6)
POSTS_PER_RUN = _int_env("MEME_SCRAPER_POSTS_PER_RUN", 24)
MAX_CONSECUTIVE_FAILURES = _int_env("MEME_SCRAPER_MAX_CONSECUTIVE_FAILURES", 5)

S3_PREFIX = "Circle/memes"

# A single, realistic, fixed User-Agent -- kept constant across a run rather than
# randomized per-request, since a stable fingerprint reads less like a bot than one
# that changes on every call.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
