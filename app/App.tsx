import { mount, signal, effect, locale, Text, View, Scroll, Clipboard, openUrl, Storage } from "nsh";
import { Input } from "nsh/base";
import { t, setLocale } from "nsh/i18n";
import nodeProcess from "process";
import {
  scanRepo, findRepos, expandTilde, tildify, buildLex, lexSearch,
  embedTexts, cosine, repoText, hybridSearch,
  saveIndex, loadIndex, saveVectors, loadVectors,
  type RepoEntry, type EmbedConfig, type HybridHit, type LexIndex,
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

/** 状态行存 key 而不是文案, 这样切语言时跟着变 */
interface Status { key: string; n?: number; detail?: string }

interface AppState {
  phase: Phase;
  status: Status;
  progress: string;
  repos: RepoEntry[];
  scannedAt: string;
  roots: string;
}

const DEFAULT_CFG: EmbedConfig = {
  baseUrl: "https://api.openai.com/v1",
  model: "text-embedding-3-small",
  apiKey: "",
};

/** 应用数据目录 (索引和向量落盘的位置); 没有的平台只在内存里保留 */
const DATA_DIR: string = nodeProcess.dataDir ?? "";

function statusText(s: Status): string {
  return [s.n !== undefined ? String(s.n) : "", t(s.key), s.detail ?? ""].filter(Boolean).join(" ");
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 120);
}

