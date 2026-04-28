import asyncio
import json
import os
import pty
import re
import select as _select
import signal
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse

load_dotenv()

SCRIPTS_DIR   = Path(os.getenv("SCRIPTS_DIR",   "./scripts")).resolve()
STATUS_DIR    = Path(os.getenv("STATUS_DIR",    "./status")).resolve()
LIBRARIES_DIR = Path(os.getenv("LIBRARIES_DIR", "./libraries")).resolve()
SESSIONS_FILE = Path(os.getenv("SESSIONS_FILE", "./sessions.json")).resolve()
LOGS_DIR      = Path(os.getenv("LOGS_DIR",      "./logs")).resolve()
AUTH_TOKEN    = os.getenv("AUTH_TOKEN", "changeme")
HOST          = os.getenv("HOST", "127.0.0.1")
PORT          = int(os.getenv("PORT", "8000"))

app = FastAPI()

PARAM_RE = re.compile(r'\{\{([A-Z_0-9]+)\}\}')

BACKGROUND_JOBS: dict = {}
_job_counter = 0

def _next_job_id() -> str:
    global _job_counter
    _job_counter += 1
    return str(_job_counter)

async def _watch_job(job_id: str, proc, tmp_path=None):
    await proc.wait()
    BACKGROUND_JOBS.pop(job_id, None)
    if tmp_path:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


def check_token(token: str):
    if token != AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")


def resolve_script(script_name: str) -> Path:
    path = (SCRIPTS_DIR / script_name).resolve()
    if not str(path).startswith(str(SCRIPTS_DIR) + os.sep):
        raise HTTPException(status_code=400, detail="Invalid path")
    if path.suffix != ".sh":
        raise HTTPException(status_code=400, detail="Not a .sh file")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Script not found")
    return path


def parse_library_file(path: Path) -> list:
    entries = []
    current_name = None
    current_lines: list[str] = []

    def flush():
        if current_name is not None:
            template = "\n".join(current_lines).rstrip()
            params = sorted(set(PARAM_RE.findall(template)))
            entries.append({"name": current_name, "template": template, "params": params})

    for line in path.read_text().splitlines():
        if not line.strip():
            flush()
            current_name = None
            current_lines = []
            continue
        # new entry: non-whitespace start and first | separates name from command
        if line[0] not in " \t" and "|" in line:
            flush()
            idx = line.index("|")
            current_name = line[:idx].strip()
            current_lines = [line[idx + 1:]]
        else:
            current_lines.append(line)

    flush()
    return entries


def _session_log_path(session_id: str) -> Path:
    safe = re.sub(r'[^a-zA-Z0-9_\-.]', '_', session_id)
    return LOGS_DIR / (safe + ".jsonl")


def _append_session_log(session_id: str, entry: dict):
    if not session_id:
        return
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    with open(_session_log_path(session_id), "a") as f:
        f.write(json.dumps(entry) + "\n")


async def stream_proc(websocket: WebSocket, proc, session_id: str = "", run_info: dict = None):
    log_lines: list = []

    async def _stream(pipe, msg_type: str):
        async for line in pipe:
            decoded = line.decode(errors="replace")
            await websocket.send_text(json.dumps({"type": msg_type, "data": decoded}))
            if session_id:
                log_lines.append({"t": "o" if msg_type == "stdout" else "e", "d": decoded})

    await asyncio.gather(_stream(proc.stdout, "stdout"), _stream(proc.stderr, "stderr"))
    await proc.wait()
    await websocket.send_text(json.dumps({"type": "exit", "data": str(proc.returncode)}))

    if session_id and run_info is not None:
        _append_session_log(session_id, {
            **run_info,
            "ts": datetime.now(timezone.utc).isoformat(),
            "lines": log_lines,
            "code": proc.returncode,
        })


@app.get("/api/status")
def list_status(token: str = Query(...)):
    check_token(token)
    if not STATUS_DIR.exists():
        return JSONResponse([])
    return JSONResponse(sorted(f.stem for f in STATUS_DIR.iterdir() if f.suffix == ".sh" and f.is_file()))


