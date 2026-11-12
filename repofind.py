#!/usr/bin/env python3
"""
repofind — 本地 git 仓库语义/词法检索工具

用法:
  python3 repofind.py scan                    # 扫描并建立索引
  python3 repofind.py search "查询词"          # 检索仓库
  python3 repofind.py search "查询" -n 5       # 限制返回条数
  python3 repofind.py list                    # 列出所有已索引仓库
  python3 repofind.py path "部分路径"          # 按路径模糊查找

索引位置: ~/.cache/repofind/index.json
扫描根目录: ~/work ~/Projects ~/code ~/dev ~/Documents (可通过 -r 添加)

检索策略:
  1. TF-IDF 词法打分 (英文按词, 中文按 bigram, 路径段单独加权)
  2. 若本地有 Ollama 且拉了 embedding 模型, 自动升级为真语义检索
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path

INDEX_PATH = Path.home() / ".cache" / "repofind" / "index.json"
DEFAULT_ROOTS = ["~/work", "~/Projects", "~/code", "~/dev", "~/Documents"]
README_NAMES = ["README.md", "README.rst", "README.txt", "README", "readme.md"]
MAX_README_CHARS = 2000

CJK_RE = re.compile(r'[\u4e00-\u9fff]')
TOKEN_RE = re.compile(r'[a-zA-Z][a-zA-Z0-9_\-]*')


# ---------------- 扫描 ----------------

def find_repos(roots, max_depth=5):
    """递归查找 git 仓库 (含子仓库), 跳过 node_modules/.cache 等"""
    skip = {"node_modules", ".cache", ".venv", "venv", "__pycache__", "target", "dist"}
    repos = set()
    for root in roots:
        root = Path(root).expanduser()
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            # 先检查是否仓库, 再过滤 (否则 .git 会被 startswith(".") 过滤掉)
            is_repo = ".git" in dirnames or ".git" in filenames
            if is_repo:
                repos.add(dirpath)
                dirnames[:] = []  # 仓库内部不再找嵌套仓库
                continue
            dirnames[:] = [d for d in dirnames if d not in skip and not d.startswith(".")]
            if len(Path(dirpath).parts) - len(root.parts) >= max_depth:
                dirnames[:] = []
    return sorted(repos)


def git_cmd(repo, *args):
    try:
        r = subprocess.run(["git", "-C", str(repo)] + list(args),
                           capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def read_readme(repo):
    for name in README_NAMES:
        p = Path(repo) / name
        if p.is_file():
            try:
                return p.read_text(errors="ignore")[:MAX_README_CHARS]
            except Exception:
                pass
    return ""


def detect_langs(repo):
    """粗略检测主要语言 (按文件扩展名计数)"""
    ext_map = {
        ".py": "Python", ".rs": "Rust", ".ts": "TypeScript", ".tsx": "TypeScript",
        ".js": "JavaScript", ".jsx": "JavaScript", ".go": "Go", ".java": "Java",
        ".swift": "Swift", ".c": "C", ".h": "C", ".cpp": "C++", ".sh": "Shell",
        ".rb": "Ruby", ".lua": "Lua", ".zig": "Zig",
    }
    counts = {}
    for dirpath, dirnames, filenames in os.walk(repo):
        dirnames[:] = [d for d in dirnames if d not in {"node_modules", ".git", "venv", ".venv", "target"}]
        for f in filenames:
            lang = ext_map.get(os.path.splitext(f)[1].lower())
            if lang:
                counts[lang] = counts.get(lang, 0) + 1
    return [l for l, _ in sorted(counts.items(), key=lambda x: -x[1])[:3]]


def scan_repo(repo_path):
    repo_path = str(Path(repo_path).expanduser().resolve())
    entry = {
        "path": repo_path,
        "name": os.path.basename(repo_path),
        "readme": read_readme(repo_path),
        "langs": detect_langs(repo_path),
        "branch": git_cmd(repo_path, "rev-parse", "--abbrev-ref", "HEAD"),
        "remote": git_cmd(repo_path, "config", "--get", "remote.origin.url"),
        "last_commit": git_cmd(repo_path, "log", "-1", "--format=%cs %s"),
    }
    return entry


def cmd_scan(roots):
    all_repos = find_repos(roots)
    # 排除父仓库包含子仓库的重复 (dotfiles 里的 config 仓库等), 保留全部但可区分
    print(f"发现 {len(all_repos)} 个仓库, 正在扫描元数据...")
    entries = []
    for i, repo in enumerate(all_repos):
        entries.append(scan_repo(repo))
        print(f"  [{i+1}/{len(all_repos)}] {repo}", flush=True)
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(json.dumps({"scanned_at": time.strftime("%Y-%m-%d %H:%M:%S"), "repos": entries},
                                     ensure_ascii=False, indent=1))
    print(f"\n✓ 索引已写入 {INDEX_PATH}")


# ---------------- 分词 ----------------

def tokenize(text):
    """英文按词小写; 中文按 bigram; 驼峰/连字符拆分"""
    tokens = []
    for raw in TOKEN_RE.findall(text):
        low = raw.lower()
        tokens.append(low)
        # 驼峰拆分: paiRec -> pai, rec
        parts = re.findall(r'[A-Z][a-z]+|[a-z]+|[A-Z]+(?![a-z])', raw)
        if len(parts) > 1:
            tokens.extend(p.lower() for p in parts)
    # 中文 bigram
    cjk_runs = CJK_RE.findall(text)
    if cjk_runs:
        s = "".join(cjk_runs)
        tokens.append(s)  # 整段也保留 (短查询全匹配用)
        for i in range(len(s) - 1):
            tokens.append(s[i:i+2])
        if len(s) == 1:
            tokens.append(s)
    return tokens


def path_tokens(path):
    """路径段: 用 / _ - . 拆分, 每段再 tokenize"""
    segs = re.split(r'[/_.\-]', path.replace(Path.home().as_posix(), "~"))
    return tokenize(" ".join(segs))


# ---------------- TF-IDF 索引 ----------------

class LexicalIndex:
    def __init__(self, entries):
        self.entries = entries
        self.df = {}          # token -> 文档频率
        self.doc_tokens = []  # [(path_tokens, readme_tokens, name_tokens)]
        for e in entries:
            pt = path_tokens(e["path"])
            nt = tokenize(e["name"])
            rt = tokenize(e.get("readme") or "")
            lt = [t for t in tokenize(" ".join(e.get("langs") or []))]
            all_t = set(pt) | set(nt) | set(rt) | set(lt)
            for t in all_t:
                self.df[t] = self.df.get(t, 0) + 1
            self.doc_tokens.append((pt, nt, rt, lt, all_t))
        self.N = len(entries)

    def idf(self, tok):
        return math.log((self.N + 1) / (self.df.get(tok, 0) + 1)) + 0.01

    def search(self, query, top_n=10):
        q_tokens = tokenize(query)
        q_path_tokens = path_tokens(query)
        results = []
        for i, e in enumerate(self.entries):
            pt, nt, rt, lt, all_t = self.doc_tokens[i]
            score = 0.0
            matched = set()
            for tok in set(q_tokens) | set(q_path_tokens):
                w = self.idf(tok)
                if tok in nt:
                    score += 6 * w       # 仓库名命中, 权重最高
                    matched.add(tok)
                elif tok in pt:
                    score += 4 * w       # 路径段命中
                    matched.add(tok)
                elif tok in rt:
                    score += 2 * w       # README 命中
                    matched.add(tok)
                elif tok in lt:
                    score += 1.5 * w
                    matched.add(tok)
                elif tok in all_t:
                    matched.add(tok)
            # 短中文整串匹配加成
            for seg in re.split(r'\s+', query):
                if CJK_RE.search(seg) and seg in (e.get("readme") or ""):
                    score += 3
                    matched.add(seg)
            if score > 0:
                results.append((score, matched, e))
        results.sort(key=lambda x: -x[0])
        return results[:top_n]


# ---------------- 在线 Embedding 语义检索 ----------------
# 兼容所有 OpenAI 格式接口: OpenAI / SiliconFlow / DashScope 兼容模式 / 各种代理
# 配置 (环境变量):
#   REPOFIND_EMBED_KEY    API key (必须)
#   REPOFIND_EMBED_URL    base url, 默认 https://api.openai.com/v1
#   REPOFIND_EMBED_MODEL  模型名, 默认 text-embedding-3-small

VECTORS_PATH = Path.home() / ".cache" / "repofind" / "vectors.json"

EMB_KEY = os.environ.get("REPOFIND_EMBED_KEY") or os.environ.get("OPENAI_API_KEY") or ""
EMB_URL = (os.environ.get("REPOFIND_EMBED_URL") or "https://new-api.tuhuyun.cn/v1").rstrip("/")
EMB_MODEL = os.environ.get("REPOFIND_EMBED_MODEL") or "bge-m3"


def embed_texts(texts, batch=32):
    """批量获取 embedding, 返回向量列表. 逐批请求避免超时."""
    import urllib.request
    import urllib.error
    all_vecs = []
    for i in range(0, len(texts), batch):
        chunk = texts[i:i+batch]
        req = urllib.request.Request(
            EMB_URL + "/embeddings",
            data=json.dumps({"model": EMB_MODEL, "input": chunk}).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {EMB_KEY}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                resp = json.load(r)
        except urllib.error.HTTPError as ex:
            body = ex.read().decode(errors="ignore")[:200]
            sys.exit(f"embedding API 报错 {ex.code}: {body}")
        # 按 index 排序保证顺序
        data = sorted(resp["data"], key=lambda d: d["index"])
        all_vecs.extend(d["embedding"] for d in data)
        print(f"  embedding {min(i+batch, len(texts))}/{len(texts)}", flush=True)
    return all_vecs


def repo_text(e):
    """拼接用于 embedding 的仓库描述文本"""
    parts = [e["name"], e["path"].replace(Path.home().as_posix(), "~")]
    if e.get("langs"):
        parts.append("语言: " + " ".join(e["langs"]))
    if e.get("readme"):
        parts.append(e["readme"][:1500])
    return "\n".join(parts)[:4000]


def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def cmd_embed():
    """为索引中的所有仓库生成 embedding 向量"""
    if not EMB_KEY:
        sys.exit("缺少 API key: 请设置环境变量 REPOFIND_EMBED_KEY")
    repos = load_index()
    texts = [repo_text(e) for e in repos]
    print(f"正在为 {len(repos)} 个仓库生成 embedding ({EMB_MODEL})...")
    vecs = embed_texts(texts)
    VECTORS_PATH.parent.mkdir(parents=True, exist_ok=True)
    # 存成浮点数组列表, 带模型指纹防止换模型后错配
    VECTORS_PATH.write_text(json.dumps({"model": EMB_MODEL, "url": EMB_URL,
                                        "vectors": vecs}, ensure_ascii=False))
    print(f"✓ 向量已写入 {VECTORS_PATH} ({len(vecs)} 条)")


def cmd_search(query, top_n, use_semantic=True):
    repos = load_index()
    lex = LexicalIndex(repos)
    lex_results = lex.search(query, top_n)

    sem_results = []
    sem_note = ""
    if use_semantic:
        if not (VECTORS_PATH.exists() and EMB_KEY):
            sem_note = "(无向量索引或未配置 key, 仅词法结果)"
        else:
            vec_data = json.loads(VECTORS_PATH.read_text())
            if vec_data.get("model") != EMB_MODEL:
                sem_note = f"(向量是 {vec_data['model']} 生成的, 与当前 {EMB_MODEL} 不匹配, 仅词法结果)"
            else:
                print("查询向量生成中...", flush=True)
                qvec = embed_texts([query[:4000]], batch=1)[0]
                scored = []
                for e, v in zip(repos, vec_data["vectors"]):
                    scored.append((cosine(qvec, v), e))
                scored.sort(key=lambda x: -x[0])
                sem_results = scored[:top_n]
                sem_note = f"({EMB_MODEL} 语义检索)"

    # ---- 融合排序: 语义分和词法分都归一化后加权 (语义 0.6 / 词法 0.4) ----
    def minmax(scores):
        if not scores:
            return scores
        lo, hi = min(scores), max(scores)
        rng = (hi - lo) or 1.0
        return [(s - lo) / rng for s in scores]

    lex_scores = minmax([s for s, _, _ in lex_results])
    sem_scores = minmax([c for c, _ in sem_results])
    lex_norm = {i: sc for i, sc in enumerate(lex_scores)}
    sem_norm = {i: sc for i, sc in enumerate(sem_scores)}
    # e 对象按索引回查, 避免把 dict 放进 set
    candidates = {}
    for i, (_, _, e) in enumerate(lex_results):
        candidates[id(e)] = (e, 0.4 * lex_norm[i])
    for i, (_, e) in enumerate(sem_results):
        old = candidates.get(id(e), (e, 0.0))
        candidates[id(e)] = (e, old[1] + 0.6 * sem_norm[i])
    fused_sorted = sorted(candidates.values(), key=lambda x: -x[1])[:top_n]

    print(sem_note)
    if not fused_sorted:
        print("没有匹配的仓库, 试试换个关键词")
        return
    print(f"共 {len(fused_sorted)} 条结果:")
    for rank, (e, score) in enumerate(fused_sorted, 1):
        fmt_result(score, set(), e, rank)


# ---------------- 命令 ----------------

def load_index():
    if not INDEX_PATH.exists():
        sys.exit("索引不存在, 请先运行: python3 repofind.py scan")
    data = json.loads(INDEX_PATH.read_text())
    return data["repos"]


def fmt_result(score, matched, e, rank):
    print(f"\n#{rank}  {e['name']}  (score {score:.2f})")
    print(f"    路径: {e['path']}")
    meta = []
    if e.get("langs"): meta.append(" / ".join(e["langs"]))
    if e.get("branch"): meta.append(f"分支 {e['branch']}")
    if e.get("last_commit"): meta.append(f"最近提交 {e['last_commit'][:60]}")
    if meta:
        print(f"    信息: {' · '.join(meta)}")
    if e.get("remote"):
        print(f"    远端: {e['remote']}")
    if matched:
        print(f"    命中: {', '.join(sorted(list(matched))[:8])}")


def cmd_list():
    repos = load_index()
    print(f"已索引 {len(repos)} 个仓库:")
    for e in repos:
        langs = " / ".join(e.get("langs") or []) or "?"
        print(f"  {e['name']:<30} [{langs}]  {e['path']}")


def cmd_path(pattern):
    repos = load_index()
    hits = [e for e in repos if pattern.lower() in e["path"].lower()]
    for e in hits:
        print(f"  {e['name']:<30} {e['path']}")
    if not hits:
        print("路径中没有包含该字符串的仓库")


def main():
    ap = argparse.ArgumentParser(description="本地 git 仓库检索")
    ap.add_argument("-r", "--roots", nargs="+", default=DEFAULT_ROOTS,
                    help="扫描根目录, 默认: " + " ".join(DEFAULT_ROOTS))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan", help="扫描并建立索引")
    p_search = sub.add_parser("search", help="语义+词法混合检索")
    p_search.add_argument("query")
    p_search.add_argument("-n", type=int, default=10)
    p_search.add_argument("--no-semantic", action="store_true", help="只用词法检索")
    sub.add_parser("embed", help="为所有仓库生成 embedding 向量 (需配置 API key)")
    sub.add_parser("list", help="列出所有仓库")
    p_path = sub.add_parser("path", help="按路径字符串模糊查找")
    p_path.add_argument("pattern")
    args = ap.parse_args()

    if args.cmd == "scan":
        cmd_scan(args.roots)
    elif args.cmd == "search":
        cmd_search(args.query, args.n, use_semantic=not args.no_semantic)
    elif args.cmd == "embed":
        cmd_embed()
    elif args.cmd == "list":
        cmd_list()
    elif args.cmd == "path":
        cmd_path(args.pattern)


if __name__ == "__main__":
    main()
