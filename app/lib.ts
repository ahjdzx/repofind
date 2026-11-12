/**
 * lib.ts — RepoFind 核心逻辑 (纯客户端, 无 server / 无 Python)
 * 扫描本地 git 仓库 → 提取元数据 (读 .git 内部文件) → 索引 → 混合检索 → 落盘
 */

import os from "os";
import * as fs from "fs/promises";

// ---------- 类型 ----------

export interface RepoEntry {
  path: string;
  name: string;
  readme: string;
  langs: string[];
  branch: string;
  remote: string;
  /** HEAD 最后一次变动: "2026-11-01 fix: xxx" (不是 commit 时只有日期) */
  lastCommit: string;
}

export interface EmbedConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface HybridHit {
  entry: RepoEntry;
  score: number;
  matched: string[];
  semantic: boolean;
}

// ---------- 常量 ----------

const README_NAMES = ["README.md", "README.rst", "README.txt", "README", "readme.md"];
const SKIP_DIRS = new Set([
  "node_modules", ".cache", ".venv", "venv", "__pycache__",
  "target", "dist", ".stack-work", "Pods", "DerivedData",
]);
const MAX_DEPTH = 5;
const MAX_README_CHARS = 2000;
/** fs.writeFile 单文件上限 8 MiB, 留余量 */
const MAX_FILE_BYTES = 7 * 1024 * 1024;

const EXT_LANG: Record<string, string> = {
  ".py": "Python", ".rs": "Rust", ".ts": "TypeScript", ".tsx": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".go": "Go",
  ".java": "Java", ".swift": "Swift", ".c": "C", ".h": "C", ".cpp": "C++",
  ".cc": "C++", ".sh": "Shell", ".rb": "Ruby", ".lua": "Lua", ".zig": "Zig",
  ".kt": "Kotlin", ".scala": "Scala", ".vue": "Vue", ".php": "PHP",
};

// ---------- 路径工具 ----------

let homeCache: string | null = null;

/** 用户主目录; 没有主目录的平台 (浏览器) 返回 "" */
export function home(): string {
  if (homeCache === null) {
    try {
      homeCache = os.homedir();
    } catch {
      homeCache = "";
    }
  }
  return homeCache;
}

export function expandTilde(p: string): string {
  if (p === "~") return home();
  if (p.startsWith("~/")) return home() + p.slice(1);
  return p;
}

