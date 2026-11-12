import { mount, signal, effect, Text, View, Scroll, Clipboard, openUrl, Storage } from "nsh";
import { Input } from "nsh/base";
import {
  scanRepo, findRepos, expandTilde, tokenize, pathTokens, LexicalIndex,
  embedTexts, cosine, repoText, hybridSearch, home,
  type RepoEntry, type EmbedConfig, type HybridHit,
} from "./lib";

// ============================================================
// RepoFind — 本地 git 仓库语义搜索 (纯客户端, 无 server)
// 美学: 雷达室 — 近黑冷灰 / 琥珀信号 / 等宽数据 / 编辑部列表
// ============================================================

const ACCENT = "#e8a33d";      // 琥珀
const ACCENT_DIM = "#8a6224";
const BG = "#101214";
const PANEL = "#16191c";
const LINE = "#262b30";
const TEXT = "#d6dade";
const MUTED = "#71797f";
const SCAN = "#5fb3a1";        // 扫描完成/在线的青绿

type Screen = "search" | "settings";
type Phase = "idle" | "scanning" | "embedding" | "ready";

interface AppState {
  phase: Phase;
  status: string;       // 底部状态行
  progress: string;     // 进度详情
  repos: RepoEntry[];
  vectorMeta: { model: string; count: number } | null;
  scannedAt: string;
  roots: string;
}