@app.get("/api/status/run")
async def run_status(token: str = Query(...)):
    check_token(token)
    if not STATUS_DIR.exists():
        return JSONResponse({})
    scripts = [f for f in STATUS_DIR.iterdir() if f.suffix == ".sh" and f.is_file()]

    async def _run(path: Path):
        try:
            proc = await asyncio.create_subprocess_exec(
                "bash", str(path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10.0)
            return path.stem, stdout.decode(errors="replace").strip().replace("\n", " ")
        except Exception:
            return path.stem, None

    results = await asyncio.gather(*[_run(s) for s in scripts])
    return JSONResponse({name: val for name, val in results})


@app.get("/api/scripts")
def list_scripts(token: str = Query(...)):
    check_token(token)
    if not SCRIPTS_DIR.exists():
        return JSONResponse([])
    return JSONResponse(sorted(f.name for f in SCRIPTS_DIR.iterdir() if f.suffix == ".sh" and f.is_file()))


@app.get("/api/logs/{session_id}")
def get_session_log(session_id: str, token: str = Query(...)):
    check_token(token)
    path = _session_log_path(session_id)
    if not path.exists():
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        path.touch()
        return JSONResponse([])
    entries = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                entries.append(json.loads(line))
            except Exception:
                pass
    return JSONResponse(entries)


@app.get("/api/scripts/{script_name}")
def get_script_content(script_name: str, token: str = Query(...)):
    check_token(token)
    path = resolve_script(script_name)
    content = path.read_text()
    params = sorted(set(PARAM_RE.findall(content)))
    return JSONResponse({"name": script_name, "content": content, "params": params})


@app.get("/api/libraries")
def list_libraries(token: str = Query(...)):
    check_token(token)
    if not LIBRARIES_DIR.exists():
        return JSONResponse({})
    result = {}
    for lib_file in sorted(LIBRARIES_DIR.iterdir()):
        if lib_file.is_file():
            category = lib_file.stem.replace("_library", "").replace("_", " ").upper()
            result[lib_file.name] = {
                "category": category,
                "entries": parse_library_file(lib_file),
            }
    return JSONResponse(result)


@app.websocket("/ws/run/{script_name}")
async def run_script(websocket: WebSocket, script_name: str, token: str = Query(...), session_id: str = Query("")):
    if token != AUTH_TOKEN:
        await websocket.close(code=4001)
        return
    try:
        script_path = resolve_script(script_name)
    except HTTPException:
        await websocket.close(code=4004)
        return

    await websocket.accept()
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            "bash", str(script_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await stream_proc(websocket, proc, session_id, {"name": script_name, "cat": None})
    except WebSocketDisconnect:
        if proc and proc.returncode is None:
            proc.kill()
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "data": str(e)}))
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/run-interactive/{script_name}")
async def run_script_interactive(websocket: WebSocket, script_name: str, token: str = Query(...), session_id: str = Query("")):
    if token != AUTH_TOKEN:
        await websocket.close(code=4001)
        return
    try:
        script_path = resolve_script(script_name)
    except HTTPException:
        await websocket.close(code=4004)
        return

    await websocket.accept()

    master_fd = None
    child_pid = None
    active = True
    tmp_path = None

    try:
        data = json.loads(await websocket.receive_text())
        params = data.get("params", {})

        content = script_path.read_text()
        for key, value in params.items():
            content = content.replace(f"{{{{{key}}}}}", value)
        remaining = PARAM_RE.findall(content)
        if remaining:
            raise ValueError(f"Unresolved params: {remaining}")

        with tempfile.NamedTemporaryFile(mode='w', suffix='.sh', delete=False) as f:
            f.write(content)
            tmp_path = f.name
        os.chmod(tmp_path, 0o700)

        master_fd, slave_fd = pty.openpty()
        child_pid = os.fork()
        if child_pid == 0:
            import fcntl, termios
            os.close(master_fd)
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            for fd in (0, 1, 2):
                os.dup2(slave_fd, fd)
            if slave_fd > 2:
                os.close(slave_fd)
            os.execv("/bin/bash", ["/bin/bash", tmp_path])
            os._exit(127)

        os.close(slave_fd)

        loop = asyncio.get_running_loop()

        def _pty_read():
            r, _, _ = _select.select([master_fd], [], [], 0.05)
            if r:
                try:
                    return os.read(master_fd, 4096)
                except OSError:
                    return None
            return b""

        async def reader():
            nonlocal active, child_pid
            while active:
                chunk = await loop.run_in_executor(None, _pty_read)
                if chunk is None:
                    break
                if chunk:
                    await websocket.send_text(json.dumps({"type": "stdout", "data": chunk.decode("utf-8", errors="replace")}))
                if child_pid is not None:
                    pid, wstatus = os.waitpid(child_pid, os.WNOHANG)
                    if pid != 0:
                        code = (wstatus >> 8) & 0xFF
                        child_pid = None
                        # drain remaining PTY output before sending exit
                        while True:
                            drain = await loop.run_in_executor(None, _pty_read)
                            if not drain:
                                break
                            await websocket.send_text(json.dumps({"type": "stdout", "data": drain.decode("utf-8", errors="replace")}))
                        await websocket.send_text(json.dumps({"type": "exit", "data": str(code)}))
                        break
            active = False

        async def writer():
            nonlocal active
            while active:
                try:
                    msg = json.loads(await websocket.receive_text())
                    t = msg.get("type")
                    if t == "input":
                        os.write(master_fd, msg.get("data", "").encode("utf-8", errors="replace"))
                    elif t == "close":
                        break
                except WebSocketDisconnect:
                    break
                except Exception:
                    break
            active = False

        await asyncio.gather(reader(), writer(), return_exceptions=True)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "data": str(e)}))
        except Exception:
            pass
    finally:
        if child_pid is not None:
            try:
                os.kill(child_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(child_pid, os.WNOHANG)
            except Exception:
                pass
        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/exec-interactive")
async def exec_interactive(websocket: WebSocket, token: str = Query(...), session_id: str = Query("")):
    if token != AUTH_TOKEN:
        await websocket.close(code=4001)
        return

    await websocket.accept()

    master_fd = None
    child_pid = None
    active = True

    try:
        data = json.loads(await websocket.receive_text())
        library_name = data.get("library", "")
        entry_name   = data.get("name", "")
        params       = data.get("params", {})

        lib_path = (LIBRARIES_DIR / library_name).resolve()
        if not str(lib_path).startswith(str(LIBRARIES_DIR) + os.sep):
            raise ValueError("Invalid library path")
        if not lib_path.is_file():
            raise ValueError(f"Library not found: {library_name}")

        entries = parse_library_file(lib_path)
        entry = next((e for e in entries if e["name"] == entry_name), None)
        if not entry:
            raise ValueError(f"Entry not found: {entry_name}")

        command = entry["template"]
        for key, value in params.items():
            command = command.replace(f"{{{{{key}}}}}", value)
        remaining = PARAM_RE.findall(command)
        if remaining:
            raise ValueError(f"Unresolved params: {remaining}")

        master_fd, slave_fd = pty.openpty()

        child_pid = os.fork()
        if child_pid == 0:
            import fcntl, termios
            os.close(master_fd)
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            for fd in (0, 1, 2):
                os.dup2(slave_fd, fd)
            if slave_fd > 2:
                os.close(slave_fd)
            os.execv("/bin/bash", ["/bin/bash", "-c", command])
            os._exit(127)

        os.close(slave_fd)

        loop = asyncio.get_running_loop()

        def _pty_read():
            r, _, _ = _select.select([master_fd], [], [], 0.05)
            if r:
                try:
                    return os.read(master_fd, 4096)
                except OSError:
                    return None
            return b""

        async def reader():
            nonlocal active, child_pid
            while active:
                chunk = await loop.run_in_executor(None, _pty_read)
                if chunk is None:
                    break
                if chunk:
                    await websocket.send_text(json.dumps({
                        "type": "stdout",
                        "data": chunk.decode("utf-8", errors="replace"),
                    }))
                if child_pid is not None:
                    pid, wstatus = os.waitpid(child_pid, os.WNOHANG)
                    if pid != 0:
                        code = (wstatus >> 8) & 0xFF
                        child_pid = None
                        # drain remaining PTY output before sending exit
                        while True:
                            drain = await loop.run_in_executor(None, _pty_read)
                            if not drain:
                                break
                            await websocket.send_text(json.dumps({
                                "type": "stdout",
                                "data": drain.decode("utf-8", errors="replace"),
                            }))
                        await websocket.send_text(json.dumps({"type": "exit", "data": str(code)}))
                        break
            active = False

        async def writer():
            nonlocal active
            while active:
                try:
                    msg = json.loads(await websocket.receive_text())
                    t = msg.get("type")
                    if t == "input":
                        os.write(master_fd, msg.get("data", "").encode("utf-8", errors="replace"))
                    elif t == "close":
                        break
                except WebSocketDisconnect:
                    break
                except Exception:
                    break
            active = False

        await asyncio.gather(reader(), writer(), return_exceptions=True)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "data": str(e)}))
        except Exception:
            pass
    finally:
        if child_pid is not None:
            try:
                os.kill(child_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(child_pid, os.WNOHANG)
            except Exception:
                pass
        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/exec")
async def exec_command(websocket: WebSocket, token: str = Query(...), session_id: str = Query("")):
    if token != AUTH_TOKEN:
        await websocket.close(code=4001)
        return

    await websocket.accept()
    proc = None
    try:
        data = json.loads(await websocket.receive_text())
        library_name = data.get("library", "")
        entry_name   = data.get("name", "")
        params       = data.get("params", {})

        lib_path = (LIBRARIES_DIR / library_name).resolve()
        if not str(lib_path).startswith(str(LIBRARIES_DIR) + os.sep):
            raise ValueError("Invalid library path")
        if not lib_path.is_file():
            raise ValueError(f"Library not found: {library_name}")

        entries = parse_library_file(lib_path)
        entry = next((e for e in entries if e["name"] == entry_name), None)
        if not entry:
            raise ValueError(f"Entry not found: {entry_name}")

        command = entry["template"]
        for key, value in params.items():
            command = command.replace(f"{{{{{key}}}}}", value)

        remaining = PARAM_RE.findall(command)
        if remaining:
            raise ValueError(f"Unresolved params: {remaining}")

        category = lib_path.stem.replace("_library", "").replace("_", " ").upper()
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await stream_proc(websocket, proc, session_id, {"name": entry_name, "cat": category})

    except WebSocketDisconnect:
        if proc and proc.returncode is None:
            proc.kill()
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "data": str(e)}))
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/run-with-params/{script_name}")
async def run_script_with_params(websocket: WebSocket, script_name: str, token: str = Query(...), session_id: str = Query("")):
    if token != AUTH_TOKEN:
        await websocket.close(code=4001)
        return
    try:
        script_path = resolve_script(script_name)
    except HTTPException:
        await websocket.close(code=4004)
        return

    await websocket.accept()
    proc = None
    tmp_path = None
    try:
        data = json.loads(await websocket.receive_text())
        params = data.get("params", {})

        content = script_path.read_text()
        for key, value in params.items():
            content = content.replace(f"{{{{{key}}}}}", value)

        remaining = PARAM_RE.findall(content)
        if remaining:
            raise ValueError(f"Unresolved params: {remaining}")

        with tempfile.NamedTemporaryFile(mode='w', suffix='.sh', delete=False) as f:
            f.write(content)
            tmp_path = f.name
        os.chmod(tmp_path, 0o700)

        proc = await asyncio.create_subprocess_exec(
            "bash", tmp_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await stream_proc(websocket, proc, session_id, {"name": script_name, "cat": None})

    except WebSocketDisconnect:
        if proc and proc.returncode is None:
            proc.kill()
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "data": str(e)}))
        except Exception:
            pass
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
        try:
            await websocket.close()
        except Exception:
            pass


