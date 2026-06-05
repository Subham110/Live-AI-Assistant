import os
import json
import asyncio
from pathlib import Path
from typing import AsyncGenerator
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import google.generativeai as genai
import httpx
from dotenv import load_dotenv
from collections import defaultdict

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

app = FastAPI(title="Live AI Assistant API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory session store (replace with Redis in production)
session_memory: dict[str, list] = defaultdict(list)
WINDOW_SIZE = 10

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip().strip('"').strip("'")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "").strip().strip('"').strip("'")

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

# ── Gemini tool declaration ───────────────────────────────────────────────────

web_search_tool = genai.protos.Tool(
    function_declarations=[
        genai.protos.FunctionDeclaration(
            name="web_search",
            description=(
                "Search the internet for current, real-time information. "
                "Use this whenever the question involves recent events, live data, "
                "prices, news, or anything that may have changed recently."
            ),
            parameters=genai.protos.Schema(
                type=genai.protos.Type.OBJECT,
                properties={
                    "query": genai.protos.Schema(
                        type=genai.protos.Type.STRING,
                        description="The search query to look up"
                    ),
                    "verify": genai.protos.Schema(
                        type=genai.protos.Type.BOOLEAN,
                        description="Set true to run a verification search cross-checking a draft answer"
                    ),
                },
                required=["query"]
            )
        )
    ]
)

SYSTEM_PROMPT = """You are Nexus, a Live AI Assistant with real-time internet access powered by Gemini.

Your capabilities:
1. SEARCH: Use the web_search tool to find current information before answering
2. VERIFY: After forming an answer, use web_search with verify=true to cross-check key facts
3. REMEMBER: You have access to this session's conversation history

Rules:
- Always search for questions about current events, prices, live data, or recent facts
- After getting search results, verify important claims with a second search
- Cite your sources — include the URLs from search results
- If search results conflict, mention the discrepancy
- Be concise and direct. Format with markdown where helpful
- For follow-up questions, use conversation history to maintain context

Format your final answers clearly with:
- A direct answer first
- Supporting details
- Sources (as inline links or a brief list at the end)"""


# ── Web search implementation ─────────────────────────────────────────────────

async def tavily_search(query: str) -> dict:
    if not TAVILY_API_KEY:
        return {
            "answer": f"[Demo mode — Tavily API key not set. Query was: '{query}']",
            "results": [
                {"title": "Example Result", "url": "https://example.com", "content": "Demo search result content."}
            ]
        }
    async with httpx.AsyncClient(timeout=15.0) as http:
        resp = await http.post(
            "https://api.tavily.com/search",
            json={
                "api_key": TAVILY_API_KEY,
                "query": query,
                "search_depth": "advanced",
                "include_answer": True,
                "max_results": 5,
            }
        )
        resp.raise_for_status()
        data = resp.json()
        return {
            "answer": data.get("answer", ""),
            "results": [
                {"title": r.get("title", ""), "url": r.get("url", ""), "content": r.get("content", "")[:400]}
                for r in data.get("results", [])
            ]
        }


async def execute_tool(name: str, inputs: dict) -> str:
    if name == "web_search":
        query = inputs.get("query", "")
        is_verify = inputs.get("verify", False)
        prefix = "VERIFICATION SEARCH" if is_verify else "SEARCH RESULTS"
        try:
            data = await tavily_search(query)
            lines = [f"[{prefix} for: '{query}']", f"Summary: {data['answer']}", ""]
            for i, r in enumerate(data["results"][:4], 1):
                lines.append(f"{i}. {r['title']}")
                lines.append(f"   URL: {r['url']}")
                lines.append(f"   {r['content']}")
                lines.append("")
            return "\n".join(lines)
        except Exception as e:
            return f"Search failed: {str(e)}"
    return "Unknown tool"


# ── Memory helpers ────────────────────────────────────────────────────────────

def load_memory(session_id: str) -> list:
    msgs = session_memory[session_id]
    return msgs[-(WINDOW_SIZE * 2):]


def save_memory(session_id: str, messages: list):
    session_memory[session_id] = messages[-(WINDOW_SIZE * 2):]


