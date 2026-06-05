# Nexus — Live AI Assistant

A production-ready AI assistant with real-time internet access, fact verification, and session memory.

## Stack

| Layer | Technology |
|---|---|
| AI Agent | Gemini 2.0 Flash (Google) |
| Web Search | Tavily API |
| Backend | FastAPI + SSE streaming |
| Memory | In-process session store (swap for Redis in prod) |
| Frontend | Vanilla HTML/CSS/JS |
| Container | Docker + Nginx |

## Features

- **Real-time web search** — Agent autonomously decides when to call `web_search`
- **Dual-pass verification** — Runs a second search to cross-check facts before responding
- **Tool calling** — LLM decides which tools to use via Anthropic's tool-use API
- **Session memory** — 10-turn sliding window persisted per session
- **SSE streaming** — Tokens stream live to the UI, no waiting
- **Live capability panel** — UI shows search/verify/memory status in real time

## Quick Start

### 1. Get API keys

- **Google AI Studio**: https://aistudio.google.com/apikey (free tier available)
- **Tavily**: https://tavily.com (free tier: 1000 searches/month)

### 2. Set environment variables

```bash
cp backend/.env.example backend/.env
# Edit .env with your keys:
# GEMINI_API_KEY=AIza...
# TAVILY_API_KEY=tvly-...
```

### 3a. Docker (recommended)

```bash
docker-compose up --build
```

Open http://localhost:3000

### 3b. Vercel

Deploy the repo to Vercel and add these Environment Variables in Project Settings:

```bash
GEMINI_API_KEY=your_google_ai_studio_key
TAVILY_API_KEY=your_tavily_key
```

The frontend is served from `frontend/`, and `/ask`, `/health`, and `/session/*` are routed to the FastAPI app through `api/index.py`.

### 3c. Manual

```bash
# Backend
cd backend
pip install -r requirements.txt
uvicorn main:app --reload

# Frontend (any static server)
cd frontend
npx serve .  # or open index.html directly
```

## API

### POST /ask
Stream a response from the agent.

```json
{
  "session_id": "session_abc123",
  "query": "What is the latest Claude model?"
}
```

Returns SSE stream with events:
- `{"type": "token", "text": "..."}` — streamed tokens
- `{"type": "status", "text": "Searching: ..."}` — tool activity
- `{"type": "done", "tools_used": [...]}` — completion signal
- `{"type": "error", "text": "..."}` — error

### DELETE /session/{session_id}
Clear session memory.

### GET /health
Returns API key status and server health.

## Production Upgrades

| Feature | Swap |
|---|---|
| Memory | Replace dict with Redis (`redis-py`) |
| Search | Add fallback to Serper.dev |
| Auth | Add JWT middleware |
| Rate limiting | Add `slowapi` |
| Observability | Add LangSmith tracing |

## Project Structure

```
live-ai-assistant/
├── backend/
│   ├── main.py          # FastAPI app, agent loop, tool execution
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
├── frontend/
│   ├── index.html       # Chat UI shell
│   ├── style.css        # Dark editorial theme
│   └── app.js           # SSE client, message rendering, state
├── docker-compose.yml
├── nginx.conf
└── README.md
```
