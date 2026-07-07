"""
Entry point for pm2 (see ecosystem.config.cjs). Runs the scraper's main loop on a
background thread and exposes a minimal Flask health endpoint so this service can
be monitored the same way as the other python-services.
"""

import logging
import os
import threading

from dotenv import load_dotenv
from flask import Flask, jsonify

load_dotenv()

from scraper import main_loop  # noqa: E402

logger = logging.getLogger("meme_scraper.app")

app = Flask(__name__)

_scraper_thread = threading.Thread(target=main_loop.main, name="meme-scraper-loop", daemon=True)


@app.route("/health", methods=["GET"])
def health():
    return jsonify(
        {
            "status": "healthy",
            "service": "instagram-meme-scraper",
            "scraper_loop_alive": _scraper_thread.is_alive(),
        }
    ), 200


if __name__ == "__main__":
    _scraper_thread.start()
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5001")))
