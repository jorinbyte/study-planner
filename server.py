#!/usr/bin/env python3
"""
StudyFlow — Bachelor Study Planner & Gemini AI Study Companion
Zero-dependency Python 3 backend (stdlib only: http.server, sqlite3, urllib, zipfile).
"""

import argparse
import base64
import json
import mimetypes
import os
import re
import signal
import socket
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "study_planner.db"

DEFAULT_MODEL = "gemini-2.5-flash"
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB per file
MAX_INLINE_TOTAL_BYTES = 12 * 1024 * 1024  # 12 MB total inline binary payload per Gemini call

INLINE_GEMINI_MIMES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
}

TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".csv", ".json", ".tex", ".py", ".js", ".ts",
    ".jsx", ".tsx", ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs",
    ".html", ".css", ".sql", ".xml", ".yaml", ".yml", ".r", ".m", ".sh",
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    ensure_dirs()
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS courses (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                code TEXT DEFAULT '',
                color TEXT DEFAULT '#4F46E5',
                instructor TEXT DEFAULT '',
                semester TEXT DEFAULT '',
                description TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS items (
                id TEXT PRIMARY KEY,
                course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
                type TEXT NOT NULL CHECK(type IN ('assignment', 'test')),
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                due_date TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'submitted', 'graded')),
                priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
                estimated_minutes INTEGER NOT NULL DEFAULT 60,
                actual_minutes INTEGER NOT NULL DEFAULT 0,
                weight_percent REAL,
                grade TEXT DEFAULT '',
                submitted_at TEXT DEFAULT '',
                submission_notes TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chapters (
                id TEXT PRIMARY KEY,
                item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                chapter_label TEXT DEFAULT '',
                title TEXT NOT NULL,
                todo_notes TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'done')),
                estimated_minutes INTEGER NOT NULL DEFAULT 30,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
                item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
                chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
                doc_role TEXT NOT NULL DEFAULT 'study_material',
                original_name TEXT NOT NULL,
                stored_name TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                extracted_text TEXT DEFAULT '',
                uploaded_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS subtask_explanations (
                id TEXT PRIMARY KEY,
                chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
                prompt_focus TEXT DEFAULT '',
                content_md TEXT NOT NULL,
                model_used TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS subtask_tests (
                id TEXT PRIMARY KEY,
                chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                difficulty TEXT NOT NULL DEFAULT 'medium',
                questions_json TEXT NOT NULL,
                last_answers_json TEXT DEFAULT '',
                last_score REAL,
                last_total REAL,
                last_feedback_json TEXT DEFAULT '',
                model_used TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                attempted_at TEXT DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS ai_overviews (
                id TEXT PRIMARY KEY,
                course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
                scope_label TEXT NOT NULL DEFAULT 'All Courses',
                overview_json TEXT DEFAULT '',
                content_md TEXT NOT NULL DEFAULT '',
                model_used TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS course_themes (
                id TEXT PRIMARY KEY,
                course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
                document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
                title TEXT NOT NULL,
                summary TEXT DEFAULT '',
                importance TEXT NOT NULL DEFAULT 'medium',
                key_concepts_json TEXT DEFAULT '[]',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS gemini_usage_log (
                id TEXT PRIMARY KEY,
                model TEXT DEFAULT '',
                ts_epoch REAL NOT NULL,
                day_key TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_gemini_usage_ts ON gemini_usage_log(ts_epoch);
            CREATE INDEX IF NOT EXISTS idx_gemini_usage_day ON gemini_usage_log(day_key);
            """
        )
        defaults = {
            "gemini_api_key": "",
            "gemini_model": DEFAULT_MODEL,
            "gemini_rpm_limit": "5",
            "gemini_daily_limit": "50",
            "student_name": "Bachelor Student",
            "semester_name": "Current Semester",
            "daily_study_hours": "4",
        }
        for k, v in defaults.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v)
            )


# ---------------------------------------------------------------------------
# Document text extraction (stdlib only: docx, pptx, plain text)
# ---------------------------------------------------------------------------

def extract_text_from_file(file_path: Path, original_name: str, mime_type: str) -> str:
    ext = Path(original_name).suffix.lower()
    try:
        if ext in TEXT_EXTENSIONS or (mime_type and mime_type.startswith("text/")):
            raw = file_path.read_bytes()
            text = raw.decode("utf-8", errors="replace")
            return text[:40000]

        if ext == ".docx":
            with zipfile.ZipFile(file_path, "r") as zf:
                if "word/document.xml" not in zf.namelist():
                    return ""
                root = ET.fromstring(zf.read("word/document.xml"))
                paragraphs = []
                for p in root.iter():
                    if p.tag.endswith("}p"):
                        texts = [t.text for t in p.iter() if t.tag.endswith("}t") and t.text]
                        if texts:
                            paragraphs.append("".join(texts))
                return "\n".join(paragraphs)[:40000]

        if ext == ".pptx":
            with zipfile.ZipFile(file_path, "r") as zf:
                slide_names = [
                    n for n in zf.namelist()
                    if re.match(r"^ppt/slides/slide\d+\.xml$", n)
                ]
                slide_names.sort(key=lambda s: int(re.search(r"slide(\d+)\.xml$", s).group(1)))
                slides_out = []
                for idx, sname in enumerate(slide_names, start=1):
                    root = ET.fromstring(zf.read(sname))
                    texts = [t.text.strip() for t in root.iter() if t.tag.endswith("}t") and t.text and t.text.strip()]
                    if texts:
                        slides_out.append(f"[Slide {idx}]\n" + "\n".join(texts))
                return "\n\n".join(slides_out)[:40000]
    except Exception:
        return ""
    return ""


# ---------------------------------------------------------------------------
# Settings & Gemini Backend Integration
# ---------------------------------------------------------------------------

_request_ctx = threading.local()
_rate_limit_lock = threading.Lock()

BUSY_HTTP_CODES = {429, 500, 502, 503, 504}
BUSY_KEYWORDS = (
    "overloaded",
    "busy",
    "unavailable",
    "resource_exhausted",
    "resource exhausted",
    "rate limit",
    "quota",
    "try again",
    "temporarily",
    "high demand",
)


class GeminiBusyError(RuntimeError):
    """Raised when Gemini servers are busy, rate-limited, or transiently unavailable."""

    def __init__(self, message: str, upstream_status: int = 503, retry_after: float | None = None):
        super().__init__(message)
        self.upstream_status = upstream_status
        self.retry_after = retry_after


class GeminiLocalRateLimitError(RuntimeError):
    """Raised when local per-minute or daily Gemini quota protection blocks an outbound call."""

    def __init__(self, message: str, retryable: bool = True, retry_after: float | None = None, reason: str = "rpm"):
        super().__init__(message)
        self.retryable = retryable
        self.retry_after = retry_after
        self.reason = reason


def _today_key() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def get_rate_limit_status(conn: sqlite3.Connection) -> dict:
    rows = conn.execute(
        "SELECT key, value FROM settings WHERE key IN ('gemini_rpm_limit', 'gemini_daily_limit')"
    ).fetchall()
    s = {r["key"]: r["value"] for r in rows}
    try:
        rpm_limit = max(0, int(s.get("gemini_rpm_limit", "5") or 0))
    except ValueError:
        rpm_limit = 5
    try:
        daily_limit = max(0, int(s.get("gemini_daily_limit", "50") or 0))
    except ValueError:
        daily_limit = 50

    now_ts = time.time()
    window_start = now_ts - 60.0
    day_key = _today_key()

    minute_rows = conn.execute(
        "SELECT ts_epoch FROM gemini_usage_log WHERE ts_epoch >= ? ORDER BY ts_epoch ASC",
        (window_start,),
    ).fetchall()
    used_last_minute = len(minute_rows)
    used_today = conn.execute(
        "SELECT COUNT(*) FROM gemini_usage_log WHERE day_key = ?",
        (day_key,),
    ).fetchone()[0]

    next_slot_seconds = 0.0
    if rpm_limit > 0 and used_last_minute >= rpm_limit and minute_rows:
        oldest_in_window = float(minute_rows[0]["ts_epoch"])
        next_slot_seconds = max(1.0, round((oldest_in_window + 60.0) - now_ts, 1))

    return {
        "rpm_limit": rpm_limit,
        "daily_limit": daily_limit,
        "used_last_minute": used_last_minute,
        "used_today": used_today,
        "next_slot_seconds": next_slot_seconds,
        "day_key": day_key,
    }


def _reserve_gemini_slot(model: str, client_handles_retry: bool) -> None:
    """
    Atomically enforce the user's configured RPM & Daily safety cap before calling Gemini.
    - Daily cap reached -> hard block (prevents accidental charges / daily exhaustion).
    - RPM cap reached -> if client handles retry, raises retryable error with exact wait seconds
      so the UI shows a live countdown; otherwise sleeps locally until a slot opens.
    """
    while True:
        wait_sec = 0.0
        with _rate_limit_lock:
            with get_db() as conn:
                status = get_rate_limit_status(conn)
                rpm_limit = status["rpm_limit"]
                daily_limit = status["daily_limit"]
                used_today = status["used_today"]
                used_min = status["used_last_minute"]

                if daily_limit > 0 and used_today >= daily_limit:
                    raise GeminiLocalRateLimitError(
                        f"Daily Gemini safety cap reached ({used_today}/{daily_limit} requests today). "
                        "This protects you from unexpected quota exhaustion or charges. "
                        "You can adjust or reset the daily cap in Settings.",
                        retryable=False,
                        retry_after=None,
                        reason="daily",
                    )

                if rpm_limit > 0 and used_min >= rpm_limit:
                    wait_sec = max(1.0, status["next_slot_seconds"])
                    if client_handles_retry:
                        raise GeminiLocalRateLimitError(
                            f"Local rate limit reached ({used_min}/{rpm_limit} requests/min). "
                            f"Waiting {int(round(wait_sec))}s to avoid Gemini rate limits & charges...",
                            retryable=True,
                            retry_after=wait_sec,
                            reason="rpm",
                        )
                else:
                    # Reserve slot immediately before sending outbound HTTP request
                    now_ts = time.time()
                    conn.execute(
                        "INSERT INTO gemini_usage_log (id, model, ts_epoch, day_key) VALUES (?, ?, ?, ?)",
                        (str(uuid.uuid4()), model, now_ts, _today_key()),
                    )
                    # Prune old logs (> 7 days) occasionally
                    conn.execute(
                        "DELETE FROM gemini_usage_log WHERE ts_epoch < ?",
                        (now_ts - 7 * 86400,),
                    )
                    return

        if wait_sec > 0:
            time.sleep(min(wait_sec, 61.0))


def _is_busy_message(text: str) -> bool:
    low = (text or "").lower()
    return any(kw in low for kw in BUSY_KEYWORDS)


def _parse_retry_after(headers) -> float | None:
    if not headers:
        return None
    val = headers.get("Retry-After")
    if not val:
        return None
    try:
        return max(1.0, min(60.0, float(val)))
    except ValueError:
        return None


def _model_sort_key(model_id: str) -> tuple:
    """Sort newest, most capable Gemini models first."""
    low = model_id.lower()
    is_gemini = 0 if low.startswith("gemini-") else 1
    # Deprioritize specialized/legacy variants below general flash/pro models
    is_special = 1 if any(k in low for k in ("embedding", "aqa", "imagen", "veo", "tts", "audio", "robotics", "computer-use", "gemma")) else 0
    is_exp = 1 if any(k in low for k in ("exp", "legacy", "001")) else 0
    # Extract version number e.g. 3.0, 2.5, 2.0, 1.5
    m = re.search(r"gemini-(\d+(?:\.\d+)?)", low)
    ver = float(m.group(1)) if m else 0.0
    # Prefer flash & pro over flash-lite or nano at same version
    tier = 2
    if "pro" in low:
        tier = 0
    elif "flash" in low and "lite" not in low:
        tier = 1
    elif "lite" in low:
        tier = 2
    else:
        tier = 3
    return (is_gemini, is_special, -ver, is_exp, tier, low)


def fetch_gemini_models(api_key: str) -> list[dict]:
    """Query Google's Gemini API for all currently available generateContent models."""
    if not api_key:
        raise ValueError(
            "Gemini API token is not configured. Enter your Gemini API key first to fetch models."
        )

    models_out: list[dict] = []
    seen_ids: set[str] = set()
    page_token = ""

    for _ in range(4):
        qs = "pageSize=100" + (f"&pageToken={urllib.parse.quote(page_token)}" if page_token else "")
        url = f"https://generativelanguage.googleapis.com/v1beta/models?{qs}"
        req = urllib.request.Request(
            url,
            headers={"x-goog-api-key": api_key},
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            detail = err_body
            try:
                detail = json.loads(err_body).get("error", {}).get("message", err_body)
            except Exception:
                pass
            if e.code in BUSY_HTTP_CODES or _is_busy_message(detail):
                raise GeminiBusyError(
                    f"Gemini servers are busy while listing models ({e.code}): {detail}",
                    upstream_status=e.code,
                    retry_after=_parse_retry_after(e.headers),
                )
            raise RuntimeError(f"Failed to fetch Gemini models ({e.code}): {detail}")
        except urllib.error.URLError as e:
            raise GeminiBusyError(f"Could not reach Gemini API to list models: {e.reason}", upstream_status=503)

        for m in data.get("models") or []:
            methods = m.get("supportedGenerationMethods") or []
            if "generateContent" not in methods:
                continue
            raw_name = m.get("name") or ""
            model_id = raw_name.split("/", 1)[1] if raw_name.startswith("models/") else raw_name
            if not model_id or model_id in seen_ids:
                continue
            seen_ids.add(model_id)
            models_out.append(
                {
                    "id": model_id,
                    "display_name": m.get("displayName") or model_id,
                    "description": (m.get("description") or "")[:220],
                    "version": m.get("version") or "",
                    "input_token_limit": m.get("inputTokenLimit") or 0,
                    "output_token_limit": m.get("outputTokenLimit") or 0,
                }
            )

        page_token = data.get("nextPageToken") or ""
        if not page_token:
            break

    models_out.sort(key=lambda item: _model_sort_key(item["id"]))
    return models_out


def get_all_settings(conn: sqlite3.Connection) -> dict:
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    data = {r["key"]: r["value"] for r in rows}
    env_key = os.environ.get("GEMINI_API_KEY", "").strip()
    stored_key = data.get("gemini_api_key", "").strip()
    effective_key = stored_key or env_key
    masked = ""
    if effective_key:
        if len(effective_key) > 8:
            masked = f"{effective_key[:4]}...{effective_key[-4:]}"
        else:
            masked = "****"
    cached_models = []
    if data.get("gemini_models_cache"):
        try:
            cached_models = json.loads(data["gemini_models_cache"])
        except Exception:
            cached_models = []
    rl_status = get_rate_limit_status(conn)
    return {
        "gemini_api_key_configured": bool(effective_key),
        "gemini_api_key_source": "settings" if stored_key else ("env" if env_key else "none"),
        "gemini_api_key_masked": masked,
        "gemini_model": data.get("gemini_model") or DEFAULT_MODEL,
        "gemini_models_cache": cached_models,
        "gemini_models_updated_at": data.get("gemini_models_updated_at") or "",
        "gemini_rpm_limit": rl_status["rpm_limit"],
        "gemini_daily_limit": rl_status["daily_limit"],
        "rate_limit_status": rl_status,
        "student_name": data.get("student_name") or "Bachelor Student",
        "semester_name": data.get("semester_name") or "Current Semester",
        "daily_study_hours": float(data.get("daily_study_hours") or 4),
    }


def get_gemini_credentials(conn: sqlite3.Connection) -> tuple[str, str]:
    rows = conn.execute(
        "SELECT key, value FROM settings WHERE key IN ('gemini_api_key', 'gemini_model')"
    ).fetchall()
    s = {r["key"]: r["value"] for r in rows}
    api_key = (s.get("gemini_api_key") or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    model = (s.get("gemini_model") or DEFAULT_MODEL).strip()
    return api_key, model


def build_document_parts(docs: list[dict], max_text_chars: int = 24000) -> tuple[list[dict], list[str]]:
    """
    Build Gemini content parts from attached documents.
    - Text/docx/pptx files are included as structured text snippets.
    - PDFs and images are included natively via inlineData (base64).
    """
    parts: list[dict] = []
    included_names: list[str] = []
    total_inline = 0
    total_text = 0

    for doc in docs:
        fpath = UPLOADS_DIR / doc["stored_name"]
        if not fpath.exists():
            continue

        name = doc["original_name"]
        mime = (doc["mime_type"] or "").lower()
        role = doc.get("doc_role", "study_material")
        extracted = (doc.get("extracted_text") or "").strip()

        if extracted:
            remaining = max_text_chars - total_text
            if remaining > 300:
                snippet = extracted[: min(remaining, 8000)]
                total_text += len(snippet)
                parts.append(
                    {"text": f"\n--- Attached Document ({role}): {name} ---\n{snippet}\n--- End of {name} ---\n"}
                )
                included_names.append(name)
            continue

        if mime in INLINE_GEMINI_MIMES:
            size = fpath.stat().st_size
            if total_inline + size <= MAX_INLINE_TOTAL_BYTES:
                raw = fpath.read_bytes()
                total_inline += size
                norm_mime = "image/jpeg" if mime == "image/jpg" else mime
                parts.append({"text": f"\n[Attached {role} file: {name}]"})
                parts.append(
                    {
                        "inlineData": {
                            "mimeType": norm_mime,
                            "data": base64.b64encode(raw).decode("ascii"),
                        }
                    }
                )
                included_names.append(name)

    return parts, included_names


def call_gemini(
    api_key: str,
    model: str,
    parts: list[dict],
    system_instruction: str = "",
    expect_json: bool = False,
    temperature: float = 0.4,
    max_retries: int = 3,
) -> tuple[str, str]:
    if not api_key:
        raise ValueError(
            "Gemini API token is not configured. Open Settings to enter your Gemini API key."
        )

    safe_model = urllib.parse.quote(model.strip(), safe="")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{safe_model}:generateContent"

    payload: dict = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": 8192,
        },
    }
    if system_instruction:
        payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}
    if expect_json:
        payload["generationConfig"]["responseMimeType"] = "application/json"

    client_handles_retry = bool(getattr(_request_ctx, "client_retry", False))
    attempts = 1 if client_handles_retry else (max_retries + 1)
    encoded_payload = json.dumps(payload).encode("utf-8")

    body = None
    for attempt in range(attempts):
        # Enforce local per-minute & daily quota guard BEFORE contacting Google
        _reserve_gemini_slot(model, client_handles_retry)
        req = urllib.request.Request(
            url,
            data=encoded_payload,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": api_key,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            detail = err_body
            try:
                parsed = json.loads(err_body)
                detail = parsed.get("error", {}).get("message", err_body)
            except Exception:
                pass

            retry_after = _parse_retry_after(e.headers)
            is_busy = (e.code in BUSY_HTTP_CODES) or _is_busy_message(detail)
            if is_busy:
                busy_msg = f"Gemini servers are busy ({e.code}): {detail}"
                if not client_handles_retry and attempt < attempts - 1:
                    delay = retry_after if retry_after is not None else min(12.0, 2.0 * (2 ** attempt))
                    time.sleep(delay)
                    continue
                raise GeminiBusyError(busy_msg, upstream_status=e.code, retry_after=retry_after)

            if e.code in (400, 401, 403):
                raise RuntimeError(f"Gemini API authentication/request error ({e.code}): {detail}")
            if e.code == 404:
                raise RuntimeError(
                    f"Gemini model '{model}' was not found (404). Refresh models in Settings and pick an active model. Details: {detail}"
                )
            raise RuntimeError(f"Gemini API HTTP error ({e.code}): {detail}")
        except (urllib.error.URLError, TimeoutError) as e:
            reason = getattr(e, "reason", str(e))
            busy_msg = f"Gemini connection busy/timed out: {reason}"
            if not client_handles_retry and attempt < attempts - 1:
                time.sleep(min(10.0, 2.0 * (2 ** attempt)))
                continue
            raise GeminiBusyError(busy_msg, upstream_status=503)

    if not body:
        raise RuntimeError("Gemini returned no response.")

    candidates = body.get("candidates") or []
    if not candidates:
        block_reason = body.get("promptFeedback", {}).get("blockReason")
        raise RuntimeError(
            f"Gemini returned no content{f' (blocked: {block_reason})' if block_reason else ''}."
        )

    out_parts = candidates[0].get("content", {}).get("parts") or []
    text = "".join(p.get("text", "") for p in out_parts).strip()
    if not text:
        raise RuntimeError("Gemini returned an empty response.")
    return text, model


def parse_json_lenient(raw_text: str) -> dict:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if match:
            return json.loads(match.group(0))
        raise


def allocate_minutes_proportionally(weights: list[float], total_minutes: int) -> list[int]:
    """Distribute total_minutes across items proportionally to weights, summing cleanly to total_minutes."""
    n = len(weights)
    if n == 0:
        return []
    total_minutes = max(0, int(total_minutes))
    if total_minutes == 0:
        return [0] * n
    clean_w = [max(1.0, float(w or 1.0)) for w in weights]
    sum_w = sum(clean_w)
    # Use 5-minute steps when total_minutes >= n * 5 for clean study blocks
    step = 5 if total_minutes >= n * 5 else 1
    raw_alloc = [total_minutes * (w / sum_w) for w in clean_w]
    alloc = [max(step, int(round(x / step)) * step) for x in raw_alloc]
    diff = total_minutes - sum(alloc)
    # Adjust largest/smallest slots until sum matches total_minutes exactly
    guard = 0
    while diff != 0 and guard < 1000:
        guard += 1
        if diff > 0:
            delta = min(step, diff)
            idx = max(range(n), key=lambda i: raw_alloc[i] - alloc[i])
            alloc[idx] += delta
            diff -= delta
        else:
            candidates = [i for i in range(n) if alloc[i] > step]
            if not candidates:
                candidates = [i for i in range(n) if alloc[i] > 1]
                if not candidates:
                    break
                delta = 1
            else:
                delta = min(step, -diff)
            idx = max(candidates, key=lambda i: alloc[i] - raw_alloc[i])
            alloc[idx] -= delta
            diff += delta
    return alloc


def serialize_theme(row: sqlite3.Row) -> dict:
    d = dict(row)
    try:
        d["key_concepts"] = json.loads(d.get("key_concepts_json") or "[]")
    except Exception:
        d["key_concepts"] = []
    return d


# ---------------------------------------------------------------------------
# Query Helpers
# ---------------------------------------------------------------------------

def serialize_item(conn: sqlite3.Connection, row: sqlite3.Row, include_details: bool = False) -> dict:
    item = dict(row)
    chapters = [
        dict(c)
        for c in conn.execute(
            """
            SELECT c.*,
                (SELECT COUNT(*) FROM subtask_explanations e WHERE e.chapter_id = c.id) AS explanations_count,
                (SELECT COUNT(*) FROM subtask_tests t WHERE t.chapter_id = c.id) AS tests_count,
                (SELECT COUNT(*) FROM documents d WHERE d.chapter_id = c.id) AS docs_count
            FROM chapters c
            WHERE c.item_id = ?
            ORDER BY c.sort_order ASC, c.created_at ASC
            """,
            (item["id"],),
        ).fetchall()
    ]
    chapter_total_minutes = sum(int(c["estimated_minutes"] or 0) for c in chapters)
    chapter_remaining_minutes = sum(
        int(c["estimated_minutes"] or 0) for c in chapters if c["status"] != "done"
    )
    done_count = sum(1 for c in chapters if c["status"] == "done")
    doc_count = conn.execute(
        "SELECT COUNT(*) FROM documents WHERE item_id = ?", (item["id"],)
    ).fetchone()[0]

    item["chapters_total"] = len(chapters)
    item["chapters_done"] = done_count
    item["chapters_estimated_minutes"] = chapter_total_minutes
    item["chapters_remaining_minutes"] = chapter_remaining_minutes
    item["effective_estimated_minutes"] = (
        chapter_total_minutes if chapters and chapter_total_minutes > 0 else int(item["estimated_minutes"] or 0)
    )
    item["effective_remaining_minutes"] = (
        0
        if item["status"] in ("submitted", "graded")
        else (chapter_remaining_minutes if chapters else int(item["estimated_minutes"] or 0))
    )
    item["documents_count"] = doc_count

    if item.get("course_id"):
        course = conn.execute(
            "SELECT id, name, code, color FROM courses WHERE id = ?", (item["course_id"],)
        ).fetchone()
        item["course"] = dict(course) if course else None
    else:
        item["course"] = None

    if include_details:
        item["chapters"] = chapters
        docs = [
            dict(d)
            for d in conn.execute(
                """
                SELECT id, course_id, item_id, chapter_id, doc_role, original_name,
                       mime_type, size_bytes, uploaded_at,
                       CASE WHEN length(extracted_text) > 0 THEN 1 ELSE 0 END AS has_extracted_text
                FROM documents
                WHERE item_id = ?
                ORDER BY uploaded_at DESC
                """,
                (item["id"],),
            ).fetchall()
        ]
        item["documents"] = docs

    return item


def get_relevant_docs_for_chapter(conn: sqlite3.Connection, chapter: dict, item: dict) -> list[dict]:
    """Gather documents attached to the chapter, parent item, or parent course."""
    seen = set()
    docs = []
    queries = [
        ("SELECT * FROM documents WHERE chapter_id = ? ORDER BY uploaded_at DESC", (chapter["id"],)),
        ("SELECT * FROM documents WHERE item_id = ? ORDER BY uploaded_at DESC", (item["id"],)),
    ]
    if item.get("course_id"):
        queries.append(
            ("SELECT * FROM documents WHERE course_id = ? ORDER BY uploaded_at DESC", (item["course_id"],))
        )
    for sql, params in queries:
        for row in conn.execute(sql, params).fetchall():
            if row["id"] not in seen:
                seen.add(row["id"])
                docs.append(dict(row))
    return docs


def seed_demo_data(conn: sqlite3.Connection) -> dict:
    """Populate realistic bachelor student sample courses, tests, assignments, chapters, and notes."""
    now = datetime.now()
    now_iso = utc_now_iso()

    def future_date(days: int) -> str:
        return (now + timedelta(days=days)).strftime("%Y-%m-%d")

    c1 = str(uuid.uuid4())
    c2 = str(uuid.uuid4())
    c3 = str(uuid.uuid4())

    courses = [
        (c1, "Algorithms & Data Structures", "CS-204", "#4F46E5", "Prof. Dr. Weber", "Fall 2026", "Graph algorithms, dynamic programming, amortized analysis, and NP-completeness.", now_iso),
        (c2, "Linear Algebra II", "MATH-202", "#0D9488", "Prof. Dr. Lindner", "Fall 2026", "Eigenvalues, diagonalization, inner product spaces, SVD, and spectral theorem.", now_iso),
        (c3, "Database Systems", "CS-210", "#D97706", "Prof. Dr. Novak", "Fall 2026", "Relational algebra, B+ trees, query optimization, transactions, and ACID concurrency.", now_iso),
    ]
    conn.executemany(
        "INSERT INTO courses (id, name, code, color, instructor, semester, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        courses,
    )

    i1 = str(uuid.uuid4())
    i2 = str(uuid.uuid4())
    i3 = str(uuid.uuid4())
    i4 = str(uuid.uuid4())

    items = [
        (i1, c1, "test", "Midterm Exam: Graphs & Dynamic Programming", "Closed-book 90-minute midterm covering Chapters 1-4. Focus on correctness proofs and runtime bounds.", future_date(5), "in_progress", "high", 360, 120, 35.0, "", "", "", now_iso, now_iso),
        (i2, c2, "assignment", "Problem Set 5: Spectral Theorem & SVD", "Submit full mathematical proofs as PDF and Python verification notebook.", future_date(3), "in_progress", "high", 210, 60, 10.0, "", "", "", now_iso, now_iso),
        (i3, c3, "test", "Quiz 2: Normalization & B+ Trees", "Online + written short-answer quiz on 3NF/BCNF decomposition and index page splits.", future_date(9), "todo", "medium", 180, 0, 15.0, "", "", "", now_iso, now_iso),
        (i4, c1, "assignment", "Lab 3: Dijkstra & A* Pathfinding", "Implement priority queue Dijkstra and A* heuristic search on campus map graph.", future_date(-2), "submitted", "medium", 240, 225, 10.0, "1.3 (94%)", now_iso, "Submitted repo zip and benchmark report on Moodle.", now_iso, now_iso),
    ]
    conn.executemany(
        """INSERT INTO items (id, course_id, type, title, description, due_date, status, priority,
           estimated_minutes, actual_minutes, weight_percent, grade, submitted_at, submission_notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        items,
    )

    chapters = [
        (str(uuid.uuid4()), i1, "Ch. 1", "BFS, DFS & Topological Sorting", "Review adjacency list complexity O(V+E), cycle detection in directed graphs, and Kosaraju's SCC algorithm.", "done", 90, 1, now_iso, now_iso),
        (str(uuid.uuid4()), i1, "Ch. 2", "Shortest Paths (Dijkstra & Bellman-Ford)", "Practice relaxing edges, negative weight cycle detection, and prove greedy choice property for non-negative weights.", "in_progress", 120, 2, now_iso, now_iso),
        (str(uuid.uuid4()), i1, "Ch. 3", "Dynamic Programming & Memoization", "Solve knapsack, longest common subsequence, and matrix chain multiplication. Write recurrence relations clearly.", "todo", 150, 3, now_iso, now_iso),

        (str(uuid.uuid4()), i2, "Ch. 4.1", "Orthogonal Projections & Gram-Schmidt", "Derive orthonormal basis for exercises 1 and 2; verify orthogonality.", "done", 60, 1, now_iso, now_iso),
        (str(uuid.uuid4()), i2, "Ch. 4.2", "Symmetric Matrices & Spectral Theorem", "Prove that eigenvectors of distinct eigenvalues of a real symmetric matrix are orthogonal.", "in_progress", 90, 2, now_iso, now_iso),
        (str(uuid.uuid4()), i2, "Ch. 4.3", "Singular Value Decomposition (SVD)", "Compute full SVD of a 3x2 matrix by hand and relate singular values to matrix rank.", "todo", 60, 3, now_iso, now_iso),

        (str(uuid.uuid4()), i3, "Lecture 5", "Functional Dependencies & BCNF", "Practice Armstrong's axioms, attribute closure, and lossless-join decomposition.", "todo", 90, 1, now_iso, now_iso),
        (str(uuid.uuid4()), i3, "Lecture 6", "B+ Tree Insertion & Deletion Splits", "Trace order-4 B+ tree insertions and leaf node redistribution step by step.", "todo", 90, 2, now_iso, now_iso),

        (str(uuid.uuid4()), i4, "Part 1", "Min-Heap Priority Queue Implementation", "Implement decrease-key operation and unit tests.", "done", 120, 1, now_iso, now_iso),
        (str(uuid.uuid4()), i4, "Part 2", "A* Heuristic Admissibility Report", "Compare Euclidean vs Manhattan distance heuristics on 10k-node grid.", "done", 120, 2, now_iso, now_iso),
    ]
    conn.executemany(
        """INSERT INTO chapters (id, item_id, chapter_label, title, todo_notes, status,
           estimated_minutes, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        chapters,
    )

    # Create sample lecture notes markdown files so AI features have immediate rich context
    sample_notes = [
        (
            c1,
            i1,
            "lecture",
            "Lecture_04_Shortest_Paths_and_DP.md",
            """# CS-204 Lecture 4: Shortest Paths & Dynamic Programming

## 1. Shortest Path Algorithms
- **BFS**: Finds shortest path in unweighted graphs in O(V + E).
- **Dijkstra's Algorithm**: Non-negative edge weights. Uses a min-priority queue. Complexity: O((V + E) log V) with binary heap.
  - Key invariant: When vertex u is extracted from the priority queue, d[u] equals the true shortest path distance delta(s, u).
  - Fails with negative edges because a later path could reduce an already-settled vertex's distance.
- **Bellman-Ford**: Handles negative edge weights in O(VE). Relaxes all edges |V|-1 times. A V-th pass detects reachable negative-weight cycles.

## 2. Dynamic Programming Paradigm
Two required properties:
1. **Optimal Substructure**: An optimal solution contains optimal solutions to subproblems.
2. **Overlapping Subproblems**: Recursive subproblems repeat, enabling memoization or bottom-up tabulation.

### Classic Problems
- **0/1 Knapsack**: dp[i][w] = max(dp[i-1][w], val[i] + dp[i-1][w - wt[i]]). Pseudo-polynomial O(nW).
- **Longest Common Subsequence (LCS)**: O(mn) time and space (optimizable to O(min(m, n)) space).
""",
        ),
        (
            c2,
            i2,
            "lecture",
            "Lecture_07_Spectral_Theorem_and_SVD.md",
            """# MATH-202 Lecture 7: Spectral Theorem & SVD

## Spectral Theorem (Real Symmetric Matrices)
Every real symmetric n x n matrix A (A = A^T) has:
1. Only real eigenvalues.
2. Eigenvectors corresponding to distinct eigenvalues are mutually orthogonal.
3. Orthogonal diagonalization: A = Q Lambda Q^T, where Q is orthogonal (Q^T Q = I) and Lambda is diagonal.

## Singular Value Decomposition (SVD)
Any real m x n matrix A can be factored as A = U Sigma V^T:
- U (m x m orthogonal): left singular vectors (eigenvectors of A A^T).
- V (n x n orthogonal): right singular vectors (eigenvectors of A^T A).
- Sigma (m x n diagonal): non-negative singular values sigma_1 >= sigma_2 >= ... >= 0, equal to sqrt(eigenvalues of A^T A).
- Rank of A equals the number of non-zero singular values.
""",
        ),
        (
            c3,
            i3,
            "lecture",
            "Lecture_05_BCNF_and_BPlusTrees.md",
            """# CS-210 Lecture 5 & 6: Normalization & B+ Trees

## Functional Dependencies & Normal Forms
- **BCNF**: For every non-trivial FD X -> Y, X must be a superkey. Guarantees no redundancy from FDs, but may not always preserve all FDs.
- **3NF**: For every non-trivial FD X -> Y, either X is a superkey OR every attribute in Y is prime (part of some candidate key). Always achievable with lossless join and dependency preservation.

## B+ Trees
- Balanced search tree optimized for disk/page I/O.
- All actual record pointers reside in leaf nodes; leaf nodes are linked in a doubly linked list for fast range scans.
- Internal nodes store separator keys and child page pointers.
- Insertion overflow splits node at midpoint and pushes/copies middle key up.
""",
        ),
    ]

    for course_id, item_id, role, fname, content in sample_notes:
        doc_id = str(uuid.uuid4())
        stored = f"{doc_id}_{fname}"
        fpath = UPLOADS_DIR / stored
        raw = content.encode("utf-8")
        fpath.write_bytes(raw)
        conn.execute(
            """INSERT INTO documents (id, course_id, item_id, chapter_id, doc_role, original_name,
               stored_name, mime_type, size_bytes, extracted_text, uploaded_at)
               VALUES (?, ?, ?, NULL, ?, ?, ?, 'text/markdown', ?, ?, ?)""",
            (doc_id, course_id, item_id, role, fname, stored, len(raw), content, now_iso),
        )

    return {"courses_created": len(courses), "items_created": len(items), "chapters_created": len(chapters)}


# ---------------------------------------------------------------------------
# HTTP Request Handler
# ---------------------------------------------------------------------------

class StudyPlannerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, format: str, *args) -> None:
        # Clean concise server logging
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {self.address_string()} - {format % args}")

    def send_json(self, data: dict | list, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message: str, status: int = 400) -> None:
        self.send_json({"error": message}, status=status)

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length == 0:
            return {}
        if length > MAX_UPLOAD_BYTES * 2:
            raise ValueError("Request body too large.")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path.startswith("/api/"):
            try:
                self.handle_api_get(path, query)
            except ValueError as e:
                self.send_error_json(str(e), 400)
            except Exception as e:
                self.send_error_json(f"Server error: {e}", 500)
            return

        # Serve static frontend files (SPA fallback to index.html)
        if path == "/" or not (STATIC_DIR / path.lstrip("/")).exists():
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if not path.startswith("/api/"):
            self.send_error_json("Not found", 404)
            return
        _request_ctx.client_retry = self.headers.get("X-Client-Retry") == "1"
        try:
            body = self.read_json_body()
            self.handle_api_post(path, body)
        except ValueError as e:
            self.send_error_json(str(e), 400)
        except GeminiLocalRateLimitError as e:
            self.send_json(
                {
                    "error": str(e),
                    "retryable": e.retryable,
                    "local_rate_limit": True,
                    "rate_limit_reason": e.reason,
                    "upstream_status": "Rate Guard",
                    "retry_after": e.retry_after,
                },
                status=429,
            )
        except GeminiBusyError as e:
            self.send_json(
                {
                    "error": str(e),
                    "retryable": True,
                    "upstream_status": e.upstream_status,
                    "retry_after": e.retry_after,
                },
                status=503,
            )
        except RuntimeError as e:
            self.send_error_json(str(e), 502)
        except Exception as e:
            self.send_error_json(f"Server error: {e}", 500)
        finally:
            _request_ctx.client_retry = False

    def do_PUT(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if not path.startswith("/api/"):
            self.send_error_json("Not found", 404)
            return
        try:
            body = self.read_json_body()
            self.handle_api_put(path, body)
        except ValueError as e:
            self.send_error_json(str(e), 400)
        except Exception as e:
            self.send_error_json(f"Server error: {e}", 500)

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if not path.startswith("/api/"):
            self.send_error_json("Not found", 404)
            return
        try:
            self.handle_api_delete(path)
        except ValueError as e:
            self.send_error_json(str(e), 400)
        except Exception as e:
            self.send_error_json(f"Server error: {e}", 500)

    # ---------------- API GET ----------------

    def handle_api_get(self, path: str, query: dict) -> None:
        with get_db() as conn:
            if path == "/api/health":
                self.send_json({"ok": True, "time": utc_now_iso()})
                return

            if path == "/api/bootstrap":
                settings = get_all_settings(conn)
                courses = [
                    dict(r)
                    for r in conn.execute(
                        """
                        SELECT c.*,
                            (SELECT COUNT(*) FROM items i WHERE i.course_id = c.id) AS items_count,
                            (SELECT COUNT(*) FROM documents d WHERE d.course_id = c.id) AS docs_count,
                            (SELECT COUNT(*) FROM course_themes th WHERE th.course_id = c.id) AS themes_count
                        FROM courses c
                        ORDER BY c.name ASC
                        """
                    ).fetchall()
                ]
                item_rows = conn.execute(
                    "SELECT * FROM items ORDER BY CASE WHEN due_date = '' THEN 1 ELSE 0 END, due_date ASC, created_at DESC"
                ).fetchall()
                items = [serialize_item(conn, r, include_details=False) for r in item_rows]
                docs = [
                    dict(d)
                    for d in conn.execute(
                        """
                        SELECT id, course_id, item_id, chapter_id, doc_role, original_name,
                               mime_type, size_bytes, uploaded_at,
                               CASE WHEN length(extracted_text) > 0 THEN 1 ELSE 0 END AS has_extracted_text
                        FROM documents
                        ORDER BY uploaded_at DESC
                        """
                    ).fetchall()
                ]
                overviews = [
                    dict(o)
                    for o in conn.execute(
                        "SELECT id, course_id, scope_label, overview_json, content_md, model_used, created_at FROM ai_overviews ORDER BY created_at DESC LIMIT 12"
                    ).fetchall()
                ]
                themes = [
                    serialize_theme(t)
                    for t in conn.execute(
                        "SELECT * FROM course_themes ORDER BY created_at DESC"
                    ).fetchall()
                ]
                quiz_history = [
                    dict(q)
                    for q in conn.execute(
                        """
                        SELECT t.id, t.title, t.difficulty, t.last_score, t.last_total, t.attempted_at,
                               c.title AS chapter_title, c.chapter_label,
                               i.title AS item_title, i.course_id,
                               co.name AS course_name, co.color AS course_color
                        FROM subtask_tests t
                        JOIN chapters c ON c.id = t.chapter_id
                        JOIN items i ON i.id = c.item_id
                        LEFT JOIN courses co ON co.id = i.course_id
                        WHERE t.last_score IS NOT NULL AND t.last_total IS NOT NULL AND t.last_total > 0
                        ORDER BY t.attempted_at ASC
                        LIMIT 40
                        """
                    ).fetchall()
                ]
                self.send_json(
                    {
                        "settings": settings,
                        "courses": courses,
                        "items": items,
                        "documents": docs,
                        "overviews": overviews,
                        "themes": themes,
                        "quiz_history": quiz_history,
                    }
                )
                return

            if path == "/api/themes":
                rows = conn.execute("SELECT * FROM course_themes ORDER BY created_at DESC").fetchall()
                self.send_json([serialize_theme(r) for r in rows])
                return

            if path == "/api/settings":
                self.send_json(get_all_settings(conn))
                return

            if path == "/api/settings/rate-limit":
                self.send_json(get_rate_limit_status(conn))
                return

            if path == "/api/courses":
                rows = conn.execute("SELECT * FROM courses ORDER BY name ASC").fetchall()
                self.send_json([dict(r) for r in rows])
                return

            if path == "/api/items":
                rows = conn.execute(
                    "SELECT * FROM items ORDER BY CASE WHEN due_date = '' THEN 1 ELSE 0 END, due_date ASC"
                ).fetchall()
                self.send_json([serialize_item(conn, r, include_details=False) for r in rows])
                return

            m = re.match(r"^/api/items/([^/]+)$", path)
            if m:
                row = conn.execute("SELECT * FROM items WHERE id = ?", (m.group(1),)).fetchone()
                if not row:
                    self.send_error_json("Item not found", 404)
                    return
                self.send_json(serialize_item(conn, row, include_details=True))
                return

            m = re.match(r"^/api/chapters/([^/]+)/explanations$", path)
            if m:
                rows = conn.execute(
                    "SELECT * FROM subtask_explanations WHERE chapter_id = ? ORDER BY created_at DESC",
                    (m.group(1),),
                ).fetchall()
                self.send_json([dict(r) for r in rows])
                return

            m = re.match(r"^/api/chapters/([^/]+)/tests$", path)
            if m:
                rows = conn.execute(
                    "SELECT * FROM subtask_tests WHERE chapter_id = ? ORDER BY created_at DESC",
                    (m.group(1),),
                ).fetchall()
                out = []
                for r in rows:
                    d = dict(r)
                    d["questions"] = json.loads(d["questions_json"]) if d["questions_json"] else []
                    d["last_answers"] = json.loads(d["last_answers_json"]) if d["last_answers_json"] else {}
                    d["last_feedback"] = json.loads(d["last_feedback_json"]) if d["last_feedback_json"] else {}
                    out.append(d)
                self.send_json(out)
                return

            if path == "/api/documents":
                rows = conn.execute(
                    """
                    SELECT id, course_id, item_id, chapter_id, doc_role, original_name,
                           mime_type, size_bytes, uploaded_at
                    FROM documents ORDER BY uploaded_at DESC
                    """
                ).fetchall()
                self.send_json([dict(r) for r in rows])
                return

            m = re.match(r"^/api/documents/([^/]+)/download$", path)
            if m:
                doc = conn.execute("SELECT * FROM documents WHERE id = ?", (m.group(1),)).fetchone()
                if not doc:
                    self.send_error_json("Document not found", 404)
                    return
                fpath = UPLOADS_DIR / doc["stored_name"]
                if not fpath.exists():
                    self.send_error_json("Stored file missing on disk", 404)
                    return
                raw = fpath.read_bytes()
                inline = query.get("inline", ["0"])[0] == "1"
                disposition = "inline" if inline else "attachment"
                safe_name = re.sub(r'["\\\r\n]', "_", doc["original_name"])
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", doc["mime_type"] or "application/octet-stream")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Content-Disposition", f'{disposition}; filename="{safe_name}"')
                self.end_headers()
                self.wfile.write(raw)
                return

            if path == "/api/ai/overviews":
                rows = conn.execute(
                    "SELECT * FROM ai_overviews ORDER BY created_at DESC LIMIT 20"
                ).fetchall()
                self.send_json([dict(r) for r in rows])
                return

            self.send_error_json("Endpoint not found", 404)

    # ---------------- API POST ----------------

    def handle_api_post(self, path: str, body: dict) -> None:
        with get_db() as conn:
            if path == "/api/seed-demo":
                res = seed_demo_data(conn)
                self.send_json({"ok": True, **res}, 201)
                return

            if path == "/api/settings/reset-usage":
                conn.execute("DELETE FROM gemini_usage_log")
                self.send_json({"ok": True, "rate_limit_status": get_rate_limit_status(conn)})
                return

            if path == "/api/settings/gemini-models":
                api_key = (body.get("api_key") or "").strip()
                saved_key, _ = get_gemini_credentials(conn)
                use_key = api_key or saved_key
                models = fetch_gemini_models(use_key)
                now = utc_now_iso()
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES ('gemini_models_cache', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (json.dumps(models, ensure_ascii=False),),
                )
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES ('gemini_models_updated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (now,),
                )
                self.send_json({"models": models, "count": len(models), "updated_at": now})
                return

            if path == "/api/settings/test-gemini":
                api_key = (body.get("api_key") or "").strip()
                model = (body.get("model") or "").strip()
                saved_key, saved_model = get_gemini_credentials(conn)
                use_key = api_key or saved_key
                use_model = model or saved_model
                t0 = time.time()
                text, used_model = call_gemini(
                    use_key,
                    use_model,
                    [{"text": "Reply with exactly: OK"}],
                    temperature=0.0,
                )
                latency_ms = int((time.time() - t0) * 1000)
                self.send_json(
                    {
                        "ok": True,
                        "model": used_model,
                        "reply": text[:120],
                        "latency_ms": latency_ms,
                    }
                )
                return

            if path == "/api/courses":
                name = (body.get("name") or "").strip()
                if not name:
                    raise ValueError("Course name is required.")
                cid = str(uuid.uuid4())
                now = utc_now_iso()
                conn.execute(
                    """INSERT INTO courses (id, name, code, color, instructor, semester, description, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        cid,
                        name,
                        (body.get("code") or "").strip(),
                        (body.get("color") or "#4F46E5").strip(),
                        (body.get("instructor") or "").strip(),
                        (body.get("semester") or "").strip(),
                        (body.get("description") or "").strip(),
                        now,
                    ),
                )
                row = conn.execute("SELECT * FROM courses WHERE id = ?", (cid,)).fetchone()
                self.send_json(dict(row), 201)
                return

            if path == "/api/items":
                title = (body.get("title") or "").strip()
                if not title:
                    raise ValueError("Title is required.")
                item_type = body.get("type", "assignment")
                if item_type not in ("assignment", "test"):
                    raise ValueError("Type must be 'assignment' or 'test'.")
                iid = str(uuid.uuid4())
                now = utc_now_iso()
                est = max(0, int(body.get("estimated_minutes") or 0))
                weight = body.get("weight_percent")
                weight_val = float(weight) if weight not in (None, "") else None
                course_id = body.get("course_id") or None
                conn.execute(
                    """INSERT INTO items (id, course_id, type, title, description, due_date, status, priority,
                       estimated_minutes, actual_minutes, weight_percent, grade, submitted_at, submission_notes, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '', '', '', ?, ?)""",
                    (
                        iid,
                        course_id,
                        item_type,
                        title,
                        (body.get("description") or "").strip(),
                        (body.get("due_date") or "").strip(),
                        body.get("status") or "todo",
                        body.get("priority") or "medium",
                        est,
                        weight_val,
                        now,
                        now,
                    ),
                )
                # Optional initial chapters array
                init_chapters = body.get("chapters") or []
                for idx, ch in enumerate(init_chapters, start=1):
                    ch_title = (ch.get("title") or "").strip()
                    if not ch_title:
                        continue
                    conn.execute(
                        """INSERT INTO chapters (id, item_id, chapter_label, title, todo_notes, status,
                           estimated_minutes, sort_order, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?)""",
                        (
                            str(uuid.uuid4()),
                            iid,
                            (ch.get("chapter_label") or f"Ch. {idx}").strip(),
                            ch_title,
                            (ch.get("todo_notes") or "").strip(),
                            max(0, int(ch.get("estimated_minutes") or 30)),
                            idx,
                            now,
                            now,
                        ),
                    )
                row = conn.execute("SELECT * FROM items WHERE id = ?", (iid,)).fetchone()
                self.send_json(serialize_item(conn, row, include_details=True), 201)
                return

            m = re.match(r"^/api/items/([^/]+)/submit$", path)
            if m:
                iid = m.group(1)
                row = conn.execute("SELECT * FROM items WHERE id = ?", (iid,)).fetchone()
                if not row:
                    self.send_error_json("Item not found", 404)
                    return
                now = utc_now_iso()
                grade = (body.get("grade") if "grade" in body else row["grade"] or "").strip()
                notes = (body.get("submission_notes") if "submission_notes" in body else row["submission_notes"] or "").strip()
                actual = body.get("actual_minutes")
                actual_val = max(0, int(actual)) if actual not in (None, "") else row["actual_minutes"]
                course_id = body.get("course_id") if "course_id" in body else row["course_id"]
                title = (body.get("title") or row["title"]).strip()
                due_date = (body.get("due_date") if "due_date" in body else row["due_date"] or "").strip()
                item_type = body.get("type") or row["type"]
                requested_status = body.get("status")
                if requested_status in ("todo", "in_progress", "submitted", "graded"):
                    new_status = requested_status
                else:
                    new_status = "graded" if grade else "submitted"
                submitted_at = row["submitted_at"] or now
                if new_status in ("todo", "in_progress"):
                    submitted_at = ""
                conn.execute(
                    """UPDATE items
                       SET course_id = ?, type = ?, title = ?, due_date = ?,
                           status = ?, grade = ?, submission_notes = ?, actual_minutes = ?,
                           submitted_at = ?, updated_at = ?
                       WHERE id = ?""",
                    (course_id, item_type, title, due_date, new_status, grade, notes, actual_val, submitted_at, now, iid),
                )
                if body.get("mark_chapters_done"):
                    conn.execute(
                        "UPDATE chapters SET status = 'done', updated_at = ? WHERE item_id = ?",
                        (now, iid),
                    )
                updated = conn.execute("SELECT * FROM items WHERE id = ?", (iid,)).fetchone()
                self.send_json(serialize_item(conn, updated, include_details=True))
                return

            m = re.match(r"^/api/items/([^/]+)/rescale-time$", path)
            if m:
                iid = m.group(1)
                row = conn.execute("SELECT * FROM items WHERE id = ?", (iid,)).fetchone()
                if not row:
                    self.send_error_json("Item not found", 404)
                    return
                available_minutes = max(0, int(body.get("available_minutes") or 0))
                now = utc_now_iso()
                conn.execute(
                    "UPDATE items SET estimated_minutes = ?, updated_at = ? WHERE id = ?",
                    (available_minutes, now, iid),
                )
                open_chapters = conn.execute(
                    "SELECT id, estimated_minutes FROM chapters WHERE item_id = ? AND status != 'done' ORDER BY sort_order ASC, created_at ASC",
                    (iid,),
                ).fetchall()
                if open_chapters and available_minutes > 0:
                    weights = [max(1, int(c["estimated_minutes"] or 30)) for c in open_chapters]
                    alloc = allocate_minutes_proportionally(weights, available_minutes)
                    for ch, mins in zip(open_chapters, alloc):
                        conn.execute(
                            "UPDATE chapters SET estimated_minutes = ?, updated_at = ? WHERE id = ?",
                            (mins, now, ch["id"]),
                        )
                updated = conn.execute("SELECT * FROM items WHERE id = ?", (iid,)).fetchone()
                self.send_json(serialize_item(conn, updated, include_details=True))
                return

            m = re.match(r"^/api/items/([^/]+)/generate-subtasks$", path)
            if m:
                iid = m.group(1)
                row = conn.execute("SELECT * FROM items WHERE id = ?", (iid,)).fetchone()
                if not row:
                    self.send_error_json("Item not found", 404)
                    return
                item = dict(row)
                course = None
                if item.get("course_id"):
                    c_row = conn.execute("SELECT * FROM courses WHERE id = ?", (item["course_id"],)).fetchone()
                    course = dict(c_row) if c_row else None

                available_minutes = max(0, int(body.get("available_minutes") or item["estimated_minutes"] or 120))
                focus = (body.get("focus") or "").strip()
                replace_existing = bool(body.get("replace_existing", False))
                create_themes = bool(body.get("create_themes", True))
                doc_ids = body.get("document_ids") or []

                # Collect docs: explicit doc_ids + item docs + course docs
                seen = set()
                rel_docs = []
                if doc_ids:
                    placeholders = ",".join("?" for _ in doc_ids)
                    for d in conn.execute(f"SELECT * FROM documents WHERE id IN ({placeholders})", doc_ids).fetchall():
                        if d["id"] not in seen:
                            seen.add(d["id"])
                            rel_docs.append(dict(d))
                for d in conn.execute("SELECT * FROM documents WHERE item_id = ? ORDER BY uploaded_at DESC", (iid,)).fetchall():
                    if d["id"] not in seen:
                        seen.add(d["id"])
                        rel_docs.append(dict(d))
                if item.get("course_id"):
                    for d in conn.execute("SELECT * FROM documents WHERE course_id = ? ORDER BY uploaded_at DESC", (item["course_id"],)).fetchall():
                        if d["id"] not in seen:
                            seen.add(d["id"])
                            rel_docs.append(dict(d))

                api_key, model = get_gemini_credentials(conn)
                prompt_text = f"""You are an expert study planner for a bachelor's student.
Break down the following {item['type']} into clear, actionable chapter subtasks based on the attached course documents and details.
The student has exactly {available_minutes} minutes ({round(available_minutes / 60, 2)} hours) left to complete this!
Tailor the depth and estimated_minutes of each subtask so all subtasks together fit realistically within {available_minutes} minutes.

Course: {course['name'] + ' (' + course['code'] + ')' if course else 'General Study'}
{item['type'].title()}: {item['title']}
Description: {item['description'] or 'None'}
Due Date: {item['due_date'] or 'Not set'}
{f"Additional focus from student: {focus}" if focus else ""}

Return ONLY valid JSON matching this exact schema:
{{
  "subtasks": [
    {{
      "chapter_label": "Ch. 1",
      "title": "Concise chapter or subtask title",
      "todo_notes": "Concrete, actionable steps to complete or master based on the document",
      "estimated_minutes": 45
    }}
  ],
  "themes": [
    {{
      "title": "Key Theme Name",
      "importance": "high",
      "summary": "1-2 sentence overview of this theme",
      "key_concepts": ["Concept A", "Concept B"]
    }}
  ]
}}
Generate between 3 and 8 well-structured subtasks ordered logically for studying/completion.
"""
                parts = [{"text": prompt_text}]
                doc_parts, used_docs = build_document_parts(rel_docs, max_text_chars=26000)
                parts.extend(doc_parts)

                raw_json, used_model = call_gemini(
                    api_key,
                    model,
                    parts,
                    system_instruction="You are a university study coach who builds realistic, document-grounded subtask plans. Output strictly valid JSON.",
                    expect_json=True,
                    temperature=0.35,
                )
                parsed = parse_json_lenient(raw_json)
                raw_subtasks = parsed.get("subtasks") or []
                if not raw_subtasks:
                    raise RuntimeError("Gemini did not return any subtasks.")

                now = utc_now_iso()
                if replace_existing:
                    conn.execute("DELETE FROM chapters WHERE item_id = ?", (iid,))
                    start_order = 0
                else:
                    start_order = conn.execute(
                        "SELECT COALESCE(MAX(sort_order), 0) FROM chapters WHERE item_id = ?", (iid,)
                    ).fetchone()[0]

                # Scale generated subtask times cleanly to match student's time left
                weights = [max(5, int(st.get("estimated_minutes") or 30)) for st in raw_subtasks]
                allocated = allocate_minutes_proportionally(weights, available_minutes)

                created_chapters = []
                for idx, (st, mins) in enumerate(zip(raw_subtasks, allocated), start=1):
                    st_title = (st.get("title") or "").strip()
                    if not st_title:
                        continue
                    cid = str(uuid.uuid4())
                    conn.execute(
                        """INSERT INTO chapters (id, item_id, chapter_label, title, todo_notes, status,
                           estimated_minutes, sort_order, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?)""",
                        (
                            cid,
                            iid,
                            (st.get("chapter_label") or f"Part {start_order + idx}").strip(),
                            st_title,
                            (st.get("todo_notes") or "").strip(),
                            mins,
                            start_order + idx,
                            now,
                            now,
                        ),
                    )
                    created_chapters.append(cid)

                conn.execute(
                    "UPDATE items SET estimated_minutes = ?, updated_at = ? WHERE id = ?",
                    (available_minutes, now, iid),
                )

                created_themes = []
                if create_themes and item.get("course_id"):
                    primary_doc_id = rel_docs[0]["id"] if rel_docs else None
                    for th in parsed.get("themes") or []:
                        t_title = (th.get("title") or "").strip()
                        if not t_title:
                            continue
                        # Avoid duplicate exact theme title within same course
                        dup = conn.execute(
                            "SELECT id FROM course_themes WHERE course_id = ? AND lower(title) = lower(?)",
                            (item["course_id"], t_title),
                        ).fetchone()
                        if dup:
                            continue
                        tid = str(uuid.uuid4())
                        imp = th.get("importance") if th.get("importance") in ("low", "medium", "high") else "medium"
                        conn.execute(
                            """INSERT INTO course_themes (id, course_id, document_id, title, summary, importance, key_concepts_json, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                            (
                                tid,
                                item["course_id"],
                                primary_doc_id,
                                t_title,
                                (th.get("summary") or "").strip(),
                                imp,
                                json.dumps(th.get("key_concepts") or [], ensure_ascii=False),
                                now,
                            ),
                        )
                        created_themes.append(tid)

                updated = conn.execute("SELECT * FROM items WHERE id = ?", (iid,)).fetchone()
                self.send_json(
                    {
                        "item": serialize_item(conn, updated, include_details=True),
                        "subtasks_created": len(created_chapters),
                        "themes_created": len(created_themes),
                        "used_documents": used_docs,
                        "model_used": used_model,
                    },
                    201,
                )
                return

            if path == "/api/ai/generate-from-documents":
                course_id = body.get("course_id") or None
                doc_ids = body.get("document_ids") or []
                available_minutes = max(15, int(body.get("available_minutes") or 180))
                due_date = (body.get("due_date") or "").strip()
                goal_hint = (body.get("goal_hint") or "").strip()
                default_type = body.get("default_type") or "test"
                if default_type not in ("assignment", "test"):
                    default_type = "test"

                course = None
                if course_id:
                    c_row = conn.execute("SELECT * FROM courses WHERE id = ?", (course_id,)).fetchone()
                    course = dict(c_row) if c_row else None

                docs = []
                if doc_ids:
                    placeholders = ",".join("?" for _ in doc_ids)
                    docs = [
                        dict(d)
                        for d in conn.execute(
                            f"SELECT * FROM documents WHERE id IN ({placeholders}) ORDER BY uploaded_at DESC",
                            doc_ids,
                        ).fetchall()
                    ]
                elif course_id:
                    docs = [
                        dict(d)
                        for d in conn.execute(
                            "SELECT * FROM documents WHERE course_id = ? ORDER BY uploaded_at DESC",
                            (course_id,),
                        ).fetchall()
                    ]

                if not docs:
                    raise ValueError("Please upload or select at least one course document first.")

                # Infer course_id from document if not explicitly passed
                if not course_id and docs[0].get("course_id"):
                    course_id = docs[0]["course_id"]
                    c_row = conn.execute("SELECT * FROM courses WHERE id = ?", (course_id,)).fetchone()
                    course = dict(c_row) if c_row else None

                api_key, model = get_gemini_credentials(conn)

                prompt_text = f"""You are an academic study planner analyzing uploaded university course document(s) for a bachelor's student.
The student uploaded these document(s) and has exactly {available_minutes} minutes ({round(available_minutes / 60, 2)} hours) of study time left!
Your job is to extract:
1. All major **Themes** covered in the course document(s).
2. Actionable **Tasks** (tests/exam prep modules or assignments discovered or implied by the material — typically 1 to 3 cohesive tasks).
3. Inside EACH task, detailed chapter **Subtasks** telling the student what needs to be done, budgeted so the SUM of all subtasks across all tasks fits realistically within the student's {available_minutes} minutes left.
4. A concise lecture breakdown & study plan for the AI Lecture Overview.

Course: {course['name'] + ' (' + course['code'] + ')' if course else 'Auto-detect from document'}
Preferred primary task type: {default_type}
Target Due / Test Date: {due_date or 'Infer from document if explicitly mentioned, otherwise empty string ""'}
{f"Student goal / focus: {goal_hint}" if goal_hint else ""}

Return ONLY valid JSON matching this exact schema:
{{
  "executive_summary": "3-sentence overview of the uploaded material and study approach.",
  "themes": [
    {{
      "title": "Theme Name",
      "importance": "high",
      "summary": "Clear 1-2 sentence explanation of this theme.",
      "key_concepts": ["Concept 1", "Concept 2", "Concept 3"],
      "related_chapters": ["Ch. 1"]
    }}
  ],
  "tasks": [
    {{
      "type": "{default_type}",
      "title": "Clear task or exam prep title",
      "description": "Scope and learning goals from the document",
      "due_date": "{due_date}",
      "priority": "high",
      "subtasks": [
        {{
          "chapter_label": "Ch. 1",
          "title": "Specific chapter or topic subtask",
          "todo_notes": "Concrete things to read, solve, or prove",
          "estimated_minutes": 45
        }}
      ]
    }}
  ],
  "lecture_summaries": [
    {{
      "lecture_or_source": "Document or Lecture Section",
      "course": "{course['name'] if course else 'Course'}",
      "key_takeaways": ["Takeaway 1", "Takeaway 2"],
      "likely_exam_questions": ["Potential exam question"]
    }}
  ],
  "connections": ["How key themes relate to one another"],
  "study_plan": [
    {{
      "priority_order": 1,
      "focus_area": "Highest-impact topic to start with",
      "reason": "Why start here given the time left",
      "recommended_hours": 1.5
    }}
  ]
}}
"""
                parts = [{"text": prompt_text}]
                doc_parts, used_docs = build_document_parts(docs, max_text_chars=28000)
                parts.extend(doc_parts)

                raw_json, used_model = call_gemini(
                    api_key,
                    model,
                    parts,
                    system_instruction="You are an expert bachelor-level academic planner. Extract accurate themes, tasks, and realistic time-budgeted subtasks from course documents. Output strictly valid JSON.",
                    expect_json=True,
                    temperature=0.35,
                )
                parsed = parse_json_lenient(raw_json)
                now = utc_now_iso()
                primary_doc_id = docs[0]["id"]

                # 1. Save extracted themes
                created_themes = []
                for th in parsed.get("themes") or []:
                    t_title = (th.get("title") or "").strip()
                    if not t_title:
                        continue
                    tid = str(uuid.uuid4())
                    imp = th.get("importance") if th.get("importance") in ("low", "medium", "high") else "medium"
                    conn.execute(
                        """INSERT INTO course_themes (id, course_id, document_id, title, summary, importance, key_concepts_json, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            tid,
                            course_id,
                            primary_doc_id,
                            t_title,
                            (th.get("summary") or "").strip(),
                            imp,
                            json.dumps(th.get("key_concepts") or [], ensure_ascii=False),
                            now,
                        ),
                    )
                    created_themes.append(
                        serialize_theme(conn.execute("SELECT * FROM course_themes WHERE id = ?", (tid,)).fetchone())
                    )

                # 2. Scale all subtask durations across all tasks so total == available_minutes
                raw_tasks = parsed.get("tasks") or []
                if not raw_tasks:
                    raw_tasks = [
                        {
                            "type": default_type,
                            "title": f"Study Plan: {docs[0]['original_name']}",
                            "description": parsed.get("executive_summary", ""),
                            "due_date": due_date,
                            "priority": "high",
                            "subtasks": [
                                {
                                    "chapter_label": f"Theme {i + 1}",
                                    "title": t.get("title", f"Section {i + 1}"),
                                    "todo_notes": t.get("summary", ""),
                                    "estimated_minutes": 45,
                                }
                                for i, t in enumerate((parsed.get("themes") or [])[:5])
                            ],
                        }
                    ]

                flat_subtasks = []
                for t_idx, task in enumerate(raw_tasks):
                    sts = task.get("subtasks") or []
                    if not sts:
                        sts = [
                            {
                                "chapter_label": "Part 1",
                                "title": task.get("title", "Study Material"),
                                "todo_notes": task.get("description", ""),
                                "estimated_minutes": 45,
                            }
                        ]
                        task["subtasks"] = sts
                    for s_idx, st in enumerate(sts):
                        flat_subtasks.append((t_idx, s_idx, max(5, int(st.get("estimated_minutes") or 30))))

                alloc_all = allocate_minutes_proportionally([x[2] for x in flat_subtasks], available_minutes)
                for (t_idx, s_idx, _), mins in zip(flat_subtasks, alloc_all):
                    raw_tasks[t_idx]["subtasks"][s_idx]["estimated_minutes"] = mins

                created_items = []
                total_subtasks = 0
                for task in raw_tasks:
                    t_title = (task.get("title") or "").strip()
                    if not t_title:
                        continue
                    t_type = task.get("type") if task.get("type") in ("assignment", "test") else default_type
                    t_prio = task.get("priority") if task.get("priority") in ("low", "medium", "high") else "medium"
                    t_due = (due_date or task.get("due_date") or "").strip()
                    if t_due and not re.match(r"^\d{4}-\d{2}-\d{2}$", t_due):
                        t_due = due_date
                    subtasks = task.get("subtasks") or []
                    t_est = sum(int(st.get("estimated_minutes") or 0) for st in subtasks)
                    iid = str(uuid.uuid4())
                    conn.execute(
                        """INSERT INTO items (id, course_id, type, title, description, due_date, status, priority,
                           estimated_minutes, actual_minutes, weight_percent, grade, submitted_at, submission_notes, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, 0, NULL, '', '', '', ?, ?)""",
                        (
                            iid,
                            course_id,
                            t_type,
                            t_title,
                            (task.get("description") or "").strip(),
                            t_due,
                            t_prio,
                            t_est,
                            now,
                            now,
                        ),
                    )
                    for idx, st in enumerate(subtasks, start=1):
                        st_title = (st.get("title") or "").strip()
                        if not st_title:
                            continue
                        conn.execute(
                            """INSERT INTO chapters (id, item_id, chapter_label, title, todo_notes, status,
                               estimated_minutes, sort_order, created_at, updated_at)
                               VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?)""",
                            (
                                str(uuid.uuid4()),
                                iid,
                                (st.get("chapter_label") or f"Ch. {idx}").strip(),
                                st_title,
                                (st.get("todo_notes") or "").strip(),
                                max(5, int(st.get("estimated_minutes") or 30)),
                                idx,
                                now,
                                now,
                            ),
                        )
                        total_subtasks += 1

                    row = conn.execute("SELECT * FROM items WHERE id = ?", (iid,)).fetchone()
                    created_items.append(serialize_item(conn, row, include_details=True))

                # Link uploaded unlinked document(s) to the primary created item for immediate visibility
                if created_items:
                    first_item_id = created_items[0]["id"]
                    for d in docs:
                        if not d.get("item_id"):
                            conn.execute(
                                "UPDATE documents SET item_id = ? WHERE id = ?",
                                (first_item_id, d["id"]),
                            )

                # 3. Also store an AI Overview snapshot so the Overview tab updates immediately
                parsed["used_documents"] = used_docs
                scope_label = (
                    f"{course['code'] + ' — ' if course and course.get('code') else ''}{course['name']}"
                    if course
                    else docs[0]["original_name"]
                )
                ov_id = str(uuid.uuid4())
                conn.execute(
                    """INSERT INTO ai_overviews (id, course_id, scope_label, overview_json, content_md, model_used, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        ov_id,
                        course_id,
                        scope_label,
                        json.dumps(parsed, ensure_ascii=False),
                        parsed.get("executive_summary", ""),
                        used_model,
                        now,
                    ),
                )

                self.send_json(
                    {
                        "themes": created_themes,
                        "items": created_items,
                        "subtasks_created": total_subtasks,
                        "overview_id": ov_id,
                        "used_documents": used_docs,
                        "model_used": used_model,
                    },
                    201,
                )
                return

            m = re.match(r"^/api/items/([^/]+)/chapters$", path)
            if m:
                iid = m.group(1)
                if not conn.execute("SELECT id FROM items WHERE id = ?", (iid,)).fetchone():
                    self.send_error_json("Parent item not found", 404)
                    return
                title = (body.get("title") or "").strip()
                if not title:
                    raise ValueError("Chapter / subtask title is required.")
                max_order = conn.execute(
                    "SELECT COALESCE(MAX(sort_order), 0) FROM chapters WHERE item_id = ?", (iid,)
                ).fetchone()[0]
                cid = str(uuid.uuid4())
                now = utc_now_iso()
                conn.execute(
                    """INSERT INTO chapters (id, item_id, chapter_label, title, todo_notes, status,
                       estimated_minutes, sort_order, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        cid,
                        iid,
                        (body.get("chapter_label") or "").strip(),
                        title,
                        (body.get("todo_notes") or "").strip(),
                        body.get("status") or "todo",
                        max(0, int(body.get("estimated_minutes") or 30)),
                        max_order + 1,
                        now,
                        now,
                    ),
                )
                row = conn.execute(
                    """SELECT c.*, 0 AS explanations_count, 0 AS tests_count, 0 AS docs_count
                       FROM chapters c WHERE c.id = ?""",
                    (cid,),
                ).fetchone()
                self.send_json(dict(row), 201)
                return

            if path == "/api/documents":
                filename = os.path.basename((body.get("filename") or "").strip())
                if not filename:
                    raise ValueError("Filename is required.")
                content_b64 = body.get("content_base64") or ""
                if not content_b64:
                    raise ValueError("File content is empty.")
                try:
                    raw = base64.b64decode(content_b64)
                except Exception:
                    raise ValueError("Invalid base64 file payload.")
                if len(raw) > MAX_UPLOAD_BYTES:
                    raise ValueError("File exceeds maximum allowed size (25 MB).")

                doc_id = str(uuid.uuid4())
                safe_fname = re.sub(r"[^A-Za-z0-9._-]", "_", filename)
                stored_name = f"{doc_id}_{safe_fname}"
                fpath = UPLOADS_DIR / stored_name
                fpath.write_bytes(raw)

                mime = (body.get("mime_type") or "").strip()
                if not mime:
                    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"

                extracted = extract_text_from_file(fpath, filename, mime)
                now = utc_now_iso()
                course_id = body.get("course_id") or None
                item_id = body.get("item_id") or None
                chapter_id = body.get("chapter_id") or None

                # Auto-link course_id from item if not explicitly provided
                if item_id and not course_id:
                    it = conn.execute("SELECT course_id FROM items WHERE id = ?", (item_id,)).fetchone()
                    if it:
                        course_id = it["course_id"]

                conn.execute(
                    """INSERT INTO documents (id, course_id, item_id, chapter_id, doc_role, original_name,
                       stored_name, mime_type, size_bytes, extracted_text, uploaded_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        doc_id,
                        course_id,
                        item_id,
                        chapter_id,
                        body.get("doc_role") or "study_material",
                        filename,
                        stored_name,
                        mime,
                        len(raw),
                        extracted,
                        now,
                    ),
                )
                row = conn.execute(
                    """SELECT id, course_id, item_id, chapter_id, doc_role, original_name,
                              mime_type, size_bytes, uploaded_at,
                              CASE WHEN length(extracted_text) > 0 THEN 1 ELSE 0 END AS has_extracted_text
                       FROM documents WHERE id = ?""",
                    (doc_id,),
                ).fetchone()
                self.send_json(dict(row), 201)
                return

            # ---- AI: Generate Explanation for a Subtask / Chapter ----
            m = re.match(r"^/api/chapters/([^/]+)/explain$", path)
            if m:
                chapter_id = m.group(1)
                ch_row = conn.execute("SELECT * FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
                if not ch_row:
                    self.send_error_json("Chapter / subtask not found", 404)
                    return
                chapter = dict(ch_row)
                item = dict(conn.execute("SELECT * FROM items WHERE id = ?", (chapter["item_id"],)).fetchone())
                course = None
                if item.get("course_id"):
                    c_row = conn.execute("SELECT * FROM courses WHERE id = ?", (item["course_id"],)).fetchone()
                    course = dict(c_row) if c_row else None

                focus = (body.get("focus") or "").strip()
                include_docs = body.get("include_docs", True)

                api_key, model = get_gemini_credentials(conn)

                context_lines = [
                    "You are an expert university tutor helping a bachelor's student master a specific chapter/subtask.",
                    f"Course: {course['name']} ({course['code']})" if course else "Course: General Study",
                    f"Parent {item['type'].title()}: {item['title']}",
                    f"Parent Description: {item['description']}" if item["description"] else "",
                    f"Chapter / Section: {chapter['chapter_label']} — {chapter['title']}",
                    f"What needs to be done / Study Goals: {chapter['todo_notes']}" if chapter["todo_notes"] else "",
                    f"Estimated Study Time: {chapter['estimated_minutes']} minutes",
                ]
                if focus:
                    context_lines.append(f"Student's Specific Focus Request: {focus}")

                prompt_text = "\n".join(line for line in context_lines if line) + """

Write a clear, structured, bachelor-level study explanation in Markdown. Include:
1. **Core Concept & Intuition** — explain the "why" clearly before diving into formalism.
2. **Key Definitions, Formulas, or Rules** — concise and exam-ready.
3. **Worked Example** — walk through a concrete step-by-step example.
4. **Common Pitfalls & Exam Tips** — mistakes students frequently make on tests.
5. **Quick Checklist** — 3-5 bullet takeaways to verify understanding before moving on.

Ground your explanation in any attached lecture slides/documents if provided. Use clean Markdown formatting.
"""
                parts = [{"text": prompt_text}]
                used_docs = []
                if include_docs:
                    rel_docs = get_relevant_docs_for_chapter(conn, chapter, item)
                    doc_parts, used_docs = build_document_parts(rel_docs)
                    parts.extend(doc_parts)

                content_md, used_model = call_gemini(
                    api_key,
                    model,
                    parts,
                    system_instruction="You are a supportive, rigorous university teaching assistant for a bachelor's student.",
                    expect_json=False,
                    temperature=0.35,
                )

                exp_id = str(uuid.uuid4())
                now = utc_now_iso()
                conn.execute(
                    """INSERT INTO subtask_explanations (id, chapter_id, prompt_focus, content_md, model_used, created_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (exp_id, chapter_id, focus, content_md, used_model, now),
                )
                row = conn.execute(
                    "SELECT * FROM subtask_explanations WHERE id = ?", (exp_id,)
                ).fetchone()
                resp = dict(row)
                resp["used_documents"] = used_docs
                self.send_json(resp, 201)
                return

            # ---- AI: Generate Practice Test for a Subtask / Chapter ----
            m = re.match(r"^/api/chapters/([^/]+)/generate-test$", path)
            if m:
                chapter_id = m.group(1)
                ch_row = conn.execute("SELECT * FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
                if not ch_row:
                    self.send_error_json("Chapter / subtask not found", 404)
                    return
                chapter = dict(ch_row)
                item = dict(conn.execute("SELECT * FROM items WHERE id = ?", (chapter["item_id"],)).fetchone())
                course = None
                if item.get("course_id"):
                    c_row = conn.execute("SELECT * FROM courses WHERE id = ?", (item["course_id"],)).fetchone()
                    course = dict(c_row) if c_row else None

                difficulty = body.get("difficulty") or "medium"
                if difficulty not in ("easy", "medium", "hard"):
                    difficulty = "medium"
                q_count = max(3, min(12, int(body.get("question_count") or 5)))
                include_open = bool(body.get("include_open_ended", True))
                include_docs = body.get("include_docs", True)

                api_key, model = get_gemini_credentials(conn)

                open_note = (
                    "Include a mix of multiple-choice ('mcq') and 1-2 short-answer/conceptual ('short') questions."
                    if include_open
                    else "Make all questions multiple-choice ('mcq') with 4 distinct options."
                )

                prompt_text = f"""Create a bachelor-level practice test for this study chapter/subtask.
Course: {course['name'] + ' (' + course['code'] + ')' if course else 'General Study'}
Parent {item['type'].title()}: {item['title']}
Chapter: {chapter['chapter_label']} — {chapter['title']}
What needs to be done: {chapter['todo_notes'] or 'Master the core concepts and exam applications.'}
Difficulty: {difficulty}
Total questions: {q_count}
{open_note}

Return ONLY valid JSON matching this exact schema:
{{
  "title": "Short descriptive quiz title",
  "questions": [
    {{
      "id": "q1",
      "type": "mcq",
      "question": "Clear question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correct_index": 0,
      "explanation": "Why the correct answer is right and why others are wrong."
    }},
    {{
      "id": "q2",
      "type": "short",
      "question": "Short-answer or mini-proof question",
      "model_answer": "Complete ideal bachelor-level answer",
      "key_points": ["Key point 1", "Key point 2"],
      "explanation": "Grading rubric and intuition."
    }}
  ]
}}
Ground questions in attached lecture slides/documents if provided.
"""
                parts = [{"text": prompt_text}]
                used_docs = []
                if include_docs:
                    rel_docs = get_relevant_docs_for_chapter(conn, chapter, item)
                    doc_parts, used_docs = build_document_parts(rel_docs)
                    parts.extend(doc_parts)

                raw_json, used_model = call_gemini(
                    api_key,
                    model,
                    parts,
                    system_instruction="You are a university professor designing accurate, unambiguous exam practice questions. Output strictly valid JSON.",
                    expect_json=True,
                    temperature=0.45,
                )

                parsed = parse_json_lenient(raw_json)
                questions = parsed.get("questions") or []
                if not questions:
                    raise RuntimeError("Gemini returned a practice test with no questions.")

                # Normalize question ids
                for idx, q in enumerate(questions, start=1):
                    q.setdefault("id", f"q{idx}")
                    if q.get("type") not in ("mcq", "short"):
                        q["type"] = "mcq" if q.get("options") else "short"

                test_title = (parsed.get("title") or f"Practice Test: {chapter['title']}").strip()
                test_id = str(uuid.uuid4())
                now = utc_now_iso()
                conn.execute(
                    """INSERT INTO subtask_tests (id, chapter_id, title, difficulty, questions_json,
                       model_used, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (test_id, chapter_id, test_title, difficulty, json.dumps(questions), used_model, now),
                )
                self.send_json(
                    {
                        "id": test_id,
                        "chapter_id": chapter_id,
                        "title": test_title,
                        "difficulty": difficulty,
                        "questions": questions,
                        "last_answers": {},
                        "last_feedback": {},
                        "last_score": None,
                        "last_total": None,
                        "model_used": used_model,
                        "created_at": now,
                        "used_documents": used_docs,
                    },
                    201,
                )
                return

            # ---- Grade a Practice Test Attempt ----
            m = re.match(r"^/api/tests/([^/]+)/grade$", path)
            if m:
                test_id = m.group(1)
                row = conn.execute("SELECT * FROM subtask_tests WHERE id = ?", (test_id,)).fetchone()
                if not row:
                    self.send_error_json("Practice test not found", 404)
                    return
                questions = json.loads(row["questions_json"])
                answers = body.get("answers") or {}
                use_ai_grading = bool(body.get("use_ai_grading", True))

                feedback = {}
                score = 0.0
                total = float(len(questions))
                short_to_grade = []

                for q in questions:
                    qid = q["id"]
                    ans = answers.get(qid)
                    if q["type"] == "mcq":
                        is_correct = ans is not None and str(ans) == str(q.get("correct_index"))
                        pts = 1.0 if is_correct else 0.0
                        score += pts
                        feedback[qid] = {
                            "correct": is_correct,
                            "score": pts,
                            "max_score": 1.0,
                            "feedback": q.get("explanation") or "",
                        }
                    else:
                        text_ans = (str(ans) if ans is not None else "").strip()
                        if not text_ans:
                            feedback[qid] = {
                                "correct": False,
                                "score": 0.0,
                                "max_score": 1.0,
                                "feedback": "No answer submitted. Review the model answer below.",
                            }
                        else:
                            short_to_grade.append((q, text_ans))

                if short_to_grade:
                    api_key, model = get_gemini_credentials(conn)
                    graded_via_ai = False
                    if use_ai_grading and api_key:
                        try:
                            grading_items = [
                                {
                                    "id": q["id"],
                                    "question": q["question"],
                                    "model_answer": q.get("model_answer", ""),
                                    "key_points": q.get("key_points", []),
                                    "student_answer": ans_txt,
                                }
                                for q, ans_txt in short_to_grade
                            ]
                            g_prompt = (
                                "Grade these bachelor student short-answer responses fairly on a 0.0 to 1.0 scale "
                                "(e.g., 0, 0.5, 0.75, 1.0). Return ONLY JSON:\n"
                                '{"results": [{"id": "q2", "score": 0.8, "correct": true, "feedback": "Concise constructive feedback"}]}\n\n'
                                + json.dumps(grading_items, ensure_ascii=False)
                            )
                            raw_g, _ = call_gemini(
                                api_key,
                                model,
                                [{"text": g_prompt}],
                                system_instruction="You are a fair, concise university grader. Output strictly valid JSON.",
                                expect_json=True,
                                temperature=0.1,
                            )
                            parsed_g = parse_json_lenient(raw_g)
                            for res in parsed_g.get("results", []):
                                qid = res.get("id")
                                pts = max(0.0, min(1.0, float(res.get("score", 0.0))))
                                score += pts
                                feedback[qid] = {
                                    "correct": bool(res.get("correct", pts >= 0.7)),
                                    "score": round(pts, 2),
                                    "max_score": 1.0,
                                    "feedback": res.get("feedback", ""),
                                }
                            graded_via_ai = True
                        except Exception:
                            graded_via_ai = False

                    if not graded_via_ai:
                        for q, _ in short_to_grade:
                            if q["id"] not in feedback:
                                score += 0.5
                                feedback[q["id"]] = {
                                    "correct": False,
                                    "score": 0.5,
                                    "max_score": 1.0,
                                    "feedback": "Compare your response with the model answer and key points below.",
                                }

                now = utc_now_iso()
                score = round(score, 2)
                conn.execute(
                    """UPDATE subtask_tests
                       SET last_answers_json = ?, last_score = ?, last_total = ?,
                           last_feedback_json = ?, attempted_at = ?
                       WHERE id = ?""",
                    (json.dumps(answers), score, total, json.dumps(feedback), now, test_id),
                )
                self.send_json(
                    {
                        "id": test_id,
                        "score": score,
                        "total": total,
                        "percent": round((score / total) * 100, 1) if total > 0 else 0,
                        "feedback": feedback,
                        "attempted_at": now,
                    }
                )
                return

            # ---- AI: Generate Lectures & Themes Overview ----
            if path == "/api/ai/overview":
                course_id = body.get("course_id") or None
                focus_prompt = (body.get("focus_prompt") or "").strip()
                api_key, model = get_gemini_credentials(conn)
                settings = get_all_settings(conn)

                if course_id:
                    courses = [
                        dict(r) for r in conn.execute("SELECT * FROM courses WHERE id = ?", (course_id,)).fetchall()
                    ]
                    if not courses:
                        self.send_error_json("Selected course not found", 404)
                        return
                    scope_label = f"{courses[0]['code'] + ' — ' if courses[0]['code'] else ''}{courses[0]['name']}"
                    items = [
                        serialize_item(conn, r, include_details=True)
                        for r in conn.execute(
                            "SELECT * FROM items WHERE course_id = ? ORDER BY due_date ASC", (course_id,)
                        ).fetchall()
                    ]
                    docs = [
                        dict(r)
                        for r in conn.execute(
                            "SELECT * FROM documents WHERE course_id = ? ORDER BY uploaded_at DESC", (course_id,)
                        ).fetchall()
                    ]
                else:
                    courses = [dict(r) for r in conn.execute("SELECT * FROM courses ORDER BY name ASC").fetchall()]
                    scope_label = "All Courses & Lectures"
                    items = [
                        serialize_item(conn, r, include_details=True)
                        for r in conn.execute("SELECT * FROM items ORDER BY due_date ASC").fetchall()
                    ]
                    docs = [
                        dict(r)
                        for r in conn.execute("SELECT * FROM documents ORDER BY uploaded_at DESC").fetchall()
                    ]

                if not courses and not items and not docs:
                    raise ValueError(
                        "Add at least one course, assignment/test, or lecture document before generating an AI overview."
                    )

                # Build structured study snapshot for Gemini
                snapshot = {
                    "today": datetime.now().strftime("%Y-%m-%d"),
                    "semester": settings.get("semester_name"),
                    "daily_study_hours_target": settings.get("daily_study_hours"),
                    "scope": scope_label,
                    "courses": [
                        {
                            "name": c["name"],
                            "code": c["code"],
                            "instructor": c["instructor"],
                            "description": c["description"],
                        }
                        for c in courses
                    ],
                    "assignments_and_tests": [
                        {
                            "type": it["type"],
                            "title": it["title"],
                            "course": it["course"]["name"] if it.get("course") else "Unassigned",
                            "due_date": it["due_date"],
                            "status": it["status"],
                            "priority": it["priority"],
                            "estimated_minutes_remaining": it["effective_remaining_minutes"],
                            "description": it["description"],
                            "chapters": [
                                {
                                    "label": ch["chapter_label"],
                                    "title": ch["title"],
                                    "todo_notes": ch["todo_notes"],
                                    "status": ch["status"],
                                    "estimated_minutes": ch["estimated_minutes"],
                                }
                                for ch in it.get("chapters", [])
                            ],
                        }
                        for it in items
                    ],
                }

                prompt_text = f"""Analyze this bachelor student's entire study landscape (courses, lectures, chapters, deadlines, time estimates, and attached lecture documents).
{f"Additional student focus: {focus_prompt}" if focus_prompt else ""}

Study Data Snapshot (JSON):
{json.dumps(snapshot, ensure_ascii=False, indent=2)}

Return ONLY valid JSON matching this exact schema:
{{
  "executive_summary": "3-4 sentence synthesis of the current academic workload, key themes, and exam readiness.",
  "themes": [
    {{
      "title": "Major Theme Name",
      "course": "Course name or Cross-Course",
      "importance": "high",
      "summary": "Clear conceptual overview of this theme.",
      "key_concepts": ["Concept 1", "Concept 2", "Concept 3"],
      "related_chapters": ["Ch. 1", "Lecture 4"]
    }}
  ],
  "lecture_summaries": [
    {{
      "lecture_or_source": "Lecture / Document / Module Title",
      "course": "Course Name",
      "key_takeaways": ["Takeaway 1", "Takeaway 2"],
      "likely_exam_questions": ["Potential exam question or proof"]
    }}
  ],
  "connections": [
    "How Theme A builds on or connects to Theme B..."
  ],
  "study_plan": [
    {{
      "priority_order": 1,
      "focus_area": "What to study next",
      "reason": "Deadline urgency + dependency rationale",
      "recommended_hours": 2.5
    }}
  ],
  "markdown_notes": "Optional extra study advice or formula highlights in concise Markdown."
}}
"""
                parts = [{"text": prompt_text}]
                doc_parts, used_docs = build_document_parts(docs, max_text_chars=28000)
                parts.extend(doc_parts)

                raw_json, used_model = call_gemini(
                    api_key,
                    model,
                    parts,
                    system_instruction="You are an academic advisor and subject-matter synthesizer for a bachelor's student. Produce insightful, accurate structured JSON.",
                    expect_json=True,
                    temperature=0.35,
                )

                parsed = parse_json_lenient(raw_json)
                parsed["used_documents"] = used_docs
                ov_id = str(uuid.uuid4())
                now = utc_now_iso()
                conn.execute(
                    """INSERT INTO ai_overviews (id, course_id, scope_label, overview_json, content_md, model_used, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        ov_id,
                        course_id,
                        scope_label,
                        json.dumps(parsed, ensure_ascii=False),
                        parsed.get("markdown_notes", ""),
                        used_model,
                        now,
                    ),
                )
                row = conn.execute("SELECT * FROM ai_overviews WHERE id = ?", (ov_id,)).fetchone()
                self.send_json(dict(row), 201)
                return

            self.send_error_json("Endpoint not found", 404)

    # ---------------- API PUT ----------------

    def handle_api_put(self, path: str, body: dict) -> None:
        with get_db() as conn:
            if path == "/api/settings":
                allowed = {
                    "gemini_api_key",
                    "gemini_model",
                    "gemini_rpm_limit",
                    "gemini_daily_limit",
                    "student_name",
                    "semester_name",
                    "daily_study_hours",
                }
                for key, val in body.items():
                    if key not in allowed:
                        continue
                    # Don't overwrite stored API key if blank unless explicitly cleared
                    if key == "gemini_api_key" and val is None:
                        continue
                    if key in ("gemini_rpm_limit", "gemini_daily_limit"):
                        try:
                            val = str(max(0, int(val)))
                        except (ValueError, TypeError):
                            raise ValueError(f"{key} must be a non-negative integer.")
                    conn.execute(
                        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (key, str(val).strip()),
                    )
                self.send_json(get_all_settings(conn))
                return

            m = re.match(r"^/api/courses/([^/]+)$", path)
            if m:
                cid = m.group(1)
                row = conn.execute("SELECT * FROM courses WHERE id = ?", (cid,)).fetchone()
                if not row:
                    self.send_error_json("Course not found", 404)
                    return
                conn.execute(
                    """UPDATE courses
                       SET name = ?, code = ?, color = ?, instructor = ?, semester = ?, description = ?
                       WHERE id = ?""",
                    (
                        (body.get("name") or row["name"]).strip(),
                        (body.get("code") if "code" in body else row["code"]).strip(),
                        (body.get("color") or row["color"]).strip(),
                        (body.get("instructor") if "instructor" in body else row["instructor"]).strip(),
                        (body.get("semester") if "semester" in body else row["semester"]).strip(),
                        (body.get("description") if "description" in body else row["description"]).strip(),
                        cid,
                    ),
                )
                updated = conn.execute("SELECT * FROM courses WHERE id = ?", (cid,)).fetchone()
                self.send_json(dict(updated))
                return

            m = re.match(r"^/api/items/([^/]+)$", path)
            if m:
                iid = m.group(1)
                row = conn.execute("SELECT * FROM items WHERE id = ?", (iid,)).fetchone()
                if not row:
                    self.send_error_json("Item not found", 404)
                    return
                now = utc_now_iso()
                weight = body.get("weight_percent") if "weight_percent" in body else row["weight_percent"]
                weight_val = float(weight) if weight not in (None, "") else None
                new_status = body.get("status") or row["status"]
                submitted_at = row["submitted_at"] or ""
                if new_status in ("submitted", "graded") and not submitted_at:
                    submitted_at = now
                elif new_status in ("todo", "in_progress"):
                    submitted_at = ""
                conn.execute(
                    """UPDATE items
                       SET course_id = ?, type = ?, title = ?, description = ?, due_date = ?,
                           status = ?, priority = ?, estimated_minutes = ?, actual_minutes = ?,
                           weight_percent = ?, grade = ?, submitted_at = ?, submission_notes = ?, updated_at = ?
                       WHERE id = ?""",
                    (
                        body.get("course_id") if "course_id" in body else row["course_id"],
                        body.get("type") or row["type"],
                        (body.get("title") or row["title"]).strip(),
                        (body.get("description") if "description" in body else row["description"]).strip(),
                        (body.get("due_date") if "due_date" in body else row["due_date"]).strip(),
                        new_status,
                        body.get("priority") or row["priority"],
                        max(0, int(body.get("estimated_minutes") if "estimated_minutes" in body else row["estimated_minutes"])),
                        max(0, int(body.get("actual_minutes") if "actual_minutes" in body else row["actual_minutes"])),
                        weight_val,
                        (body.get("grade") if "grade" in body else row["grade"]).strip(),
                        submitted_at,
                        (body.get("submission_notes") if "submission_notes" in body else row["submission_notes"]).strip(),
                        now,
                        iid,
                    ),
                )
                updated = conn.execute("SELECT * FROM items WHERE id = ?", (iid,)).fetchone()
                self.send_json(serialize_item(conn, updated, include_details=True))
                return

            m = re.match(r"^/api/themes/([^/]+)$", path)
            if m:
                tid = m.group(1)
                row = conn.execute("SELECT * FROM course_themes WHERE id = ?", (tid,)).fetchone()
                if not row:
                    self.send_error_json("Theme not found", 404)
                    return
                concepts = body.get("key_concepts")
                concepts_json = (
                    json.dumps(concepts, ensure_ascii=False)
                    if isinstance(concepts, list)
                    else row["key_concepts_json"]
                )
                conn.execute(
                    """UPDATE course_themes
                       SET course_id = ?, title = ?, summary = ?, importance = ?, key_concepts_json = ?
                       WHERE id = ?""",
                    (
                        body.get("course_id") if "course_id" in body else row["course_id"],
                        (body.get("title") or row["title"]).strip(),
                        (body.get("summary") if "summary" in body else row["summary"]).strip(),
                        body.get("importance") or row["importance"],
                        concepts_json,
                        tid,
                    ),
                )
                updated = conn.execute("SELECT * FROM course_themes WHERE id = ?", (tid,)).fetchone()
                self.send_json(serialize_theme(updated))
                return

            m = re.match(r"^/api/chapters/([^/]+)$", path)
            if m:
                cid = m.group(1)
                row = conn.execute("SELECT * FROM chapters WHERE id = ?", (cid,)).fetchone()
                if not row:
                    self.send_error_json("Chapter not found", 404)
                    return
                now = utc_now_iso()
                conn.execute(
                    """UPDATE chapters
                       SET chapter_label = ?, title = ?, todo_notes = ?, status = ?,
                           estimated_minutes = ?, sort_order = ?, updated_at = ?
                       WHERE id = ?""",
                    (
                        (body.get("chapter_label") if "chapter_label" in body else row["chapter_label"]).strip(),
                        (body.get("title") or row["title"]).strip(),
                        (body.get("todo_notes") if "todo_notes" in body else row["todo_notes"]).strip(),
                        body.get("status") or row["status"],
                        max(0, int(body.get("estimated_minutes") if "estimated_minutes" in body else row["estimated_minutes"])),
                        int(body.get("sort_order") if "sort_order" in body else row["sort_order"]),
                        now,
                        cid,
                    ),
                )
                updated = conn.execute(
                    """SELECT c.*,
                        (SELECT COUNT(*) FROM subtask_explanations e WHERE e.chapter_id = c.id) AS explanations_count,
                        (SELECT COUNT(*) FROM subtask_tests t WHERE t.chapter_id = c.id) AS tests_count,
                        (SELECT COUNT(*) FROM documents d WHERE d.chapter_id = c.id) AS docs_count
                       FROM chapters c WHERE c.id = ?""",
                    (cid,),
                ).fetchone()
                self.send_json(dict(updated))
                return

            self.send_error_json("Endpoint not found", 404)

    # ---------------- API DELETE ----------------

    def handle_api_delete(self, path: str) -> None:
        with get_db() as conn:
            m = re.match(r"^/api/courses/([^/]+)$", path)
            if m:
                conn.execute("DELETE FROM courses WHERE id = ?", (m.group(1),))
                self.send_json({"ok": True})
                return

            m = re.match(r"^/api/items/([^/]+)$", path)
            if m:
                # Delete physical files linked to this item
                docs = conn.execute("SELECT stored_name FROM documents WHERE item_id = ?", (m.group(1),)).fetchall()
                for d in docs:
                    fp = UPLOADS_DIR / d["stored_name"]
                    if fp.exists():
                        fp.unlink(missing_ok=True)
                conn.execute("DELETE FROM items WHERE id = ?", (m.group(1),))
                self.send_json({"ok": True})
                return

            m = re.match(r"^/api/chapters/([^/]+)$", path)
            if m:
                conn.execute("DELETE FROM chapters WHERE id = ?", (m.group(1),))
                self.send_json({"ok": True})
                return

            m = re.match(r"^/api/documents/([^/]+)$", path)
            if m:
                doc = conn.execute("SELECT stored_name FROM documents WHERE id = ?", (m.group(1),)).fetchone()
                if doc:
                    fp = UPLOADS_DIR / doc["stored_name"]
                    if fp.exists():
                        fp.unlink(missing_ok=True)
                conn.execute("DELETE FROM documents WHERE id = ?", (m.group(1),))
                self.send_json({"ok": True})
                return

            m = re.match(r"^/api/explanations/([^/]+)$", path)
            if m:
                conn.execute("DELETE FROM subtask_explanations WHERE id = ?", (m.group(1),))
                self.send_json({"ok": True})
                return

            m = re.match(r"^/api/tests/([^/]+)$", path)
            if m:
                conn.execute("DELETE FROM subtask_tests WHERE id = ?", (m.group(1),))
                self.send_json({"ok": True})
                return

            m = re.match(r"^/api/ai/overviews/([^/]+)$", path)
            if m:
                conn.execute("DELETE FROM ai_overviews WHERE id = ?", (m.group(1),))
                self.send_json({"ok": True})
                return

            m = re.match(r"^/api/themes/([^/]+)$", path)
            if m:
                conn.execute("DELETE FROM course_themes WHERE id = ?", (m.group(1),))
                self.send_json({"ok": True})
                return

            self.send_error_json("Endpoint not found", 404)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def _detect_lan_ip() -> str:
    """Detect primary LAN IPv4 address without sending external packets."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
    except Exception:
        pass
    try:
        ip = socket.gethostbyname(socket.gethostname())
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass
    return ""


def run_server(host: str = "0.0.0.0", port: int = 8080) -> None:
    init_db()
    server = ReusableThreadingHTTPServer((host, port), StudyPlannerHandler)

    def _handle_sigterm(signum, frame):
        print("\nReceived stop signal — shutting down StudyFlow server...", flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()

    try:
        signal.signal(signal.SIGTERM, _handle_sigterm)
    except Exception:
        pass

    print(f"StudyFlow backend listening on {host}:{port}", flush=True)
    print(f"  Local:   http://127.0.0.1:{port}", flush=True)
    if host in ("0.0.0.0", "::", ""):
        lan_ip = _detect_lan_ip()
        hostname = socket.gethostname()
        if lan_ip:
            print(f"  Network: http://{lan_ip}:{port}", flush=True)
        if hostname:
            print(f"  mDNS:    http://{hostname}.local:{port}", flush=True)
    print(f"  DB:      {DB_PATH}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down StudyFlow server...", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="StudyFlow — Bachelor Study Planner Server")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"), help="Bind address (default: 0.0.0.0 for LAN access)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")), help="Port to listen on (default: 8080)")
    args = parser.parse_args()
    run_server(host=args.host, port=args.port)
