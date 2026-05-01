import base64
import re
from pathlib import Path

from fastapi import HTTPException

import config

PARAM_RE = re.compile(r'\{\{([A-Z_0-9]+)\}\}')


def resolve_script(script_name: str) -> Path:
    scripts_dir = config.get_scripts_dir()
    path = (scripts_dir / script_name).resolve()
    if scripts_dir not in path.parents:
        raise HTTPException(status_code=400, detail="Invalid path")
    if path.suffix != ".sh":
        raise HTTPException(status_code=400, detail="Not a .sh file")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Script not found")
    return path


def resolve_library(lib_name: str) -> Path:
    libraries_dir = config.get_libraries_dir()
    path = (libraries_dir / lib_name).resolve()
    if libraries_dir not in path.parents:
        raise HTTPException(status_code=400, detail="Invalid library")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Library not found")
    return path


def _validate_lib_path(lib_name: str) -> Path:
    libraries_dir = config.get_libraries_dir()
    path = (libraries_dir / lib_name).resolve()
    if libraries_dir not in path.parents:
        raise HTTPException(status_code=400, detail="Invalid library")
    return path


def _pipe_cmd(command: str, destination: str) -> str:
    """Pipe base64-encoded command into destination, avoiding shell injection."""
    b64 = base64.b64encode(command.encode()).decode()
    return f"echo {b64} | base64 -d | {destination}"


def _flush_entry(entries: list, name: str, lines: list[str]) -> None:
    template = "\n".join(lines).rstrip()
    if ":" in name:
        colon_idx = name.index(":")
        display_name = name[:colon_idx].strip()
        destination = name[colon_idx + 1:].strip()
    else:
        display_name = name
        destination = ""
    params = sorted(set(PARAM_RE.findall(template) + PARAM_RE.findall(destination)))
    entries.append({"name": display_name, "destination": destination, "template": template, "params": params})


def parse_library_file(path: Path) -> list:
    entries: list = []
    current_name: str | None = None
    current_lines: list[str] = []

    for line in path.read_text().splitlines():
        if not line.strip():
            if current_name is not None:
                _flush_entry(entries, current_name, current_lines)
                current_name = None
                current_lines = []
            continue
        if line[0] not in " \t" and "|" in line:
            if current_name is not None:
                _flush_entry(entries, current_name, current_lines)
            idx = line.index("|")
            current_name = line[:idx].strip()
            current_lines = [line[idx + 1:]]
        else:
            current_lines.append(line)

    if current_name is not None:
        _flush_entry(entries, current_name, current_lines)

    return entries


def _resolve_entry(lib_path: Path, entry_name: str, params: dict) -> tuple[str, str, str]:
    """Returns (exec_cmd, category, destination)."""
    entries = parse_library_file(lib_path)
    entry = next((e for e in entries if e["name"] == entry_name), None)
    if not entry:
        raise ValueError(f"Entry not found: {entry_name}")
    command = entry["template"]
    destination = entry.get("destination", "")
    for key, value in params.items():
        command = command.replace(f"{{{{{key}}}}}", value)
        destination = destination.replace(f"{{{{{key}}}}}", value)
    remaining = PARAM_RE.findall(command) + PARAM_RE.findall(destination)
    if remaining:
        raise ValueError(f"Unresolved params: {remaining}")
    category = lib_path.stem.replace("_library", "").replace("_", " ").upper()
    exec_cmd = _pipe_cmd(command, destination) if destination else command
    return exec_cmd, category, destination
