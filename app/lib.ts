/**
 * lib.ts — RepoFind 核心逻辑 (纯 TSX, 无 server / 无 Python)
 * 扫描本地 git 仓库 → 提取元数据 (读 .git 内部文件) → 索引 → 混合检索
 */

import osDefault from "os";
import * as fsPromises from "fs/promises";

const os = osDefault as { homedir(): string };
const fs = fsPromises as {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(path: string, options: { withFileTypes: true }): Promise<{ name: string; isDirectory(): boolean }[]>;
};

// ---------- 类型 ----------

export interface RepoEntry {
  path: string;
  name: string;
  readme: string;
  langs: string[];
  branch: string;
  remote: string;
  lastCommit: string; // "2026-11-01 fix: xxx"
}

export interface IndexData {
  version: 1;
  scannedAt: string;
  roots: string[];
  repos: RepoEntry[];
}

export interface SearchHit {
  entry: RepoEntry;
  score: number;
  matched: string[];
}

export interface EmbedConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface VectorData {
  model: string;
  baseUrl: string;
  dims: number;
  vectors: number[][]; // 与 index.repos 对齐
}

// ---------- 常量 ----------

export const README_NAMES = [
  "README.md", "README.rst", "README.txt", "README", "readme.md",
];
const SKIP_DIRS = new Set([
  "node_modules", ".cache", ".venv", "venv", "__pycache__",
  "target", "dist", ".stack-work", "Pods", "DerivedData",
]);
const MAX_DEPTH = 5;
const MAX_README_CHARS = 2000;

const EXT_LANG: Record<string, string> = {
  ".py": "Python", ".rs": "Rust", ".ts": "TypeScript", ".tsx": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".go": "Go",
  ".java": "Java", ".swift": "Swift", ".c": "C", ".h": "C", ".cpp": "C++",
  ".cc": "C++", ".sh": "Shell", ".rb": "Ruby", ".lua": "Lua", ".zig": "Zig",
  ".kt": "Kotlin", ".scala": "Scala", ".vue": "Vue", ".php": "PHP",
};

// ---------- 路径工具 (手动拼, fs API 用绝对路径) ----------

export function home(): string {
  return os.homedir();
}

export function expandTilde(p: string): string {
  if (p === "~") return home();
  if (p.startsWith("~/")) return home() + p.slice(1);
  return p;
}

export function joinPath(a: string, b: string): string {
  return a.endsWith("/") ? a + b : a + "/" + b;
}

function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// ---------- 扫描 ----------

/** 递归找 git 仓库 (存在 .git 目录的), 不深入仓库内部 */
export async function findRepos(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无权限/不存在, 静默跳过
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = joinPath(dir, e.name);
      if (e.name === ".git") {
        found.push(dir);
        continue;
      }
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

/** 从 .git 内部文件提取 branch / remote / last commit (不调 git 进程) */
async function gitMeta(gitDir: string): Promise<{ branch: string; remote: string; lastCommit: string }> {
  let branch = "";
  let remote = "";
  let lastCommit = "";
  // HEAD: "ref: refs/heads/main"
  try {
    const head = await fs.readFile(joinPath(gitDir, "HEAD"), "utf8");
    const m = head.match(/ref:\s*refs\/heads\/(\S+)/);
    if (m) branch = m[1];
  } catch { /* 空仓库 */ }
  // config: remote "origin" url
  try {
    const cfg = await fs.readFile(joinPath(gitDir, "config"), "utf8");
    const m = cfg.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(\S+)/);
    if (m) remote = m[1];
  } catch { /* 无远端 */ }
  // FETCH_HEAD / COMMIT_EDITMSG / ORIG_HEAD 都不可靠, 用 logs/HEAD 最新一条
  try {
    const log = await fs.readFile(joinPath(joinPath(gitDir, "logs"), "HEAD"), "utf8");
    const lines = log.trim().split("\n").filter(Boolean);
    const last = lines[lines.length - 1];
    // 格式: <old> <new> <name> <email> <ts> <tz>\tmessage
    const m = last?.match(/^\S+ \S+ \S+ \S+ (\d+) [+\-]\d{4}\t(.*)$/);
    if (m) {
      const date = new Date(parseInt(m[1]) * 1000);
      const y = date.getFullYear();
      const mo = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      lastCommit = `${y}-${mo}-${d} ${m[2]}`.slice(0, 80);
    }
  } catch { /* shallow clone 无 logs */ }
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
      if (e.isDirectory()) {
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
  return {
    path: repoPath,
    name: baseName(repoPath),
    readme,
    langs,
    ...meta,
  };
}

// ---------- 分词 ----------

const CJK = /[\u4e00-\u9fff]/;
const TOKEN = /[a-zA-Z][a-zA-Z0-9_\-]*/g;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.match(TOKEN) ?? []) {
    const low = raw.toLowerCase();
    tokens.push(low);
    const parts = raw.match(/[A-Z][a-z]+|[a-z]+|[A-Z]+(?![a-z])/g);
    if (parts && parts.length > 1) tokens.push(...parts.map((p) => p.toLowerCase()));
  }
  const cjkRuns = text.match(new RegExp(CJK.source, "g")) ?? [];
  if (cjkRuns.length) {
    const s = cjkRuns.join("");
    tokens.push(s);
    for (let i = 0; i < s.length - 1; i++) tokens.push(s.slice(i, i + 2));
    if (s.length === 1) tokens.push(s);
  }
  return tokens;
}

