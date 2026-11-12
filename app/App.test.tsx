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

function options(files: Map<string, string | Uint8Array>, apiKey = "test-key") {
  return {
    locale: "en-US",
    platform: "macos" as const,
    width: 1000,
    height: 700,
    storage: {
      roots: "/fake/work",
      cfg: JSON.stringify({ baseUrl: "https://emb.test/v1", model: "fake-embed", apiKey }),
    },
    network: {
      [`POST ${EMBED_URL}`]: (req: { body?: string | null }) => {
        const input: string[] = JSON.parse(req.body ?? "{}").input;
        return { body: { data: input.map((text, index) => ({ index, embedding: embed(text) })) } };
      },
    },
    // 无头运行没有数据目录: 给一个固定的, 落盘走假文件系统
    modules: { "fs/promises": fakeFs(files), process: { "default.dataDir": "/data" } },
  };
}

async function buildIndex(app: Awaited<ReturnType<typeof open>>) {
  await app.press("⚙ SETTINGS");
  await app.press("▶ SCAN + INDEX");
  await app.waitUntil(() => app.texts().some((s) => /^2 repos/.test(s)));
  await app.press("‹ BACK");
}

test("starts empty and points at Settings", async () => {
  const app = await open("./App.tsx", options(new Map()));
  expect(app.texts()).toContain("Open SETTINGS to build the index first");
  expect(app.texts()).toContain("Not indexed");
});

test("scans, embeds and ranks with lexical + semantic scores", async () => {
  const app = await open("./App.tsx", options(fixture()));
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
  const app = await open("./App.tsx", options(fixture(), ""));
  await app.press("⚙ SETTINGS");
  await app.press("▶ SCAN + INDEX");
  await app.waitFor("2 repos (no API key, lexical only)");
  await app.press("‹ BACK");
  await app.type(PLACEHOLDER, "recommender");
  await app.waitFor("recsys-demo");
  expect(app.texts()).not.toContain("spiderling");
  expect(app.texts()).toContain("LEXICAL");
  expect(app.requests().length).toBe(0);
});

test("index and vectors survive a restart", async () => {
  const files = fixture();
  const first = await open("./App.tsx", options(files));
  await buildIndex(first);

  const second = await open("./App.tsx", options(files));
  await second.waitFor("2 repos · vectors ready");
  await second.type(PLACEHOLDER, "scraping");
  await second.waitFor("spiderling");
  expect(second.texts()).toContain("HYBRID");
});

test("switches language", async () => {
  const app = await open("./App.tsx", options(new Map()));
  await app.press("中文");
  await app.waitFor("未索引");
  expect(app.texts()).toContain("先去 SETTINGS 建索引");
  expect(app.storage().locale).toBe("zh-CN");
});