function loadConfig(): EmbedConfig {
  // 同步读不到 Storage (async), 先给默认值, mount 后 effect 里覆盖
  return { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", apiKey: "" };
}

function loadState(): AppState {
  return {
    phase: "idle",
    status: "未索引",
    progress: "",
    repos: [],
    vectorMeta: null,
    scannedAt: "",
    roots: "~/work ~/src",
  };
}

function App() {
  const screen = signal<Screen>("search");
  const cfg = signal<EmbedConfig>(loadConfig());
  const state = signal<AppState>(loadState());
  const query = signal("");
  const hits = signal<HybridHit[]>([]);
  const searching = signal(false);
  const copiedIdx = signal(-1);
  const searchMode = signal<"hybrid" | "lexical">("hybrid");
  let vectors: number[][] | null = null;
  let searchSeq = 0;

  // ---- 启动: 读配置和索引缓存 ----
  effect(() => {
    (async () => {
      try {
        const savedCfg = await Storage.getItem("cfg");
        if (savedCfg) cfg.set({ ...cfg(), ...JSON.parse(savedCfg) });
        const savedRoots = await Storage.getItem("roots");
        if (savedRoots) {
          const s = state();
          state.set({ ...s, roots: savedRoots });
        }
        const savedIndex = await Storage.getItem("index");
        if (savedIndex) {
          const idx = JSON.parse(savedIndex);
          const s = state();
          state.set({
            ...s,
            repos: idx.repos,
            scannedAt: idx.scannedAt,
            phase: "ready",
            status: `${idx.repos.length} 个仓库已索引`,
          });
          const savedVec = await Storage.getItem("vectors");
          if (savedVec) {
            const v = JSON.parse(savedVec);
            if (v.model === cfg().model) {
              vectors = v.vectors;
              state.set({ ...state(), vectorMeta: { model: v.model, count: v.vectors.length } });
            }
          }
        }
      } catch (e) {
        console.error("load failed", e);
      }
    })();
  });

  // ---- 搜索 (300ms 防抖) ----
  effect(() => {
    const q = query().trim();
    if (!q) {
      hits.set([]);
      searching.set(false);
      return;
    }
    const mySeq = ++searchSeq;
    searching.set(true);
    const t = setTimeout(() => runSearch(q, mySeq), 300);
    return () => clearTimeout(t);
  });

  async function runSearch(q: string, mySeq: number) {
    const s = state();
    if (!s.repos.length) {
      if (mySeq === searchSeq) { searching.set(false); hits.set([]); }
      return;
    }
    try {
      // 词法
      const lex = new LexicalIndex(s.repos);
      const lexAll: { idx: number; score: number; matched: string[] }[] = [];
      // LexicalIndex.search 返回 topN, 这里需要全量带 idx — 重算一遍轻量打分
      // (复用内部实现: 直接调用 search 再映射回 idx 不可靠, 所以简化: search topN 后线性定位)
      const top = lex.search(q, 20);
      // 用 pathTokens+tokenize 匹配不到 idx 的问题: 我们在 LexicalIndex 上加一个带 idx 的接口太重,
      // 直接线性扫 (323 条 × 几十个 token, 毫秒级)
      const qt = new Set([...tokenize(q), ...pathTokens(q)]);
      // 重建 df/doc (与 LexicalIndex 相同逻辑), 为了拿到 idx 与分数 — 封装在下方 localLex
      const localLex = buildLex(s.repos);
      for (let i = 0; i < s.repos.length; i++) {
        const r = scoreDoc(localLex, i, qt);
        if (r.score > 0) lexAll.push({ idx: i, ...r });
      }
      lexAll.sort((a, b) => b.score - a.score);

      // 语义 (有向量 + 配了 key + hybrid 模式才跑)
      let semScores: Map<number, number> | null = null;
      if (searchMode() === "hybrid" && vectors && cfg().apiKey) {
        const [qv] = await embedTexts(cfg(), [q.slice(0, 4000)], 1);
        const all: { idx: number; c: number }[] = [];
        for (let i = 0; i < vectors.length; i++) {
          all.push({ idx: i, c: cosine(qv, vectors[i]) });
        }
        all.sort((a, b) => b.c - a.c);
        semScores = new Map(all.slice(0, 20).map((x) => [x.idx, x.c]));
      }

      if (mySeq !== searchSeq) return;
      hits.set(hybridSearch(s.repos, lexAll, semScores, 20));
      searching.set(false);
      void top; // (search 调用仅为预热内部分词缓存)
    } catch (e) {
      if (mySeq !== searchSeq) return;
      console.error("search failed", e);
      searching.set(false);
      state.set({ ...state(), status: `搜索出错: ${String(e).slice(0, 80)}` });
    }
  }

  // ---- 扫描 + embedding ----
  async function runIndex() {
    const roots = state().roots.split(/\s+/).filter(Boolean).map(expandTilde);
    if (!roots.length) return;
    state.set({ ...state(), phase: "scanning", progress: "", status: "扫描中…" });
    try {
      const found: string[] = [];
      for (const r of roots) {
        const rs = await findRepos(r);
        found.push(...rs);
        state.set({ ...state(), progress: `${r} → ${rs.length} 个仓库` });
      }
      const repos: RepoEntry[] = [];
      for (let i = 0; i < found.length; i++) {
        repos.push(await scanRepo(found[i]));
        if (i % 20 === 0 || i === found.length - 1) {
          state.set({ ...state(), progress: `读取元数据 ${i + 1}/${found.length}` });
        }
      }
      const scannedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
      state.set({
        ...state(), repos, scannedAt, phase: "embedding",
        status: `${repos.length} 个仓库已扫描`, progress: "生成向量…",
      });
      await Storage.setItem("index", JSON.stringify({ scannedAt, repos: state().roots, repos2: undefined, ...{} }) && "");
      // 存索引 (repos 可能大, README 截断过, 一般 < 2MB)
      await Storage.setItem("index", JSON.stringify({ scannedAt, repos }));
      // embedding
      if (cfg().apiKey) {
        const texts = repos.map(repoText);
        const vecs = await embedTexts(cfg(), texts);
        vectors = vecs;
        await Storage.setItem("vectors", JSON.stringify({ model: cfg().model, vectors: vecs }));
        state.set({
          ...state(), phase: "ready",
          vectorMeta: { model: cfg().model, count: vecs.length },
          status: `${repos.length} 个仓库 · ${cfg().model} 向量就绪`,
          progress: "",
        });
      } else {
        state.set({ ...state(), phase: "ready", status: `${repos.length} 个仓库 (未配置 API key, 仅词法检索)`, progress: "" });
      }
    } catch (e) {
      console.error("index failed", e);
      state.set({ ...state(), phase: "ready", status: `索引失败: ${String(e).slice(0, 100)}`, progress: "" });
    }
  }

  function saveCfg(next: EmbedConfig) {
    cfg.set(next);
    Storage.setItem("cfg", JSON.stringify(next)).catch(() => {});
    // 模型变了, 旧向量作废
    const vm = state().vectorMeta;
    if (vectors && vm && vm.model !== next.model) {
      vectors = null;
      state.set({ ...state(), vectorMeta: null });
    }
  }

  // ================= UI =================

  const mono = "SF Mono, Menlo, monospace";

  return (
    <View class="flex-1 bg-[#101214]">
      {screen() === "search" ? <SearchScreen /> : <SettingsScreen />}
      <StatusBar />
    </View>
  );

  function SearchScreen() {
    return (
      <View class="flex-1">
        {/* 顶栏 */}
        <View
          class="pt-[env(safe-area-inset-top)] px-6 pt-5 pb-4 gap-4"
          style={{ backgroundColor: PANEL, borderBottomWidth: 1, borderBottomColor: LINE }}
        >
          <View class="flex-row items-center justify-between">
            <View class="flex-row items-baseline gap-2">
              <Text style={{ fontSize: 20, fontWeight: "800", letterSpacing: 2, color: TEXT }}>
                REPO<Text style={{ color: ACCENT }}>FIND</Text>
              </Text>
              <Text style={{ fontSize: 10, color: MUTED, fontFamily: mono, letterSpacing: 1 }}>
                SEMANTIC INDEX v1
              </Text>
            </View>
            <View
              class="rounded px-3 py-1"
              style={{ borderWidth: 1, borderColor: LINE }}
              role="button"
              onPress={() => screen.set("settings")}
            >
              <Text style={{ fontSize: 11, color: MUTED, fontFamily: mono }}>⚙ SETTINGS</Text>
            </View>
          </View>

          {/* 搜索框 */}
          <View
            class="flex-row items-center gap-3 rounded px-4 py-3"
            style={{ backgroundColor: BG, borderWidth: 1, borderColor: searching() ? ACCENT_DIM : LINE }}
          >
            <Text style={{ color: searching() ? ACCENT : MUTED, fontSize: 14, fontFamily: mono }}>
              {searching() ? "◌" : "›"}
            </Text>
            <View class="flex-1">
              <Input
                value={query()}
                onChange={(e: { value: string }) => query.set(e.value)}
                placeholder="描述你想找的仓库 — 推荐系统 / rust gui / 爬虫…"
                returnKeyType="search"
                submitBehavior="submit"
                autoFocus
                style={{ fontSize: 15, color: TEXT, fontFamily: mono }}
              />
            </View>
            {/* 模式切换 */}
            <View
              class="rounded px-2 py-0.5"
              role="button"
              style={{ borderWidth: 1, borderColor: searchMode() === "hybrid" ? ACCENT_DIM : LINE }}
              onPress={() => searchMode.set(searchMode() === "hybrid" ? "lexical" : "hybrid")}
            >
              <Text style={{ fontSize: 10, fontFamily: mono, color: searchMode() === "hybrid" ? ACCENT : MUTED }}>
                {searchMode() === "hybrid" ? "SEM+" : "LEX"}
              </Text>
            </View>
          </View>
        </View>

        {/* 结果 */}
        <Scroll class="flex-1">
          <View class="px-6 py-4 gap-0">
            {/* 空态 */}
            {hits().length === 0 && !searching() && (
              <View class="items-center pt-24 gap-3">
                <Text style={{ fontSize: 40, color: LINE }}>◎</Text>
                <Text style={{ color: MUTED, fontSize: 13, fontFamily: mono }}>
                  {query() ? "无匹配 — 换个说法" : state().repos.length ? "输入自然语言描述" : "先去 SETTINGS 建索引"}
                </Text>
                {state().repos.length > 0 && (
                  <View class="flex-row gap-4 pt-2">
                    {["推荐系统", "向量检索", "爬虫"].map((s) => (
                      <Text
                        style={{ color: ACCENT_DIM, fontSize: 12, fontFamily: mono }}
                        onPress={() => query.set(s)}
                      >
                        {s}
                      </Text>
                    ))}
                  </View>
                )}
              </View>
            )}

            {/* 列表头 */}
            {hits().length > 0 && (
              <View class="flex-row justify-between pb-2" style={{ borderBottomWidth: 1, borderBottomColor: LINE }}>
                <Text style={{ color: MUTED, fontSize: 10, fontFamily: mono, letterSpacing: 1.5 }}>
                  {hits().length} RESULTS
                </Text>
                <Text style={{ color: MUTED, fontSize: 10, fontFamily: mono, numberOfLines: 1 }}>
                  {state().repos.length} REPOS INDEXED
                </Text>
              </View>
            )}

            {/* 结果行 — 编辑部式: 左对齐分数字 + 内容列 */}
            {hits().map((h, idx) => {
              const e = h.entry;
              const pct = Math.min(100, Math.round(h.score * 100));
              const gh = e.remote.includes("github.com")
                ? e.remote.replace("git@github.com:", "https://github.com/").replace(/\.git$/, "")
                : "";
              return (
                <View
                  class="flex-row py-4 gap-4"
                  style={{ borderBottomWidth: idx < hits().length - 1 ? 1 : 0, borderBottomColor: LINE }}
                  role="button"
                  onPress={() => {
                    Clipboard.writeText(e.path);
                    copiedIdx.set(idx);
                    setTimeout(() => copiedIdx.set(-1), 1500);
                  }}
                >
                  {/* 分数列 */}
                  <View class="items-center gap-1" style={{ width: 44 }}>
                    <Text style={{ color: h.semantic ? ACCENT : MUTED, fontSize: 15, fontWeight: "700", fontFamily: mono }}>
                      {pct}
                    </Text>
                    <View style={{ width: 26, height: 2, backgroundColor: h.semantic ? ACCENT : LINE }} />
                    <Text style={{ color: MUTED, fontSize: 8, fontFamily: mono }}>
                      {h.semantic ? "SEM" : "LEX"}
                    </Text>
                  </View>
                  {/* 内容列 */}
                  <View class="flex-1 gap-1">
                    <View class="flex-row items-center gap-2 flex-wrap">
                      <Text style={{ color: TEXT, fontSize: 15, fontWeight: "600" }}>{e.name}</Text>
                      {copiedIdx() === idx && (
                        <Text style={{ color: SCAN, fontSize: 10, fontFamily: mono }}>✓ PATH COPIED</Text>
                      )}
                    </View>
                    <Text style={{ color: MUTED, fontSize: 11, fontFamily: mono, numberOfLines: 1 }}>
                      {e.path.replace(home(), "~")}
                    </Text>
                    <View class="flex-row gap-3 items-center flex-wrap pt-0.5">
                      {e.langs.map((l) => (
                        <Text style={{ color: ACCENT_DIM, fontSize: 10, fontFamily: mono }}>◆ {l}</Text>
                      ))}
                      {e.branch ? <Text style={{ color: MUTED, fontSize: 10, fontFamily: mono }}>⑂ {e.branch}</Text> : null}
                      {e.lastCommit ? (
                        <Text style={{ color: MUTED, fontSize: 10, fontFamily: mono }}>
                          {e.lastCommit.slice(0, 46)}
                        </Text>
                      ) : null}
                    </View>
                    {gh ? (
                      <Text style={{ color: ACCENT_DIM, fontSize: 10, fontFamily: mono }} onPress={() => openUrl(gh)}>
                        GITHUB ↗
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        </Scroll>
      </View>
    );
  }

  function SettingsScreen() {
    return (
      <View class="flex-1">
        <View
          class="pt-[env(safe-area-inset-top)] px-6 pt-5 pb-4 flex-row items-center justify-between"
          style={{ backgroundColor: PANEL, borderBottomWidth: 1, borderBottomColor: LINE }}
        >
          <Text style={{ fontSize: 18, fontWeight: "700", color: TEXT, fontFamily: mono, letterSpacing: 1 }}>SETTINGS</Text>
          <Text style={{ color: ACCENT, fontSize: 13, fontFamily: mono }} onPress={() => screen.set("search")}>
            ‹ BACK
          </Text>
        </View>
        <Scroll class="flex-1">
          <View class="px-6 py-5 gap-6">
            {/* 扫描 */}
            <Section title="1 · 索引">
              <Field label="扫描目录 (空格分隔)" value={state().roots}
                onChange={(v: string) => {
                  state.set({ ...state(), roots: v });
                  Storage.setItem("roots", v).catch(() => {});
                }} />
              <View class="flex-row gap-3 items-center pt-1">
                <View
                  class="rounded px-4 py-2"
                  role="button"
                  style={{
                    backgroundColor: state().phase === "scanning" || state().phase === "embedding" ? LINE : ACCENT,
                  }}
                  onPress={() => { if (state().phase === "ready" || state().phase === "idle") runIndex(); }}
                >
                  <Text style={{
                    color: state().phase === "scanning" || state().phase === "embedding" ? MUTED : "#101214",
                    fontSize: 12, fontWeight: "700", fontFamily: mono,
                  }}>
                    {state().phase === "scanning" ? "SCANNING…" : state().phase === "embedding" ? "EMBEDDING…" : "▶ SCAN + INDEX"}
                  </Text>
                </View>
                <Text style={{ color: MUTED, fontSize: 11, fontFamily: mono, flex: 1, numberOfLines: 2 }}>
                  {state().progress || (state().scannedAt ? `上次: ${state().scannedAt}` : "")}
                </Text>
              </View>
            </Section>

            {/* 模型配置 */}
            <Section title="2 · Embedding 模型">
              <Field label="Base URL (OpenAI 兼容)" value={cfg().baseUrl}
                onChange={(v: string) => saveCfg({ ...cfg(), baseUrl: v })} />
              <Field label="模型名" value={cfg().model}
                onChange={(v: string) => saveCfg({ ...cfg(), model: v })} />
              <Field label="API Key" value={cfg().apiKey} masked
                onChange={(v: string) => saveCfg({ ...cfg(), apiKey: v })} />
              <Text style={{ color: MUTED, fontSize: 10, fontFamily: mono, lineHeight: 15 }}>
                {'任意 OpenAI 兼容接口。推荐: SiliconFlow 免费 BAAI/bge-m3 (中文好)\n配置保存在本机 Storage, 不上传'}
              </Text>
              {state().vectorMeta ? (
                <Text style={{ color: SCAN, fontSize: 10, fontFamily: mono }}>
                  ✓ {state().vectorMeta!.model} · {state().vectorMeta!.count} vectors
                </Text>
              ) : (
                <Text style={{ color: ACCENT_DIM, fontSize: 10, fontFamily: mono }}>
                  无向量 — 仅词法模式 (SEM 开关无效)
                </Text>
              )}
            </Section>

            {/* 关于 */}
            <Section title="About">
              <Text style={{ color: MUTED, fontSize: 11, fontFamily: mono, lineHeight: 17 }}>
                {'RepoFind — 语义检索本地 git 仓库\n混合排序: 0.6 × cosine + 0.4 × TF-IDF\ngithub.com/ahjdzx/repofind'}
              </Text>
            </Section>
          </View>
        </Scroll>
      </View>
    );
  }

  function StatusBar() {
    const dot = state().phase === "ready" ? SCAN : state().phase === "idle" ? MUTED : ACCENT;
    return (
      <View
        class="flex-row items-center justify-between px-6 py-2 pb-[max(env(safe-area-inset-bottom),8px)]"
        style={{ backgroundColor: PANEL, borderTopWidth: 1, borderTopColor: LINE }}
      >
        <View class="flex-row items-center gap-2">
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot }} />
          <Text style={{ color: MUTED, fontSize: 10, fontFamily: mono }}>{state().status}</Text>
        </View>
        <Text style={{ color: MUTED, fontSize: 10, fontFamily: mono }}>
          {searchMode() === "hybrid" && vectors ? "HYBRID" : "LEXICAL"}
        </Text>
      </View>
    );
  }

  function Section(props: { title: string; children: any }) {
    return (
      <View class="gap-3">
        <Text style={{ color: ACCENT, fontSize: 11, fontWeight: "700", fontFamily: mono, letterSpacing: 2 }}>
          {props.title}
        </Text>
        <View class="gap-3">{props.children}</View>
      </View>
    );
  }

  function Field(props: { label: string; value: string; masked?: boolean; onChange: (v: string) => void }) {
    return (
      <View class="gap-1">
        <Text style={{ color: MUTED, fontSize: 10, fontFamily: mono, letterSpacing: 1 }}>{props.label.toUpperCase()}</Text>
        <View class="rounded px-3 py-2" style={{ backgroundColor: BG, borderWidth: 1, borderColor: LINE }}>
          <Input
            value={props.value}
            masked={props.masked}
            onChange={(e: { value: string }) => props.onChange(e.value)}
            style={{ fontSize: 13, color: TEXT, fontFamily: mono }}
          />
        </View>
      </View>
    );
  }
}

// ---- 词法打分辅助 (带 idx, 供混合检索全量扫描) ----

interface LexDoc { pt: Set<string>; nt: Set<string>; rt: Set<string>; lt: Set<string> }

function buildLex(entries: RepoEntry[]) {
  const df = new Map<string, number>();
  const docs: LexDoc[] = entries.map((e) => {
    const pt = new Set(pathTokens(e.path.replace(home(), "~")));
    const nt = new Set(tokenize(e.name));
    const rt = new Set(tokenize(e.readme));
    const lt = new Set(tokenize(e.langs.join(" ")));
    for (const t of new Set([...pt, ...nt, ...rt, ...lt])) df.set(t, (df.get(t) ?? 0) + 1);
    return { pt, nt, rt, lt };
  });
  return { df, docs, n: entries.length };
}

function scoreDoc(lex: ReturnType<typeof buildLex>, i: number, qt: Set<string>): { score: number; matched: string[] } {
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
  return { score, matched };
}

mount(App);
