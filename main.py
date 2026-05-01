import asyncio
import json
import logging
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse

from auth import TokenAuth, ws_auth
from config import HOST, LIBRARIES_DIR, LOGS_DIR, PORT, SCRIPTS_DIR, SSL_CERT, SSL_KEY, STATUS_DIR
from library import PARAM_RE, _resolve_entry, _validate_lib_path, parse_library_file, resolve_library, resolve_script
from runner import _run_pty_session, stream_proc
from sessions import _append_session_log, _load_sessions, _save_sessions, _session_log_path, _sessions_lock

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)

app = FastAPI()
BACKGROUND_JOBS: dict = {}


async def _watch_job(job_id: str, proc, tmp_path=None):
    await proc.wait()
    BACKGROUND_JOBS.pop(job_id, None)
    if tmp_path:
        try:
            os.unlink(tmp_path)
        except Exception:
            log.warning("Failed to unlink tmp job script %s", tmp_path)


# ── HTTP endpoints ────────────────────────────────────────────────────────────

@app.get("/api/status")
def list_status(_: TokenAuth):
    if not STATUS_DIR.exists():
        return JSONResponse([])
    return JSONResponse(sorted(f.stem for f in STATUS_DIR.iterdir() if f.suffix == ".sh" and f.is_file()))


@app.get("/api/status/run")
async def run_status(_: TokenAuth):
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
        except Exception as e:
            log.warning("Status script %s failed: %s", path.name, e)
            return path.stem, None

    results = await asyncio.gather(*[_run(s) for s in scripts])
    return JSONResponse({name: val for name, val in results})


@app.get("/api/scripts")
def list_scripts(_: TokenAuth):
    if not SCRIPTS_DIR.exists():
        return JSONResponse([])
    return JSONResponse(sorted(f.name for f in SCRIPTS_DIR.iterdir() if f.suffix == ".sh" and f.is_file()))


@app.get("/api/logs/{session_id}")
def get_session_log(session_id: str, _: TokenAuth):
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
                log.warning("Bad log line in session %s", session_id)
    return JSONResponse(entries)


@app.get("/api/scripts/{script_name}")
def get_script_content(script_name: str, _: TokenAuth):
    path = resolve_script(script_name)
    content = path.read_text()
    params = sorted(set(PARAM_RE.findall(content)))
    return JSONResponse({"name": script_name, "content": content, "params": params})


@app.get("/api/libraries")
def list_libraries(_: TokenAuth):
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


@app.put("/api/scripts/{script_name}")
async def update_script(script_name: str, request: Request, _: TokenAuth):
    body = await request.json()
    content = body.get("content", "")
    path = resolve_script(script_name)
    await asyncio.to_thread(path.write_text, content)
    return JSONResponse({"ok": True})


@app.post("/api/scripts")
async def create_script(request: Request, _: TokenAuth):
    body = await request.json()
    name = body.get("name", "").strip()
    content = body.get("content", "")
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    if not name.endswith(".sh"):
        name += ".sh"
    path = (SCRIPTS_DIR / name).resolve()
    if SCRIPTS_DIR not in path.parents:
        raise HTTPException(status_code=400, detail="Invalid name")
    if path.exists():
        raise HTTPException(status_code=409, detail="Script already exists")
    SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(path.write_text, content)
    await asyncio.to_thread(os.chmod, str(path), 0o755)
    return JSONResponse({"ok": True, "name": name})


@app.put("/api/libraries/{lib_name}/entries/{entry_name}")
async def update_library_entry(lib_name: str, entry_name: str, request: Request, _: TokenAuth):
    body = await request.json()
    new_template = body.get("template", "").strip()
    new_destination = body.get("destination", "").strip()
    if not new_template:
        raise HTTPException(status_code=400, detail="Template required")

    lib_path = resolve_library(lib_name)
    text = await asyncio.to_thread(lib_path.read_text)
    blocks = re.split(r'\n\n+', text.rstrip('\n'))

    found = False
    new_blocks = []
    for block in blocks:
        if not block.strip():
            continue
        first_line = block.split('\n')[0]
        if '|' not in first_line or first_line[0] in ' \t':
            new_blocks.append(block)
            continue
        full_key = first_line.split('|', 1)[0].strip()
        block_display_name = full_key.split(':', 1)[0].strip()
        if block_display_name == entry_name:
            new_key = entry_name + ":" + new_destination if new_destination else entry_name
            lines = new_template.split('\n')
            new_block = new_key + '|' + lines[0]
            if len(lines) > 1:
                new_block += '\n' + '\n'.join(lines[1:])
            new_blocks.append(new_block)
            found = True
        else:
            new_blocks.append(block)

    if not found:
        raise HTTPException(status_code=404, detail="Entry not found")

    await asyncio.to_thread(lib_path.write_text, '\n\n'.join(new_blocks) + '\n')
    return JSONResponse({"ok": True})


