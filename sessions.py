import asyncio
import json
import logging
import re
from pathlib import Path

import config

log = logging.getLogger(__name__)

_sessions_lock = asyncio.Lock()


def _session_log_path(session_id: str) -> Path:
    safe = re.sub(r'[^a-zA-Z0-9_\-.]', '_', session_id)
    return config.get_logs_dir() / (safe + ".jsonl")


def _append_session_log(session_id: str, entry: dict) -> None:
    if not session_id:
        return
    config.get_logs_dir().mkdir(parents=True, exist_ok=True)
    with open(_session_log_path(session_id), "a") as f:
        f.write(json.dumps(entry) + "\n")


def _load_sessions() -> dict:
    path = config.get_sessions_file()
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            log.warning("Failed to parse sessions file", exc_info=True)
            return {}
    return {}


def _save_sessions(data: dict) -> None:
    path = config.get_sessions_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))
