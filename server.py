#!/usr/bin/env python3
"""
repofind-server — repofind 的 HTTP API 服务 (标准库, 零依赖)

给 RepoFind nsh 应用用:
  GET /search?q=<query>&n=<limit>   语义+词法混合检索, 返回 JSON
  GET /health                        健康检查

启动: python3 server.py [--port 8765]
"""

import json
import os
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import repofind as rf


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # 安静模式

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query, encoding="utf-8", errors="replace")

        if parsed.path == "/health":
            n = len(rf.load_index())
            self._json(200, {"ok": True, "repos": n,
                             "vectors": rf.VECTORS_PATH.exists()})
            return

        if parsed.path == "/search":
            q = (params.get("q") or [""])[0].strip()
            n = int((params.get("n") or ["10"])[0])
            if not q:
                self._json(400, {"error": "missing q"})
                return
            repos = rf.load_index()
            lex = rf.LexicalIndex(repos)
            lex_results = lex.search(q, n)

            sem_results = []
            used_semantic = False
            if rf.VECTORS_PATH.exists() and rf.EMB_KEY:
                vec_data = json.loads(rf.VECTORS_PATH.read_text())
                if vec_data.get("model") == rf.EMB_MODEL:
                    try:
                        qvec = rf.embed_texts([q[:4000]], batch=1)[0]
                        scored = [(rf.cosine(qvec, v), e) for e, v in zip(repos, vec_data["vectors"])]
                        scored.sort(key=lambda x: -x[0])
                        sem_results = scored[:n]
                        used_semantic = True
                    except Exception as ex:
                        print(f"semantic fallback to lexical: {ex}", file=sys.stderr)

            # 与 repofind.cmd_search 相同的融合逻辑: 语义 0.6 / 词法 0.4, min-max 归一化
            def minmax(scores):
                if not scores:
                    return scores
                lo, hi = min(scores), max(scores)
                rng = (hi - lo) or 1.0
                return [(s - lo) / rng for s in scores]

            lex_scores = minmax([s for s, _, _ in lex_results])
            sem_scores = minmax([c for c, _ in sem_results])
            candidates = {}
            for i, (s, matched, e) in enumerate(lex_results):
                entry = candidates.setdefault(id(e), {"e": e, "score": 0.0, "matched": set()})
                entry["score"] += 0.4 * lex_scores[i]
                entry["matched"] |= matched
            for i, (c, e) in enumerate(sem_results):
                entry = candidates.setdefault(id(e), {"e": e, "score": 0.0, "matched": set()})
                entry["score"] += 0.6 * sem_scores[i]
            items = sorted(candidates.values(), key=lambda x: -x["score"])[:n]

            self._json(200, {
                "query": q,
                "semantic": used_semantic,
                "model": rf.EMB_MODEL if used_semantic else None,
                "results": [{
                    "name": it["e"]["name"],
                    "path": it["e"]["path"],
                    "langs": it["e"].get("langs") or [],
                    "branch": it["e"].get("branch") or "",
                    "last_commit": it["e"].get("last_commit") or "",
                    "remote": it["e"].get("remote") or "",
                    "score": round(it["score"], 4),
                } for it in items],
            })
            return

        self._json(404, {"error": "not found"})


def main():
    port = 8765
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"repofind server on http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
