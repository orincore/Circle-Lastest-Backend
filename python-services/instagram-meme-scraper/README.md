# Instagram Meme Scraper

Standalone Python service that scrapes public Instagram profiles (configured as
"meme sources") and stores the media in S3 + metadata in the same Postgres
database the Node backend uses (`meme_sources`, `memes`, `meme_assets` tables).
It runs independently of the Node backend — no HTTP calls between them, just a
shared database and S3 bucket.

## Important: Terms of Service risk

Scraping Instagram is against their Terms of Use. This service is intentionally
built to minimize the practical risk of that:

- **No login.** All requests are anonymous, so no Instagram account is ever at
  risk of a ban — only the scraping IP is exposed.
- **Proxy rotation** (`MEME_SCRAPER_PROXIES`) spreads that IP-level exposure
  across a pool instead of hammering Instagram from one address.
- **One source at a time, with large jittered delays** between sources and
  between individual asset downloads — this is a low-throughput, low-profile
  design on purpose. It will not scrape hundreds of profiles quickly, and that's
  intentional.
- **Automatic backoff + circuit breaker** (see below) so a source that starts
  getting blocked doesn't keep getting hit.

You are responsible for deciding which profiles are acceptable to scrape and for
supplying your own proxies — this service does not include or recommend any
proxy provider.

## How backoff works

Each `meme_sources` row tracks `consecutive_failures`, `backoff_until`, and
`status` (`active` / `backoff` / `disabled`):

1. A 401/403/429 response, or an HTML page instead of JSON (login wall /
   checkpoint), counts as a failure.
2. `backoff_until` is set to `now() + min(30min * 2^consecutive_failures, 24h)`
   — the source is skipped until then.
3. After 5 consecutive failures, the source is set to `disabled` and needs
   manual admin review (via the Node backend's `PATCH
   /api/admin/memes/sources/:id` with `clear_backoff: true`, after checking
   whether Instagram changed something or the profile is gone/private).
4. Any successful fetch resets `consecutive_failures` to 0 and clears backoff.

## Adding a source

Sources are managed through the Node backend's admin API, not this service:

```
POST /api/admin/memes/sources
{ "instagram_username": "some_meme_page", "scrape_interval_minutes": 60 }
```

## Setup

```
./setup.sh   # creates venv, installs deps, copies .env.example -> .env
# edit .env: DATABASE_URL, AWS_*, MEME_SCRAPER_PROXIES
./start.sh
```

Or under pm2, matching the other `python-services/*`:

```
pm2 start ecosystem.config.cjs
```

## What it scrapes

Images, multi-image carousels, and video reels from each source's most recent
posts (one page per source per run — enough to catch new posts between runs).
Each Instagram post becomes one `memes` row; each file (image, video, or a
video's thumbnail) becomes one `meme_assets` row, uploaded to
`Circle/memes/{instagram_username}/{shortcode}/{position}-{asset_type}.{ext}`
in the shared S3 bucket. `instagram_shortcode` is unique, so re-scraping a
profile never creates duplicates — already-seen posts are skipped before any
download happens.