def to_gemini_history(messages: list) -> list:
    """Convert flat role/content list to Gemini Content objects."""
    history = []
    for m in messages:
        role = "user" if m["role"] == "user" else "model"
        content = m["content"]
        if isinstance(content, str):
            history.append({"role": role, "parts": [{"text": content}]})
        # skip non-string tool result messages (handled inline)
    return history


# ── Streaming agent ───────────────────────────────────────────────────────────

async def run_agent_stream(session_id: str, query: str) -> AsyncGenerator[str, None]:
    history = load_memory(session_id)
    # messages for memory tracking (simple role/content dicts)
    mem_messages = history + [{"role": "user", "content": query}]
    tool_calls_made = []

    def sse(data: dict) -> str:
        return f"data: {json.dumps(data)}\n\n"

    try:
        model = genai.GenerativeModel(
            model_name="gemini-2.5-flash",
            system_instruction=SYSTEM_PROMPT,
            tools=[web_search_tool],
        )

        # build Gemini-format history (all but the latest user message)
        gemini_history = to_gemini_history(history)
        chat = model.start_chat(history=gemini_history)

        current_query = query

        while True:
            yield sse({"type": "status", "text": "Thinking..."})

            # Send message — run in thread to avoid blocking
            response = await asyncio.get_event_loop().run_in_executor(
                None, lambda q=current_query: chat.send_message(q)
            )

            candidate = response.candidates[0]
            parts = candidate.content.parts

            text_parts = []
            function_calls = []

            for part in parts:
                if hasattr(part, "text") and part.text:
                    text_parts.append(part.text)
                if hasattr(part, "function_call") and part.function_call.name:
                    function_calls.append(part.function_call)

            # stream text tokens char by char
            if text_parts:
                full_text = "".join(text_parts)
                for char in full_text:
                    yield sse({"type": "token", "text": char})
                    await asyncio.sleep(0.004)

            # no function calls → done
            if not function_calls:
                # save to memory
                mem_messages.append({"role": "assistant", "content": "".join(text_parts)})
                save_memory(session_id, mem_messages)
                yield sse({"type": "done", "tools_used": tool_calls_made})
                return

            # execute each function call and build tool response parts
            tool_response_parts = []
            for fc in function_calls:
                fn_name = fc.name
                fn_args = dict(fc.args)
                tool_calls_made.append(fn_name)

                status = f"Searching: {fn_args.get('query', '')}"
                if fn_args.get("verify"):
                    status = f"Verifying: {fn_args.get('query', '')}"
                yield sse({"type": "status", "text": status})

                result_text = await execute_tool(fn_name, fn_args)

                tool_response_parts.append(
                    genai.protos.Part(
                        function_response=genai.protos.FunctionResponse(
                            name=fn_name,
                            response={"result": result_text}
                        )
                    )
                )

            # feed tool results back as next turn
            current_query = genai.protos.Content(
                role="user",
                parts=tool_response_parts
            )

    except Exception as e:
        yield sse({"type": "error", "text": str(e)})


# ── API routes ────────────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    session_id: str
    query: str


@app.post("/api/ask")
@app.post("/ask")
async def ask(body: QueryRequest):
    if not GEMINI_API_KEY:
        raise HTTPException(
            500,
            "GEMINI_API_KEY is not set. Create backend/.env with GEMINI_API_KEY=your_key, "
            "or export it before starting uvicorn."
        )
    if not body.query.strip():
        raise HTTPException(400, "Query cannot be empty")
    return StreamingResponse(
        run_agent_stream(body.session_id, body.query.strip()),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@app.delete("/api/session/{session_id}")
@app.delete("/session/{session_id}")
async def clear_session(session_id: str):
    session_memory.pop(session_id, None)
    return {"cleared": True}


@app.get("/api/health")
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "gemini": bool(GEMINI_API_KEY),
        "tavily": bool(TAVILY_API_KEY)
    }


@app.get("/api")
@app.get("/")
async def root():
    return {"message": "Live AI Assistant API (Gemini) — POST /ask to query"}
