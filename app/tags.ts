/**
 * tags.ts — 给仓库打分类标签, 并按标签统计 / 筛选
 *
 * 标签都是从索引里已有的字段推出来的 (不落盘, 改了规则不用重扫):
 *   topic     主题, 按关键词规则判断, 一个仓库最多 3 个
 *   lang      语言 (扫描时按扩展名数出来的前 3 个)
 *   activity  本机 HEAD 最后一次变动距今多久
 *   work      本机有没有提交过
 *   host      远端在哪 (github.com / 自建 gitlab / 无远端)
 *   owner     远端的用户或组织
 */

import { tokenize, pathTokens, type RepoEntry } from "./lib";

export type FacetId = "topic" | "lang" | "activity" | "work" | "host" | "owner";
export const FACETS: FacetId[] = ["topic", "lang", "activity", "work", "host", "owner"];

/** "没有这一项" 的占位值 (没识别出语言 / 没有远端) */
export const NONE = "~none";

export interface RepoTags {
  topics: string[];
  /** 得分最高的主题: 雷达图上按它分扇区 */
  topic: string;
  langs: string[];
  activity: string;
  work: string;
  host: string;
  owner: string;
  /** HEAD 最后一次变动距今的天数; null = 不知道 */
  ageDays: number | null;
}

export type Filters = Record<FacetId, string[]>;

// ---------- 主题规则 ----------

/**
 * 词的写法:
 *   "flink"            整词匹配 (按 tokenize 切出来的词, 驼峰和连字符会拆开)
 *   "recommend*"       词前缀匹配
 *   "machine learning" 带空格 / 标点 / 中文的: 在原文里做子串匹配
 * strong 在 README 里出现也算; weak 太常见, 只在仓库名、路径和简介里出现才算。
 */
interface TopicRule {
  id: string;
  /** 搜索时这些词也能命中打了这个标签的仓库 */
  terms: string;
  strong: string[];
  weak: string[];
  /** 依赖名: 整名匹配, "x*" 前缀, 带 "/" 或 "." 的做子串 (go module 路径) */
  deps: string[];
  /** 根目录下的文件或目录 (目录带 "/") */
  files?: string[];
}

export const OTHER = "other";