/** 展示用: 把主目录前缀换回 ~ */
export function tildify(p: string): string {
  const h = home();
  return h && p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

export function joinPath(a: string, b: string): string {
  return a.endsWith("/") ? a + b : a + "/" + b;
}

function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 运行时的 Dirent.isDirectory 是方法; 测试桩跨边界后只剩布尔值, 两种都认 */
function isDir(e: { isDirectory: unknown }): boolean {
  return typeof e.isDirectory === "function" ? !!e.isDirectory() : !!e.isDirectory;
}

function errCode(err: unknown): string {
  return (err as { code?: string })?.code ?? String(err);
}

// ---------- 扫描 ----------

/**
 * 递归找 git 仓库 (目录里有 .git 的)。找到仓库后不再深入, 所以子模块/嵌套仓库不重复计入。
 * 根目录读不了会抛错 (权限没授予/路径写错), 子目录读不了静默跳过。
 */
export async function findRepos(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) throw new Error(`${dir}: ${errCode(err)}`);
      return;
    }
    // .git 是目录 (普通仓库) 或文件 (worktree / submodule)
    if (entries.some((e) => e.name === ".git")) {
      found.push(dir);
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (!isDir(e)) continue;
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      await walk(joinPath(dir, e.name), depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

/** reflog 一行 → "YYYY-MM-DD [commit 标题]"。只有 commit 类条目才带标题, pull/checkout 等只留日期 */
export function parseReflogLine(line: string): string {
  // 格式: <old> <new> <name...> <email> <ts> <tz>\t<message>
  const m = line.match(/ (\d{9,}) [+\-]\d{4}\t(.*)$/);
  if (!m) return "";
  const date = new Date(parseInt(m[1], 10) * 1000);
  const ymd = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  const c = m[2].match(/^commit(?: \([^)]*\))?: (.*)$/);
  return c ? `${ymd} ${c[1]}`.slice(0, 80) : ymd;
}

/** 从 .git 内部文件提取 branch / remote / 最近活动 (不调 git 进程) */
async function gitMeta(gitDir: string): Promise<{ branch: string; remote: string; lastCommit: string }> {
  let branch = "";
  let remote = "";
  let lastCommit = "";
  try {
    const head = await fs.readFile(joinPath(gitDir, "HEAD"), "utf8");
    const m = head.match(/ref:\s*refs\/heads\/(\S+)/);
    if (m) branch = m[1];
  } catch { /* .git 是文件 (worktree) 或空仓库 */ }
  try {
    const cfg = await fs.readFile(joinPath(gitDir, "config"), "utf8");
    const m = cfg.match(/\[remote "origin"\][^\[]*?url\s*=\s*(\S+)/);
    if (m) remote = m[1];
  } catch { /* 无远端 */ }
  try {
    const log = await fs.readFile(joinPath(joinPath(gitDir, "logs"), "HEAD"), "utf8");
    const lines = log.trim().split("\n").filter(Boolean);
    // 优先取最近一条 commit 记录 (有标题), 否则退回最后一条的日期
    let picked = "";
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 50; i--) {
      const s = parseReflogLine(lines[i]);
      if (s.length > 10) { picked = s; break; }
    }
    lastCommit = picked || parseReflogLine(lines[lines.length - 1] ?? "");
  } catch { /* 没有 reflog */ }
  return { branch, remote, lastCommit };
}

async function detectLangs(repo: string): Promise<string[]> {
  const counts: Record<string, number> = {};
  const walk = async (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (isDir(e)) {
        if (e.name === ".git" || SKIP_DIRS.has(e.name)) continue;
        await walk(joinPath(dir, e.name), depth + 1);
      } else {
        const dot = e.name.lastIndexOf(".");
        if (dot >= 0) {
          const lang = EXT_LANG[e.name.slice(dot).toLowerCase()];
          if (lang) counts[lang] = (counts[lang] ?? 0) + 1;
        }
      }
    }
  };
  await walk(repo, 0);
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l);
}

async function readReadme(repo: string): Promise<string> {
  for (const name of README_NAMES) {
    try {
      const text = await fs.readFile(joinPath(repo, name), "utf8");
      return text.slice(0, MAX_README_CHARS);
    } catch { /* 试下一个 */ }
  }
  return "";
}

export async function scanRepo(repoPath: string): Promise<RepoEntry> {
  const [meta, langs, readme] = await Promise.all([
    gitMeta(joinPath(repoPath, ".git")),
    detectLangs(repoPath),
    readReadme(repoPath),
  ]);
  return { path: repoPath, name: baseName(repoPath), readme, langs, ...meta };
}

// ---------- 分词 ----------

const CJK_G = /[\u4e00-\u9fff]/g;
const TOKEN = /[a-zA-Z][a-zA-Z0-9_\-]*/g;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.match(TOKEN) ?? []) {
    tokens.push(raw.toLowerCase());
    const parts = raw.match(/[A-Z][a-z]+|[a-z]+|[A-Z]+(?![a-z])/g);
    if (parts && parts.length > 1) tokens.push(...parts.map((p) => p.toLowerCase()));
  }
  const cjk = text.match(CJK_G);
  if (cjk) {
    const s = cjk.join("");
    tokens.push(s);
    for (let i = 0; i < s.length - 1; i++) tokens.push(s.slice(i, i + 2));
  }
  return tokens;
}

export function pathTokens(path: string): string[] {
  return tokenize(path.split(/[/_.\-]/).join(" "));
}

// ---------- 词法索引 (TF-IDF, 名称 > 路径 > README > 语言) ----------