@app.put("/api/scripts/{script_name}")
async def update_script(script_name: str, request: Request, token: str = Query(...)):
    check_token(token)
    body = await request.json()
    content = body.get("content", "")
    path = resolve_script(script_name)
    path.write_text(content)
    return JSONResponse({"ok": True})


@app.post("/api/scripts")
async def create_script(request: Request, token: str = Query(...)):
    check_token(token)
    body = await request.json()
    name = body.get("name", "").strip()
    content = body.get("content", "")
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    if not name.endswith(".sh"):
        name += ".sh"
    path = (SCRIPTS_DIR / name).resolve()
    if not str(path).startswith(str(SCRIPTS_DIR) + os.sep):
        raise HTTPException(status_code=400, detail="Invalid name")
    if path.exists():
        raise HTTPException(status_code=409, detail="Script already exists")
    SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    os.chmod(str(path), 0o755)
    return JSONResponse({"ok": True, "name": name})


@app.put("/api/libraries/{lib_name}/entries/{entry_name}")
async def update_library_entry(lib_name: str, entry_name: str, request: Request, token: str = Query(...)):
    check_token(token)
    body = await request.json()
    new_template = body.get("template", "").strip()
    if not new_template:
        raise HTTPException(status_code=400, detail="Template required")

    lib_path = (LIBRARIES_DIR / lib_name).resolve()
    if not str(lib_path).startswith(str(LIBRARIES_DIR) + os.sep):
        raise HTTPException(status_code=400, detail="Invalid library")
    if not lib_path.is_file():
        raise HTTPException(status_code=404, detail="Library not found")

    text = lib_path.read_text()
    blocks = re.split(r'\n\n+', text.rstrip('\n'))

    found = False
    new_blocks = []
    for block in blocks:
        if not block.strip():
            continue
        first_line = block.split('\n')[0]
        block_name = first_line.split('|', 1)[0].strip() if '|' in first_line and first_line[0] not in ' \t' else None
        if block_name == entry_name:
            lines = new_template.split('\n')
            new_block = entry_name + '|' + lines[0]
            if len(lines) > 1:
                new_block += '\n' + '\n'.join(lines[1:])
            new_blocks.append(new_block)
            found = True
        else:
            new_blocks.append(block)

    if not found:
        raise HTTPException(status_code=404, detail="Entry not found")

    lib_path.write_text('\n\n'.join(new_blocks) + '\n')
    return JSONResponse({"ok": True})