export const TOPIC_RULES: TopicRule[] = [
  {
    id: "ai",
    terms: "ai ml machine learning llm 机器学习 人工智能 大模型",
    strong: [
      "llm", "llms", "gpt", "chatgpt", "openai", "langchain", "llama", "transformer*", "bert", "pytorch",
      "tensorflow", "keras", "machine learning", "deep learning", "neural network", "large language model",
      "fine-tun", "finetun", "diffusion", "huggingface", "hugging face", "rag", "embedding*", "nlp",
      "computer vision", "ocr", "asr", "tts", "speech recognition", "lightgbm", "xgboost", "onnx", "inference",
      "multimodal", "deepseek", "qwen", "gemini", "claude", "prompt*", "mcp",
      "机器学习", "深度学习", "大模型", "神经网络", "模型训练", "语音识别", "人工智能", "微调", "智能体", "多模态", "推理服务",
    ],
    weak: ["ai", "ml", "model*", "agent*", "algo*", "feature*", "train*", "predict*", "模型", "算法", "特征"],
    deps: [
      "torch", "tensorflow", "transformers", "langchain*", "openai", "anthropic", "scikit-learn", "sklearn", "keras",
      "lightgbm", "xgboost", "onnxruntime*", "paddlepaddle", "modelscope", "jax", "llama-index*", "sentence-transformers",
      "diffusers", "ollama", "@anthropic-ai/sdk", "ai",
    ],
  },
  {
    id: "search",
    terms: "search recommendation recsys ranking 搜索 推荐 检索",
    strong: [
      "recommend*", "recommand*", "recsys", "learning to rank", "ltr", "elasticsearch", "lucene", "solr", "search engine",
      "vector search", "semantic search", "faiss", "milvus", "information retrieval", "bm25", "rerank*", "full-text search",
      "knowledge graph", "kbqa", "ctr", "collaborative filtering",
      "推荐系统", "推荐算法", "推荐引擎", "推荐模型", "个性化推荐", "搜索引擎", "全文检索", "向量检索", "语义检索", "信息检索",
      "召回", "排序模型", "相关性", "知识图谱", "协同过滤",
    ],
    weak: ["search*", "retriev*", "rank*", "relevance", "query", "es", "rec", "recall", "qa", "搜索", "检索", "推荐", "问答"],
    deps: [
      "elasticsearch*", "@elastic/elasticsearch", "faiss*", "pymilvus", "lucene*", "opensearch*", "whoosh", "tantivy",
      "meilisearch", "easyrec", "olivere/elastic", "qdrant-client", "chromadb", "lancedb",
    ],
  },
  {
    id: "data",
    terms: "data streaming etl database 数据 大数据",
    strong: [
      "flink", "spark", "kafka", "hadoop", "hive", "hbase", "etl", "airflow", "clickhouse", "doris", "presto", "trino",
      "data pipeline", "data warehouse", "data lake", "stream processing", "olap", "dbt", "pulsar", "iceberg", "hudi",
      "datax", "big data", "time series", "data engineering",
      "大数据", "数据仓库", "数仓", "流处理", "实时计算", "数据同步", "数据管道", "数据湖", "离线计算",
    ],
    weak: [
      "data", "sql", "db", "database*", "pipeline*", "stream*", "warehouse", "analytics", "mysql", "postgres*", "redis",
      "mongodb", "sqlite", "csv", "数据", "数据库", "报表",
    ],
    deps: [
      "pyspark", "apache-flink", "kafka-python", "confluent-kafka", "clickhouse*", "sqlalchemy", "pymysql", "duckdb",
      "polars", "pyarrow", "flink-*", "spark-*", "kafka-clients", "apache-airflow", "pandas", "segmentio/kafka-go",
    ],
  },
  {
    id: "backend",
    terms: "backend api server service 后端 服务",
    strong: [
      "microservice*", "grpc", "rest api", "restful", "api server", "web framework", "http server", "springboot",
      "spring boot", "spring cloud", "fastapi", "flask", "django", "koa", "nestjs", "api gateway", "rpc", "dubbo",
      "graphql", "middleware", "oauth", "jwt", "web service",
      "微服务", "后端", "服务端", "接口服务", "网关", "中间件",
    ],
    weak: ["server*", "service*", "api", "apis", "backend", "gateway", "platform", "express", "gin", "服务", "平台", "接口"],
    deps: [
      "express", "koa", "fastapi", "flask", "django", "gin-gonic/gin", "spring-boot*", "grpc*", "grpcio*", "axum",
      "actix-web", "tornado", "sanic", "@nestjs/core", "labstack/echo", "go-zero", "go-kratos", "uvicorn", "hertz",
      "fastify", "hono", "rocket", "warp", "starlette",
    ],
  },
  {
    id: "infra",
    terms: "devops infra kubernetes deploy 运维 部署 监控",
    strong: [
      "kubernetes", "k8s", "helm", "terraform", "ansible", "prometheus", "grafana", "ci/cd", "jenkins", "kubectl",
      "istio", "envoy", "devops", "sre", "service mesh", "load balanc", "observability", "alertmanager", "etcd", "consul",
      "argocd", "github actions", "operator",
      "运维", "监控告警", "容器编排", "云原生", "服务网格", "持续集成",
    ],
    weak: [
      "docker*", "nginx", "container*", "deploy*", "monitor*", "infra*", "ops", "cluster*", "cloud", "config*", "kube*",
      "部署", "集群", "容器", "监控", "配置",
    ],
    deps: ["k8s.io/", "sigs.k8s.io/", "kubernetes", "docker", "helm.sh/", "prometheus*", "prometheus/client_golang", "pulumi*"],
    files: ["Chart.yaml", "charts/", "helm/", "terraform/", "k8s/", "kustomization.yaml", "manifests/", "jsonnetfile.json"],
  },
  {
    id: "tools",
    terms: "cli tools developer tooling 工具 命令行 脚本",
    strong: [
      "cli", "command line", "command-line", "vim", "neovim", "vscode", "vs code", "plugin*", "lint*", "formatter",
      "dotfiles", "tmux", "wezterm", "alfred", "raycast", "homebrew", "developer tool", "devtool*", "sdk",
      "code generat", "scaffold*", "boilerplate", "toolkit", "language server", "lsp", "compiler", "parser", "debugger",
      "tui",
      "命令行", "脚手架", "插件", "工具集", "工具箱", "开发工具", "效率工具",
    ],
    weak: [
      "tool*", "script*", "util*", "helper*", "kit", "generator", "terminal", "shell", "zsh", "extension*", "template*",
      "工具", "脚本", "配置",
    ],
    deps: ["clap", "spf13/cobra", "click", "typer", "commander", "yargs", "inquirer", "oclif", "urfave/cli", "ratatui", "ink"],
  },
  {
    id: "automation",
    terms: "crawler scraper automation bot 爬虫 自动化",
    strong: [
      "crawler*", "spider*", "scrapy", "scrap*", "puppeteer", "playwright", "selenium", "tampermonkey", "userscript*",
      "greasemonkey", "browser automation", "web automation", "rpa", "headless browser", "webdriver", "n8n",
      "爬虫", "爬取", "抓取", "油猴", "自动化脚本", "浏览器自动化",
    ],
    weak: ["automat*", "bot", "bots", "crawl*", "cron", "workflow*", "自动化", "机器人", "定时任务"],
    deps: [
      "scrapy", "puppeteer*", "playwright*", "@playwright/test", "selenium*", "beautifulsoup4", "bs4", "cheerio",
      "requests-html", "gocolly/colly", "pyppeteer", "crawlee", "chromedp",
    ],
  },
  {
    id: "web",
    terms: "web frontend ui 前端 网页",
    strong: [
      "react", "vue", "vuejs", "angular", "svelte", "nextjs", "next.js", "nuxt", "frontend", "front-end", "tailwind*",
      "webpack", "vite", "web app", "single page", "antd", "ant design", "element-ui", "element plus", "admin template",
      "component library", "design system",
      "前端", "后台管理", "管理后台", "中后台", "组件库", "网页",
    ],
    weak: ["web", "ui", "admin", "site", "website", "blog", "h5", "page*", "css", "html", "dashboard*", "页面", "网站", "博客"],
    deps: [
      "react", "vue", "next", "nuxt", "svelte", "@angular/core", "vite", "webpack", "antd", "element-plus", "element-ui",
      "tailwindcss", "umi", "astro", "solid-js", "preact", "jquery", "@vitejs/*",
    ],
  },
  {
    id: "app",
    terms: "app desktop mobile gui 应用 桌面 客户端",
    strong: [
      "ios", "android", "swiftui", "flutter", "react native", "react-native", "electron", "tauri", "gpui", "desktop app",
      "mobile app", "menu bar", "menubar", "xcode", "jetpack compose", "uikit", "appkit", "mac app", "native app", "gtk",
      "egui", "game*", "unity", "godot",
      "小程序", "桌面应用", "桌面端", "移动端", "安卓", "游戏",
    ],
    weak: ["app", "apps", "desktop", "mobile", "mac", "macos", "gui", "应用", "桌面", "客户端"],
    deps: [
      "electron", "@tauri-apps/api", "tauri", "gpui", "react-native", "flutter", "egui", "iced", "expo", "gtk4", "bevy",
      "nsh-core", "wails*",
    ],
    files: ["Info.plist", "AndroidManifest.xml", "pubspec.yaml", "nsh.json", "Package.swift"],
  },
  {
    id: "learn",
    terms: "learning tutorial examples reference 学习 教程 示例",
    strong: [
      "tutorial*", "course*", "leetcode", "interview*", "cheat sheet", "cheatsheet", "handbook", "roadmap", "rustlings",
      "koans", "exercises", "crash course", "from scratch", "step by step", "curriculum", "bootcamp", "study notes",
      "hello world", "curated list",
      "教程", "学习笔记", "面试", "刷题", "入门", "从零", "手把手", "课程", "实战", "题解",
    ],
    weak: [
      "awesome", "learn*", "study", "note", "notes", "book*", "example*", "demo*", "sample*", "playground*", "practice",
      "guide*", "test", "kata", "slides", "ppt", "share*", "docs", "wiki", "学习", "笔记", "示例", "演示", "练习", "分享", "文档",
    ],
    deps: ["mdbook", "mkdocs*", "docusaurus", "@docusaurus/core", "vitepress", "jupyter", "notebook"],
    files: ["SUMMARY.md", "book.toml", "mkdocs.yml"],
  },
];

