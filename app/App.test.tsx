import { expect, open, test } from "nsh/test";

// 无头回归测试: 假文件系统 + 假 embedding 接口, 覆盖 扫描 → 索引 → 混合检索 → 落盘 → 重启恢复。
// (真实文件权限由 nsh.json 的 capabilities.fs 管, 那一层要用 `nsh test --target macos` 才测得到。)

const PLACEHOLDER = "text:Describe the repo you want — recommender / rust gui / crawler…";
const EMBED_URL = "https://emb.test/v1/embeddings";

/** 内存文件系统: 路径 → 内容; 目录由路径前缀推出 */
function fakeFs(store: Map<string, string | Uint8Array>) {
  const norm = (p: string) => p.replace(/\/+$/, "");
  const files = {
    keys: () => store.keys(),
    get: (p: string) => store.get(norm(p)),
    set: (p: string, v: string | Uint8Array) => store.set(norm(p), v),
    delete: (p: string) => store.delete(norm(p)),
  };
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT", path });
  const children = (dir: string) => {
    const prefix = norm(dir).replace(/\/?$/, "/");
    const names = new Map<string, boolean>(); // name → 是否目录
    for (const p of files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length).split("/");
      names.set(rest[0], rest.length > 1 || names.get(rest[0]) === true);
    }
    return names;
  };
  return {
    readdir: (dir: string) => {
      const names = children(dir);
      if (!names.size) throw enoent(dir);
      return [...names].sort().map(([name, isDir]) => ({ name, isDirectory: isDir }));
    },
    readFile: (path: string, encoding?: string) => {
      const data = files.get(path);
      if (data === undefined) throw enoent(path);
      if (encoding) return typeof data === "string" ? data : new TextDecoder().decode(data);
      return typeof data === "string" ? new TextEncoder().encode(data) : data;
    },
    writeFile: (path: string, data: string | Uint8Array) => {
      // 二进制跨桩边界后不一定还是 Uint8Array
      const bytes = (d: unknown) =>
        d instanceof Uint8Array ? d.slice() : Uint8Array.from(Array.isArray(d) ? d : Object.values(d as object));
      files.set(path, typeof data === "string" ? data : bytes(data));
    },
    mkdir: () => {},
    unlink: (path: string) => { files.delete(path); },
  };
}

function fixture(): Map<string, string | Uint8Array> {
  const reflog = (ts: number, msg: string) =>
    `${"0".repeat(40)} ${"a".repeat(40)} Dev Eloper <dev@example.com> ${ts} +0800\t${msg}\n`;
  return new Map<string, string | Uint8Array>([
    ["/fake/work/spiderling/.git/HEAD", "ref: refs/heads/main\n"],
    ["/fake/work/spiderling/.git/config", '[remote "origin"]\n\turl = git@github.com:someone/spiderling.git\n'],
    ["/fake/work/spiderling/.git/logs/HEAD",
      reflog(1750000000, "commit: add retry queue") + reflog(1760000000, "pull --ff-only: Fast-forward")],
    ["/fake/work/spiderling/README.md", "# spiderling\nA crawler for news sites.\n"],
    ["/fake/work/spiderling/main.py", "print('hi')\n"],
    ["/fake/work/spiderling/vendor/nested/.git/HEAD", "ref: refs/heads/main\n"],
    ["/fake/work/group/recsys-demo/.git/HEAD", "ref: refs/heads/dev\n"],
    ["/fake/work/group/recsys-demo/README.md", "# recsys-demo\nRecommender system demo.\n"],
    ["/fake/work/group/recsys-demo/app.go", "package main\n"],
    ["/fake/work/node_modules/junk/.git/HEAD", "ref: refs/heads/main\n"],
  ]);
}

/** 假 embedding: 爬虫类 → x 轴, 推荐类 → y 轴, 其它 → z 轴 */
function embed(text: string): number[] {
  if (/crawl|scrap/i.test(text)) return [1, 0, 0];
  if (/recommend/i.test(text)) return [0, 1, 0];
  return [0, 0, 1];
}