@app.post("/api/libraries/{lib_name}/entries")
async def create_library_entry(lib_name: str, request: Request, _: TokenAuth):
    body = await request.json()
    entry_name = body.get("name", "").strip()
    destination = body.get("destination", "").strip()
    template = body.get("template", "").strip()
    if not entry_name or not template:
        raise HTTPException(status_code=400, detail="Name and template required")
    lib_path = _validate_lib_path(lib_name)
    full_key = entry_name + ":" + destination if destination else entry_name
    if lib_path.exists():
        entries = await asyncio.to_thread(parse_library_file, lib_path)
        if any(e["name"] == entry_name for e in entries):
            raise HTTPException(status_code=409, detail="Entry already exists")
        existing = await asyncio.to_thread(lib_path.read_text)
        sep = "" if existing.endswith("\n\n") else ("\n" if existing.endswith("\n") else "\n\n")
        await asyncio.to_thread(lib_path.write_text, existing + sep + full_key + "|" + template + "\n")
    else:
        LIBRARIES_DIR.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(lib_path.write_text, full_key + "|" + template + "\n")
    return JSONResponse({"ok": True})


@app.get("/api/sessions")
async def get_sessions(_: TokenAuth):
    return JSONResponse(await asyncio.to_thread(_load_sessions))


@app.post("/api/sessions/{session_id}")
async def upsert_session(session_id: str, request: Request, _: TokenAuth):
    body = await request.json()
    async with _sessions_lock:
        sessions = await asyncio.to_thread(_load_sessions)
        sessions[session_id] = body
        await asyncio.to_thread(_save_sessions, sessions)
    return JSONResponse({"ok": True})


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str, _: TokenAuth):
    async with _sessions_lock:
        sessions = await asyncio.to_thread(_load_sessions)
        sessions.pop(session_id, None)
        await asyncio.to_thread(_save_sessions, sessions)
    return JSONResponse({"ok": True})


@app.get("/api/jobs")
def list_jobs(_: TokenAuth):
    return JSONResponse([
        {"id": jid, "name": j["name"], "cat": j.get("cat"), "started": j["started"], "pid": j["proc"].pid}
        for jid, j in BACKGROUND_JOBS.items()
    ])


