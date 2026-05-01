import asyncio
import fcntl
import json
import logging
import os
import pty
import struct
import termios
from datetime import datetime, timezone
from functools import partial

from fastapi import WebSocket, WebSocketDisconnect

from sessions import _append_session_log

log = logging.getLogger(__name__)


async def stream_proc(
    websocket: WebSocket,
    proc,
    session_id: str = "",
    run_info: dict = None,
) -> None:
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
        await asyncio.to_thread(_append_session_log, session_id, {
            **run_info,
            "ts": datetime.now(timezone.utc).isoformat(),
            "lines": log_lines,
            "code": proc.returncode,
        })


def _setup_ctty(slave_fd: int) -> None:
    # setsid() → session leader with no ctty.
    # TIOCSCTTY on slave_fd (kept open via pass_fds) → slave becomes ctty.
    # Using slave_fd directly avoids relying on dup2 order, which differs
    # between CPython and uvloop.
    os.setsid()
    fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)


async def _run_pty_session(
    websocket: WebSocket,
    exec_args: list[str],
    session_id: str,
    run_info: dict,
) -> None:
    """Spawn exec_args under a PTY, bridge its I/O over WebSocket.

    The WebSocket must already be accepted before calling this.
    """
    master_fd: int | None = None
    proc = None
    log_lines: list = []
    exit_code = -1
    loop = asyncio.get_running_loop()
    pty_queue: asyncio.Queue = asyncio.Queue()

    try:
        master_fd, slave_fd = pty.openpty()

        proc = await asyncio.create_subprocess_exec(
            *exec_args,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            pass_fds=(slave_fd,),
            preexec_fn=partial(_setup_ctty, slave_fd),
        )
        # Parent must close slave so master gets EIO when child exits.
        os.close(slave_fd)

        def _on_master_readable() -> None:
            try:
                data = os.read(master_fd, 4096)
                pty_queue.put_nowait(data if data else None)
            except OSError:
                loop.remove_reader(master_fd)
                pty_queue.put_nowait(None)

        loop.add_reader(master_fd, _on_master_readable)

        async def reader() -> None:
            nonlocal exit_code
            while True:
                chunk = await pty_queue.get()
                if chunk is None:
                    break
                decoded = chunk.decode("utf-8", errors="replace")
                log_lines.append({"t": "o", "d": decoded})
                try:
                    await websocket.send_text(json.dumps({"type": "stdout", "data": decoded}))
                except Exception:
                    break
            exit_code = (await proc.wait()) or 0
            try:
                await websocket.send_text(json.dumps({"type": "exit", "data": str(exit_code)}))
            except Exception:
                pass

        async def writer() -> None:
            while True:
                try:
                    msg = json.loads(await websocket.receive_text())
                except WebSocketDisconnect:
                    break
                except Exception:
                    break
                t = msg.get("type")
                if t == "input":
                    try:
                        os.write(master_fd, msg.get("data", "").encode("utf-8", errors="replace"))
                    except OSError as e:
                        try:
                            await websocket.send_text(json.dumps({"type": "error", "data": f"write error: {e}"}))
                        except Exception:
                            pass
                elif t == "resize":
                    cols = max(1, int(msg.get("cols", 80)))
                    rows = max(1, int(msg.get("rows", 24)))
                    try:
                        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                    except OSError:
                        pass
                elif t == "close":
                    break

        async def keepalive() -> None:
            while True:
                await asyncio.sleep(20)
                try:
                    await websocket.send_text(json.dumps({"type": "ping"}))
                except Exception:
                    break

        await asyncio.gather(reader(), writer(), keepalive(), return_exceptions=True)

    finally:
        if master_fd is not None:
            loop.remove_reader(master_fd)
            try:
                os.close(master_fd)
            except OSError:
                pass
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
            except Exception:
                pass
            try:
                await proc.wait()
            except Exception:
                pass
        if session_id:
            await asyncio.to_thread(_append_session_log, session_id, {
                **run_info,
                "ts": datetime.now(timezone.utc).isoformat(),
                "lines": log_lines,
                "code": exit_code,
            })