export function pathTokens(path: string): string[] {
  return tokenize(path.split(/[/_.\-]/).join(" "));
}

// ---------- 词法索引 ----------

export class LexicalIndex {
  private df = new Map<string, number>();
  private docs: { pt: Set<string>; nt: Set<string>; rt: Set<string>; lt: Set<string> }[] = [];
  private n = 0;

  constructor(entries: RepoEntry[]) {
    this.n = entries.length;
    for (const e of entries) {
      const pt = new Set(pathTokens(e.path.replace(home(), "~")));
      const nt = new Set(tokenize(e.name));
      const rt = new Set(tokenize(e.readme));
      const lt = new Set(tokenize(e.langs.join(" ")));
      this.docs.push({ pt, nt, rt, lt });
      for (const t of new Set([...pt, ...nt, ...rt, ...lt])) {
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    }
  }

  private idf(t: string): number {
    return Math.log((this.n + 1) / ((this.df.get(t) ?? 0) + 1)) + 0.01;
  }

  search(query: string, topN = 20): SearchHit[] {
    const qt = new Set([...tokenize(query), ...pathTokens(query)]);
    const hits: SearchHit[] = [];
    for (let i = 0; i < this.n; i++) {
      const { pt, nt, rt, lt } = this.docs[i];
      let score = 0;
      const matched: string[] = [];
      for (const tok of qt) {
        const w = this.idf(tok);
        if (nt.has(tok)) { score += 6 * w; matched.push(tok); }
        else if (pt.has(tok)) { score += 4 * w; matched.push(tok); }
        else if (rt.has(tok)) { score += 2 * w; matched.push(tok); }
        else if (lt.has(tok)) { score += 1.5 * w; matched.push(tok); }
      }
      if (score > 0) hits.push({ entry: { path: "", name: "" } as RepoEntry, score, matched });
      // entry 由调用方按下标回填 (避免持有大对象)
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topN);
  }
}

// ---------- Embedding ----------

export async function embedTexts(cfg: EmbedConfig, texts: string[], batch = 32): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batch) {
    const chunk = texts.slice(i, i + batch).map((t) => t.slice(0, 4000));
    const res = await fetch(joinUrl(cfg.baseUrl, "/embeddings"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, input: chunk }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`embedding API ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    for (const d of [...data.data].sort((a, b) => a.index - b.index)) out.push(d.embedding);
  }
  return out;
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export function repoText(e: RepoEntry): string {
  const parts = [e.name, e.path.replace(home(), "~")];
  if (e.langs.length) parts.push("语言: " + e.langs.join(" "));
  if (e.readme) parts.push(e.readme.slice(0, 1500));
  return parts.join("\n").slice(0, 4000);
}

// ---------- 混合检索 ----------

export function minmax(scores: number[]): number[] {
  if (!scores.length) return scores;
  const lo = Math.min(...scores), hi = Math.max(...scores);
  const rng = hi - lo || 1;
  return scores.map((s) => (s - lo) / rng);
}

export interface HybridHit {
  entry: RepoEntry;
  score: number;
  matched: string[];
  semantic: boolean;
}

/**
 * 混合排序: 语义 0.6 + 词法 0.4 (各自 min-max 归一化)
 * semantic=false 时纯词法
 */
export function hybridSearch(
  entries: RepoEntry[],
  lexHits: { idx: number; score: number; matched: string[] }[],
  semScores: Map<number, number> | null,
  topN = 20,
): HybridHit[] {
  const fused = new Map<number, { score: number; matched: string[] }>();
  const lexNorm = minmax(lexHits.map((h) => h.score));
  lexHits.forEach((h, i) => {
    const f = fused.get(h.idx) ?? { score: 0, matched: [] };
    f.score += 0.4 * lexNorm[i];
    f.matched.push(...h.matched);
    fused.set(h.idx, f);
  });
  if (semScores) {
    const arr = [...semScores.values()];
    const norm = minmax(arr);
    [...semScores.keys()].forEach((idx, i) => {
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
