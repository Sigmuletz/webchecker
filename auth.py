import hmac
from typing import Annotated

from fastapi import Depends, HTTPException, Query, Request

from config import AUTH_TOKEN


async def _verify_token(
    request: Request,
    token: str = Query(default=""),
) -> None:
    """Accept token via Authorization: Bearer header or ?token= query param."""
    auth_header = request.headers.get("Authorization", "")
    bearer = auth_header[7:] if auth_header.startswith("Bearer ") else ""
    tok = bearer or token
    if not tok or not hmac.compare_digest(tok, AUTH_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid token")


TokenAuth = Annotated[None, Depends(_verify_token)]


def ws_auth(token: str) -> bool:
    """WebSocket auth — browser WS API cannot set headers, so query param only."""
    return bool(token) and hmac.compare_digest(token, AUTH_TOKEN)
