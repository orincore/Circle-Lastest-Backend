"""
Standalone local viewer for scraped memes -- NOT part of the pm2-managed scraper
service (app.py/main_loop.py). Run manually (`python viewer.py`) whenever you want
to browse what's been ingested so far. Queries Postgres live on every request and
links directly to the real S3 URLs (this runs as a normal local web page, not a
sandboxed artifact, so the browser loads images/video straight from
media.orincore.com with no size limit and no embedding needed).
"""

import os

from dotenv import load_dotenv
from flask import Flask, jsonify, request

load_dotenv()

from scraper import db  # noqa: E402

app = Flask(__name__)

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Meme Import — Contact Sheet</title>
<style>
:root {
  --bg: #eef0ee;
  --bg-tint: #e4e7e2;
  --card: #ffffff;
  --ink: #18170f;
  --ink-soft: #55523f;
  --line: #d3d6cd;
  --accent: #f3cc00;
  --accent-ink: #1c1a0a;
  --video: #d8432b;
  --shadow: 0 1px 2px rgba(24,23,15,0.06), 0 8px 24px -12px rgba(24,23,15,0.18);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141310; --bg-tint: #1a1815; --card: #1e1c17; --ink: #f1eee6;
    --ink-soft: #b8b39f; --line: #38352c; --accent: #f3cc00; --accent-ink: #1c1a0a;
    --video: #ff7a5c; --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 12px 32px -14px rgba(0,0,0,0.6);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); font-family: Georgia, serif; }
body { padding: 0 0 4rem; }
.label { font-family: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif; text-transform: uppercase; letter-spacing: 0.04em; }
header.top { position: sticky; top: 0; z-index: 10; background: var(--bg); border-bottom: 1px solid var(--line); padding: 1.4rem 1.5rem 1.1rem; }
.top-inner { max-width: 1180px; margin: 0 auto; display: flex; align-items: baseline; justify-content: space-between; gap: 1.5rem; flex-wrap: wrap; }
h1.label { font-size: clamp(1.6rem, 3vw, 2.3rem); margin: 0; line-height: 1; }
h1.label .count { font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; color: var(--accent-ink); background: var(--accent); padding: 0.12em 0.4em; margin-right: 0.5rem; box-shadow: var(--shadow); }
.subtitle { font-family: ui-monospace, monospace; font-size: 0.8rem; color: var(--ink-soft); }
.filters { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.chip { font-family: Impact, Haettenschweiler, sans-serif; text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.85rem; padding: 0.35em 0.75em; background: var(--ink); color: var(--bg); border: 1px solid var(--ink); cursor: pointer; }
.chip[data-active="true"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
main { max-width: 1180px; margin: 2rem auto 0; padding: 0 1.5rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 1.4rem; }
.card { background: var(--card); box-shadow: var(--shadow); cursor: pointer; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line); }
.card .frame { position: relative; aspect-ratio: 4/5; background: var(--bg-tint); overflow: hidden; }
.card .frame img { width: 100%; height: 100%; object-fit: cover; display: block; }
.badge { position: absolute; top: 0.55rem; left: 0.55rem; font-family: Impact, sans-serif; text-transform: uppercase; font-size: 0.72rem; padding: 0.2em 0.55em; background: var(--ink); color: var(--bg); }
.badge.video { background: var(--video); color: #fff; }
.badge.carousel { background: var(--accent); color: var(--accent-ink); }
.meta { padding: 0.7rem 0.8rem 0.85rem; display: flex; flex-direction: column; gap: 0.35rem; }
.source-tag { align-self: flex-start; font-family: Impact, sans-serif; text-transform: uppercase; font-size: 0.78rem; background: var(--ink); color: var(--bg); padding: 0.15em 0.5em; }
.caption { font-size: 0.9rem; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 1.35em; }
.stats { display: flex; justify-content: space-between; font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; font-size: 0.76rem; color: var(--ink-soft); }
.lightbox { position: fixed; inset: 0; background: rgba(10,10,8,0.86); display: none; align-items: center; justify-content: center; padding: 2rem; z-index: 100; }
.lightbox[data-open="true"] { display: flex; }
.lightbox-inner { background: var(--card); max-width: 680px; width: 100%; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow); }
.lightbox-inner img, .lightbox-inner video { width: 100%; display: block; background: #000; max-height: 70vh; }
.lightbox-body { padding: 1.1rem 1.3rem 1.4rem; }
.lightbox-body .caption { -webkit-line-clamp: initial; min-height: 0; white-space: pre-wrap; font-size: 0.98rem; }
.close-btn { font-family: ui-monospace, monospace; position: absolute; top: 1.1rem; right: 1.3rem; background: var(--accent); color: var(--accent-ink); border: none; width: 2.1rem; height: 2.1rem; font-size: 1.1rem; cursor: pointer; z-index: 1; }
.load-more { display: block; margin: 2rem auto 0; font-family: Impact, sans-serif; text-transform: uppercase; letter-spacing: 0.04em; background: var(--ink); color: var(--bg); border: none; padding: 0.7em 1.6em; cursor: pointer; }
.status { text-align: center; padding: 3rem 1rem; color: var(--ink-soft); font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<header class="top">
  <div class="top-inner">
    <div>
      <h1 class="label"><span class="count" id="total-count">0</span>Memes Imported</h1>
      <div class="subtitle" id="subtitle">loading…</div>
    </div>
    <div class="filters" id="filters"></div>
  </div>
</header>
<main>
  <div class="grid" id="grid"></div>
  <div class="status" id="status"></div>
  <button class="load-more" id="load-more" style="display:none">Load more</button>
</main>
<div class="lightbox" id="lightbox"><div class="lightbox-inner" id="lightbox-inner"></div></div>
<script>
let offset = 0;
const LIMIT = 60;
let activeSource = 'all';
let allLoaded = [];
let sourceCounts = {};
let totalCount = 0;

function fmtLikes(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1000000) return (n/1000000).toFixed(1).replace(/\\.0$/, '') + 'M';
  if (n >= 1000) return (n/1000).toFixed(1).replace(/\\.0$/, '') + 'K';
  return String(n);
}
function timeAgo(iso) {
  if (!iso) return '—';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return days + ' days ago';
  const months = Math.floor(days/30);
  if (months < 12) return months + (months===1?' month ago':' months ago');
  const years = Math.floor(months/12);
  return years + (years===1?' year ago':' years ago');
}
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}
function primaryImage(m) {
  const img = m.assets.find(a => a.asset_type === 'image') || m.assets.find(a => a.asset_type === 'thumbnail');
  return img ? img.s3_url : null;
}
function badgeFor(m) {
  if (m.post_type === 'video') return '<span class="badge video">▶ Video</span>';
  if (m.post_type === 'carousel') return '<span class="badge carousel">' + m.assets.filter(a => a.asset_type === 'image').length + ' Photos</span>';
  return '';
}

async function fetchPage() {
  const params = new URLSearchParams({ limit: LIMIT, offset });
  if (activeSource !== 'all') params.set('source', activeSource);
  const res = await fetch('/api/memes?' + params.toString());
  return res.json();
}

function renderFilters(sources) {
  const el = document.getElementById('filters');
  const all = ['all', ...sources];
  el.innerHTML = all.map(s => {
    const label = s === 'all' ? 'All' : '@' + s;
    return `<button class="chip" data-source="${s}" data-active="${s === activeSource}">${label}</button>`;
  }).join('');
  el.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      activeSource = btn.dataset.source;
      offset = 0;
      allLoaded = [];
      document.getElementById('grid').innerHTML = '';
      renderFilters(sources);
      loadMore();
    });
  });
}

