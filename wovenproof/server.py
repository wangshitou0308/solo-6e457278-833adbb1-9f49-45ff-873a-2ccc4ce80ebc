#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""织纹校对工具 —— 本地服务

仅使用 Python 标准库：http.server 提供静态页面与 JSON API，
sqlite3 保存项目的多个版本。默认监听 http://127.0.0.1:8765
"""

import json
import os
import sqlite3
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.path.join(BASE_DIR, "wovenproof.db")
HOST = "127.0.0.1"
PORT = 8765

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
}


def db_connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # 外键约束是连接级设置，必须显式打开，ON DELETE CASCADE 才会生效
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    with db_connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                name    TEXT UNIQUE NOT NULL,
                created REAL NOT NULL,
                updated REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS versions (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                label      TEXT NOT NULL,
                note       TEXT DEFAULT '',
                draft      TEXT NOT NULL,
                created    REAL NOT NULL
            )
            """
        )
        # 清理在启用外键约束之前可能残留的孤儿版本
        conn.execute(
            """DELETE FROM versions
               WHERE project_id NOT IN (SELECT id FROM projects)"""
        )
        # 整经批次：独立于项目/版本之外的生产数据，整包 JSON 存取
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS warp_batches (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                name    TEXT NOT NULL,
                status  TEXT NOT NULL DEFAULT 'draft',
                data    TEXT NOT NULL,
                created REAL NOT NULL,
                updated REAL NOT NULL
            )
            """
        )


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "WovenProof/1.0"

    # ---------- 基础工具 ----------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ApiError(400, "缺少请求体")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "请求体不是有效 JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "请求体必须是 JSON 对象")
        return data

    def _error(self, exc):
        self._send_json({"ok": False, "error": exc.message}, exc.status)

    def log_message(self, fmt, *args):  # 安静一点
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---------- 路由 ----------
    def do_GET(self):
        path = urlparse(self.path).path
        try:
            parts = [p for p in path.split("/") if p]
            if path == "/api/projects":
                return self._list_projects()
            if path == "/api/warpbatches":
                return self._list_warp_batches()
            if len(parts) == 3 and parts[:2] == ["api", "warpbatches"]:
                return self._get_warp_batch(int(parts[2]))
            if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[2] == "versions":
                return self._get_version(int(parts[3]))
            if len(parts) == 3 and parts[:2] == ["api", "projects"]:
                return self._get_project(int(parts[2]))
        except ApiError as exc:
            return self._error(exc)
        except ValueError:
            return self._error(ApiError(400, "无效的编号"))
        return self._serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            data = self._read_json()
            if path == "/api/projects":
                return self._save_project(data)
            if path == "/api/warpbatches":
                return self._create_warp_batch(data)
            if path.endswith("/versions"):
                pid = path.split("/")[3]
                return self._save_version(int(pid), data)
            raise ApiError(404, "未知接口")
        except ApiError as exc:
            return self._error(exc)
        except ValueError:
            return self._error(ApiError(400, "无效的编号"))

    def do_PUT(self):
        path = urlparse(self.path).path
        try:
            data = self._read_json()
            parts = [p for p in path.split("/") if p]
            if len(parts) == 3 and parts[:2] == ["api", "warpbatches"]:
                return self._update_warp_batch(int(parts[2]), data)
            raise ApiError(404, "未知接口")
        except ApiError as exc:
            return self._error(exc)
        except ValueError:
            return self._error(ApiError(400, "无效的编号"))

    def do_DELETE(self):
        path = urlparse(self.path).path
        try:
            parts = [p for p in path.split("/") if p]
            # /api/projects/<pid>                    删项目（外键级联清理其全部版本）
            # /api/projects/<pid>/versions/<vid>     仅删该项目名下的指定版本
            if len(parts) == 3 and parts[:2] == ["api", "projects"]:
                pid = int(parts[2])
                with db_connect() as conn:
                    exists = conn.execute(
                        "SELECT 1 FROM projects WHERE id=?", (pid,)).fetchone()
                    if exists is None:
                        raise ApiError(404, f"项目 #{pid} 不存在")
                    conn.execute("DELETE FROM versions WHERE project_id=?", (pid,))
                    conn.execute("DELETE FROM projects WHERE id=?", (pid,))
                return self._send_json({"ok": True, "deleted": "project", "id": pid})
            if (len(parts) == 5 and parts[:2] == ["api", "projects"]
                    and parts[3] == "versions"):
                pid, vid = int(parts[2]), int(parts[4])
                with db_connect() as conn:
                    proj = conn.execute(
                        "SELECT 1 FROM projects WHERE id=?", (pid,)).fetchone()
                    if proj is None:
                        raise ApiError(404, f"项目 #{pid} 不存在")
                    # 版本必须确实隶属于该项目，不能借项目路径删别人的版本
                    ver = conn.execute(
                        "SELECT 1 FROM versions WHERE id=? AND project_id=?",
                        (vid, pid)).fetchone()
                    if ver is None:
                        raise ApiError(404, f"项目 #{pid} 下没有版本 #{vid}")
                    conn.execute("DELETE FROM versions WHERE id=? AND project_id=?",
                                 (vid, pid))
                return self._send_json({"ok": True, "deleted": "version", "id": vid})
            if len(parts) == 3 and parts[:2] == ["api", "warpbatches"]:
                bid = int(parts[2])
                with db_connect() as conn:
                    row = conn.execute(
                        "SELECT 1 FROM warp_batches WHERE id=?", (bid,)).fetchone()
                    if row is None:
                        raise ApiError(404, f"整经批次 #{bid} 不存在")
                    conn.execute("DELETE FROM warp_batches WHERE id=?", (bid,))
                return self._send_json({"ok": True, "deleted": "warp_batch", "id": bid})
            raise ApiError(404, f"未知地址：{path}")
        except ApiError as exc:
            return self._error(exc)
        except ValueError:
            return self._error(ApiError(400, "编号必须是整数"))

    # ---------- 静态文件 ----------
    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        rel = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        inside = rel == STATIC_DIR or rel.startswith(STATIC_DIR + os.sep)
        if not inside or not os.path.isfile(rel):
            # 注意：状态行原因短语必须是 latin-1，不能含中文，否则 send_error 会崩
            body = "404 文件不存在".encode("utf-8")
            self.send_response(404, "Not Found")
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        ext = os.path.splitext(rel)[1].lower()
        body = open(rel, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        # 完全本地工具，允许浏览器缓存静态资源
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- API 实现 ----------
    @staticmethod
    def _validate_draft(data):
        name = str(data.get("name") or "").strip()
        draft = data.get("draft")
        if not name:
            raise ApiError(400, "项目名称不能为空")
        if not isinstance(draft, dict):
            raise ApiError(400, "缺少 draft 数据")
        return name, draft

    def _list_projects(self):
        with db_connect() as conn:
            projects = [dict(r) for r in conn.execute(
                """SELECT p.id, p.name, p.created, p.updated,
                          (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id) AS version_count,
                          (SELECT label FROM versions v WHERE v.project_id = p.id
                           ORDER BY v.created DESC LIMIT 1) AS latest_label
                   FROM projects p ORDER BY p.updated DESC""")]
        self._send_json({"ok": True, "projects": projects})

    def _get_project(self, pid):
        with db_connect() as conn:
            proj = conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
            if proj is None:
                raise ApiError(404, "项目不存在")
            versions = [dict(r) for r in conn.execute(
                "SELECT id, label, note, created FROM versions WHERE project_id=? ORDER BY created",
                (pid,))]
        result = dict(proj)
        result["versions"] = versions
        self._send_json({"ok": True, "project": result})

    def _get_version(self, vid):
        with db_connect() as conn:
            row = conn.execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
            if row is None:
                raise ApiError(404, "版本不存在")
            draft = json.loads(row["draft"])
        self._send_json({
            "ok": True,
            "version": {
                "id": row["id"], "label": row["label"], "note": row["note"],
                "created": row["created"], "draft": draft,
            },
        })

    def _save_project(self, data):
        name, draft = self._validate_draft(data)
        now = time.time()
        with db_connect() as conn:
            row = conn.execute("SELECT id FROM projects WHERE name=?", (name,)).fetchone()
            if row:
                pid = row["id"]
                conn.execute("UPDATE projects SET updated=? WHERE id=?", (now, pid))
            else:
                cur = conn.execute(
                    "INSERT INTO projects(name, created, updated) VALUES(?,?,?)",
                    (name, now, now))
                pid = cur.lastrowid
            cur = conn.execute(
                "INSERT INTO versions(project_id, label, note, draft, created) VALUES(?,?,?,?,?)",
                (pid, str(data.get("label") or "当前版本")[:80],
                 str(data.get("note") or "")[:400],
                 json.dumps(draft, ensure_ascii=False), now))
            vid = cur.lastrowid
        self._send_json({"ok": True, "projectId": pid, "versionId": vid})

    def _save_version(self, pid, data):
        draft = data.get("draft")
        label = str(data.get("label") or "版本")[:80]
        if not isinstance(draft, dict):
            raise ApiError(400, "缺少 draft 数据")
        now = time.time()
        with db_connect() as conn:
            proj = conn.execute("SELECT id FROM projects WHERE id=?", (pid,)).fetchone()
            if proj is None:
                raise ApiError(404, "项目不存在")
            cur = conn.execute(
                "INSERT INTO versions(project_id, label, note, draft, created) VALUES(?,?,?,?,?)",
                (pid, label, str(data.get("note") or "")[:400],
                 json.dumps(draft, ensure_ascii=False), now))
            conn.execute("UPDATE projects SET updated=? WHERE id=?", (now, pid))
        self._send_json({"ok": True, "versionId": cur.lastrowid})

    # ---------- 整经批次 ----------
    WARP_STATUSES = ("draft", "locked", "running", "done")

    @classmethod
    def _validate_warp_payload(cls, data, partial=False):
        """校验批次写入体；partial=True 时允许只更新部分字段。"""
        out = {}
        if not partial or "name" in data:
            name = str(data.get("name") or "").strip()
            if not name:
                raise ApiError(400, "批次名称不能为空")
            out["name"] = name[:80]
        if not partial or "status" in data:
            status = str(data.get("status") or "draft")
            if status not in cls.WARP_STATUSES:
                raise ApiError(400, f"批次状态必须是 {'/'.join(cls.WARP_STATUSES)} 之一")
            out["status"] = status
        if not partial or "data" in data:
            payload = data.get("data")
            if not isinstance(payload, dict):
                raise ApiError(400, "缺少 data 数据")
            out["data"] = json.dumps(payload, ensure_ascii=False)
        return out

    @staticmethod
    def _warp_summary(row):
        """列表用摘要：从整包 JSON 里挑几个展示字段，解析失败也不影响列表。"""
        item = {"id": row["id"], "name": row["name"], "status": row["status"],
                "created": row["created"], "updated": row["updated"]}
        try:
            d = json.loads(row["data"])
            frozen = d.get("frozen") or {}
            item["ends"] = frozen.get("E") or d.get("ends") or 0
            item["progress"] = d.get("progress") or 0
            item["sections"] = len(d.get("cuts") or []) + 1
        except (ValueError, TypeError, AttributeError):
            pass
        return item

    def _list_warp_batches(self):
        with db_connect() as conn:
            rows = conn.execute(
                "SELECT * FROM warp_batches ORDER BY updated DESC").fetchall()
        self._send_json({"ok": True,
                         "batches": [self._warp_summary(r) for r in rows]})

    def _get_warp_batch(self, bid):
        with db_connect() as conn:
            row = conn.execute(
                "SELECT * FROM warp_batches WHERE id=?", (bid,)).fetchone()
        if row is None:
            raise ApiError(404, "整经批次不存在")
        batch = self._warp_summary(row)
        try:
            batch["data"] = json.loads(row["data"])
        except ValueError:
            raise ApiError(500, "批次数据损坏，无法解析")
        self._send_json({"ok": True, "batch": batch})

    def _create_warp_batch(self, data):
        fields = self._validate_warp_payload(data)
        now = time.time()
        with db_connect() as conn:
            cur = conn.execute(
                "INSERT INTO warp_batches(name, status, data, created, updated)"
                " VALUES(?,?,?,?,?)",
                (fields["name"], fields["status"], fields["data"], now, now))
            bid = cur.lastrowid
        self._send_json({"ok": True, "batchId": bid})

    def _update_warp_batch(self, bid, data):
        fields = self._validate_warp_payload(data, partial=True)
        if not fields:
            raise ApiError(400, "没有需要更新的字段")
        now = time.time()
        with db_connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM warp_batches WHERE id=?", (bid,)).fetchone()
            if row is None:
                raise ApiError(404, "整经批次不存在")
            sets = ", ".join(f"{k}=?" for k in fields) + ", updated=?"
            conn.execute(f"UPDATE warp_batches SET {sets} WHERE id=?",
                         (*fields.values(), now, bid))
        self._send_json({"ok": True, "batchId": bid})


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print(f"织纹校对工具已启动：{url}")
    print(f"存档数据库：{DB_PATH}")
    print("按 Ctrl+C 停止服务。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
