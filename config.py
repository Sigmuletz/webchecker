import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

SCRIPTS_DIR   = Path(os.getenv("SCRIPTS_DIR",   "./scripts")).resolve()
STATUS_DIR    = Path(os.getenv("STATUS_DIR",    "./status")).resolve()
LIBRARIES_DIR = Path(os.getenv("LIBRARIES_DIR", "./libraries")).resolve()
SESSIONS_FILE = Path(os.getenv("SESSIONS_FILE", "./sessions.json")).resolve()
LOGS_DIR      = Path(os.getenv("LOGS_DIR",      "./logs")).resolve()
AUTH_TOKEN    = os.getenv("AUTH_TOKEN", "changeme")
HOST          = os.getenv("HOST", "127.0.0.1")
PORT          = int(os.getenv("PORT", "8000"))
SSL_CERT      = os.getenv("SSL_CERT", "")
SSL_KEY       = os.getenv("SSL_KEY", "")