function renderCards(memes) {
  const grid = document.getElementById('grid');
  grid.insertAdjacentHTML('beforeend', memes.map(m => {
    const img = primaryImage(m);
    return `
      <div class="card" tabindex="0" data-id="${m.id}">
        <div class="frame">
          ${img ? `<img src="${img}" alt="" loading="lazy" />` : ''}
          ${badgeFor(m)}
        </div>
        <div class="meta">
          <span class="source-tag">@${m.source}</span>
          <div class="caption">${escapeHtml(m.caption) || '<em>No caption</em>'}</div>
          <div class="stats"><span>♥ ${fmtLikes(m.like_count)}</span><span>${timeAgo(m.posted_at)}</span></div>
        </div>
      </div>`;
  }).join(''));

  grid.querySelectorAll('.card').forEach(card => {
    if (card.dataset.bound) return;
    card.dataset.bound = '1';
    const id = card.dataset.id;
    const open = () => openLightbox(allLoaded.find(m => m.id === id));
    card.addEventListener('click', open);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

async function loadMore() {
  const statusEl = document.getElementById('status');
  const btn = document.getElementById('load-more');
  statusEl.textContent = 'loading…';
  btn.style.display = 'none';

  const data = await fetchPage();
  allLoaded = allLoaded.concat(data.memes);
  offset += data.memes.length;
  totalCount = data.total;
  sourceCounts = data.source_counts;

  document.getElementById('total-count').textContent = totalCount;
  document.getElementById('subtitle').textContent = Object.entries(sourceCounts).map(([s,c]) => '@' + s + ' (' + c + ')').join('   ·   ');
  renderFilters(Object.keys(sourceCounts).sort());
  renderCards(data.memes);

  if (allLoaded.length === 0) {
    statusEl.textContent = 'No memes match this filter.';
  } else if (data.memes.length < LIMIT) {
    statusEl.textContent = `Showing all ${allLoaded.length}.`;
  } else {
    statusEl.textContent = '';
    btn.style.display = 'block';
  }
}

document.getElementById('load-more').addEventListener('click', loadMore);

function openLightbox(m) {
  if (!m) return;
  const videoAsset = m.assets.find(a => a.asset_type === 'video');
  const img = primaryImage(m);
  const box = document.getElementById('lightbox');
  const inner = document.getElementById('lightbox-inner');
  let mediaHtml = '';
  if (videoAsset) {
    mediaHtml = `<video src="${videoAsset.s3_url}" controls autoplay playsinline ${img ? `poster="${img}"` : ''}></video>`;
  } else if (img) {
    mediaHtml = `<img src="${img}" alt="" />`;
  }
  inner.innerHTML = `
    <div style="position:relative">
      <button class="close-btn" id="close-btn" aria-label="Close">✕</button>
      ${mediaHtml}
    </div>
    <div class="lightbox-body">
      <span class="source-tag">@${m.source}</span>
      <div class="caption" style="margin-top:0.6rem">${escapeHtml(m.caption) || 'No caption'}</div>
      <div class="stats" style="margin-top:0.9rem">
        <span>♥ ${fmtLikes(m.like_count)} likes</span>
        <span>${m.posted_at ? new Date(m.posted_at).toLocaleDateString(undefined, {year:'numeric', month:'short', day:'numeric'}) : '—'}</span>
      </div>
    </div>`;
  box.setAttribute('data-open', 'true');
  document.getElementById('close-btn').addEventListener('click', closeLightbox);
}
function closeLightbox() {
  document.getElementById('lightbox').setAttribute('data-open', 'false');
  document.getElementById('lightbox-inner').innerHTML = '';
}
document.getElementById('lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') closeLightbox(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

loadMore();
</script>
</body>
</html>
"""


@app.route("/")
def index():
    return PAGE


@app.route("/api/memes")
def api_memes():
    limit = min(int(request.args.get("limit", 60)), 200)
    offset = int(request.args.get("offset", 0))
    source = request.args.get("source")

    conn = db.get_conn()
    with db.cursor(conn) as cur:
        cur.execute("SELECT instagram_username, id FROM meme_sources")
        source_id_by_name = {r["instagram_username"]: r["id"] for r in cur.fetchall()}

        cur.execute(
            """
            SELECT s.instagram_username, count(*) as c
            FROM memes m JOIN meme_sources s ON s.id = m.source_id
            GROUP BY s.instagram_username
            """
        )
        source_counts = {r["instagram_username"]: r["c"] for r in cur.fetchall()}

        where = ""
        params = []
        if source and source in source_id_by_name:
            where = "WHERE m.source_id = %s"
            params.append(source_id_by_name[source])

        cur.execute(f"SELECT count(*) as c FROM memes m {where}", params)
        total = cur.fetchone()["c"]

        cur.execute(
            f"""
            SELECT m.id, s.instagram_username as source, m.instagram_shortcode, m.post_type,
                   m.caption, m.like_count, m.posted_at
            FROM memes m
            JOIN meme_sources s ON s.id = m.source_id
            {where}
            ORDER BY m.posted_at DESC NULLS LAST, m.created_at DESC
            LIMIT %s OFFSET %s
            """,
            params + [limit, offset],
        )
        meme_rows = cur.fetchall()
        meme_ids = [r["id"] for r in meme_rows]

        assets_by_meme = {}
        if meme_ids:
            cur.execute(
                "SELECT meme_id, asset_type, position, s3_url, width, height FROM meme_assets WHERE meme_id = ANY(%s::uuid[]) ORDER BY position",
                ([str(mid) for mid in meme_ids],),
            )
            for r in cur.fetchall():
                assets_by_meme.setdefault(str(r["meme_id"]), []).append(
                    {
                        "asset_type": r["asset_type"],
                        "position": r["position"],
                        "s3_url": r["s3_url"],
                        "width": r["width"],
                        "height": r["height"],
                    }
                )
    conn.close()

    memes = [
        {
            "id": str(r["id"]),
            "source": r["source"],
            "shortcode": r["instagram_shortcode"],
            "post_type": r["post_type"],
            "caption": r["caption"],
            "like_count": r["like_count"],
            "posted_at": r["posted_at"].isoformat() if r["posted_at"] else None,
            "assets": assets_by_meme.get(str(r["id"]), []),
        }
        for r in meme_rows
    ]

    return jsonify({"memes": memes, "total": total, "source_counts": source_counts})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("VIEWER_PORT", "5002")), debug=False)
