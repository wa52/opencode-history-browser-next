import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


APP_DIR = Path(__file__).resolve().parent
HOME = Path.home()
DB_PATH = Path(os.environ.get("OPENCODE_DB", HOME / ".local" / "share" / "opencode" / "opencode.db"))
STATE_PATH = Path(os.environ.get("OPENCODE_HISTORY_STATE", HOME / ".config" / "opencode" / "history-browser.json"))
OPENCODE_CMD = Path(os.environ.get("OPENCODE_CMD", HOME / "AppData" / "Roaming" / "npm" / "opencode.cmd"))


def connect(write=False):
    if write:
        return sqlite3.connect(DB_PATH)
    uri = f"file:{DB_PATH.as_posix()}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def load_state():
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"pinned": []}


def save_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_json(value, fallback=None):
    if fallback is None:
        fallback = {}
    try:
        return json.loads(value) if value else fallback
    except Exception:
        return fallback


def text_preview(session_id, limit=2):
    with connect() as con:
        con.row_factory = sqlite3.Row
        rows = con.execute(
            """
            select p.data, m.data as message_data
            from part p
            join message m on m.id = p.message_id
            where p.session_id = ?
            order by p.time_created desc
            limit 30
            """,
            (session_id,),
        ).fetchall()

    snippets = []
    for row in rows:
        part = parse_json(row["data"])
        if part.get("type") != "text" or not part.get("text"):
            continue
        message = parse_json(row["message_data"])
        role = message.get("role", "message")
        text = " ".join(str(part.get("text", "")).split())
        if text:
            snippets.append({"role": role, "text": text[:240]})
        if len(snippets) >= limit:
            break
    return list(reversed(snippets))


def session_row(row):
    pinned = set(load_state().get("pinned", []))
    return {
        "id": row["id"],
        "title": row["title"],
        "directory": row["directory"],
        "slug": row["slug"],
        "created": row["time_created"],
        "updated": row["time_updated"],
        "archived": row["time_archived"],
        "projectID": row["project_id"],
        "model": row["model"],
        "agent": row["agent"],
        "cost": row["cost"],
        "tokensInput": row["tokens_input"],
        "tokensOutput": row["tokens_output"],
        "summary": {
            "files": row["summary_files"] or 0,
            "additions": row["summary_additions"] or 0,
            "deletions": row["summary_deletions"] or 0,
        },
        "pinned": row["id"] in pinned,
        "preview": text_preview(row["id"], 1),
    }


def list_sessions(query=""):
    state = load_state()
    pinned = state.get("pinned", [])
    pinned_rank = {session_id: index for index, session_id in enumerate(pinned)}
    sql = """
        select *
        from session
        where time_archived is null
    """
    params = []
    if query:
        sql += " and (title like ? or directory like ? or id like ?)"
        like = f"%{query}%"
        params.extend([like, like, like])
    sql += " order by time_updated desc limit 300"

    with connect() as con:
        con.row_factory = sqlite3.Row
        rows = [session_row(row) for row in con.execute(sql, params).fetchall()]

    rows.sort(key=lambda item: (0 if item["pinned"] else 1, pinned_rank.get(item["id"], 999999), -int(item["updated"] or 0)))
    return rows


def get_session(session_id):
    with connect() as con:
        con.row_factory = sqlite3.Row
        session = con.execute("select * from session where id = ?", (session_id,)).fetchone()
        if not session:
            return None
        messages = con.execute(
            """
            select m.id, m.data, m.time_created, m.time_updated
            from message m
            where m.session_id = ?
            order by m.time_created asc
            """,
            (session_id,),
        ).fetchall()
        parts = con.execute(
            """
            select p.message_id, p.data, p.time_created
            from part p
            where p.session_id = ?
            order by p.time_created asc
            """,
            (session_id,),
        ).fetchall()

    by_message = {}
    for part_row in parts:
        part = parse_json(part_row["data"])
        by_message.setdefault(part_row["message_id"], []).append(part)

    output = session_row(session)
    output["messages"] = []
    for message_row in messages:
        info = parse_json(message_row["data"])
        text_parts = []
        extra_parts = []
        for part in by_message.get(message_row["id"], []):
            kind = part.get("type")
            if kind == "text" and part.get("text"):
                text_parts.append(part.get("text", ""))
            elif kind and kind not in {"step-start", "step-finish"}:
                extra_parts.append(kind)
        output["messages"].append(
            {
                "id": message_row["id"],
                "role": info.get("role", "message"),
                "created": message_row["time_created"],
                "text": "\n\n".join(text_parts).strip(),
                "extras": extra_parts[:8],
            }
        )
    return output


