# -*- coding: utf-8 -*-
"""
任务喵云同步后端 v2（多用户 + JWT 认证版）
- POST /api/auth/register       → 手机号+密码注册，返回 JWT
- POST /api/auth/login          → 手机号+密码登录，返回 JWT
- GET  /api/auth/me             → 取当前用户信息（需 Bearer token）
- GET  /api/tasks               → 取当前用户的任务全量（需 Bearer token）
- PUT  /api/tasks               → 覆盖写入当前用户的任务全量（需 Bearer token）
- GET  /download                → APK 下载（无认证）
- POST /api/feishu/event        → 接收飞书事件推送（url_verification 握手 + 妙计事件入库）
- GET  /api/feishu/events       → 任务喵轮询拉取新事件（after=游标）
- OPTIONS /*                    → CORS 预检

依赖: pip install pyjwt
监听地址: TASKCAT_HOST / TASKCAT_PORT（默认 127.0.0.1:8080）
持久化: SQLite（%BASE_DIR%/taskcat.db）
"""
import hashlib
import hmac
import json
import os
import sqlite3
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

try:
    import jwt as pyjwt
except ImportError:
    pyjwt = None

BASE_DIR = os.path.abspath(os.environ.get('TASKCAT_DATA_DIR') or os.path.join(
    os.path.dirname(os.path.dirname(__file__)), '.tools', 'taskcat-server'))
DB_FILE = os.path.join(BASE_DIR, "taskcat.db")
APK_FILE = os.path.join(BASE_DIR, "taskcat.apk")

CORS_HEADERS = [
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS"),
    ("Access-Control-Allow-Headers", "Content-Type, Authorization"),
]

# ── JWT 密钥：持久化到磁盘（服务器重启后 token 继续有效，用户无需重新登录）──
JWT_SECRET_FILE = os.path.join(BASE_DIR, "jwt_secret.key")


def _load_jwt_secret() -> str:
    """从磁盘读取密钥；不存在则生成并写入（保证跨重启稳定）"""
    try:
        with open(JWT_SECRET_FILE, "r", encoding="utf-8") as f:
            s = f.read().strip()
        if len(s) >= 32:
            return s
    except Exception:
        pass
    s = uuid.uuid4().hex + uuid.uuid4().hex
    os.makedirs(BASE_DIR, exist_ok=True)
    with open(JWT_SECRET_FILE, "w", encoding="utf-8") as f:
        f.write(s)
    return s


JWT_SECRET = _load_jwt_secret()
JWT_ALGO = "HS256"
JWT_EXPIRY = 30 * 24 * 3600  # 30 天