const LOCAL_MODELS = [
  { id: "multilingual-e5-small", name: "multilingual-e5-small", size: 135, dim: 384, recommended: true },
  { id: "bge-small-zh-v1.5", name: "bge-small-zh-v1.5", size: 25, dim: 512, recommended: false },
];

interface Opts {
  apiKey?: string;
  /** 直接写进 Storage 的 embedding 配置 (新格式); 不给就用外部 API + apiKey */
  embed?: object;
  /** 老版本的配置格式 ({ baseUrl, model, apiKey }), 测迁移用 */
  legacy?: object;
  /** 本地模块: 已下载的模型、推理的替身 */
  installed?: string[];
  localEmbed?: (dir: string, id: string, texts: string[], query: boolean) => number[];
  download?: () => unknown;
  /** 打开文件夹 / 终端的调用记录 */
  shellCalls?: string[][];
  terminals?: string[];
  /** 平台支不支持本地模型 (Intel Mac / 浏览器: 否) */
  supported?: boolean;
}

function options(files: Map<string, string | Uint8Array>, o: Opts | string = {}) {
  const opt: Opts = typeof o === "string" ? { apiKey: o } : o;
  const apiKey = opt.apiKey ?? "test-key";
  const storage: Record<string, string> = { roots: "/fake/work" };
  if (opt.legacy) storage.cfg = JSON.stringify(opt.legacy);
  else storage.embed = JSON.stringify(opt.embed ?? { provider: "api", api: { baseUrl: "https://emb.test/v1", model: "fake-embed", apiKey } });
  return {
    locale: "en-US",
    platform: "macos" as const,
    width: 1000,
    height: 700,
    storage,
    network: {
      [`POST ${EMBED_URL}`]: (req: { body?: string | null }) => {
        const input: string[] = JSON.parse(req.body ?? "{}").input;
        return { body: { data: input.map((text, index) => ({ index, embedding: embed(text) })) } };
      },
    },
    modules: {
      // 无头运行没有数据目录: 给一个固定的, 落盘走假文件系统
      "fs/promises": fakeFs(files),
      process: { "default.dataDir": "/data" },
      // 本地模型: 测试里不真下载, 也不真推理 (真推理在 macOS 宿主上手动验证)
      "repofind/native": {
        "Local.supported": opt.supported ?? true,
        "Local.models": LOCAL_MODELS,
        "Local.installed": opt.installed ?? [],
        "Local.progress": { id: "", done: 0, total: 0, active: false, error: "", source: "" },
        "Local.loaded": "",
        "Local.download": opt.download ?? (() => { throw new Error("offline in tests"); }),
        "Local.embed": opt.localEmbed ?? (() => { throw new Error("no local model in tests"); }),
        "Local.cancel": () => {},
        "Local.remove": () => {},
        "Local.release": () => {},
        // 打开文件夹 / 终端: 记下调用, 不真的打开
        "Shell.terminals": opt.terminals ?? ["Terminal", "iTerm"],
        "Shell.openFolder": (path: string) => { opt.shellCalls?.push(["folder", path]); },
        "Shell.openTerminal": (path: string, app: string) => { opt.shellCalls?.push(["terminal", path, app]); },
      },
    },
  };
}

/** 本地模型的替身: 和远程替身同样的向量, 拼成一维 */
function fakeLocal(_dir: string, _id: string, texts: string[]): number[] {
  return texts.flatMap((text) => embed(text));
}

/** 打开应用后切到搜索页 (默认打开的是总览页) */
async function openSearch(o: ReturnType<typeof options>) {
  const app = await open("./App.tsx", o);
  await app.press("id:tab-search");
  return app;
}

function embedRequests(app: Awaited<ReturnType<typeof open>>): number {
  return app.requests().filter((r) => r.url === EMBED_URL).reduce((n, r) => n + JSON.parse(r.body ?? "{}").input.length, 0);
}

