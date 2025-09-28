# Ollama Web Frontend (local)

FastAPI + vanilla JS UI for a local Ollama install.

**Features**
- Model picker
- System prompt & temperature
- Streaming responses (with buffered fallback)
- Multi-chat (stored in localStorage)

## Run

    python3 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    export OLLAMA_URL="http://127.0.0.1:11434"
    python -m uvicorn server:app --host 127.0.0.1 --port 7860 --reload

Open http://127.0.0.1:7860

## Notes
- First run of a model may take time to load/compile in Ollama.
- Chat history is saved locally in your browser (localStorage).
- /chat_stream provides token streaming; falls back to /chat if streaming fails.

## License
MIT — see LICENSE.