export const TOPIC_IDS: string[] = [...TOPIC_RULES.map((r) => r.id), OTHER];

/**
 * 一段文本的词: set 查整词, sorted (排好序, 用到时才排) 二分查前缀, raw 查带空格 / 中文的短语。
 * 以前把所有词拼成一个长字符串再 includes, 每个关键词都要扫一遍整段 README,
 * 328 个仓库要 700 多 ms; 换成集合查找后是几十 ms。
 */
interface Haystack { set: Set<string>; sorted: string[] | null; raw: string }

function haystack(text: string, asPath = false): Haystack {
  const toks = asPath ? [...pathTokens(text), ...tokenize(text)] : tokenize(text);
  const lower = text.toLowerCase();
  // 路径里的 "machine_learning" 也要能匹配 "machine learning"
  const raw = asPath ? lower + " " + lower.replace(/[\\/_.\-]+/g, " ") : lower;
  return { set: new Set(toks), sorted: null, raw };
}

/** 有没有以 stem 开头的词 */
function hasPrefix(h: Haystack, stem: string): boolean {
  const a = (h.sorted ??= [...h.set].sort());
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < stem) lo = mid + 1; else hi = mid;
  }
  return lo < a.length && a[lo].startsWith(stem);
}

/** 关键词的种类事先算好: 短语 (带空格 / 中文 / 符号), 前缀 (结尾 *), 整词 */
const PHRASE = /[^a-z0-9*]/;
const termKind = new Map<string, 0 | 1 | 2>();
function kindOf(term: string): 0 | 1 | 2 {
  let k = termKind.get(term);
  if (k === undefined) {
    k = PHRASE.test(term) ? 0 : term.endsWith("*") ? 1 : 2;
    termKind.set(term, k);
  }
  return k;
}