async function buildIndex(app: Awaited<ReturnType<typeof open>>) {
  await app.press("id:tab-settings");
  await app.press("▶ SCAN + INDEX");
  await app.waitUntil(() => app.texts().some((s) => /^2 repos/.test(s)));
  await app.press("id:tab-search");
}

test("starts empty and offers to build the index", async () => {
  const app = await openSearch(options(new Map()));
  expect(app.texts()).toContain("No index yet. Scan your repo folders first, then search.");
  expect(app.texts()).toContain("Scan roots: /fake/work");
  expect(app.texts()).toContain("Not indexed");
});

test("searching before indexing says so, and indexing from there works", async () => {
  const app = await openSearch(options(fixture(), ""));
  await app.type(PLACEHOLDER, "recommender");
  await app.waitFor("Nothing to search yet: build the index first.");
  expect(app.texts()).not.toContain("No match — try different words");
  await app.press("Build index now");
  await app.waitFor("recsys-demo");
});

test("no match after indexing suggests a rebuild", async () => {
  const app = await openSearch(options(fixture(), ""));
  await app.press("Build index now");
  await app.waitFor("2 repos (no API key, lexical only)");
  await app.type(PLACEHOLDER, "kubernetes");
  await app.waitFor("No match — try different words");
  expect(app.texts().some((s) => s.startsWith("There are no vectors yet"))).toBe(true);
  expect(app.texts()).toContain("Rebuild index");
});

test("scans, embeds and ranks with lexical + semantic scores", async () => {
  const app = await openSearch(options(fixture()));
  await buildIndex(app);
  // 嵌套仓库和 node_modules 里的不算
  expect(app.texts()).toContain("2 repos · vectors ready");

  // "scraping" 在仓库名和 README 里都不出现: 只有语义能命中 spiderling
  await app.type(PLACEHOLDER, "scraping");
  await app.waitFor("spiderling");
  const texts = app.texts();
  expect(texts.indexOf("spiderling")).toBeLessThan(texts.indexOf("recsys-demo"));
  expect(texts).toContain("⑂ main");
  expect(texts).toContain("◆ Python");
  // 最近一条 reflog 是 pull, 标题取的是上一条 commit
  expect(texts.some((s) => s.endsWith("add retry queue"))).toBe(true);
  expect(texts).toContain("HYBRID");

  // 切到纯词法: "scraping" 没有任何词面匹配
  await app.press("SEM+");
  await app.waitFor("No match — try different words");
});

test("lexical search works without an API key", async () => {
  const app = await openSearch(options(fixture(), ""));
  await app.press("id:tab-settings");
  await app.press("▶ SCAN + INDEX");
  await app.waitFor("2 repos (no API key, lexical only)");
  await app.press("id:tab-search");
  await app.type(PLACEHOLDER, "recommender");
  await app.waitFor("recsys-demo");
  expect(app.texts()).not.toContain("spiderling");
  expect(app.texts()).toContain("LEXICAL");
  expect(app.requests().length).toBe(0);
});

test("index and vectors survive a restart", async () => {
  const files = fixture();
  const first = await openSearch(options(files));
  await buildIndex(first);

  const second = await openSearch(options(files));
  await second.waitFor("2 repos · vectors ready");
  await second.type(PLACEHOLDER, "scraping");
  await second.waitFor("spiderling");
  expect(second.texts()).toContain("HYBRID");
});

test("atlas counts by tag and filters search", async () => {
  const app = await openSearch(options(fixture(), ""));
  await app.press("id:tab-settings");
  await app.press("▶ SCAN + INDEX");
  await app.waitFor("2 repos (no API key, lexical only)");
  await app.press("id:tab-atlas");
  await app.waitFor("2 repos");
  expect(app.texts()).toContain("Crawlers & automation");
  expect(app.texts()).toContain("Committed locally");

  await app.press("text:Crawlers & automation");
  await app.waitFor("1 of 2 repos");

  // 搜索页带着同样的筛选条件, 不输入查询词时直接列出筛出来的仓库
  await app.press("id:tab-search");
  await app.waitFor("1 repos match");
  expect(app.texts()).toContain("spiderling");
  expect(app.texts()).not.toContain("recsys-demo");
  await app.press("Clear filters");
  await app.waitFor("Type a natural language description");
});

