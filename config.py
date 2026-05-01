import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

SCRIPTS_DIR   = Path(os.getenv("SCRIPTS_DIR",   "./scripts")).resolve()
STATUS_DIR    = Path(os.getenv("STATUS_DIR",    "./status")).resolve()
LIBRARIES_DIR = Path(os.getenv("LIBRARIES_DIR", "./libraries")).resolve()
SESSIONS_FILE = Path(os.getenv("SESSIONS_FILE", "./config/sessions.json")).resolve()
LOGS_DIR      = Path(os.getenv("LOGS_DIR",      "./logs")).resolve()
AUTH_TOKEN    = os.getenv("AUTH_TOKEN", "changeme")
HOST          = os.getenv("HOST", "127.0.0.1")
PORT          = int(os.getenv("PORT", "8000"))
SSL_CERT      = os.getenv("SSL_CERT", "")
SSL_KEY       = os.getenv("SSL_KEY", "")
WORKSPACES_FILE    = Path(os.getenv("WORKSPACES_FILE",    "./workspaces.json")).resolve()
SMART_PARAMS_FILE  = Path(os.getenv("SMART_PARAMS_FILE",  "./config/smart_params.json")).resolve()

# Active workspace paths — mutable at runtime via switch_workspace()
_active: dict[str, Path] = {
    "scripts_dir":       SCRIPTS_DIR,
    "libraries_dir":     LIBRARIES_DIR,
    "status_dir":        STATUS_DIR,
    "logs_dir":          LOGS_DIR,
    "sessions_file":     SESSIONS_FILE,
    "smart_params_file": SMART_PARAMS_FILE,
}


def get_scripts_dir() -> Path:
    return _active["scripts_dir"]


def get_libraries_dir() -> Path:
    return _active["libraries_dir"]


def get_status_dir() -> Path:
    return _active["status_dir"]


def get_logs_dir() -> Path:
    return _active["logs_dir"]


def get_sessions_file() -> Path:
    return _active["sessions_file"]


def get_smart_params_file() -> Path:
    return _active["smart_params_file"]


def switch_workspace(
    scripts_dir: Path,
    libraries_dir: Path,
    status_dir: Path,
    logs_dir: Path,
    sessions_file: Path | None = None,
    smart_params_file: Path | None = None,
) -> None:
    _active["scripts_dir"]       = scripts_dir.resolve()
    _active["libraries_dir"]     = libraries_dir.resolve()
    _active["status_dir"]        = status_dir.resolve()
    _active["logs_dir"]          = logs_dir.resolve()
    _active["sessions_file"]     = (sessions_file or SESSIONS_FILE).resolve()
    _active["smart_params_file"] = (smart_params_file or SMART_PARAMS_FILE).resolve()
