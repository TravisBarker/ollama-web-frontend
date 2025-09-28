# ollama-web-frontend


Minimal local web UI for Ollama.


## Prereqs
- Python 3.10+
- Ollama running locally (default: http://127.0.0.1:11434)


## Setup
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export OLLAMA_URL="http://127.0.0.1:11434" # optional if non-default
uvicorn server:app --host 127.0.0.1 --port 7860 --reload