test("an old { baseUrl, model, apiKey } config keeps using that API", async () => {
  const app = await openSearch(options(fixture(), { legacy: { baseUrl: "https://emb.test/v1", model: "fake-embed", apiKey: "k" } }));
  await buildIndex(app);
  expect(app.texts()).toContain("2 repos · vectors ready");
  expect(embedRequests(app)).toBe(2);
  expect(JSON.parse(app.storage().embed ?? "null")).toBe(null); // 没改过设置就不重写
});

test("rebuilding the index only embeds repos whose text changed", async () => {
  const files = fixture();
  const app = await openSearch(options(files));
  await buildIndex(app);
  expect(embedRequests(app)).toBe(2);

  // 一个仓库的 README 变了
  files.set("/fake/work/group/recsys-demo/README.md", "# recsys-demo\nRecommender system demo, now with re-ranking.\n");
  await app.press("id:tab-settings");
  await app.press("▶ SCAN + INDEX");
  await app.waitUntil(() => app.texts().some((s) => s.startsWith("2 repos · vectors ready (1 reused)")));
  expect(embedRequests(app)).toBe(3); // 只多算了一个

  // 什么都没变: 一个都不用算
  await app.press("▶ SCAN + INDEX");
  await app.waitUntil(() => app.texts().some((s) => s.startsWith("2 repos · vectors ready (2 reused)")));
  expect(embedRequests(app)).toBe(3);
});

test("local model: indexes and searches with the in-app engine", async () => {
  const calls: { texts: string[]; query: boolean }[] = [];
  const app = await openSearch(options(fixture(), {
    embed: { provider: "local", local: { model: "multilingual-e5-small", source: "auto" } },
    installed: ["multilingual-e5-small"],
    localEmbed: (dir, id, texts, query) => {
      calls.push({ texts, query });
      return fakeLocal(dir, id, texts);
    },
  }));
  await buildIndex(app);
  expect(app.texts()).toContain("2 repos · vectors ready");
  await app.type(PLACEHOLDER, "scraping");
  await app.waitFor("spiderling");
  expect(app.texts()).toContain("HYBRID");
  expect(embedRequests(app)).toBe(0); // 一个网络请求都没有
  expect(calls[0].query).toBe(false); // 仓库按文档编码
  expect(calls[calls.length - 1]).toEqual({ texts: ["scraping"], query: true }); // 查询按查询编码

  await app.press("id:tab-settings");
  await app.waitFor("In use");
  expect(app.texts().some((s) => s.startsWith("✓ 2 vectors from local:multilingual-e5-small"))).toBe(true);
});

test("local model that fails to download falls back to lexical search", async () => {
  const app = await openSearch(options(fixture(), {
    embed: { provider: "local", local: { model: "multilingual-e5-small", source: "auto" } },
  }));
  await app.press("Build index now");
  await app.waitFor("2 repos (local model not downloaded, lexical only)");
  await app.type(PLACEHOLDER, "recommender");
  await app.waitFor("recsys-demo");
  expect(app.texts()).toContain("LEXICAL");
});

test("where local models can't run (Intel Mac), it says so and stays lexical", async () => {
  let downloads = 0;
  const app = await openSearch(options(fixture(), {
    embed: { provider: "local", local: { model: "multilingual-e5-small", source: "auto" } },
    supported: false,
    download: () => { downloads++; },
  }));
  await app.press("Build index now");
  await app.waitFor("2 repos (local models are not available here, lexical only)");
  expect(downloads).toBe(0);
  await app.press("id:tab-settings");
  expect(app.texts().some((s) => s.startsWith("Local models are not available here"))).toBe(true);
  expect(app.texts()).not.toContain("Download & use");
});

