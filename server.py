import os, json
from pathlib import Path
from typing import AsyncIterator, Dict, Any

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")

app = FastAPI(title="ollama-web-frontend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

@app.get("/")
async def root() -> HTMLResponse:
    index = (static_dir / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(index)

@app.get("/health")
async def health():
    return {"status": "ok", "ollama_url": OLLAMA_URL}

@app.get("/models")
async def list_models():
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(f"{OLLAMA_URL}/api/tags")
        r.raise_for_status()
        data = r.json()
    names = sorted([m.get("name") for m in data.get("models", []) if m.get("name")])
    return {"models": names}

async def stream_chat(payload: Dict[str, Any]) -> AsyncIterator[bytes]:
    payload = {**payload, "stream": True}
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("POST", f"{OLLAMA_URL}/api/chat", json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    yield line.encode("utf-8")
                    continue
                msg = obj.get("message", {})
                chunk = msg.get("content", "")
                if chunk:
                    yield chunk.encode("utf-8")
                if obj.get("done"):
                    break

@app.post("/chat")
async def chat(req: Request):
    body = await req.json()
    model = body.get("model")
    messages = body.get("messages")
    options = body.get("options") or {}
    if not model or not messages:
        return JSONResponse({"error": "model and messages are required"}, status_code=400)
    payload = {"model": model, "messages": messages, "options": options}
    return StreamingResponse(stream_chat(payload), media_type="text/plain")
import json, httpx
from fastapi import Request
from fastapi.responses import JSONResponse, PlainTextResponse

@app.post("/chat")
async def chat(req: Request):
    body = await req.json()
    model    = (body.get("model") or "").strip()
    messages = body.get("messages") or []
    options  = body.get("options") or {}
    if not model or not messages:
        return JSONResponse({"error":"model and messages are required"}, status_code=400)

    # Non-stream call to Ollama (simplest, least error-prone)
    payload = {"model": model, "messages": messages, "stream": False, "options": options}
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPStatusError as e:
        try:
            err_body = e.response.text
        except Exception:
            err_body = ""
        return JSONResponse({"error": f"HTTP {e.response.status_code} from Ollama", "body": err_body}, status_code=502)
    except Exception as e:
        return JSONResponse({"error": f"proxy exception: {e}"}, status_code=502)

    # Extract assistant content
    msg = (data or {}).get("message") or {}
    text = msg.get("content") or ""
    # Return plain text so the front-end just appends it
    return PlainTextResponse(text)

# --- STREAMING SUPPORT (new) ---
import json
from typing import AsyncIterator, Dict, Any
from fastapi.responses import StreamingResponse

async def _stream_chat_from_ollama(payload: Dict[str, Any]) -> AsyncIterator[bytes]:
    """Proxy Ollama /api/chat with stream=True, yielding plain text chunks."""
    try:
        pl = {**payload, "stream": True}
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", f"{OLLAMA_URL}/api/chat", json=pl) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        chunk = (obj.get("message") or {}).get("content", "")
                        if chunk:
                            yield chunk.encode("utf-8")
                        if obj.get("done"):
                            break
                    except Exception:
                        # ignore non-JSON lines
                        continue
    except httpx.HTTPStatusError as e:
        body = ""
        try:
            body = e.response.text
        except Exception:
            pass
        yield (f"[ERROR] HTTP {e.response.status_code} from Ollama: {body}\n").encode("utf-8")
    except httpx.RequestError as e:
        yield (f"[ERROR] Request to Ollama failed: {e}\n").encode("utf-8")
    except Exception as e:
        yield (f"[ERROR] Server exception: {e}\n").encode("utf-8")

@app.post("/chat_stream")
async def chat_stream(req: Request):
    body = await req.json()
    model    = (body.get("model") or "").strip()
    messages = body.get("messages") or []
    options  = body.get("options") or {}
    if not model or not messages:
        return JSONResponse({"error": "model and messages are required"}, status_code=400)

    payload = {"model": model, "messages": messages, "options": options}
    return StreamingResponse(
        _stream_chat_from_ollama(payload),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-cache"}
    )