interface LexDoc { pt: Set<string>; nt: Set<string>; rt: Set<string>; lt: Set<string> }
export interface LexIndex { df: Map<string, number>; docs: LexDoc[]; n: number }

export function buildLex(entries: RepoEntry[]): LexIndex {
  const df = new Map<string, number>();
  const docs = entries.map((e) => {
    const pt = new Set(pathTokens(tildify(e.path)));
    const nt = new Set(tokenize(e.name));
    const rt = new Set(tokenize(e.readme));
    const lt = new Set(tokenize(e.langs.join(" ")));
    for (const t of new Set([...pt, ...nt, ...rt, ...lt])) df.set(t, (df.get(t) ?? 0) + 1);
    return { pt, nt, rt, lt };
  });
  return { df, docs, n: entries.length };
}

export function lexSearch(lex: LexIndex, query: string): { idx: number; score: number; matched: string[] }[] {
  const qt = new Set([...tokenize(query), ...pathTokens(query)]);
  const out: { idx: number; score: number; matched: string[] }[] = [];
  for (let i = 0; i < lex.n; i++) {
    const { pt, nt, rt, lt } = lex.docs[i];
    let score = 0;
    const matched: string[] = [];
    for (const tok of qt) {
      const idf = Math.log((lex.n + 1) / ((lex.df.get(tok) ?? 0) + 1)) + 0.01;
      if (nt.has(tok)) { score += 6 * idf; matched.push(tok); }
      else if (pt.has(tok)) { score += 4 * idf; matched.push(tok); }
      else if (rt.has(tok)) { score += 2 * idf; matched.push(tok); }
      else if (lt.has(tok)) { score += 1.5 * idf; matched.push(tok); }
    }
    if (score > 0) out.push({ idx: i, score, matched });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------- Embedding (OpenAI 兼容接口) ----------

export async function embedTexts(
  cfg: EmbedConfig,
  texts: string[],
  batch = 32,
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/embeddings";
  for (let i = 0; i < texts.length; i += batch) {
    const chunk = texts.slice(i, i + batch).map((t) => t.slice(0, 4000));
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, input: chunk }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`embedding API ${res.status}: ${body.slice(0, 160)}`);
    }
    const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    if (!Array.isArray(data.data) || data.data.length !== chunk.length) {
      throw new Error("embedding API: unexpected response shape");
    }
    for (const d of [...data.data].sort((a, b) => a.index - b.index)) out.push(Float32Array.from(d.embedding));
    onProgress?.(Math.min(i + batch, texts.length), texts.length);
  }
  return out;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export function repoText(e: RepoEntry): string {
  const parts = [e.name, tildify(e.path)];
  if (e.langs.length) parts.push("languages: " + e.langs.join(" "));
  if (e.readme) parts.push(e.readme.slice(0, 1500));
  return parts.join("\n").slice(0, 4000);
}

// ---------- 混合排序 ----------

function minmax(scores: number[]): number[] {
  if (!scores.length) return scores;
  const lo = Math.min(...scores), hi = Math.max(...scores);
  const rng = hi - lo || 1;
  return scores.map((s) => (s - lo) / rng);
}

/** 语义 0.6 + 词法 0.4 (各自 min-max 归一化); semScores 为 null 时纯词法 */
export function hybridSearch(
  entries: RepoEntry[],
  lexHits: { idx: number; score: number; matched: string[] }[],
  semScores: Map<number, number> | null,
  topN = 20,
): HybridHit[] {
  const fused = new Map<number, { score: number; matched: string[] }>();
  const lexNorm = minmax(lexHits.map((h) => h.score));
  // 没有语义分时词法分直接占满 0~1, 否则按 0.4 加权
  const lexWeight = semScores ? 0.4 : 1;
  lexHits.forEach((h, i) => {
    fused.set(h.idx, { score: lexWeight * lexNorm[i], matched: h.matched });
  });
  if (semScores) {
    const keys = [...semScores.keys()];
    const norm = minmax(keys.map((k) => semScores.get(k)!));
    keys.forEach((idx, i) => {
      const f = fused.get(idx) ?? { score: 0, matched: [] };
      f.score += 0.6 * norm[i];
      fused.set(idx, f);
    });
  }
  return [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, topN)
    .map(([idx, f]) => ({
      entry: entries[idx],
      score: f.score,
      matched: [...new Set(f.matched)].slice(0, 8),
      semantic: semScores !== null && semScores.has(idx),
    }));
}

