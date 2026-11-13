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
  /** 一句话简介: manifest 的 description, 没有就取 README 第一句正文 */
  desc: string;
  /** manifest 里声明的 keywords (小写) */
  keywords: string[];
  /** 依赖名 (小写, 最多 MAX_DEPS 个): 只用来判断分类和词法检索, 不发给 embedding 接口 */
  deps: string[];
  /** 仓库根目录下的文件/目录名 (目录带 "/" 后缀, 最多 MAX_FILES 个) */
  files: string[];
  /** HEAD 最后一次变动的时间戳 (ms); 0 = 不知道 */
  lastTs: number;
  /** reflog 里本机做的 commit 次数: 0 说明只是 clone 下来看的 */
  commits: number;
  /** 主题标签 (tags.ts classify): 扫描时算好存进索引, 打开应用时不用再算 */
  topics?: string[];
}

/** 老版本索引里没有的字段补上默认值 */
export function normalizeEntry(e: Partial<RepoEntry> & { path: string }): RepoEntry {
  const lastCommit = e.lastCommit ?? "";
  let lastTs = e.lastTs ?? 0;
  if (!lastTs) {
    const m = lastCommit.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) lastTs = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  }
  return {
    path: e.path,
    name: e.name ?? baseName(e.path),
    readme: e.readme ?? "",
    langs: e.langs ?? [],
    branch: e.branch ?? "",
    remote: e.remote ?? "",
    lastCommit,
    desc: e.desc ?? "",
    keywords: e.keywords ?? [],
    deps: e.deps ?? [],
    files: e.files ?? [],
    lastTs,
    commits: e.commits ?? 0,
    ...(Array.isArray(e.topics) ? { topics: e.topics } : {}),
  };
}

export interface EmbedConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface HybridHit {
  /** 在仓库列表里的下标 */
  idx: number;
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
const MAX_DEPS = 40;
const MAX_FILES = 50;
const MAX_MANIFEST_CHARS = 40000;
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
  if (p.startsWith("~/") || p.startsWith("~\\")) return home() + p.slice(1);
  return p;
}

/** 展示用: 把主目录前缀换回 ~ */
export function tildify(p: string): string {
  const h = home();
  return h && p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

export function joinPath(a: string, b: string): string {
  // Windows 的文件 API 也认 "/", 所以统一用它拼
  return a.endsWith("/") || a.endsWith("\\") ? a + b : a + "/" + b;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
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
async function gitMeta(
  gitDir: string,
): Promise<{ branch: string; remote: string; lastCommit: string; lastTs: number; commits: number }> {
  let branch = "";
  let remote = "";
  let lastCommit = "";
  let lastTs = 0;
  let commits = 0;
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
    const ts = (lines[lines.length - 1] ?? "").match(/ (\d{9,}) [+\-]\d{4}\t/);
    if (ts) lastTs = parseInt(ts[1], 10) * 1000;
    for (const line of lines) if (/\tcommit(?: \([^)]*\))?: /.test(line)) commits++;
  } catch { /* 没有 reflog */ }
  if (!lastTs) {
    try {
      lastTs = Math.round((await fs.stat(joinPath(gitDir, "HEAD"))).mtimeMs) || 0;
    } catch { /* .git 是文件 (worktree) */ }
  }
  return { branch, remote, lastCommit, lastTs, commits };
}

// ---------- manifest: 简介 / 关键词 / 依赖 ----------

interface Manifest { desc: string; keywords: string[]; deps: string[] }

const tomlString = (text: string, key: string): string =>
  text.match(new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m"))?.[1] ?? "";

const tomlArray = (text: string, key: string): string[] => {
  const body = text.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"))?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]);
};

/** "torch>=2.0 ; python_version..." → "torch" */
const pyDepName = (spec: string): string => spec.trim().match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0] ?? "";