function App() {
  const screen = signal<Screen>("search");
  const cfg = signal<EmbedConfig>(DEFAULT_CFG);
  const state = signal<AppState>({
    phase: "idle",
    status: { key: "app.not_indexed" },
    progress: "",
    repos: [],
    scannedAt: "",
    roots: "~/work ~/src",
  });
  const query = signal("");
  const hits = signal<HybridHit[]>([]);
  const searching = signal(false);
  const copiedIdx = signal(-1);
  const searchMode = signal<"hybrid" | "lexical">("hybrid");
  /** 内存里的向量, 带生成它的模型名; 只有和当前配置的模型一致才用 */
  const vec = signal<{ model: string; vectors: Float32Array[] } | null>(null);
  let lex: { repos: RepoEntry[]; index: LexIndex } | null = null;
  let searchSeq = 0;

  /** 语义检索此刻可用: 有向量、模型对得上、数量和仓库对齐、配了 key */
  const semanticReady = () => {
    const v = vec();
    return !!v && v.model === cfg().model && v.vectors.length === state().repos.length && !!cfg().apiKey;
  };

  // ---- 启动: 读配置和落盘的索引 ----
  (async () => {
    try {
      const savedLocale = await Storage.getItem("locale");
      if (savedLocale) setLocale(savedLocale);
      const savedCfg = await Storage.getItem("cfg");
      if (savedCfg) cfg.set({ ...DEFAULT_CFG, ...JSON.parse(savedCfg) });
      const savedRoots = await Storage.getItem("roots");
      if (savedRoots) state.set({ ...state(), roots: savedRoots });
      // 早期版本把索引/向量塞在 Storage 里 (会撑爆 5MB 配额), 清掉
      Storage.removeItem("index").catch(() => {});
      Storage.removeItem("vectors").catch(() => {});
      if (!DATA_DIR) return;
      const idx = await loadIndex(DATA_DIR);
      if (!idx) return;
      const v = await loadVectors(DATA_DIR);
      const usable = !!v && v.vectors.length === idx.repos.length;
      if (usable) vec.set({ model: v!.model, vectors: v!.vectors });
      state.set({
        ...state(),
        repos: idx.repos,
        scannedAt: idx.scannedAt,
        phase: "ready",
        status: { key: usable ? "app.status_ready" : "app.status_indexed", n: idx.repos.length },
      });
    } catch (e) {
      console.error("load failed", e);
    }
  })();

  // ---- 搜索 (300ms 防抖) ----
  effect(() => {
    const q = query().trim();
    searchMode(); // 切模式时重搜
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

  async function runSearch(q: string, mySeq: number) {
    const repos = state().repos;
    if (!repos.length) {
      if (mySeq === searchSeq) { searching.set(false); hits.set([]); }
      return;
    }
    try {
      if (!lex || lex.repos !== repos) lex = { repos, index: buildLex(repos) };
      const lexHits = lexSearch(lex.index, q);

      let semScores: Map<number, number> | null = null;
      if (searchMode() === "hybrid" && semanticReady()) {
        const vectors = vec()!.vectors;
        const [qv] = await embedTexts(cfg(), [q], 1);
        const all = vectors.map((v, idx) => ({ idx, c: cosine(qv, v) }));
        all.sort((a, b) => b.c - a.c);
        semScores = new Map(all.slice(0, 20).map((x) => [x.idx, x.c]));
      }

      if (mySeq !== searchSeq) return;
      hits.set(hybridSearch(repos, lexHits, semScores, 20));
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
      for (const r of roots) {
        const rs = await findRepos(r);
        found.push(...rs);
        state.set({ ...state(), progress: `${tildify(r)} → ${rs.length}` });
      }
      const paths = [...new Set(found)].sort();
      const repos: RepoEntry[] = [];
      for (let i = 0; i < paths.length; i += 8) {
        repos.push(...(await Promise.all(paths.slice(i, i + 8).map(scanRepo))));
        state.set({ ...state(), progress: `${repos.length}/${paths.length}` });
      }
      const scannedAt = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
      vec.set(null); // 旧向量和新仓库列表不再对齐
      state.set({
        ...state(), repos, scannedAt, phase: "embedding", progress: "",
        status: { key: "app.status_scan", n: repos.length },
      });
      if (DATA_DIR) await saveIndex(DATA_DIR, { scannedAt, repos });

      if (!cfg().apiKey || !repos.length) {
        state.set({ ...state(), phase: "ready", status: { key: "app.status_no_key", n: repos.length } });
        return;
      }
      const model = cfg().model;
      const vectors = await embedTexts(cfg(), repos.map(repoText), 32, (done, total) => {
        state.set({ ...state(), progress: `${t("app.status_indexing")} ${done}/${total}` });
      });
      vec.set({ model, vectors });
      if (DATA_DIR) await saveVectors(DATA_DIR, { model, baseUrl: cfg().baseUrl, vectors });
      state.set({ ...state(), phase: "ready", progress: "", status: { key: "app.status_ready", n: repos.length } });
    } catch (e) {
      console.error("index failed", e);
      state.set({
        ...state(), phase: "ready", progress: "",
        status: { key: "app.status_index_failed", detail: errText(e) },
      });
    }
  }

  function saveCfg(next: EmbedConfig) {
    cfg.set(next);
    Storage.setItem("cfg", JSON.stringify(next)).catch(() => {});
  }

  function toggleLocale() {
    const next = locale().startsWith("zh") ? "en" : "zh-CN";
    setLocale(next);
    Storage.setItem("locale", next).catch(() => {});
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
            <View class="flex-row gap-2 items-center">
              <View
                class="rounded px-2 py-1"
                style={{ borderWidth: 1, borderColor: locale().startsWith("zh") ? ACCENT_DIM : LINE }}
                role="button"
                onPress={toggleLocale}
              >
                <Text style={{ fontSize: 10, color: MUTED, fontFamily: mono }}>{locale().startsWith("zh") ? "EN" : "中文"}</Text>
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
                placeholder={t("app.placeholder")}
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
                  {query() ? t("app.no_match") : state().repos.length ? t("app.type_to_search") : t("app.go_settings")}
                </Text>
                {state().repos.length > 0 && (
                  <View class="flex-row gap-4 pt-2">
                    {[t("suggestions.rec"), t("suggestions.emb"), t("suggestions.crawler")].map((s) => (
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
                      {tildify(e.path)}
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
                  {state().progress || (state().scannedAt ? `${t("settings.last_scan")} ${state().scannedAt}` : "")}
                </Text>
              </View>
            </Section>

            {/* 模型配置 */}
            <Section title={t("settings.section_model")}>
              <Field label={t("settings.base_url")} value={cfg().baseUrl}
                onChange={(v: string) => saveCfg({ ...cfg(), baseUrl: v })} />
              <Field label={t("settings.model_name")} value={cfg().model}
                onChange={(v: string) => saveCfg({ ...cfg(), model: v })} />
              <Field label="API Key" value={cfg().apiKey} masked
                onChange={(v: string) => saveCfg({ ...cfg(), apiKey: v })} />
              <Text style={{ color: MUTED, fontSize: 10, fontFamily: mono, lineHeight: 15 }}>
                {t("settings.model_hint") + String.fromCharCode(10) + t("settings.storage_hint")}
              </Text>
              {semanticReady() ? (
                <Text style={{ color: SCAN, fontSize: 10, fontFamily: mono }}>
                  ✓ {vec()!.model} · {vec()!.vectors.length} vectors
                </Text>
              ) : (
                <Text style={{ color: ACCENT_DIM, fontSize: 10, fontFamily: mono }}>
                  {t("settings.no_vectors")}
                </Text>
              )}
            </Section>

            {/* 关于 */}
            <Section title="About">
              <Text style={{ color: MUTED, fontSize: 11, fontFamily: mono, lineHeight: 17 }}>
                {t("settings.about_line1") + String.fromCharCode(10) + t("settings.about_line2") + String.fromCharCode(10) + t("settings.about_line3")}
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
        class="flex-row items-center justify-between px-6 py-2"
        style={{ backgroundColor: PANEL, borderTopWidth: 1, borderTopColor: LINE }}
      >
        <View class="flex-row items-center gap-2">
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot }} />
          <Text style={{ color: MUTED, fontSize: 10, fontFamily: mono }}>{statusText(state().status)}</Text>
        </View>
        <Text style={{ color: MUTED, fontSize: 10, fontFamily: mono }}>
          {searchMode() === "hybrid" && semanticReady() ? "HYBRID" : "LEXICAL"}
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

mount(App);