test("switching the embedding source in settings", async () => {
  const app = await openSearch(options(fixture()));
  await buildIndex(app);
  await app.press("id:tab-settings");
  expect(app.texts().some((s) => s.startsWith("✓ 2 vectors from api:https://emb.test/v1#fake-embed"))).toBe(true);

  await app.press("id:opt-service");
  await app.waitFor("text:http://127.0.0.1:1234/v1");
  expect(app.texts().some((s) => s.startsWith("The vectors were made by api:"))).toBe(true);
  expect(JSON.parse(app.storage().embed).provider).toBe("service");

  await app.press("id:opt-local");
  await app.waitFor("multilingual-e5-small");
  expect(app.texts()).toContain("Download & use");
  expect(app.texts()).toContain("bge-small-zh-v1.5");
});

test("opens on the Atlas; tabs are Atlas, Search, Settings", async () => {
  const app = await open("./App.tsx", options(fixture(), ""));
  await app.press("Build index now");
  await app.waitFor("2 repos (no API key, lexical only)");
  await app.waitFor("Crawlers & automation");
  expect(app.texts().filter((s) => ["Atlas", "Search", "Settings"].includes(s))).toEqual(["Atlas", "Search", "Settings"]);
});

test("opens a result in Finder or a terminal", async () => {
  const calls: string[][] = [];
  const app = await openSearch(options(fixture(), { apiKey: "", shellCalls: calls }));
  await buildIndex(app);
  await app.type(PLACEHOLDER, "recommender");
  await app.waitFor("recsys-demo");
  await app.press("Open in Finder");
  await app.press("Open in Terminal");
  await app.waitUntil(() => calls.length === 2);
  expect(calls[0]).toEqual(["folder", "/fake/work/group/recsys-demo"]);
  // 点行里的小按钮不该顺带触发整行的 "复制路径"
  expect(app.texts()).not.toContain("✓ PATH COPIED");
  expect(calls[1]).toEqual(["terminal", "/fake/work/group/recsys-demo", "Terminal"]);

  // 设置里换成 iTerm, 记住选择
  await app.press("id:tab-settings");
  await app.press("id:opt-iTerm");
  expect(app.storage().terminal).toBe("iTerm");
  await app.press("id:tab-search");
  await app.waitFor("recsys-demo");
  await app.press("Open in Terminal");
  await app.waitUntil(() => calls.length === 3);
  expect(calls[2]).toEqual(["terminal", "/fake/work/group/recsys-demo", "iTerm"]);
});

test("topics are saved with the index, and filled in once for an old index", async () => {
  const files = fixture();
  const app = await openSearch(options(files, ""));
  await buildIndex(app);
  const saved = JSON.parse(files.get("/data/index.json") as string);
  expect(saved.tagsVersion).toBe(1);
  expect(saved.repos.every((r: { topics?: unknown }) => Array.isArray(r.topics))).toBe(true);

  // 老索引: 没有 topics
  for (const r of saved.repos) delete r.topics;
  saved.tagsVersion = 0;
  files.set("/data/index.json", JSON.stringify(saved));
  const again = await open("./App.tsx", options(files, ""));
  await again.waitFor("Crawlers & automation");
  await again.waitUntil(() => JSON.parse(files.get("/data/index.json") as string).tagsVersion === 1);
});

test("the status bar doesn't say vectors are ready when they came from another model", async () => {
  const files = fixture();
  const first = await openSearch(options(files));
  await buildIndex(first);
  await first.waitFor("2 repos · vectors ready");
  const second = await open("./App.tsx", options(files, {
    embed: { provider: "api", api: { baseUrl: "https://emb.test/v1", model: "another-model", apiKey: "k" } },
  }));
  await second.waitFor("2 repos · the vectors don't match the model in Settings, lexical only");
  expect(second.texts()).not.toContain("2 repos · vectors ready");
});

test("switches language", async () => {
  const app = await openSearch(options(new Map()));
  await app.press("中文");
  await app.waitFor("未索引");
  expect(app.texts()).toContain("还没有索引，先扫描一遍仓库目录才能搜索。");
  expect(app.storage().locale).toBe("zh-CN");
});