@app.post("/api/libraries/{lib_name}/entries")
async def create_library_entry(lib_name: str, request: Request, token: str = Query(...)):
    check_token(token)
    body = await request.json()
    entry_name = body.get("name", "").strip()
    template = body.get("template", "").strip()
    if not entry_name or not template:
        raise HTTPException(status_code=400, detail="Name and template required")
    lib_path = (LIBRARIES_DIR / lib_name).resolve()
    if not str(lib_path).startswith(str(LIBRARIES_DIR) + os.sep):
        raise HTTPException(status_code=400, detail="Invalid library")
    if lib_path.exists():
        entries = parse_library_file(lib_path)
        if any(e["name"] == entry_name for e in entries):
            raise HTTPException(status_code=409, detail="Entry already exists")
        existing = lib_path.read_text()
        sep = "" if existing.endswith("\n\n") else ("\n" if existing.endswith("\n") else "\n\n")
        lib_path.write_text(existing + sep + entry_name + "|" + template + "\n")
    else:
        LIBRARIES_DIR.mkdir(parents=True, exist_ok=True)
        lib_path.write_text(entry_name + "|" + template + "\n")
    return JSONResponse({"ok": True})


def _load_sessions() -> dict:
    if SESSIONS_FILE.exists():
        try:
            return json.loads(SESSIONS_FILE.read_text())
        except Exception:
            return {}
    return {}


