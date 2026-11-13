import { mount, signal, computed, effect, locale, platform, List, Text, View, Scroll, Clipboard, openUrl, Storage } from "nsh";
import { Input } from "nsh/base";
import { t, setLocale } from "nsh/i18n";
import nodeProcess from "process";
import {
  scanRepo, findRepos, expandTilde, tildify, buildLex, lexSearch,
  cosine, repoText, hybridSearch, textHash,
  saveIndex, loadIndex, saveVectors, loadVectors, INDEX_VERSION,
  type RepoEntry, type HybridHit, type LexIndex,
} from "./lib";
import { Local, Shell, type DownloadState, type LocalModel } from "repofind/native";
import {
  DEFAULT_SETTINGS, parseSettings, embedKey, canEmbed, embed, probe,
  type EmbedSettings, type Provider, type Source,
} from "./embedder";
import {
  deriveTags, topicTerms, emptyFilters, activeFilters, toggleFilter, classifyAll, TAGS_VERSION,
  type Filters, type RepoTags,
} from "./tags";
import { Atlas, Chip, ageLabel, matching, valueLabel, type AtlasCtx } from "./Atlas";
import {
  ACCENT, ACCENT_DIM, ACCENT_TEXT, BG, LINE, MONO, MUTED, PANEL, RAISED, TEAL, TEXT,
} from "./theme";

// ============================================================
// RepoFind — 本地 git 仓库语义搜索 (纯客户端, 无 server)
// 三个页面: 搜索 / 总览 (标签统计 + 雷达图) / 设置
// ============================================================

type Screen = "search" | "atlas" | "settings";
/** loading: 打开时整理旧索引 (补算主题) */
type Phase = "idle" | "loading" | "scanning" | "embedding" | "ready";

/** 状态行存 key 而不是文案, 这样切语言时跟着变 */
interface Status { key: string; n?: number; detail?: string }

interface AppState {
  phase: Phase;
  status: Status;
  progress: string;
  repos: RepoEntry[];
  scannedAt: string;
  roots: string;
  /** 落盘索引的格式版本: 比 INDEX_VERSION 旧说明标签用的字段不全, 要重扫 */
  indexVersion: number;
}

/** 内存里的向量: 谁生成的、每个仓库文本的指纹、向量本身 (和 state().repos 一一对应) */
interface Vectors { key: string; hashes: string[]; vectors: Float32Array[] }

/** 查询向量缓存条数: 改回刚才的查询词时不用再算一次 */
const QUERY_CACHE = 64;

/** 应用数据目录 (索引和向量落盘的位置); 没有的平台只在内存里保留 */
const DATA_DIR: string = nodeProcess.dataDir ?? "";

/** 只按标签浏览 (没输入查询词) 时最多列多少个 (列表是虚拟化的, 多了也不卡) */
const BROWSE_LIMIT = 500;

const SCREENS: Screen[] = ["atlas", "search", "settings"];

function statusText(s: Status): string {
  return [s.n !== undefined ? String(s.n) : "", t(s.key), s.detail ?? ""].filter(Boolean).join(" ");
}

function downloadText(p: DownloadState): string {
  const pct = p.total > 0 ? Math.min(100, Math.floor((100 * p.done) / p.total)) : 0;
  const mb = (n: number) => (n / 1e6).toFixed(0);
  return t("embed.downloading", { id: p.id, pct, done: mb(p.done), total: mb(p.total) }) + (p.source ? ` · ${p.source}` : "");
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 120);
}