def rename_session(session_id, title):
    title = title.strip()
    if not title:
        raise ValueError("Title cannot be empty.")
    now = int(time.time() * 1000)
    with connect(write=True) as con:
        cur = con.execute(
            "update session set title = ?, time_updated = ? where id = ?",
            (title, now, session_id),
        )
        con.commit()
        if cur.rowcount == 0:
            raise ValueError("Session was not found.")


def backup_database():
    backup_dir = DB_PATH.parent / "history-browser-backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_path = backup_dir / f"opencode-before-delete-{stamp}.db"
    shutil.copy2(DB_PATH, backup_path)
    return backup_path


def delete_session(session_id):
    backup_path = backup_database()
    with connect(write=True) as con:
        session = con.execute("select id from session where id = ?", (session_id,)).fetchone()
        if not session:
            raise ValueError("Session was not found.")
        for table in ("part", "message", "session_message", "todo", "session_share"):
            con.execute(f"delete from {table} where session_id = ?", (session_id,))
        con.execute("delete from session where id = ?", (session_id,))
        con.commit()

    state = load_state()
    state["pinned"] = [item for item in state.get("pinned", []) if item != session_id]
    save_state(state)
    return backup_path


def set_pinned(session_id, pinned):
    state = load_state()
    ids = [item for item in state.get("pinned", []) if item != session_id]
    if pinned:
        ids.insert(0, session_id)
    state["pinned"] = ids
    save_state(state)


def open_session(session):
    command = f"& '{OPENCODE_CMD}' --session '{session['id']}'"
    if sys.platform == "win32":
        subprocess.Popen(
            ["powershell.exe", "-NoExit", "-Command", command],
            cwd=session.get("directory") or str(HOME),
            creationflags=subprocess.CREATE_NEW_CONSOLE,
        )
    else:
        return False
    return True


def open_new_chat():
    command = f"& '{OPENCODE_CMD}'"
    if sys.platform == "win32":
        subprocess.Popen(
            ["powershell.exe", "-NoExit", "-Command", command],
            cwd=str(HOME),
            creationflags=subprocess.CREATE_NEW_CONSOLE,
        )
    else:
        return False
    return True


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/sessions":
            query = urllib.parse.parse_qs(parsed.query).get("q", [""])[0]
            return self.json({"sessions": list_sessions(query)})
        if parsed.path.startswith("/api/sessions/"):
            session_id = urllib.parse.unquote(parsed.path.removeprefix("/api/sessions/"))
            session = get_session(session_id)
            if not session:
                return self.json({"error": "Session not found"}, status=404)
            return self.json({"session": session})
        return self.static(parsed.path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        data = self.read_json()
        if parsed.path.startswith("/api/sessions/") and parsed.path.endswith("/rename"):
            session_id = urllib.parse.unquote(parsed.path.split("/")[-2])
            try:
                rename_session(session_id, data.get("title", ""))
                return self.json({"ok": True})
            except Exception as exc:
                return self.json({"error": str(exc)}, status=400)
        if parsed.path.startswith("/api/sessions/") and parsed.path.endswith("/pin"):
            session_id = urllib.parse.unquote(parsed.path.split("/")[-2])
            set_pinned(session_id, bool(data.get("pinned")))
            return self.json({"ok": True})
        if parsed.path.startswith("/api/sessions/") and parsed.path.endswith("/delete"):
            session_id = urllib.parse.unquote(parsed.path.split("/")[-2])
            try:
                backup_path = delete_session(session_id)
                return self.json({"ok": True, "backup": str(backup_path)})
            except Exception as exc:
                return self.json({"error": str(exc)}, status=400)
        if parsed.path.startswith("/api/sessions/") and parsed.path.endswith("/open"):
            session_id = urllib.parse.unquote(parsed.path.split("/")[-2])
            session = get_session(session_id)
            if not session:
                return self.json({"error": "Session not found"}, status=404)
            ok = open_session(session)
            return self.json({"ok": ok, "command": f"opencode --session {session_id}"})
        if parsed.path == "/api/open-new":
            ok = open_new_chat()
            return self.json({"ok": ok, "command": "opencode"})
        return self.json({"error": "Not found"}, status=404)

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def json(self, data, status=200):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def static(self, request_path):
        path = "index.html" if request_path in {"/", ""} else request_path.lstrip("/")
        target = (APP_DIR / "public" / path).resolve()
        public = (APP_DIR / "public").resolve()
        if not str(target).startswith(str(public)) or not target.exists() or target.is_dir():
            self.send_error(404)
            return
        content = target.read_bytes()
        mime = "text/html; charset=utf-8"
        if target.suffix == ".css":
            mime = "text/css; charset=utf-8"
        elif target.suffix == ".js":
            mime = "application/javascript; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format, *args):
        return


def main():
    if not DB_PATH.exists():
        raise SystemExit(f"OpenCode database not found: {DB_PATH}")
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"OpenCode History Browser: http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