/** 各语言 manifest 的解析: 只取简介、关键词和依赖名, 解析不了就当没有 */
export const MANIFESTS: Record<string, (text: string) => Partial<Manifest>> = {
  "package.json": (text) => {
    const j = JSON.parse(text);
    return {
      desc: typeof j.description === "string" ? j.description : "",
      keywords: Array.isArray(j.keywords) ? j.keywords.filter((k: unknown) => typeof k === "string") : [],
      deps: [...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})],
    };
  },
  "Cargo.toml": (text) => {
    const deps: string[] = [];
    let inDeps = false;
    for (const line of text.split("\n")) {
      const sec = line.match(/^\s*\[([^\]]+)\]/);
      if (sec) {
        inDeps = /dependencies$/.test(sec[1]);
        const one = sec[1].match(/dependencies\.([\w-]+)$/); // [dependencies.tokio]
        if (one) deps.push(one[1]);
      } else if (inDeps) {
        const m = line.match(/^\s*([\w-]+)\s*=/);
        if (m) deps.push(m[1]);
      }
    }
    return { desc: tomlString(text, "description"), keywords: tomlArray(text, "keywords"), deps };
  },
  "pyproject.toml": (text) => {
    const deps = tomlArray(text, "dependencies").map(pyDepName);
    const poetry = text.match(/\[tool\.poetry\.dependencies\]([^\[]*)/)?.[1] ?? "";
    for (const m of poetry.matchAll(/^\s*([\w.-]+)\s*=/gm)) deps.push(m[1]);
    return { desc: tomlString(text, "description"), keywords: tomlArray(text, "keywords"), deps };
  },
  "requirements.txt": (text) => ({
    deps: text.split("\n").filter((l) => !/^\s*(#|-)/.test(l)).map(pyDepName),
  }),
  "setup.py": (text) => ({
    desc: text.match(/\bdescription\s*=\s*["']([^"'\n]+)["']/)?.[1] ?? "",
  }),
  "go.mod": (text) => ({
    deps: [...text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[a-z]+\/[^\s]+)\s+v\d/gm)].map((m) => m[1]),
  }),
  "pom.xml": (text) => ({
    desc: text.match(/<description>\s*([^<]{4,200}?)\s*<\/description>/)?.[1] ?? "",
    deps: [...text.matchAll(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g)].map((m) => m[1]),
  }),
};