def _save_sessions(data: dict):
    SESSIONS_FILE.write_text(json.dumps(data, indent=2))


@app.get("/api/sessions")
def get_sessions(token: str = Query(...)):
    check_token(token)
    return JSONResponse(_load_sessions())


@app.post("/api/sessions/{session_id}")
async def upsert_session(session_id: str, request: Request, token: str = Query(...)):
    check_token(token)
    body = await request.json()
    sessions = _load_sessions()
    sessions[session_id] = body
    _save_sessions(sessions)
    return JSONResponse({"ok": True})


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: str, token: str = Query(...)):
    check_token(token)
    sessions = _load_sessions()
    sessions.pop(session_id, None)
    _save_sessions(sessions)
    return JSONResponse({"ok": True})


@app.get("/api/jobs")
def list_jobs(token: str = Query(...)):
    check_token(token)
    return JSONResponse([
        {"id": jid, "name": j["name"], "cat": j.get("cat"), "started": j["started"], "pid": j["proc"].pid}
        for jid, j in BACKGROUND_JOBS.items()
    ])


@app.post("/api/jobs")
async def start_job(request: Request, token: str = Query(...)):
    check_token(token)
    body = await request.json()
    job_type = body.get("type", "script")
    params   = body.get("params", {})
    tmp_path = None

    if job_type == "script":
        name = body.get("name", "")
        path = resolve_script(name)
        content = path.read_text()
        for k, v in params.items():
            content = content.replace(f"{{{{{k}}}}}", v)
        remaining = PARAM_RE.findall(content)
        if remaining:
            raise HTTPException(status_code=400, detail=f"Unresolved params: {remaining}")
        with tempfile.NamedTemporaryFile(mode='w', suffix='.sh', delete=False) as f:
            f.write(content); tmp_path = f.name
        os.chmod(tmp_path, 0o700)
        proc = await asyncio.create_subprocess_exec(
            "bash", tmp_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        display_name = name[:-3] if name.endswith(".sh") else name
        cat = None
    else:
        library_name = body.get("library", "")
        entry_name   = body.get("name", "")
        lib_path = (LIBRARIES_DIR / library_name).resolve()
        if not str(lib_path).startswith(str(LIBRARIES_DIR) + os.sep):
            raise HTTPException(status_code=400, detail="Invalid library")
        entries = parse_library_file(lib_path)
        entry = next((e for e in entries if e["name"] == entry_name), None)
        if not entry:
            raise HTTPException(status_code=404, detail="Entry not found")
        command = entry["template"]
        for k, v in params.items():
            command = command.replace(f"{{{{{k}}}}}", v)
        remaining = PARAM_RE.findall(command)
        if remaining:
            raise HTTPException(status_code=400, detail=f"Unresolved params: {remaining}")
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        display_name = entry_name
        cat = lib_path.stem.replace("_library", "").replace("_", " ").upper()

    job_id = _next_job_id()
    BACKGROUND_JOBS[job_id] = {
        "name": display_name, "cat": cat, "proc": proc,
        "started": datetime.now(timezone.utc).strftime("%H:%M:%S"),
    }
    asyncio.create_task(_watch_job(job_id, proc, tmp_path))
    return JSONResponse({"id": job_id, "name": display_name})


@app.delete("/api/jobs/{job_id}")
async def stop_job(job_id: str, token: str = Query(...)):
    check_token(token)
    job = BACKGROUND_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    try:
        job["proc"].kill()
    except Exception:
        pass
    BACKGROUND_JOBS.pop(job_id, None)
    return JSONResponse({"ok": True})


@app.get("/")
def index():
    return FileResponse("static/index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