// ---------- 落盘 (应用数据目录) ----------
// 索引和向量存文件而不是 Storage: Storage 配额 5MB, 几百个仓库的 1024 维向量就超了。

export interface SavedIndex { scannedAt: string; repos: RepoEntry[] }
export interface SavedVectors { model: string; baseUrl: string; vectors: Float32Array[] }

function dataFile(dataDir: string, name: string): string {
  return joinPath(dataDir, name);
}

export async function saveIndex(dataDir: string, idx: SavedIndex): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
  let repos = idx.repos;
  let json = JSON.stringify({ version: 1, scannedAt: idx.scannedAt, repos });
  // 极端情况 (上千个仓库) 超过单文件上限: 逐步截短 README
  for (let cap = MAX_README_CHARS / 2; json.length * 3 > MAX_FILE_BYTES && cap >= 100; cap = Math.floor(cap / 2)) {
    repos = idx.repos.map((r) => ({ ...r, readme: r.readme.slice(0, cap) }));
    json = JSON.stringify({ version: 1, scannedAt: idx.scannedAt, repos });
  }
  await fs.writeFile(dataFile(dataDir, "index.json"), json);
}

export async function loadIndex(dataDir: string): Promise<SavedIndex | null> {
  try {
    const d = JSON.parse(await fs.readFile(dataFile(dataDir, "index.json"), "utf8"));
    return Array.isArray(d.repos) ? { scannedAt: d.scannedAt ?? "", repos: d.repos } : null;
  } catch {
    return null;
  }
}

export async function saveVectors(dataDir: string, v: SavedVectors): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
  const dims = v.vectors[0]?.length ?? 0;
  const rowsPerPart = Math.max(1, Math.floor(MAX_FILE_BYTES / Math.max(1, dims * 4)));
  let parts = 0;
  for (let start = 0; start < v.vectors.length; start += rowsPerPart, parts++) {
    const rows = v.vectors.slice(start, start + rowsPerPart);
    const buf = new Float32Array(rows.length * dims);
    rows.forEach((r, i) => buf.set(r, i * dims));
    await fs.writeFile(dataFile(dataDir, `vectors-${parts}.bin`), new Uint8Array(buf.buffer));
  }
  // meta 最后写: 读到 meta 就说明所有分片都写完了
  await fs.writeFile(
    dataFile(dataDir, "vectors.json"),
    JSON.stringify({ version: 1, model: v.model, baseUrl: v.baseUrl, dims, count: v.vectors.length, parts }),
  );
}

/** 拷贝成一块独立对齐的内存 (测试桩跨边界后可能只是普通数组/对象) */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data.slice();
  return Uint8Array.from(Array.isArray(data) ? data : Object.values(data as Record<string, number>));
}

export async function loadVectors(dataDir: string): Promise<SavedVectors | null> {
  try {
    const meta = JSON.parse(await fs.readFile(dataFile(dataDir, "vectors.json"), "utf8"));
    const vectors: Float32Array[] = [];
    for (let p = 0; p < meta.parts; p++) {
      const bytes = toBytes(await fs.readFile(dataFile(dataDir, `vectors-${p}.bin`)));
      const all = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
      for (let off = 0; off + meta.dims <= all.length; off += meta.dims) {
        vectors.push(all.subarray(off, off + meta.dims));
      }
    }
    if (vectors.length !== meta.count) return null;
    return { model: meta.model, baseUrl: meta.baseUrl ?? "", vectors };
  } catch {
    return null;
  }
}

export async function clearVectors(dataDir: string): Promise<void> {
  await fs.unlink(dataFile(dataDir, "vectors.json")).catch(() => {});
}