@app.post("/api/jobs")
async def start_job(request: Request, _: TokenAuth):
    body = await request.json()
    job_type = body.get("type", "script")
    params   = body.get("params", {})
    tmp_path = None

    if job_type == "script":
        name = body.get("name", "")
        path = resolve_script(name)
        content = await asyncio.to_thread(path.read_text)
        for k, v in params.items():
            content = content.replace(f"{{{{{k}}}}}", v)
        remaining = PARAM_RE.findall(content)
        if remaining:
            raise HTTPException(status_code=400, detail=f"Unresolved params: {remaining}")
        with tempfile.NamedTemporaryFile(mode='w', suffix='.sh', delete=False) as f:
            f.write(content)
            tmp_path = f.name
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
        lib_path = resolve_library(library_name)
        try:
            exec_cmd, cat, _ = await asyncio.to_thread(_resolve_entry, lib_path, entry_name, params)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        proc = await asyncio.create_subprocess_exec(
            "bash", "-c", exec_cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        display_name = entry_name

    job_id = str(uuid4())
    BACKGROUND_JOBS[job_id] = {
        "name": display_name, "cat": cat, "proc": proc,
        "started": datetime.now(timezone.utc).strftime("%H:%M:%S"),
    }
    asyncio.create_task(_watch_job(job_id, proc, tmp_path))
    return JSONResponse({"id": job_id, "name": display_name})


@app.delete("/api/jobs/{job_id}")
async def stop_job(job_id: str, _: TokenAuth):
    job = BACKGROUND_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    try:
        job["proc"].kill()
    except Exception:
        log.warning("Failed to kill job %s", job_id)
    BACKGROUND_JOBS.pop(job_id, None)
    return JSONResponse({"ok": True})


# ── WebSocket endpoints ───────────────────────────────────────────────────────

@app.websocket("/ws/run/{script_name}")
async def run_script(websocket: WebSocket, script_name: str, token: str = Query(...), session_id: str = Query("")):
    if not ws_auth(token):
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
        await stream_proc(websocket, proc, session_id, {"name": script_name, "cat": None, "cmd": str(script_path)})
    except WebSocketDisconnect:
        if proc and proc.returncode is None:
            proc.kill()
    except Exception as e:
        log.exception("run_script error")
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
    if not ws_auth(token):
        await websocket.close(code=4001)
        return
    try:
        script_path = resolve_script(script_name)
    except HTTPException:
        await websocket.close(code=4004)
        return

    await websocket.accept()
    tmp_path = None
    try:
        data = json.loads(await websocket.receive_text())
        params = data.get("params", {})

        content = await asyncio.to_thread(script_path.read_text)
        for key, value in params.items():
            content = content.replace(f"{{{{{key}}}}}", value)
        remaining = PARAM_RE.findall(content)
        if remaining:
            raise ValueError(f"Unresolved params: {remaining}")

        with tempfile.NamedTemporaryFile(mode='w', suffix='.sh', delete=False) as f:
            f.write(content)
            tmp_path = f.name
        os.chmod(tmp_path, 0o700)

        await _run_pty_session(
            websocket,
            ["/bin/bash", tmp_path],
            session_id,
            {"name": script_name, "cat": None, "cmd": content},
        )
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("run_script_interactive error")
        try:
            await websocket.send_text(json.dumps({"type": "error", "data": str(e)}))
        except Exception:
            pass
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                log.warning("Failed to unlink tmp script %s", tmp_path)
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/exec-interactive")
async def exec_interactive(websocket: WebSocket, token: str = Query(...), session_id: str = Query("")):
    if not ws_auth(token):
        await websocket.close(code=4001)
        return

    await websocket.accept()
    try:
        data = json.loads(await websocket.receive_text())
        library_name = data.get("library", "")
        entry_name   = data.get("name", "")
        params       = data.get("params", {})

        lib_path = resolve_library(library_name)
        exec_cmd, category, destination = await asyncio.to_thread(
            _resolve_entry, lib_path, entry_name, params
        )

        await _run_pty_session(
            websocket,
            ["/bin/bash", "-c", exec_cmd],
            session_id,
            {"name": entry_name, "cat": category, "cmd": exec_cmd, "dest": destination},
        )
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("exec_interactive error")
        try:
            await websocket.send_text(json.dumps({"type": "error", "data": str(e)}))
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/exec")
async def exec_command(websocket: WebSocket, token: str = Query(...), session_id: str = Query("")):
    if not ws_auth(token):
        await websocket.close(code=4001)
        return

    await websocket.accept()
    proc = None
    try:
        data = json.loads(await websocket.receive_text())
        library_name = data.get("library", "")
        entry_name   = data.get("name", "")
        params       = data.get("params", {})

        lib_path = resolve_library(library_name)
        exec_cmd, category, destination = await asyncio.to_thread(
            _resolve_entry, lib_path, entry_name, params
        )

        proc = await asyncio.create_subprocess_exec(
            "bash", "-c", exec_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await stream_proc(websocket, proc, session_id, {
            "name": entry_name, "cat": category, "cmd": exec_cmd, "dest": destination,
        })
    except WebSocketDisconnect:
        if proc and proc.returncode is None:
            proc.kill()
    except Exception as e:
        log.exception("exec_command error")
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
    if not ws_auth(token):
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

        content = await asyncio.to_thread(script_path.read_text)
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
        await stream_proc(websocket, proc, session_id, {"name": script_name, "cat": None, "cmd": content})

    except WebSocketDisconnect:
        if proc and proc.returncode is None:
            proc.kill()
    except Exception as e:
        log.exception("run_script_with_params error")
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


# ── Static ────────────────────────────────────────────────────────────────────

@app.get("/")
def index():
    return FileResponse("static/index.html")


if __name__ == "__main__":
    import uvicorn
    ssl_kwargs = {}
    if SSL_CERT and SSL_KEY:
        ssl_kwargs = {"ssl_certfile": SSL_CERT, "ssl_keyfile": SSL_KEY}
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False, **ssl_kwargs)