/** README 里第一句像正文的话: 跳过标题、徽章、HTML、代码块和目录 */
export function readmeTagline(readme: string): string {
  let inCode = false;
  for (const raw of readme.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) { inCode = !inCode; continue; }
    if (inCode || !line) continue;
    if (/^(#|=+$|-+$|\*+$|<|!\[|\[!\[|\||>\s*\[!|\.\. )/.test(line)) continue;
    const text = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")       // 图片
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")    // 链接 → 文字
      .replace(/<[^>]+>/g, "")
      .replace(/^[>*\-+\s]+/, "")
      .replace(/[*_`]/g, "")
      .trim();
    // "English | 简体中文" 这类语言切换 / 导航链接不算简介
    const isNav = /\s[|·•]\s/.test(text) && text.length < 60;
    if (!isNav && text.length >= 12 && /[A-Za-z\u4e00-\u9fff]/.test(text)) return text.slice(0, 160);
  }
  return "";
}

async function readManifests(repo: string, names: Set<string>): Promise<Manifest> {
  const out: Manifest = { desc: "", keywords: [], deps: [] };
  for (const [name, parse] of Object.entries(MANIFESTS)) {
    if (!names.has(name)) continue;
    try {
      const text = (await fs.readFile(joinPath(repo, name), "utf8")).slice(0, MAX_MANIFEST_CHARS);
      const m = parse(text);
      if (!out.desc && m.desc) out.desc = m.desc.trim().slice(0, 160);
      out.keywords.push(...(m.keywords ?? []));
      out.deps.push(...(m.deps ?? []));
    } catch { /* 读不了或格式不对: 跳过这个 manifest */ }
  }
  const clean = (xs: string[], max: number) =>
    [...new Set(xs.map((x) => x.toLowerCase().trim()).filter(Boolean))].slice(0, max);
  return { desc: out.desc, keywords: clean(out.keywords, 20), deps: clean(out.deps, MAX_DEPS) };
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

async function readReadme(repo: string, names: Set<string>): Promise<string> {
  for (const name of README_NAMES) {
    if (!names.has(name)) continue;
    try {
      const text = await fs.readFile(joinPath(repo, name), "utf8");
      return text.slice(0, MAX_README_CHARS);
    } catch { /* 试下一个 */ }
  }
  return "";
}

export async function scanRepo(repoPath: string): Promise<RepoEntry> {
  let top: { name: string; isDirectory: unknown }[] = [];
  try {
    top = await fs.readdir(repoPath, { withFileTypes: true });
  } catch { /* 读不了: 只剩 .git 元数据 */ }
  const names = new Set(top.map((e) => e.name));
  const files = top
    .filter((e) => e.name !== ".git" && e.name !== ".DS_Store")
    .map((e) => (isDir(e) ? e.name + "/" : e.name))
    .slice(0, MAX_FILES);
  const [meta, langs, readme, manifest] = await Promise.all([
    gitMeta(joinPath(repoPath, ".git")),
    detectLangs(repoPath),
    readReadme(repoPath, names),
    readManifests(repoPath, names),
  ]);
  return {
    path: repoPath,
    name: baseName(repoPath),
    readme,
    langs,
    ...meta,
    desc: manifest.desc || readmeTagline(readme),
    keywords: manifest.keywords,
    deps: manifest.deps,
    files,
  };
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
  return tokenize(path.split(/[\\/_.\-]/).join(" "));
}

// ---------- 词法索引 (TF-IDF, 名称 > 路径 > 简介/关键词 > README > 语言/标签 > 文件名/依赖) ----------

interface LexDoc {
  pt: Set<string>; nt: Set<string>; dt: Set<string>; rt: Set<string>; lt: Set<string>; ft: Set<string>;
}
export interface LexIndex { df: Map<string, number>; docs: LexDoc[]; n: number }

/** extra[i]: 第 i 个仓库额外可搜的词 (分类标签的名字), 和语言同权重 */
export function buildLex(entries: RepoEntry[], extra: string[] = []): LexIndex {
  const df = new Map<string, number>();
  const docs = entries.map((e, i) => {
    const pt = new Set(pathTokens(tildify(e.path)));
    const nt = new Set(tokenize(e.name));
    const dt = new Set(tokenize(e.desc + " " + e.keywords.join(" ")));
    const rt = new Set(tokenize(e.readme));
    const lt = new Set(tokenize(e.langs.join(" ") + " " + (extra[i] ?? "")));
    const ft = new Set(pathTokens(e.files.join(" ") + " " + e.deps.join(" ")));
    for (const t of new Set([...pt, ...nt, ...dt, ...rt, ...lt, ...ft])) df.set(t, (df.get(t) ?? 0) + 1);
    return { pt, nt, dt, rt, lt, ft };
  });
  return { df, docs, n: entries.length };
}

export function lexSearch(lex: LexIndex, query: string): { idx: number; score: number; matched: string[] }[] {
  const qt = new Set([...tokenize(query), ...pathTokens(query)]);
  const out: { idx: number; score: number; matched: string[] }[] = [];
  for (let i = 0; i < lex.n; i++) {
    const { pt, nt, dt, rt, lt, ft } = lex.docs[i];
    let score = 0;
    const matched: string[] = [];
    for (const tok of qt) {
      const idf = Math.log((lex.n + 1) / ((lex.df.get(tok) ?? 0) + 1)) + 0.01;
      if (nt.has(tok)) { score += 6 * idf; matched.push(tok); }
      else if (pt.has(tok)) { score += 4 * idf; matched.push(tok); }
      else if (dt.has(tok)) { score += 3 * idf; matched.push(tok); }
      else if (rt.has(tok)) { score += 2 * idf; matched.push(tok); }
      else if (lt.has(tok)) { score += 1.5 * idf; matched.push(tok); }
      else if (ft.has(tok)) { score += 1 * idf; matched.push(tok); }
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
      // 本地服务 (LM Studio / llama.cpp) 一般不要 key, 不填就不带这个头
      headers: cfg.apiKey
        ? { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` }
        : { "Content-Type": "application/json" },
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
  if (e.desc) parts.push(e.desc);
  if (e.langs.length) parts.push("languages: " + e.langs.join(" "));
  if (e.keywords.length) parts.push("keywords: " + e.keywords.join(" "));
  if (e.files.length) parts.push("files: " + e.files.slice(0, 30).join(" "));
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
      idx,
      entry: entries[idx],
      score: f.score,
      matched: [...new Set(f.matched)].slice(0, 8),
      semantic: semScores !== null && semScores.has(idx),
    }));
}

