import asyncio
import json
import logging
import re
from pathlib import Path

from config import LOGS_DIR, SESSIONS_FILE

log = logging.getLogger(__name__)

_sessions_lock = asyncio.Lock()


def _session_log_path(session_id: str) -> Path:
    safe = re.sub(r'[^a-zA-Z0-9_\-.]', '_', session_id)
    return LOGS_DIR / (safe + ".jsonl")


def _append_session_log(session_id: str, entry: dict) -> None:
    if not session_id:
        return
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    with open(_session_log_path(session_id), "a") as f:
        f.write(json.dumps(entry) + "\n")


def _load_sessions() -> dict:
    if SESSIONS_FILE.exists():
        try:
            return json.loads(SESSIONS_FILE.read_text())
        except Exception:
            log.warning("Failed to parse sessions file", exc_info=True)
            return {}
    return {}


def _save_sessions(data: dict) -> None:
    SESSIONS_FILE.write_text(json.dumps(data, indent=2))