def init_db():
    """初始化数据库：建表（幂等）"""
    os.makedirs(BASE_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            phone       TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            salt        TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id          TEXT PRIMARY KEY,
            user_id     INTEGER NOT NULL,
            title       TEXT NOT NULL DEFAULT '',
            quadrant    TEXT NOT NULL DEFAULT 'q2',
            due_at      INTEGER,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            completed_at INTEGER,
            subtasks    TEXT NOT NULL DEFAULT '[]',
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
        CREATE TABLE IF NOT EXISTS feishu_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id    TEXT UNIQUE NOT NULL,
            event_type  TEXT NOT NULL,
            minute_token TEXT,
            payload     TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
    """)
    conn.commit()
    conn.close()


def _get_conn():
    return sqlite3.connect(DB_FILE)


def _hash_password(password: str, salt: str) -> str:
    """PBKDF2-SHA256 哈希"""
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000).hex()


def _make_token(user_id: int, phone: str, pw_hash: str) -> str:
    """签发 JWT；v 字段携带密码指纹，改密码后旧 token 自动失效"""
    now = int(time.time())
    payload = {"user_id": user_id, "phone": phone, "v": pw_hash[:16], "exp": now + JWT_EXPIRY, "iat": now}
    return pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def _decode_token(token: str):
    try:
        return pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except Exception:
        return None


def _read_body(handler, max_size=1 << 20) -> bytes:
    length = int(handler.headers.get("Content-Length", 0))
    if length <= 0 or length > max_size:
        return b""
    return handler.rfile.read(length)


def _json_resp(handler, code: int, data):
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    for k, v in CORS_HEADERS:
        handler.send_header(k, v)
    handler.end_headers()
    handler.wfile.write(body)


def _auth_required(handler) -> dict | None:
    """从 Authorization header 解析 JWT 并校验密码版本，失败返回 None"""
    raw = handler.headers.get("Authorization", "")
    if not raw.startswith("Bearer "):
        _json_resp(handler, 401, {"ok": False, "error": "缺少认证令牌"})
        return None
    payload = _decode_token(raw[7:])
    if payload is None:
        _json_resp(handler, 401, {"ok": False, "error": "令牌无效或已过期"})
        return None
    # 比对密码指纹：改密码后旧 token 失效
    conn = _get_conn()
    row = conn.execute("SELECT password_hash FROM users WHERE id=?", (payload.get("user_id"),)).fetchone()
    conn.close()
    if not row:
        _json_resp(handler, 401, {"ok": False, "error": "账号不存在或已注销"})
        return None
    if payload.get("v") != row[0][:16]:
        _json_resp(handler, 401, {"ok": False, "error": "登录状态已失效，请重新登录"})
        return None
    return payload


# ── 飞书事件中转（妙计等事件由飞书推到这里，任务喵轮询拉取）──

FEISHU_APP_ID = os.environ.get('TASKCAT_FEISHU_APP_ID', '').strip()


def _handle_feishu_event(handler):
    """飞书事件回调：配置时握手 url_verification，事件推送去重入库"""
    if not FEISHU_APP_ID:
        return _json_resp(handler, 503, {"ok": False, "error": "未启用飞书事件中转"})
    body = _read_body(handler, max_size=1 << 20)
    try:
        data = json.loads(body)
    except Exception:
        return _json_resp(handler, 400, {"ok": False, "error": "请求体不是有效 JSON"})

    # 事件订阅配置时的握手校验
    if data.get("type") == "url_verification":
        return _json_resp(handler, 200, {"challenge": data.get("challenge", "")})

    header = data.get("header") or {}
    event_id = header.get("event_id") or ""
    event_type = header.get("event_type") or ""
    app_id = header.get("app_id") or ""
    if not event_id or not event_type:
        return _json_resp(handler, 200, {"ok": True, "ignored": "no header"})
    if app_id != FEISHU_APP_ID:
        return _json_resp(handler, 200, {"ok": True, "ignored": "app_id mismatch"})

    event = data.get("event") or {}
    minute_token = event.get("minute_token") or ""
    conn = _get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO feishu_events (event_id, event_type, minute_token, payload, created_at) VALUES (?, ?, ?, ?, ?)",
        (event_id, event_type, minute_token, json.dumps(event, ensure_ascii=False), int(time.time())),
    )
    # 顺带清理 7 天前的事件
    conn.execute("DELETE FROM feishu_events WHERE created_at < ?", (int(time.time()) - 7 * 86400,))
    conn.commit()
    conn.close()
    return _json_resp(handler, 200, {"code": 0})


def _handle_feishu_events(handler, query):
    """任务喵轮询：after=游标（上次拉到的最大 id），返回其后的事件"""
    if not FEISHU_APP_ID:
        return _json_resp(handler, 503, {"ok": False, "error": "未启用飞书事件中转"})
    try:
        after = int((query.get("after") or ["0"])[0])
    except ValueError:
        after = 0
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, event_id, event_type, minute_token, payload, created_at FROM feishu_events WHERE id > ? ORDER BY id LIMIT 50",
        (after,),
    ).fetchall()
    max_id = conn.execute("SELECT COALESCE(MAX(id), 0) FROM feishu_events").fetchone()[0]
    conn.close()
    events = [
        {
            "id": r[0],
            "event_id": r[1],
            "event_type": r[2],
            "minute_token": r[3],
            "payload": r[4],
            "created_at": r[5],
        }
        for r in rows
    ]
    return _json_resp(handler, 200, {"ok": True, "events": events, "cursor": max_id})


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS_HEADERS:
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/api/auth/me":
            return self._handle_me()
        elif path == "/api/tasks":
            return self._handle_get_tasks()
        elif path == "/api/feishu/events":
            from urllib.parse import parse_qs
            return _handle_feishu_events(self, parse_qs(parsed.query))
        elif path == "/download":
            return self._handle_download()
        else:
            _json_resp(self, 404, {"ok": False, "error": "Not Found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/api/auth/register":
            return self._handle_register()
        elif path == "/api/auth/login":
            return self._handle_login()
        elif path == "/api/auth/change-password":
            return self._handle_change_password()
        elif path == "/api/auth/deactivate":
            return self._handle_deactivate()
        elif path == "/api/feishu/event":
            return _handle_feishu_event(self)
        else:
            _json_resp(self, 404, {"ok": False, "error": "Not Found"})

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/api/tasks":
            return self._handle_put_tasks()
        else:
            _json_resp(self, 404, {"ok": False, "error": "Not Found"})

    # ── 修改密码 ──

    def _handle_change_password(self):
        payload = _auth_required(self)
        if not payload:
            return
        user_id = payload["user_id"]
        body = _read_body(self)
        try:
            data = json.loads(body)
        except Exception:
            return _json_resp(self, 400, {"ok": False, "error": "请求体不是有效 JSON"})
        old_pw = (data.get("oldPassword") or "").strip()
        new_pw = (data.get("newPassword") or "").strip()
        if not old_pw or not new_pw:
            return _json_resp(self, 400, {"ok": False, "error": "旧密码和新密码不能为空"})
        if len(new_pw) < 4:
            return _json_resp(self, 400, {"ok": False, "error": "新密码至少 4 位"})

        conn = _get_conn()
        row = conn.execute("SELECT password_hash, salt FROM users WHERE id=?", (user_id,)).fetchone()
        if not row:
            conn.close()
            return _json_resp(self, 404, {"ok": False, "error": "用户不存在"})
        pw_hash, salt = row
        if _hash_password(old_pw, salt) != pw_hash:
            conn.close()
            return _json_resp(self, 401, {"ok": False, "error": "旧密码错误"})
        new_salt = uuid.uuid4().hex[:16]
        new_hash = _hash_password(new_pw, new_salt)
        conn.execute("UPDATE users SET password_hash=?, salt=? WHERE id=?", (new_hash, new_salt, user_id))
        conn.commit()
        conn.close()
        # 返回新 token（旧 token 已失效；本设备无感换新，其他设备需重新登录）
        new_token = _make_token(user_id, payload["phone"], new_hash)
        return _json_resp(self, 200, {"ok": True, "message": "密码修改成功", "token": new_token})

    # ── 注销账号 ──

    def _handle_deactivate(self):
        payload = _auth_required(self)
        if not payload:
            return
        user_id = payload["user_id"]
        conn = _get_conn()
        conn.execute("DELETE FROM tasks WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM users WHERE id=?", (user_id,))
        conn.commit()
        conn.close()
        return _json_resp(self, 200, {"ok": True, "message": "账号已注销"})

    def _handle_register(self):
        body = _read_body(self)
        try:
            data = json.loads(body)
        except Exception:
            return _json_resp(self, 400, {"ok": False, "error": "请求体不是有效 JSON"})
        phone = (data.get("phone") or "").strip()
        password = (data.get("password") or "").strip()
        if not phone or not password:
            return _json_resp(self, 400, {"ok": False, "error": "手机号和密码不能为空"})
        if len(phone) < 8 or len(phone) > 20:
            return _json_resp(self, 400, {"ok": False, "error": "手机号格式不正确"})
        if len(password) < 4:
            return _json_resp(self, 400, {"ok": False, "error": "密码至少 4 位"})

        salt = uuid.uuid4().hex[:16]
        pw_hash = _hash_password(password, salt)
        conn = _get_conn()
        try:
            cur = conn.execute("INSERT INTO users (phone, password_hash, salt, created_at) VALUES (?, ?, ?, ?)",
                               (phone, pw_hash, salt, int(time.time())))
            user_id = cur.lastrowid
            conn.commit()
        except sqlite3.IntegrityError:
            conn.close()
            return _json_resp(self, 409, {"ok": False, "error": "该手机号已注册"})
        conn.close()
        token = _make_token(user_id, phone, pw_hash)
        return _json_resp(self, 200, {"ok": True, "token": token, "phone": phone, "userId": user_id})

    def _handle_login(self):
        body = _read_body(self)
        try:
            data = json.loads(body)
        except Exception:
            return _json_resp(self, 400, {"ok": False, "error": "请求体不是有效 JSON"})
        phone = (data.get("phone") or "").strip()
        password = (data.get("password") or "").strip()
        if not phone or not password:
            return _json_resp(self, 400, {"ok": False, "error": "手机号和密码不能为空"})

        conn = _get_conn()
        row = conn.execute("SELECT id, password_hash, salt FROM users WHERE phone = ?", (phone,)).fetchone()
        conn.close()
        if not row:
            return _json_resp(self, 401, {"ok": False, "error": "手机号未注册"})
        user_id, pw_hash, salt = row
        if _hash_password(password, salt) != pw_hash:
            return _json_resp(self, 401, {"ok": False, "error": "密码错误"})
        token = _make_token(user_id, phone, pw_hash)
        return _json_resp(self, 200, {"ok": True, "token": token, "phone": phone, "userId": user_id})

    def _handle_me(self):
        payload = _auth_required(self)
        if not payload:
            return
        return _json_resp(self, 200, {"ok": True, "phone": payload["phone"], "userId": payload["user_id"]})

    # ── 任务 CRUD ──

    def _handle_get_tasks(self):
        payload = _auth_required(self)
        if not payload:
            return
        user_id = payload["user_id"]
        conn = _get_conn()
        rows = conn.execute(
            "SELECT id, title, quadrant, due_at, created_at, updated_at, completed_at, subtasks FROM tasks WHERE user_id=?",
            (user_id,)
        ).fetchall()
        conn.close()
        tasks = []
        for r in rows:
            tasks.append({
                "id": r[0],
                "title": r[1],
                "quadrant": r[2],
                "dueAt": r[3],
                "createdAt": r[4],
                "updatedAt": r[5],
                "completedAt": r[6],
                "subtasks": json.loads(r[7]),
            })
        return _json_resp(self, 200, {"ok": True, "tasks": tasks, "count": len(tasks)})

    def _handle_put_tasks(self):
        payload = _auth_required(self)
        if not payload:
            return
        user_id = payload["user_id"]
        body = _read_body(self, max_size=5 << 20)
        try:
            data = json.loads(body)
        except Exception:
            return _json_resp(self, 400, {"ok": False, "error": "请求体不是有效 JSON"})
        tasks = data if isinstance(data, list) else data.get("tasks", [])
        if not isinstance(tasks, list):
            return _json_resp(self, 400, {"ok": False, "error": "请求体应为任务数组"})

        conn = _get_conn()
        conn.execute("DELETE FROM tasks WHERE user_id=?", (user_id,))
        now = int(time.time())
        inserted = 0
        for t in tasks:
            tid = t.get("id", "")
            if not tid:
                continue
            inserted += 1
            conn.execute(
                """INSERT OR REPLACE INTO tasks
                   (id, user_id, title, quadrant, due_at, created_at, updated_at, completed_at, subtasks)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    tid,
                    user_id,
                    (t.get("title") or ""),
                    (t.get("quadrant") or "q2"),
                    t.get("dueAt"),
                    t.get("createdAt", now),
                    t.get("updatedAt", now),
                    t.get("completedAt"),
                    json.dumps(t.get("subtasks", []), ensure_ascii=False),
                ),
            )
        conn.commit()
        conn.close()
        return _json_resp(self, 200, {"ok": True, "count": inserted})

    # ── APK 下载 ──

    def _handle_download(self):
        if not os.path.isfile(APK_FILE):
            return _json_resp(self, 404, {"ok": False, "error": "APK 文件不存在"})
        size = os.path.getsize(APK_FILE)
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.android.package-archive")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", 'attachment; filename="taskcat.apk"')
        for k, v in CORS_HEADERS:
            self.send_header(k, v)
        self.end_headers()
        with open(APK_FILE, "rb") as f:
            self.wfile.write(f.read())

    # ── 日志压制 ──

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    if pyjwt is None:
        print("[taskcat-server] 错误: 缺少 pyjwt 库，请运行: pip install pyjwt")
        sys.exit(1)
    init_db()
    port = int(os.environ.get("TASKCAT_PORT", "8080"))
    host = os.environ.get("TASKCAT_HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"[taskcat-server] v2 已启动，端口 {port}，数据库 {DB_FILE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[taskcat-server] 已关闭")
        server.server_close()