// ---------- 落盘 (应用数据目录) ----------
// 索引和向量存文件而不是 Storage: Storage 配额 5MB, 几百个仓库的 1024 维向量就超了。

/** 索引格式版本: 2 起带 简介 / 关键词 / 依赖 / 顶层文件 / 时间戳 / 提交数 */
export const INDEX_VERSION = 2;
/** tagsVersion: 算 topics 时分类规则的版本 (tags.ts TAGS_VERSION), 对不上就重算 */
export interface SavedIndex { scannedAt: string; repos: RepoEntry[]; version?: number; tagsVersion?: number }
/**
 * key: 向量是谁生成的 ("local:multilingual-e5-small", "api:https://…#bge-m3"), 换了就不能混用;
 * hashes[i]: 生成第 i 个向量时仓库文本的指纹, 重新索引时文本没变就直接复用
 */
export interface SavedVectors { key: string; hashes: string[]; vectors: Float32Array[] }

/** 文本指纹 (两轮 FNV-1a, 64 位): 只用来判断 "变没变" */
export function textHash(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

function dataFile(dataDir: string, name: string): string {
  return joinPath(dataDir, name);
}

export async function saveIndex(dataDir: string, idx: SavedIndex): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
  let repos = idx.repos;
  // version: 给旧索引补主题后存回去时保留原来的版本号 (还是要提示重扫)
  const head = { version: idx.version ?? INDEX_VERSION, tagsVersion: idx.tagsVersion ?? 0, scannedAt: idx.scannedAt };
  let json = JSON.stringify({ ...head, repos });
  // 极端情况 (上千个仓库) 超过单文件上限: 逐步截短 README
  for (let cap = MAX_README_CHARS / 2; json.length * 3 > MAX_FILE_BYTES && cap >= 100; cap = Math.floor(cap / 2)) {
    repos = idx.repos.map((r) => ({ ...r, readme: r.readme.slice(0, cap) }));
    json = JSON.stringify({ ...head, repos });
  }
  await fs.writeFile(dataFile(dataDir, "index.json"), json);
}

export async function loadIndex(dataDir: string): Promise<SavedIndex | null> {
  try {
    const d = JSON.parse(await fs.readFile(dataFile(dataDir, "index.json"), "utf8"));
    if (!Array.isArray(d.repos)) return null;
    const repos = d.repos.filter((r: { path?: unknown }) => typeof r?.path === "string").map(normalizeEntry);
    return { scannedAt: d.scannedAt ?? "", repos, version: d.version ?? 1, tagsVersion: d.tagsVersion ?? 0 };
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
    JSON.stringify({ version: 2, key: v.key, hashes: v.hashes, dims, count: v.vectors.length, parts }),
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
    // 版本 1 只记了接口地址和模型名, 当作外部 API 生成的; 没有指纹, 下次索引全部重算
    const key = meta.key ?? `api:${meta.baseUrl ?? ""}#${meta.model ?? ""}`;
    const hashes = Array.isArray(meta.hashes) && meta.hashes.length === vectors.length ? meta.hashes : [];
    return { key, hashes, vectors };
  } catch {
    return null;
  }
}

export async function clearVectors(dataDir: string): Promise<void> {
  await fs.unlink(dataFile(dataDir, "vectors.json")).catch(() => {});
}
