import asyncio
import json
import os
import re
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse

load_dotenv()

SCRIPTS_DIR   = Path(os.getenv("SCRIPTS_DIR",   "./scripts")).resolve()
LIBRARIES_DIR = Path(os.getenv("LIBRARIES_DIR", "./libraries")).resolve()
SESSIONS_FILE = Path(os.getenv("SESSIONS_FILE", "./sessions.json")).resolve()
AUTH_TOKEN    = os.getenv("AUTH_TOKEN", "changeme")
HOST          = os.getenv("HOST", "127.0.0.1")
PORT          = int(os.getenv("PORT", "8000"))

app = FastAPI()

PARAM_RE = re.compile(r'\{\{([A-Z_0-9]+)\}\}')


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


async def stream_proc(websocket: WebSocket, proc):
    async def _stream(pipe, msg_type: str):
        async for line in pipe:
            await websocket.send_text(json.dumps({
                "type": msg_type,
                "data": line.decode(errors="replace"),
            }))

    await asyncio.gather(_stream(proc.stdout, "stdout"), _stream(proc.stderr, "stderr"))
    await proc.wait()
    await websocket.send_text(json.dumps({"type": "exit", "data": str(proc.returncode)}))


@app.get("/api/scripts")
def list_scripts(token: str = Query(...)):
    check_token(token)
    if not SCRIPTS_DIR.exists():
        return JSONResponse([])
    return JSONResponse(sorted(f.name for f in SCRIPTS_DIR.iterdir() if f.suffix == ".sh" and f.is_file()))


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
async def run_script(websocket: WebSocket, script_name: str, token: str = Query(...)):
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
        await stream_proc(websocket, proc)
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


@app.websocket("/ws/exec")
async def exec_command(websocket: WebSocket, token: str = Query(...)):
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
        if not str(lib_path).startswith(str(LIBRARIES_DIR)):
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

        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await stream_proc(websocket, proc)

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
async def run_script_with_params(websocket: WebSocket, script_name: str, token: str = Query(...)):
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
        await stream_proc(websocket, proc)

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


@app.post("/api/libraries/{lib_name}/entries")
async def create_library_entry(lib_name: str, request: Request, token: str = Query(...)):
    check_token(token)
    body = await request.json()
    entry_name = body.get("name", "").strip()
    template = body.get("template", "").strip()
    if not entry_name or not template:
        raise HTTPException(status_code=400, detail="Name and template required")
    lib_path = (LIBRARIES_DIR / lib_name).resolve()
    if not str(lib_path).startswith(str(LIBRARIES_DIR)):
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


@app.get("/")
def index():
    return FileResponse("static/index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