function App() {
  const screen = signal<Screen>("atlas");
  const cfg = signal<EmbedSettings>(DEFAULT_SETTINGS);
  /** 只在来源真的变了时才变 (设置页按它切换面板, 改输入框不会重建面板) */
  const provider = computed<Provider>(() => cfg().provider);
  /** 已下载的本地模型 */
  /** 本地模型在这里能不能用 (要有数据目录, 浏览器和 Intel Mac 上没有推理引擎) */
  const localOk = !!DATA_DIR && Local.supported();
  const installed = signal<string[]>(localOk ? Local.installed(DATA_DIR) : []);
  /** 正在下载的模型 (轮询 Local.progress 得到) */
  const download = signal<DownloadState | null>(null);
  /** 设置页 "测试连接" 的结果 */
  const probeResult = signal<{ ok: boolean; text: string } | null>(null);
  const localModels: LocalModel[] = Local.models();
  const state = signal<AppState>({
    phase: "idle",
    status: { key: "app.not_indexed" },
    progress: "",
    repos: [],
    scannedAt: "",
    roots: "~/work ~/src",
    indexVersion: INDEX_VERSION,
  });
  const query = signal("");
  const hits = signal<HybridHit[]>([]);
  const searching = signal(false);
  const copiedPath = signal("");
  const searchMode = signal<"hybrid" | "lexical">("hybrid");
  const filters = signal<Filters>(emptyFilters());
  /** 内存里的向量; 只有和当前配置的来源一致才用 */
  const vec = signal<Vectors | null>(null);
  const queryCache = new Map<string, Float32Array>();
  let lex: { repos: RepoEntry[]; index: LexIndex } | null = null;
  let searchSeq = 0;

  // 派生状态都用 computed: 只有结果真的变了才通知。state 是一个大对象, 进度条每 300ms 更新一次,
  // 以前总览页和结果列表直接读 state(), 每次都整页重建。
  /** 仓库列表 */
  const repos = computed(() => state().repos);
  const hasRepos = computed(() => repos().length > 0);
  /** 每个仓库的标签, 和 repos() 一一对应 (主题在扫描时算好存在索引里, 这里很快) */
  const tags = computed<RepoTags[]>(() => {
    const now = Date.now();
    return repos().map((e) => deriveTags(e, now));
  });
  /** 筛选后剩下的仓库下标 (最近动过的在前) */
  const matchIds = computed(() => matching(tags(), filters()));
  const filtered = computed(() => activeFilters(filters()).length > 0);

  /** 现在的配置能不能生成向量 (本地模型下好了 / 填了服务地址 / 有 key) */
  const embedderReady = () => canEmbed(cfg(), installed());

  /** 向量是按现在的配置生成的, 而且和仓库列表对齐 */
  const vectorsMatch = () => {
    const v = vec();
    return !!v && v.key === embedKey(cfg()) && v.vectors.length === repos().length;
  };

  /** 语义检索此刻可用 */
  const semanticReady = () => vectorsMatch() && embedderReady();

  async function queryVector(q: string): Promise<Float32Array> {
    const k = embedKey(cfg()) + "\u0000" + q;
    const hit = queryCache.get(k);
    if (hit) return hit;
    const [v] = await embed(cfg(), DATA_DIR, [q], true);
    queryCache.set(k, v);
    if (queryCache.size > QUERY_CACHE) queryCache.delete(queryCache.keys().next().value!);
    return v;
  }

  /** 本机装了的终端 (macOS); 第一个是默认的 */
  const terminals: string[] = Shell.terminals();
  const terminal = signal("");

  function openFailed(e: unknown) {
    state.set({ ...state(), status: { key: "app.status_open_failed", detail: errText(e) } });
  }
  const openFolder = (path: string) => { Shell.openFolder(path).catch(openFailed); };
  const openTerminal = (path: string) => {
    Shell.openTerminal(path, terminal() || terminals[0] || "").catch(openFailed);
  };

  const copyPath = (path: string) => {
    Clipboard.writeText(path);
    copiedPath.set(path);
    setTimeout(() => { if (copiedPath() === path) copiedPath.set(""); }, 1500);
  };

  // ---- 启动: 读配置和落盘的索引 ----
  (async () => {
    try {
      const savedLocale = await Storage.getItem("locale");
      if (savedLocale) setLocale(savedLocale);
      cfg.set(parseSettings(await Storage.getItem("embed"), await Storage.getItem("cfg")));
      const savedRoots = await Storage.getItem("roots");
      if (savedRoots) state.set({ ...state(), roots: savedRoots });
      const savedTerminal = await Storage.getItem("terminal");
      if (savedTerminal && terminals.includes(savedTerminal)) terminal.set(savedTerminal);
      // 早期版本把索引/向量塞在 Storage 里 (会撑爆 5MB 配额), 清掉
      Storage.removeItem("index").catch(() => {});
      Storage.removeItem("vectors").catch(() => {});
      if (!DATA_DIR) return;
      const idx = await loadIndex(DATA_DIR);
      if (!idx) return;
      const v = await loadVectors(DATA_DIR);
      const usable = !!v && v.vectors.length === idx.repos.length;
      if (usable) vec.set(v);
      let list = idx.repos;
      if (idx.tagsVersion !== TAGS_VERSION || list.some((e) => !e.topics)) {
        // 老索引没存主题 (或分类规则改过): 分批补算一次再存回去, 以后打开就不用算了
        state.set({ ...state(), phase: "loading", status: { key: "app.status_loading" } });
        list = await classifyAll(list);
        saveIndex(DATA_DIR, { ...idx, repos: list, tagsVersion: TAGS_VERSION }).catch((e) => console.error("save index failed", e));
      }
      state.set({
        ...state(),
        repos: list,
        scannedAt: idx.scannedAt,
        indexVersion: idx.version ?? 1,
        phase: "ready",
        status: { key: usable ? "app.status_ready" : "app.status_indexed", n: list.length },
      });
      warmLex();
    } catch (e) {
      console.error("load failed", e);
    }
  })();

  // ---- 搜索 (300ms 防抖) ----
  effect(() => {
    const q = query().trim();
    searchMode(); // 切模式、改筛选条件、重建索引后重搜
    filters();
    repos();
    if (!q) {
      hits.set([]);
      searching.set(false);
      return;
    }
    const mySeq = ++searchSeq;
    searching.set(true);
    const timer = setTimeout(() => runSearch(q, mySeq), 300);
    return () => clearTimeout(timer);
  });

  /** 词法索引: 要给每个 README 分词, 几百个仓库约 150 ms */
  function ensureLex(): LexIndex {
    const list = repos();
    if (!lex || lex.repos !== list) lex = { repos: list, index: buildLex(list, tags().map(topicTerms)) };
    return lex.index;
  }

  /** 索引加载 / 重建后, 趁空闲先把词法索引建好, 第一次搜索就不用等 */
  function warmLex() {
    setTimeout(() => {
      try { ensureLex(); } catch (e) { console.error("lex index failed", e); }
    }, 400);
  }

  async function runSearch(q: string, mySeq: number) {
    const list = repos();
    if (!list.length) {
      if (mySeq === searchSeq) { searching.set(false); hits.set([]); }
      return;
    }
    try {
      const index = ensureLex();
      // 有筛选条件时只在筛出来的仓库里搜
      const allowed = filtered() ? new Set(matchIds()) : null;
      const lexHits = lexSearch(index, q).filter((h) => !allowed || allowed.has(h.idx));

      let semScores: Map<number, number> | null = null;
      if (searchMode() === "hybrid" && semanticReady() && (!allowed || allowed.size > 0)) {
        const vectors = vec()!.vectors;
        const qv = await queryVector(q);
        const candidates = allowed ? [...allowed] : vectors.map((_, i) => i);
        const all = candidates.map((idx) => ({ idx, c: cosine(qv, vectors[idx]) }));
        all.sort((a, b) => b.c - a.c);
        semScores = new Map(all.slice(0, 20).map((x) => [x.idx, x.c]));
      }

      if (mySeq !== searchSeq) return;
      hits.set(hybridSearch(list, lexHits, semScores, 20));
      searching.set(false);
    } catch (e) {
      if (mySeq !== searchSeq) return;
      console.error("search failed", e);
      searching.set(false);
      state.set({ ...state(), status: { key: "app.status_search_failed", detail: errText(e) } });
    }
  }

  // ---- 扫描 + embedding ----
  async function runIndex() {
    const roots = state().roots.split(/\s+/).filter(Boolean).map(expandTilde);
    if (!roots.length) return;
    state.set({ ...state(), phase: "scanning", progress: "", status: { key: "app.status_scanning" } });
    try {
      const found: string[] = [];
      const skipped: string[] = [];
      for (const r of roots) {
        try {
          const rs = await findRepos(r);
          found.push(...rs);
          state.set({ ...state(), progress: `${tildify(r)} → ${rs.length}` });
        } catch (err) {
          // 不存在的目录跳过; 全部都读不了才算失败
          skipped.push(errText(err));
        }
      }
      if (!found.length && skipped.length) throw new Error(skipped.join("; "));
      const paths = [...new Set(found)].sort();
      const scanned: RepoEntry[] = [];
      for (let i = 0; i < paths.length; i += 8) {
        scanned.push(...(await Promise.all(paths.slice(i, i + 8).map(scanRepo))));
        state.set({ ...state(), progress: `${scanned.length}/${paths.length}` });
      }
      state.set({ ...state(), progress: t("app.classifying") });
      const repos = await classifyAll(scanned);
      const scannedAt = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
      const previous = vec();
      vec.set(null); // 旧向量和新仓库列表不再对齐
      filters.set(emptyFilters());
      state.set({
        ...state(), repos, scannedAt, phase: "embedding", progress: "", indexVersion: INDEX_VERSION,
        status: { key: "app.status_scan", n: repos.length },
      });
      if (DATA_DIR) await saveIndex(DATA_DIR, { scannedAt, repos, tagsVersion: TAGS_VERSION });
      warmLex();
      if (!repos.length) {
        state.set({ ...state(), phase: "ready", status: { key: "app.status_scan", n: 0 } });
        return;
      }

      // 本地模型还没下载: 先下 (默认模型是这时第一次下载的)
      const settings = cfg();
      if (settings.provider === "local" && !installed().includes(settings.local.model) && localOk) {
        await downloadModel(settings.local.model);
      }
      if (!canEmbed(cfg(), installed())) {
        state.set({ ...state(), phase: "ready", progress: "", status: { key: noVectorsKey(), n: repos.length } });
        return;
      }

      // 增量: 文本没变的仓库直接用上次的向量, 只给新的 / 变了的算
      const key = embedKey(cfg());
      const texts = repos.map(repoText);
      const hashes = texts.map(textHash);
      const reuse = new Map<string, Float32Array>();
      if (previous && previous.key === key) {
        previous.hashes.forEach((h, i) => reuse.set(h, previous.vectors[i]));
      }
      const todo = hashes.map((h, i) => (reuse.has(h) ? -1 : i)).filter((i) => i >= 0);
      const kept = repos.length - todo.length;
      const fresh = await embed(cfg(), DATA_DIR, todo.map((i) => texts[i]), false, (done, total) => {
        state.set({ ...state(), progress: t("app.embedding_progress", { done, total, kept }) });
      });
      const freshByIdx = new Map(todo.map((i, k) => [i, fresh[k]]));
      const vectors = hashes.map((h, i) => freshByIdx.get(i) ?? reuse.get(h)!);
      const v = { key, hashes, vectors };
      vec.set(v);
      queryCache.clear();
      if (DATA_DIR) await saveVectors(DATA_DIR, v);
      state.set({
        ...state(), phase: "ready", progress: "",
        status: { key: "app.status_ready", n: repos.length, detail: kept ? t("app.reused", { kept }) : "" },
      });
    } catch (e) {
      console.error("index failed", e);
      state.set({
        ...state(), phase: "ready", progress: "",
        status: { key: "app.status_index_failed", detail: errText(e) },
      });
    }
  }

  function saveCfg(next: EmbedSettings) {
    cfg.set(next);
    probeResult.set(null);
    Storage.setItem("embed", JSON.stringify(next)).catch(() => {});
  }

  /** 没法生成向量时状态栏说什么 */
  function noVectorsKey(): string {
    const s = cfg();
    if (s.provider === "local") return localOk ? "app.status_no_model" : "app.status_no_local";
    return "app.status_no_key";
  }

  /** 下载本地模型; 下载期间每 300ms 读一次进度 */
  async function downloadModel(id: string): Promise<void> {
    if (!localOk || download()?.active) return;
    download.set({ id, done: 0, total: 1, active: true, error: "", source: "" });
    const poll = setInterval(() => {
      const p = Local.progress();
      download.set(p);
      if (state().phase === "embedding") state.set({ ...state(), progress: downloadText(p) });
    }, 300);
    try {
      await Local.download(DATA_DIR, id, cfg().local.source);
    } catch (e) {
      console.error("download failed", e);
    } finally {
      clearInterval(poll);
      download.set(Local.progress());
      installed.set(Local.installed(DATA_DIR));
    }
  }

  function removeModel(id: string) {
    if (!localOk) return;
    try {
      Local.remove(DATA_DIR, id);
    } catch (e) {
      console.error("remove failed", e);
    }
    installed.set(Local.installed(DATA_DIR));
  }

  async function runProbe() {
    probeResult.set({ ok: true, text: t("embed.testing") });
    try {
      const r = await probe(cfg(), DATA_DIR);
      probeResult.set({ ok: true, text: t("embed.test_ok", { dim: r.dim, ms: r.ms }) });
    } catch (e) {
      probeResult.set({ ok: false, text: errText(e) });
    }
  }

  function toggleLocale() {
    const next = locale().startsWith("zh") ? "en" : "zh-CN";
    setLocale(next);
    Storage.setItem("locale", next).catch(() => {});
  }

  const atlasCtx: AtlasCtx = {
    repos,
    tags,
    matches: matchIds,
    openFolder,
    openTerminal,
    filters: () => filters(),
    setFilters: (f) => filters.set(f),
    stale: () => state().indexVersion < INDEX_VERSION,
    openSearch: () => screen.set("search"),
    openSettings: () => screen.set("settings"),
    copyPath: (p) => Clipboard.writeText(p),
  };

  /**
   * 搜索页列表显示哪一种: 只有这个变了才换整块内容。打字、复制路径、进度更新只更新各自的那几个视图,
   * 结果行用 <Each> 按仓库复用。
   */
  const listMode = computed(() => {
    if (!hasRepos()) return "need";
    if (query().trim()) return hits().length ? "hits" : searching() ? "wait" : "nomatch";
    if (filtered()) return matchIds().length ? "browse" : "browse-empty";
    return "idle";
  });

  /** 没索引时显示什么: 只在这个变了时换内容, 进度文字自己更新 */
  const needMode = computed(() =>
    state().phase === "loading" ? "loading" : indexing() ? "indexing" : "idle",
  );

  // ================= UI =================

  return (
    <View class="flex-1" style={{ backgroundColor: BG }}>
      {screen() === "search" ? <SearchScreen /> : screen() === "atlas" ? <AtlasScreen /> : <SettingsScreen />}
      <StatusBar />
    </View>
  );

  /** 顶栏: 品牌 + 三个页签 + 语言切换; children 是各页自己的工具条 (搜索框等) */
  function Header(props: { children?: any }) {
    return (
      <View
        class="pt-[env(safe-area-inset-top)]"
        style={{ backgroundColor: PANEL, borderBottomWidth: 1, borderBottomColor: LINE, paddingHorizontal: 24, paddingTop: 14, paddingBottom: 12, gap: 12 }}
      >
        <View class="flex-row items-center justify-between" style={{ gap: 16 }}>
          <View class="flex-row items-center" style={{ gap: 24 }}>
            <Text style={{ fontSize: 19, fontWeight: "800", letterSpacing: 2, color: TEXT }}>
              REPO<Text style={{ color: ACCENT }}>FIND</Text>
            </Text>
            <View class="flex-row" role="tablist" style={{ gap: 2 }}>
              {SCREENS.map((s) => <Tab id={s} />)}
            </View>
          </View>
          <View
            role="button"
            accessibilityLabel={locale().startsWith("zh") ? "Switch to English" : "切换到中文"}
            onPress={toggleLocale}
            hoverStyle={{ backgroundColor: RAISED }}
            style={{ borderWidth: 1, borderColor: LINE, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, cursor: "pointer" }}
          >
            <Text style={{ fontSize: 11, color: MUTED }}>{locale().startsWith("zh") ? "EN" : "中文"}</Text>
          </View>
        </View>
        {props.children}
      </View>
    );
  }

  function Tab(props: { id: Screen }) {
    const on = () => screen() === props.id;
    return (
      <View
        role="tab"
        testID={`tab-${props.id}`}
        accessibilityState={{ selected: on() }}
        onPress={() => screen.set(props.id)}
        hoverStyle={{ backgroundColor: RAISED }}
        style={{
          paddingHorizontal: 12, paddingTop: 5, paddingBottom: 4, borderRadius: 3, cursor: "pointer",
          borderBottomWidth: 2, borderBottomColor: on() ? ACCENT : "transparent",
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: on() ? "600" : "500", color: on() ? TEXT : MUTED }}>
          {t(`tab.${props.id}`)}
        </Text>
      </View>
    );
  }

  function AtlasScreen() {
    return (
      <View class="flex-1">
        <Header />
        {hasRepos() ? <Atlas ctx={atlasCtx} /> : <Scroll class="flex-1"><NeedIndex /></Scroll>}
      </View>
    );
  }

  function SearchScreen() {
    return (
      <View class="flex-1">
        <Header>
          {/* 搜索框 */}
          <View
            class="flex-row items-center gap-3 rounded px-4 py-3"
            style={{ backgroundColor: BG, borderWidth: 1, borderColor: searching() ? ACCENT_DIM : LINE }}
          >
            <Text style={{ color: searching() ? ACCENT : MUTED, fontSize: 14, fontFamily: MONO }}>
              {searching() ? "◌" : "›"}
            </Text>
            <View class="flex-1">
              <Input
                value={query()}
                onChange={(e: { value: string }) => query.set(e.value)}
                placeholder={t("app.placeholder")}
                returnKeyType="search"
                submitBehavior="submit"
                autoFocus
                style={{ fontSize: 15, color: TEXT }}
              />
            </View>
            {/* 模式切换 */}
            <View
              class="rounded px-2 py-0.5"
              role="button"
              style={{ borderWidth: 1, borderColor: searchMode() === "hybrid" ? ACCENT_DIM : LINE, cursor: "pointer" }}
              onPress={() => searchMode.set(searchMode() === "hybrid" ? "lexical" : "hybrid")}
            >
              <Text style={{ fontSize: 10, fontFamily: MONO, color: searchMode() === "hybrid" ? ACCENT : MUTED }}>
                {searchMode() === "hybrid" ? "SEM+" : "LEX"}
              </Text>
            </View>
          </View>
          {/* 已选的标签: 搜索只在这些仓库里进行 */}
          {filtered() ? (
            <View class="flex-row flex-wrap items-center" style={{ gap: 6 }}>
              {activeFilters(filters()).map((a) => (
                <Chip
                  label={t(`facet.${a.facet}`) + ": " + valueLabel(a.facet, a.value)}
                  onRemove={() => filters.set(toggleFilter(filters(), a.facet, a.value))}
                />
              ))}
              <Text
                role="button"
                style={{ color: MUTED, fontSize: 12, paddingHorizontal: 6, cursor: "pointer" }}
                hoverStyle={{ color: TEXT }}
                onPress={() => filters.set(emptyFilters())}
              >
                {t("atlas.clear")}
              </Text>
            </View>
          ) : null}
        </Header>

        <Scroll class="flex-1">
          <View style={{ paddingHorizontal: 24, paddingVertical: 14 }}>{listView()}</View>
        </Scroll>
      </View>
    );
  }

  function listView() {
    switch (listMode()) {
      case "need": return <NeedIndex />;
      case "wait": return null;
      case "nomatch": return <NoMatch />;
      case "hits": return <HitList />;
      case "browse": return <BrowseList />;
      case "browse-empty": return <Empty msg={t("atlas.no_match")} />;
      default: return <Idle />;
    }
  }

  function NoMatch() {
    // 搜不到: 多半是新 clone 的仓库还没进索引, 或者还没向量只能按字面匹配
    const hint = () => state().indexVersion < INDEX_VERSION
      ? t("empty.hint_stale")
      : semanticReady() ? t("empty.hint_rescan") : t("empty.hint_no_vectors");
    return <Empty msg={t("app.no_match")} hint={hint()} action={t("empty.reindex")} />;
  }

  function HitList() {
    return (
      <View>
        <ListHead left={`${hits().length} ${t("app.results")}`} right={`${repos().length} ${t("app.repos_indexed")}`} />
        {/* 虚拟化: 只创建看得到的那几行, 滚动时复用 */}
        <List
          viewport="parent"
          each={hits()}
          keyExtractor={(h) => repos()[h.idx]?.path ?? String(h.idx)}
          estimatedItemSize={150}
        >
          {(h, k) => (
            <Row
              idx={h().idx}
              lead={String(Math.min(100, Math.round(h().score * 100)))}
              sub={h().semantic ? "SEM" : "LEX"}
              hot={h().semantic}
              last={k() === hits().length - 1}
            />
          )}
        </List>
      </View>
    );
  }

  function BrowseList() {
    const shown = computed(() => matchIds().slice(0, BROWSE_LIMIT));
    return (
      <View>
        <ListHead
          left={t("search.browse_count", { n: matchIds().length })}
          right={matchIds().length > BROWSE_LIMIT ? t("search.browse_more", { shown: BROWSE_LIMIT }) : ""}
        />
        <List viewport="parent" each={shown()} keyExtractor={(i) => String(i)} estimatedItemSize={140}>
          {(i, k) => <Row idx={i()} lead={ageLabel(tags()[i()].ageDays)} sub="" hot={false} last={k() === shown().length - 1} />}
        </List>
      </View>
    );
  }

  function Idle() {
    return (
      <View class="items-center pt-24 gap-3">
        <Text style={{ fontSize: 40, color: LINE }}>◎</Text>
        <Text style={{ color: MUTED, fontSize: 13 }}>{t("app.type_to_search")}</Text>
        <View class="flex-row gap-4 pt-2">
          {[t("suggestions.rec"), t("suggestions.emb"), t("suggestions.crawler")].map((s) => (
            <Text role="button" style={{ color: ACCENT_TEXT, fontSize: 12, cursor: "pointer" }} onPress={() => query.set(s)}>
              {s}
            </Text>
          ))}
        </View>
        <Text
          role="button"
          style={{ color: MUTED, fontSize: 12, paddingTop: 10, cursor: "pointer" }}
          hoverStyle={{ color: TEXT }}
          onPress={() => screen.set("atlas")}
        >
          {t("search.browse_hint")}
        </Text>
      </View>
    );
  }

  function indexing() {
    return state().phase === "scanning" || state().phase === "embedding";
  }

  /** 还没有索引: 直接在这里建, 不用先跑去设置页 */
  function NeedIndex() {
    const roots = () => state().roots.trim() || "—";
    return (
      <View>
        {needMode() === "loading" ? (
          <Empty msg={t("app.status_loading")} />
        ) : needMode() === "indexing" ? (
          <Empty msg={t("empty.indexing")} hint={state().progress || statusText(state().status)} />
        ) : (
          <Empty
            msg={query().trim() ? t("empty.need_index_query") : t("empty.need_index")}
            hint={t("empty.roots", { roots: roots() })}
            action={t("empty.index_now")}
            secondary={t("empty.edit_roots")}
          />
        )}
      </View>
    );
  }

  function Empty(props: { msg: string; hint?: string; action?: string; secondary?: string }) {
    return (
      <View class="items-center pt-24" style={{ gap: 12, paddingHorizontal: 24 }}>
        <Text style={{ fontSize: 40, color: LINE }}>◎</Text>
        <Text style={{ color: TEXT, fontSize: 14, textAlign: "center" }}>{props.msg}</Text>
        {props.hint ? (
          <Text style={{ color: MUTED, fontSize: 12, lineHeight: 18, textAlign: "center", maxWidth: 520 }}>{props.hint}</Text>
        ) : null}
        {props.action ? (
          <View class="flex-row items-center" style={{ gap: 16, paddingTop: 6 }}>
            <View
              role="button"
              onPress={() => { if (!indexing()) runIndex(); }}
              activeStyle={{ opacity: 0.8 }}
              style={{ backgroundColor: ACCENT, borderRadius: 4, paddingHorizontal: 16, paddingVertical: 7, cursor: "pointer" }}
            >
              <Text style={{ color: BG, fontSize: 13, fontWeight: "700" }}>{props.action}</Text>
            </View>
            {props.secondary ? (
              <Text
                role="button"
                style={{ color: ACCENT_TEXT, fontSize: 12, cursor: "pointer" }}
                hoverStyle={{ color: ACCENT }}
                onPress={() => screen.set("settings")}
              >
                {props.secondary}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  function ListHead(props: { left: string; right: string }) {
    return (
      <View class="flex-row justify-between pb-2" style={{ borderBottomWidth: 1, borderBottomColor: LINE, gap: 16 }}>
        <Text style={{ color: MUTED, fontSize: 11, letterSpacing: 1 }}>{props.left}</Text>
        <Text style={{ color: MUTED, fontSize: 11, numberOfLines: 1 }}>{props.right}</Text>
      </View>
    );
  }

  /** 文件管理器叫什么 (按平台) */
  function folderLabel(short: boolean): string {
    const os = platform.os;
    const which = os === "macos" ? "finder" : os === "windows" ? "explorer" : "files";
    return t(`open.${which}${short ? "_short" : ""}`);
  }

  /** 一行里的小按钮 (打开文件夹 / 终端 / GitHub): 按下不触发整行的 "复制路径" */
  function RowAction(props: { label: string; onPress: () => void; role?: "button" | "link" }) {
    return (
      <Text
        role={props.role ?? "button"}
        style={{ color: ACCENT_TEXT, fontSize: 11, cursor: "pointer" }}
        hoverStyle={{ color: ACCENT }}
        onPress={props.onPress}
      >
        {props.label}
      </Text>
    );
  }

  /**
   * 结果行 — 编辑部式: 左边一列分数 (搜索) 或多久没动 (浏览), 右边内容。点整行复制路径。
   * 列表会把行的格子回收给别的条目用, 所以内容都按当前的 props.idx 读, 不在函数体里取定值。
   */
  function Row(props: { idx: number; lead: string; sub: string; hot: boolean; last: boolean }) {
    const e = () => repos()[props.idx];
    const tg = () => tags()[props.idx];
    const gh = () => {
      const r = e().remote;
      return r.includes("github.com") ? r.replace("git@github.com:", "https://github.com/").replace(/\.git$/, "") : "";
    };
    return (
      <View
        class="flex-row py-4 gap-4"
        style={{ borderBottomWidth: props.last ? 0 : 1, borderBottomColor: LINE, cursor: "pointer" }}
        role="button"
        onPress={() => copyPath(e().path)}
      >
        <View class="items-center gap-1" style={{ width: 52 }}>
          <Text style={{ color: props.hot ? ACCENT : MUTED, fontSize: props.sub ? 15 : 12, fontWeight: "700", fontFamily: MONO, fontVariant: ["tabular-nums"] }}>
            {props.lead}
          </Text>
          {props.sub ? <View style={{ width: 26, height: 2, backgroundColor: props.hot ? ACCENT : LINE }} /> : null}
          {props.sub ? <Text style={{ color: MUTED, fontSize: 9, fontFamily: MONO }}>{props.sub}</Text> : null}
        </View>
        <View class="flex-1 gap-1">
          <View class="flex-row items-center gap-2 flex-wrap">
            <Text style={{ color: TEXT, fontSize: 15, fontWeight: "600" }}>{e().name}</Text>
            {copiedPath() === e().path ? (
              <Text style={{ color: TEAL, fontSize: 11 }}>{t("app.path_copied")}</Text>
            ) : null}
          </View>
          {e().desc ? <Text style={{ color: TEXT, fontSize: 13, opacity: 0.85, numberOfLines: 2 }}>{e().desc}</Text> : null}
          <Text style={{ color: MUTED, fontSize: 11, fontFamily: MONO, numberOfLines: 1 }}>{tildify(e().path)}</Text>
          <View class="flex-row gap-3 items-center flex-wrap pt-0.5">
            {tg().topics.filter((id) => id !== "other").map((id) => (
              <Text style={{ color: TEAL, fontSize: 11 }}>{t(`topic.${id}`)}</Text>
            ))}
            {e().langs.map((l) => (
              <Text style={{ color: ACCENT_TEXT, fontSize: 11, fontFamily: MONO }}>◆ {l}</Text>
            ))}
            {e().branch ? <Text style={{ color: MUTED, fontSize: 11, fontFamily: MONO }}>⑂ {e().branch}</Text> : null}
            {e().lastCommit ? (
              <Text style={{ color: MUTED, fontSize: 11, fontFamily: MONO }}>{e().lastCommit.slice(0, 46)}</Text>
            ) : null}
          </View>
          <View class="flex-row items-center flex-wrap" style={{ gap: 16, paddingTop: 2 }}>
            <RowAction label={folderLabel(false)} onPress={() => openFolder(e().path)} />
            <RowAction label={t("open.terminal")} onPress={() => openTerminal(e().path)} />
            {gh() ? <RowAction role="link" label="GitHub ↗" onPress={() => openUrl(gh())} /> : null}
          </View>
        </View>
      </View>
    );
  }

  function SettingsScreen() {
    const busy = () => state().phase === "scanning" || state().phase === "embedding";
    return (
      <View class="flex-1">
        <Header />
        <Scroll class="flex-1">
          <View class="px-6 py-5 gap-6" style={{ maxWidth: 760 }}>
            <Section title={t("settings.section_index")}>
              <Field label={t("settings.scan_dirs")} value={state().roots}
                onChange={(v: string) => {
                  state.set({ ...state(), roots: v });
                  Storage.setItem("roots", v).catch(() => {});
                }} />
              <View class="flex-row gap-3 items-center pt-1">
                <View
                  class="rounded px-4 py-2"
                  role="button"
                  accessibilityState={{ busy: busy() }}
                  style={{ backgroundColor: busy() ? LINE : ACCENT, cursor: busy() ? "default" : "pointer" }}
                  onPress={() => { if (!busy()) runIndex(); }}
                >
                  <Text style={{ color: busy() ? MUTED : BG, fontSize: 12, fontWeight: "700", fontFamily: MONO }}>
                    {state().phase === "scanning" ? "SCANNING…" : state().phase === "embedding" ? "EMBEDDING…" : "▶ SCAN + INDEX"}
                  </Text>
                </View>
                <Text style={{ color: MUTED, fontSize: 11, fontFamily: MONO, flex: 1, numberOfLines: 2 }}>
                  {state().progress || (state().scannedAt ? `${t("settings.last_scan")} ${state().scannedAt}` : "")}
                </Text>
              </View>
            </Section>

            <Section title={t("settings.section_model")}>
              <Segmented
                value={cfg().provider}
                options={(["local", "service", "api"] as Provider[]).map((p) => ({ value: p, label: t(`embed.provider_${p}`) }))}
                onChange={(p) => saveCfg({ ...cfg(), provider: p as Provider })}
              />
              <Text style={{ color: MUTED, fontSize: 12, lineHeight: 18 }}>{t(`embed.about_${cfg().provider}`)}</Text>
              {provider() === "local" ? <LocalPanel /> : provider() === "service" ? <RemotePanel which="service" /> : <RemotePanel which="api" />}
              <VectorState />
            </Section>

            {terminals.length > 1 ? (
              <Section title={t("settings.section_open")}>
                <Segmented
                  value={terminal() || terminals[0]}
                  options={terminals.map((name) => ({ value: name, label: name }))}
                  onChange={(v) => {
                    terminal.set(v);
                    Storage.setItem("terminal", v).catch(() => {});
                  }}
                />
                <Text style={{ color: MUTED, fontSize: 12 }}>{t("settings.terminal_hint")}</Text>
              </Section>
            ) : null}

            <Section title="About">
              <Text style={{ color: MUTED, fontSize: 12, lineHeight: 18 }}>
                {t("settings.about_line1") + String.fromCharCode(10) + t("settings.about_line2") + String.fromCharCode(10) + t("settings.about_line3")}
              </Text>
            </Section>
          </View>
        </Scroll>
      </View>
    );
  }

  /** 几个选项横排, 选中的高亮 (单选) */
  function Segmented(props: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
    return (
      <View class="flex-row" role="radiogroup" style={{ borderWidth: 1, borderColor: LINE, borderRadius: 5, alignSelf: "flex-start", padding: 2, gap: 2 }}>
        {props.options.map((o) => (
          <View
            role="radio"
            testID={`opt-${o.value}`}
            accessibilityState={{ checked: props.value === o.value }}
            onPress={() => props.onChange(o.value)}
            hoverStyle={{ backgroundColor: RAISED }}
            style={{
              paddingHorizontal: 12, paddingVertical: 5, borderRadius: 3, cursor: "pointer",
              backgroundColor: props.value === o.value ? RAISED : "transparent",
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: props.value === o.value ? "600" : "400", color: props.value === o.value ? ACCENT : MUTED }}>
              {o.label}
            </Text>
          </View>
        ))}
      </View>
    );
  }

  function SmallButton(props: { label: string; onPress: () => void; primary?: boolean; testID?: string }) {
    return (
      <View
        role="button"
        testID={props.testID}
        onPress={props.onPress}
        hoverStyle={{ opacity: 0.85 }}
        activeStyle={{ opacity: 0.7 }}
        style={{
          borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4, cursor: "pointer",
          backgroundColor: props.primary ? ACCENT : "transparent",
          borderWidth: props.primary ? 0 : 1, borderColor: LINE,
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: props.primary ? "700" : "400", color: props.primary ? BG : TEXT }}>{props.label}</Text>
      </View>
    );
  }

  function LocalPanel() {
    if (!localOk) {
      return <Text style={{ color: ACCENT_TEXT, fontSize: 12 }}>{t("embed.local_unavailable")}</Text>;
    }
    return (
      <View style={{ gap: 10 }}>
        <View style={{ borderWidth: 1, borderColor: LINE, borderRadius: 6 }}>
          {localModels.map((m, k) => <ModelRow m={m} last={k === localModels.length - 1} />)}
        </View>
        <View class="flex-row items-center flex-wrap" style={{ gap: 10 }}>
          <Text style={{ color: MUTED, fontSize: 12 }}>{t("embed.source")}</Text>
          <Segmented
            value={cfg().local.source}
            options={[
              { value: "auto", label: t("embed.source_auto") },
              { value: "hf", label: "huggingface.co" },
              { value: "mirror", label: "hf-mirror.com" },
            ]}
            onChange={(v) => saveCfg({ ...cfg(), local: { ...cfg().local, source: v as Source } })}
          />
        </View>
        <Text style={{ color: MUTED, fontSize: 11, lineHeight: 16 }}>{t("embed.local_note")}</Text>
      </View>
    );
  }

  function ModelRow(props: { m: LocalModel; last: boolean }) {
    const m = props.m;
    const selected = () => cfg().local.model === m.id;
    const have = () => installed().includes(m.id);
    const dl = () => (download()?.id === m.id ? download() : null);
    const use = () => saveCfg({ ...cfg(), local: { ...cfg().local, model: m.id } });
    return (
      <View
        class="flex-row items-center"
        style={{
          gap: 14, paddingHorizontal: 12, paddingVertical: 10,
          borderBottomWidth: props.last ? 0 : 1, borderBottomColor: LINE,
          backgroundColor: selected() ? RAISED : "transparent",
        }}
      >
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: selected() ? ACCENT : "transparent", borderWidth: 1, borderColor: selected() ? ACCENT : LINE }} />
        <View class="flex-1" style={{ gap: 2 }}>
          <View class="flex-row items-center flex-wrap" style={{ gap: 8 }}>
            <Text style={{ color: TEXT, fontSize: 13, fontWeight: "600", fontFamily: MONO }}>{m.name}</Text>
            {m.recommended ? <Text style={{ color: TEAL, fontSize: 11 }}>{t("embed.recommended")}</Text> : null}
          </View>
          <Text style={{ color: MUTED, fontSize: 12 }}>{t(`model.${m.id}`)}</Text>
          <Text style={{ color: MUTED, fontSize: 11, fontFamily: MONO }}>
            {`${Math.round(m.size)} MB · ${m.dim}d`}
          </Text>
          {dl()?.active ? (
            <Text style={{ color: ACCENT_TEXT, fontSize: 11, fontFamily: MONO }}>{downloadText(dl()!)}</Text>
          ) : dl()?.error ? (
            <Text style={{ color: "#e5807a", fontSize: 11 }}>{t("embed.download_failed", { error: dl()!.error.slice(0, 140) })}</Text>
          ) : null}
        </View>
        <View class="flex-row items-center" style={{ gap: 8 }}>
          {dl()?.active ? (
            <SmallButton label={t("embed.cancel")} onPress={() => Local.cancel()} />
          ) : have() ? (
            selected() ? (
              <Text style={{ color: TEAL, fontSize: 12 }}>{t("embed.in_use")}</Text>
            ) : (
              <SmallButton label={t("embed.use")} onPress={use} testID={`use-${m.id}`} />
            )
          ) : (
            <SmallButton
              label={download()?.active ? t("embed.download") : t("embed.download_use")}
              primary={selected()}
              testID={`download-${m.id}`}
              onPress={() => { if (!download()?.active) { use(); downloadModel(m.id); } }}
            />
          )}
          {have() && !dl()?.active ? (
            <Text role="button" style={{ color: MUTED, fontSize: 12, cursor: "pointer" }} hoverStyle={{ color: TEXT }} onPress={() => removeModel(m.id)}>
              {t("embed.remove")}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  function RemotePanel(props: { which: "service" | "api" }) {
    const r = () => cfg()[props.which];
    const set = (patch: Partial<EmbedSettings["api"]>) => saveCfg({ ...cfg(), [props.which]: { ...r(), ...patch } });
    return (
      <View style={{ gap: 10 }}>
        <Field label={t("settings.base_url")} value={r().baseUrl} onChange={(v) => set({ baseUrl: v })} />
        <Field label={t("settings.model_name")} value={r().model} onChange={(v) => set({ model: v })} />
        <Field
          label={props.which === "service" ? t("embed.key_optional") : "API Key"}
          value={r().apiKey}
          masked
          onChange={(v) => set({ apiKey: v })}
        />
        <Text style={{ color: MUTED, fontSize: 11, lineHeight: 16 }}>{t(`embed.hint_${props.which}`)}</Text>
        <View class="flex-row items-center" style={{ gap: 12 }}>
          <SmallButton label={t("embed.test")} onPress={runProbe} testID="embed-test" />
          {probeResult() ? (
            <Text style={{ color: probeResult()!.ok ? TEAL : "#e5807a", fontSize: 12, flex: 1 }}>{probeResult()!.text}</Text>
          ) : null}
        </View>
      </View>
    );
  }

  /** 当前向量和配置对不对得上 */
  function VectorState() {
    return (
      <View class="flex-row items-center flex-wrap" style={{ gap: 12 }}>
        <Text style={{ color: vectorsMatch() ? TEAL : ACCENT_TEXT, fontSize: 12, flex: 1, fontFamily: vectorsMatch() ? MONO : undefined }}>
          {vectorsMatch()
            ? t("embed.vectors_ok", { key: vec()!.key, n: vec()!.vectors.length })
            : vec()
              ? t("embed.vectors_mismatch", { key: vec()!.key })
              : t("settings.no_vectors")}
        </Text>
        {!vectorsMatch() && state().repos.length && !indexing() ? (
          <SmallButton label={t("empty.reindex")} onPress={() => { if (!indexing()) runIndex(); }} />
        ) : null}
      </View>
    );
  }

  /** 状态栏显示的状态: 说 "向量就绪" 之前确认向量和现在的配置对得上 */
  function shownStatus(): Status {
    const s = state().status;
    if (s.key === "app.status_ready" && !semanticReady()) {
      return { key: vec() ? "app.status_mismatch" : "app.status_indexed", n: s.n };
    }
    return s;
  }

  function StatusBar() {
    const dot = () => (state().phase === "ready" ? TEAL : state().phase === "idle" ? MUTED : ACCENT);
    return (
      <View
        class="flex-row items-center justify-between px-6 py-2"
        style={{ backgroundColor: PANEL, borderTopWidth: 1, borderTopColor: LINE }}
      >
        <View class="flex-row items-center gap-2">
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot() }} />
          <Text style={{ color: MUTED, fontSize: 11 }}>{statusText(shownStatus())}</Text>
          {/* 建索引时 (扫描 / 下载模型 / 生成向量) 在任何页面都看得到进度 */}
          {indexing() && state().progress ? (
            <Text style={{ color: ACCENT_TEXT, fontSize: 11, fontFamily: MONO, numberOfLines: 1 }}>{state().progress}</Text>
          ) : null}
        </View>
        <Text style={{ color: MUTED, fontSize: 10, fontFamily: MONO }}>
          {searchMode() === "hybrid" && semanticReady() ? "HYBRID" : "LEXICAL"}
        </Text>
      </View>
    );
  }

  function Section(props: { title: string; children: any }) {
    return (
      <View class="gap-3">
        <Text role="header" style={{ color: ACCENT, fontSize: 12, fontWeight: "700", letterSpacing: 1.5 }}>
          {props.title}
        </Text>
        <View class="gap-3">{props.children}</View>
      </View>
    );
  }

  function Field(props: { label: string; value: string; masked?: boolean; onChange: (v: string) => void }) {
    return (
      <View class="gap-1">
        <Text style={{ color: MUTED, fontSize: 11, letterSpacing: 0.5 }}>{props.label}</Text>
        <View class="rounded px-3 py-2" style={{ backgroundColor: BG, borderWidth: 1, borderColor: LINE }}>
          <Input
            value={props.value}
            masked={props.masked}
            onChange={(e: { value: string }) => props.onChange(e.value)}
            style={{ fontSize: 13, color: TEXT, fontFamily: MONO }}
          />
        </View>
      </View>
    );
  }
}


mount(App);