function termHits(term: string, h: Haystack): boolean {
  switch (kindOf(term)) {
    case 0: return h.raw.includes(term);
    case 1: return hasPrefix(h, term.slice(0, -1));
    default: return h.set.has(term);
  }
}

function depHits(term: string, deps: string[]): boolean {
  if (term.endsWith("*")) {
    const stem = term.slice(0, -1);
    return deps.some((d) => d.startsWith(stem));
  }
  if (term.includes("/") && !term.startsWith("@")) return deps.some((d) => d.includes(term));
  return deps.includes(term);
}

function fileHits(term: string, files: string[]): boolean {
  return files.includes(term);
}

const countHits = (terms: string[], h: Haystack, cap: number): number => {
  let n = 0;
  for (const t of terms) {
    if (termHits(t, h) && ++n >= cap) break;
  }
  return n;
};

const allTerms: Record<string, string[]> = {};

/** 每个主题的得分: 名称/路径 3 分一个词, 简介/关键词 3 分, README 1 分 (只算 strong), 依赖 3 分, 根目录文件 2 分 */
export function topicScores(e: RepoEntry): { id: string; score: number }[] {
  const segs = e.path.split(/[\\/]/).filter(Boolean);
  const name = haystack(segs.slice(-3).join("/"), true);
  const desc = haystack(e.desc + " " + e.keywords.join(" "));
  const readme = haystack(e.readme);
  const out: { id: string; score: number }[] = [];
  for (const r of TOPIC_RULES) {
    const all = (allTerms[r.id] ??= [...r.strong, ...r.weak]);
    let score = 3 * countHits(all, name, 2) + 3 * countHits(all, desc, 2) + countHits(r.strong, readme, 3);
    let deps = 0;
    for (const d of r.deps) if (depHits(d, e.deps) && ++deps >= 2) break;
    score += 3 * deps;
    if (r.files?.some((f) => fileHits(f, e.files))) score += 2;
    if (score > 0) out.push({ id: r.id, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

const TOPIC_THRESHOLD = 3;

export function classify(e: RepoEntry): string[] {
  const scores = topicScores(e);
  const top = scores[0]?.score ?? 0;
  if (top < TOPIC_THRESHOLD) return [OTHER];
  return scores.filter((s) => s.score >= TOPIC_THRESHOLD && s.score >= top * 0.6).slice(0, 3).map((s) => s.id);
}

// ---------- 其它标签 ----------

/** 从 remote URL 里取主机和用户/组织 */
export function parseRemote(remote: string): { host: string; owner: string } {
  let m = remote.match(/^[\w.-]+@([\w.-]+):(?:\d+\/)?(.+)$/); // git@host:owner/repo.git
  if (!m) m = remote.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/i); // https://host/owner/repo
  if (!m) return { host: NONE, owner: NONE };
  const parts = m[2].replace(/\.git$/, "").split("/").filter(Boolean);
  return { host: m[1].toLowerCase(), owner: parts.length > 1 ? parts[0] : NONE };
}

export const ACTIVITY_IDS = ["m1", "m6", "y1", "y3", "old", "unknown"];

export function activityOf(ageDays: number | null): string {
  if (ageDays === null) return "unknown";
  if (ageDays <= 30) return "m1";
  if (ageDays <= 182) return "m6";
  if (ageDays <= 365) return "y1";
  if (ageDays <= 1095) return "y3";
  return "old";
}

export const WORK_IDS = ["authored", "clone"];

/** 分类规则的版本: 改了 TOPIC_RULES 就加一, 索引里存的旧 topics 会在下次打开时重算 */
export const TAGS_VERSION = 1;

/**
 * 给每个仓库算主题并写进 e.topics。分类在 QuickJS 里每个仓库要 1~2 ms,
 * 几百个仓库就是大半秒: 分批算, 每批之间让出线程, 界面不卡。
 */
export async function classifyAll(repos: RepoEntry[], batch = 24): Promise<RepoEntry[]> {
  const out: RepoEntry[] = [];
  for (let i = 0; i < repos.length; i += batch) {
    for (const e of repos.slice(i, i + batch)) out.push({ ...e, topics: classify(e) });
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

export function deriveTags(e: RepoEntry, now: number): RepoTags {
  const topics = e.topics?.length ? e.topics : classify(e);
  const ageDays = e.lastTs > 0 ? Math.max(0, (now - e.lastTs) / 86400000) : null;
  return {
    topics,
    topic: topics[0],
    langs: e.langs.length ? e.langs : [NONE],
    activity: activityOf(ageDays),
    work: e.commits > 0 ? "authored" : "clone",
    ...parseRemote(e.remote),
    ageDays,
  };
}

/** 词法检索里额外可搜的词: 让 "devops" 能搜到打了运维标签的仓库 */
export function topicTerms(t: RepoTags): string {
  return t.topics.map((id) => TOPIC_RULES.find((r) => r.id === id)?.terms ?? "").join(" ");
}

// ---------- 统计与筛选 ----------

export function emptyFilters(): Filters {
  return { topic: [], lang: [], activity: [], work: [], host: [], owner: [] };
}

export function activeFilters(f: Filters): { facet: FacetId; value: string }[] {
  return FACETS.flatMap((facet) => f[facet].map((value) => ({ facet, value })));
}

export function toggleFilter(f: Filters, facet: FacetId, value: string): Filters {
  const cur = f[facet];
  return { ...f, [facet]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
}

export function valuesOf(t: RepoTags, facet: FacetId): string[] {
  switch (facet) {
    case "topic": return t.topics;
    case "lang": return t.langs;
    case "activity": return [t.activity];
    case "work": return [t.work];
    case "host": return [t.host];
    case "owner": return [t.owner];
  }
}

/** 同一类里选多个是 "或", 不同类之间是 "且"; skip: 不看这一类 (算这一类自己的计数时用) */
export function passes(t: RepoTags, f: Filters, skip?: FacetId): boolean {
  for (const facet of FACETS) {
    if (facet === skip || f[facet].length === 0) continue;
    const vals = valuesOf(t, facet);
    if (!f[facet].some((v) => vals.includes(v))) return false;
  }
  return true;
}

export interface FacetRow { value: string; count: number; total: number }

const FIXED_ORDER: Partial<Record<FacetId, string[]>> = { activity: ACTIVITY_IDS, work: WORK_IDS };

/**
 * 一类标签下每个值的仓库数。count: 在其它类的筛选条件下还剩多少 (点了它会得到的数量);
 * total: 不加任何筛选时的数量。只列出索引里出现过的值。
 */
export function facetRows(tags: RepoTags[], f: Filters, facet: FacetId): FacetRow[] {
  const total = new Map<string, number>();
  const count = new Map<string, number>();
  for (const t of tags) {
    const ok = passes(t, f, facet);
    for (const v of valuesOf(t, facet)) {
      total.set(v, (total.get(v) ?? 0) + 1);
      if (ok) count.set(v, (count.get(v) ?? 0) + 1);
    }
  }
  const rows = [...total].map(([value, n]) => ({ value, total: n, count: count.get(value) ?? 0 }));
  const fixed = FIXED_ORDER[facet];
  const last = (v: string) => (v === NONE || v === OTHER ? 1 : 0);
  return rows.sort((a, b) =>
    fixed
      ? fixed.indexOf(a.value) - fixed.indexOf(b.value)
      : last(a.value) - last(b.value) || b.total - a.total || a.value.localeCompare(b.value),
  );
}

/** 标签值对应的文案 key; null = 值本身就是要显示的文字 (语言名、主机名、用户名) */
export function labelKey(facet: FacetId, value: string): string | null {
  if (value === NONE) return `none.${facet}`;
  if (facet === "topic") return `topic.${value}`;
  if (facet === "activity") return `activity.${value}`;
  if (facet === "work") return `work.${value}`;
  return null;
}
