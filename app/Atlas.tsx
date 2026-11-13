import { Canvas, Scroll, Text, View, computed, platform, signal, windowSize } from "nsh";
import { t } from "nsh/i18n";
import { tildify, type RepoEntry } from "./lib";
import {
  FACETS, NONE, TOPIC_IDS, activeFilters, emptyFilters, facetRows, labelKey, passes, toggleFilter,
  type FacetId, type FacetRow, type Filters, type RepoTags,
} from "./tags";
import {
  ACCENT, ACCENT_DIM, ACCENT_TEXT, BG, LINE, LINE_STRONG, MONO, MUTED, PANEL, RAISED, TEAL, TEXT,
} from "./theme";

// ============================================================
// 总览页: 左边按标签统计 (点一下就筛选), 右边一张雷达图 —
// 每个仓库一个光点, 扇区 = 主题, 离圆心的距离 = 多久没动过。
// ============================================================

export interface AtlasCtx {
  repos: () => RepoEntry[];
  tags: () => RepoTags[];
  /** 筛选后剩下的仓库下标 (App 里算一次, 各处共用) */
  matches: () => number[];
  openFolder: (path: string) => void;
  openTerminal: (path: string) => void;
  filters: () => Filters;
  setFilters: (f: Filters) => void;
  /** 索引是旧版本建的: 缺简介 / 依赖 / 提交数, 标签不完整 */
  stale: () => boolean;
  openSearch: () => void;
  openSettings: () => void;
  copyPath: (path: string) => void;
}

export function valueLabel(facet: FacetId, value: string): string {
  const key = labelKey(facet, value);
  return key ? t(key) : value;
}

export function ageLabel(days: number | null): string {
  if (days === null) return t("age.unknown");
  if (days < 1) return t("age.today");
  if (days < 31) return t("age.d", { n: Math.floor(days) });
  if (days < 365) return t("age.mo", { n: Math.max(1, Math.round(days / 30.4)) });
  return t("age.y", { n: Math.floor(days / 365) });
}

/** 筛选后剩下的仓库下标, 最近动过的排前面 */
export function matching(tags: RepoTags[], f: Filters): number[] {
  const out: number[] = [];
  tags.forEach((tg, i) => { if (passes(tg, f)) out.push(i); });
  const age = (i: number) => tags[i].ageDays ?? Infinity;
  return out.sort((a, b) => age(a) - age(b));
}

export function Atlas(props: { ctx: AtlasCtx }) {
  const c = props.ctx;
  // computed: 窗口每拖一个像素、进度每更新一次都不会让整页重建, 只有跨过阈值才会
  const wide = computed(() => windowSize().width >= 900);
  const empty = computed(() => c.repos().length === 0);

  return (
    <View class="flex-1">
      {empty() ? (
        <View class="flex-1 items-center justify-center" style={{ gap: 14, padding: 32 }}>
          <Text style={{ color: MUTED, fontSize: 14, textAlign: "center", maxWidth: 420, lineHeight: 21 }}>
            {t("atlas.empty")}
          </Text>
          <View
            role="button"
            onPress={c.openSettings}
            style={{ backgroundColor: ACCENT, borderRadius: 4, paddingHorizontal: 16, paddingVertical: 8, cursor: "pointer" }}
            activeStyle={{ opacity: 0.8 }}
          >
            <Text style={{ color: BG, fontSize: 13, fontWeight: "700" }}>{t("atlas.open_settings")}</Text>
          </View>
        </View>
      ) : wide() ? (
        <View class="flex-1">
          <Summary ctx={c} />
          <View class="flex-1 flex-row">
            <Scroll style={{ width: 316, backgroundColor: PANEL, borderRightWidth: 1, borderRightColor: LINE }}>
              <Facets ctx={c} />
            </Scroll>
            <Scroll class="flex-1">
              <View style={{ paddingHorizontal: 28, paddingTop: 12, paddingBottom: 28, gap: 22 }}>
                <Scope ctx={c} height={470} />
                <Recent ctx={c} />
              </View>
            </Scroll>
          </View>
        </View>
      ) : (
        <Scroll class="flex-1">
          <Summary ctx={c} />
          <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 20 }}>
            <Scope ctx={c} height={360} />
            <Recent ctx={c} />
          </View>
          <View style={{ backgroundColor: PANEL, borderTopWidth: 1, borderTopColor: LINE }}>
            <Facets ctx={c} />
          </View>
        </Scroll>
      )}
    </View>
  );
}

// ---------- 顶部: 数量 + 已选条件 ----------

function Summary(props: { ctx: AtlasCtx }) {
  const c = props.ctx;
  const active = computed(() => activeFilters(c.filters()));
  const hasActive = computed(() => active().length > 0);
  const totals = computed(() => {
    const tags = c.tags();
    return {
      langs: new Set(tags.flatMap((x) => x.langs).filter((v) => v !== NONE)).size,
      owners: new Set(tags.map((x) => x.owner).filter((v) => v !== NONE)).size,
      authored: tags.filter((x) => x.work === "authored").length,
    };
  });
  const headline = () => {
    const n = c.repos().length;
    if (!hasActive()) return t("atlas.count_all", { n });
    return t("atlas.count_filtered", { m: c.matches().length, n });
  };

  return (
    <View
      style={{
        paddingHorizontal: 24, paddingVertical: 12, gap: 8,
        borderBottomWidth: 1, borderBottomColor: LINE, backgroundColor: BG,
      }}
    >
      <View class="flex-row items-center justify-between" style={{ gap: 16 }}>
        <Text style={{ color: TEXT, fontSize: 17, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{headline()}</Text>
        {hasActive() ? (
          <View
            role="button"
            onPress={() => c.setFilters(emptyFilters())}
            hoverStyle={{ backgroundColor: RAISED }}
            style={{ borderWidth: 1, borderColor: LINE_STRONG, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4, cursor: "pointer" }}
          >
            <Text style={{ color: TEXT, fontSize: 12 }}>{t("atlas.clear")}</Text>
          </View>
        ) : null}
      </View>
      {!hasActive() ? (
        <Text style={{ color: MUTED, fontSize: 12, lineHeight: 18 }}>
          {t("atlas.totals", totals()) + (c.stale() ? "  ·  " + t("atlas.stale") : "")}
        </Text>
      ) : (
        <View class="flex-row flex-wrap" style={{ gap: 6 }}>
          {active().map((a) => (
            <Chip
              label={t(`facet.${a.facet}`) + ": " + valueLabel(a.facet, a.value)}
              onRemove={() => c.setFilters(toggleFilter(c.filters(), a.facet, a.value))}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** 已选条件: 点一下移除 */
export function Chip(props: { label: string; onRemove: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={t("atlas.remove_filter", { label: props.label })}
      onPress={props.onRemove}
      hoverStyle={{ borderColor: ACCENT }}
      class="flex-row items-center"
      style={{
        gap: 8, borderWidth: 1, borderColor: ACCENT_DIM, borderRadius: 4,
        paddingLeft: 9, paddingRight: 7, paddingVertical: 3, cursor: "pointer",
      }}
    >
      <Text style={{ color: ACCENT, fontSize: 12 }}>{props.label}</Text>
      <Cross />
    </View>
  );
}

function Cross() {
  return (
    <Canvas
      style={{ width: 9, height: 9 }}
      draw={(g) => {
        g.strokeStyle = ACCENT_TEXT;
        g.lineWidth = 1.4;
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(1, 1); g.lineTo(8, 8);
        g.moveTo(8, 1); g.lineTo(1, 8);
        g.stroke();
      }}
    />
  );
}

// ---------- 左栏: 每类标签一组统计条 ----------

function Facets(props: { ctx: AtlasCtx }) {
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 28, gap: 26 }}>
      {FACETS.map((facet) => <FacetPanel ctx={props.ctx} facet={facet} />)}
    </View>
  );
}

const FACET_LIMIT: Record<FacetId, number> = { topic: 11, lang: 8, activity: 6, work: 2, host: 5, owner: 7 };

function FacetPanel(props: { ctx: AtlasCtx; facet: FacetId }) {
  const c = props.ctx;
  const facet = props.facet;
  const expanded = signal(false);
  const rows = computed(() => facetRows(c.tags(), c.filters(), facet));
  const selected = computed(() => c.filters()[facet]);
  const max = computed(() => Math.max(1, ...rows().map((r) => r.count)));
  const limit = FACET_LIMIT[facet];
  // 收起时只留前几项, 但已选中的一定留着
  const shown = computed(() => {
    const all = rows();
    const sel = selected();
    return expanded() ? all : all.filter((r, i) => i < limit || sel.includes(r.value));
  });

  const FacetRowView = (p: { row: () => FacetRow }) => {
    const value = p.row().value;
    const label = valueLabel(facet, value);
    const on = () => selected().includes(value);
    const count = () => p.row().count;
    return (
      <View
        role="checkbox"
        accessibilityLabel={`${label}, ${count()}`}
        accessibilityState={{ checked: on() }}
        onPress={() => c.setFilters(toggleFilter(c.filters(), facet, value))}
        hoverStyle={{ backgroundColor: RAISED }}
        class="flex-row items-center"
        style={{ gap: 10, paddingVertical: 5, paddingHorizontal: 8, marginHorizontal: -8, borderRadius: 4, cursor: "pointer" }}
      >
        <View
          style={{
            width: 10, height: 10, borderRadius: 2, borderWidth: 1,
            borderColor: on() ? ACCENT : LINE_STRONG, backgroundColor: on() ? ACCENT : "transparent",
          }}
        />
        <Text style={{ flex: 1, fontSize: 13, color: on() ? ACCENT : count() > 0 ? TEXT : MUTED, numberOfLines: 1 }}>
          {label}
        </Text>
        <View style={{ width: 62, height: 4, borderRadius: 2, backgroundColor: LINE }}>
          <View
            style={{
              width: Math.round((62 * count()) / max()), height: 4, borderRadius: 2,
              backgroundColor: on() ? ACCENT : LINE_STRONG,
            }}
          />
        </View>
        <Text
          style={{
            width: 34, textAlign: "right", fontSize: 12, fontFamily: MONO, fontVariant: ["tabular-nums"],
            color: on() ? ACCENT : count() > 0 ? TEXT : MUTED,
          }}
        >
          {count()}
        </Text>
      </View>
    );
  };

  return (
    <View style={{ gap: 4 }}>
      <View class="flex-row items-center justify-between" style={{ paddingBottom: 4 }}>
        <Text role="header" style={{ color: MUTED, fontSize: 11, fontWeight: "600", letterSpacing: 1.2 }}>
          {t(`facet.${facet}`).toUpperCase()}
        </Text>
        {selected().length > 0 ? (
          <Text
            role="button"
            style={{ color: ACCENT_TEXT, fontSize: 11, cursor: "pointer" }}
            onPress={() => c.setFilters({ ...c.filters(), [facet]: [] })}
          >
            {t("atlas.reset")}
          </Text>
        ) : null}
      </View>
      <Each of={shown()} key={(r) => r.value}>
        {(r) => <FacetRowView row={r} />}
      </Each>
      {rows().length > FACET_LIMIT[facet] ? (
        <Text
          role="button"
          style={{ color: MUTED, fontSize: 12, paddingTop: 4, cursor: "pointer" }}
          hoverStyle={{ color: TEXT }}
          onPress={() => expanded.set(!expanded())}
        >
          {expanded() ? t("atlas.less") : t("atlas.more", { n: rows().length - FACET_LIMIT[facet] })}
        </Text>
      ) : null}
    </View>
  );
}

// ---------- 雷达图 ----------

/** 路径 → [0, 1): 让每个仓库的光点位置固定, 重扫后不乱跳 */
function hash01(s: string, seed: number): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const MAX_AGE_DAYS = 3650;
/** 时间 → 半径比例 (对数): 近一个月占内圈 1/5, 十年以上贴边 */
const ageFraction = (days: number | null): number =>
  days === null ? 1 : Math.min(1, Math.log(1 + days / 15) / Math.log(1 + MAX_AGE_DAYS / 15));

const RINGS: { days: number; key: string }[] = [
  { days: 30, key: "atlas.ring_m1" },
  { days: 182, key: "atlas.ring_m6" },
  { days: 365, key: "atlas.ring_y1" },
  { days: 1095, key: "atlas.ring_y3" },
];
const INNER = 0.1; // 圆心留一小圈空白, 光点不挤成一团
const SPAN = (Math.PI * 2) / TOPIC_IDS.length;
const sectorStart = (k: number) => -Math.PI / 2 + k * SPAN;

function Scope(props: { ctx: AtlasCtx; height: number }) {
  const c = props.ctx;
  const hover = signal(-1);
  let geo = { cx: 0, cy: 0, R: 0 };
  let dots: { x: number; y: number; idx: number; on: boolean }[] = [];
  let cache: { tags: RepoTags[]; polar: { a: number; f: number }[] } | null = null;

  /** 每个仓库的极坐标, 只跟标签有关, 算一次就够 */
  const polar = () => {
    const tags = c.tags();
    if (cache?.tags !== tags) {
      const repos = c.repos();
      cache = {
        tags,
        polar: tags.map((tg, i) => {
          const k = Math.max(0, TOPIC_IDS.indexOf(tg.topic));
          const path = repos[i]?.path ?? String(i);
          const jitter = (hash01(path, 7) - 0.5) * 0.04;
          return {
            a: sectorStart(k) + SPAN * (0.1 + 0.8 * hash01(path, 1)),
            f: Math.min(1, Math.max(0.02, ageFraction(tg.ageDays) + jitter)),
          };
        }),
      };
    }
    return cache.polar;
  };

  const sectorAt = (x: number, y: number): number => {
    const a = Math.atan2(y - geo.cy, x - geo.cx);
    const rel = (a + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    return Math.min(TOPIC_IDS.length - 1, Math.floor(rel / SPAN));
  };

  const nearest = (x: number, y: number): number => {
    let best = -1;
    let bestD = 11 * 11;
    for (const d of dots) {
      if (!d.on) continue;
      const dd = (d.x - x) ** 2 + (d.y - y) ** 2;
      if (dd < bestD) { bestD = dd; best = d.idx; }
    }
    return best;
  };

  return (
    <View style={{ gap: 6 }}>
      <Canvas
        role="image"
        accessibilityLabel={t("atlas.scope_label")}
        style={{ height: props.height, cursor: "pointer" }}
        onPress={(e) => {
          const { x, y } = e.position;
          if (Math.hypot(x - geo.cx, y - geo.cy) > geo.R + 90) return;
          c.setFilters(toggleFilter(c.filters(), "topic", TOPIC_IDS[sectorAt(x, y)]));
        }}
        onMouseMove={(e) => {
          const idx = nearest(e.position.x, e.position.y);
          if (idx !== hover()) hover.set(idx);
        }}
        onMouseLeave={() => hover.set(-1)}
        draw={(g, { width, height }) => {
          const tags = c.tags();
          const f = c.filters();
          const pts = polar();
          const hovered = hover();
          const labelRoom = Math.min(104, width * 0.24);
          const R = Math.max(40, Math.min(width / 2 - labelRoom, height / 2 - 30));
          const cx = width / 2;
          const cy = height / 2;
          geo = { cx, cy, R };
          const radius = (frac: number) => R * (INNER + (1 - INNER) * frac);

          // 选中的主题: 整个扇区微微点亮
          for (const id of f.topic) {
            const k = TOPIC_IDS.indexOf(id);
            if (k < 0) continue;
            g.beginPath();
            g.moveTo(cx, cy);
            g.arc(cx, cy, R, sectorStart(k), sectorStart(k) + SPAN);
            g.closePath();
            g.fillStyle = "rgba(232, 163, 61, 0.09)";
            g.fill();
          }

          // 时间环 + 外圈
          g.lineWidth = 1;
          for (const ring of RINGS) {
            g.beginPath();
            g.arc(cx, cy, radius(ageFraction(ring.days)), 0, Math.PI * 2);
            g.strokeStyle = LINE;
            g.stroke();
          }
          g.beginPath();
          g.arc(cx, cy, R, 0, Math.PI * 2);
          g.strokeStyle = LINE_STRONG;
          g.stroke();

          // 扇区分隔线 + 主题名和数量
          const per = new Array(TOPIC_IDS.length).fill(0);
          tags.forEach((tg) => { if (passes(tg, f)) per[Math.max(0, TOPIC_IDS.indexOf(tg.topic))]++; });
          TOPIC_IDS.forEach((id, k) => {
            const a = sectorStart(k);
            g.beginPath();
            g.moveTo(cx + Math.cos(a) * radius(0), cy + Math.sin(a) * radius(0));
            g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
            g.strokeStyle = LINE;
            g.stroke();

            const mid = a + SPAN / 2;
            const lx = cx + Math.cos(mid) * (R + 12);
            const ly = cy + Math.sin(mid) * (R + 12);
            const side = Math.cos(mid);
            g.textAlign = side > 0.25 ? "left" : side < -0.25 ? "right" : "center";
            g.textBaseline = Math.sin(mid) > 0.6 ? "top" : Math.sin(mid) < -0.6 ? "bottom" : "middle";
            g.font = "600 12px system-ui";
            g.fillStyle = f.topic.includes(id) ? ACCENT : per[k] > 0 ? TEXT : MUTED;
            g.fillText(`${t(`topic_short.${id}`)}  ${per[k]}`, lx, ly);
          });

          // 时间刻度: 写在正上方那条分隔线旁边 (画在光点之后, 带底色, 不被光点盖住)
          const ringLabels = () => {
            g.font = `10px ${MONO}`;
            g.textAlign = "left";
            g.textBaseline = "middle";
            for (const ring of RINGS) {
              const label = t(ring.key);
              const y = cy - radius(ageFraction(ring.days));
              const w = g.measureText(label).width;
              g.fillStyle = BG;
              g.fillRect(cx + 3, y - 7, w + 6, 14);
              g.fillStyle = MUTED;
              g.fillText(label, cx + 6, y);
            }
          };

          // 光点: 先画被筛掉的 (暗), 再画只是 clone 的 (青绿), 最后画自己提交过的 (琥珀)
          dots = pts.map((p, idx) => ({
            x: cx + Math.cos(p.a) * radius(p.f),
            y: cy + Math.sin(p.a) * radius(p.f),
            idx,
            on: passes(tags[idx], f),
          }));
          const paint = (keep: (d: { idx: number; on: boolean }) => boolean, color: string, r: number) => {
            g.fillStyle = color;
            g.beginPath();
            for (const d of dots) {
              if (!keep(d)) continue;
              g.moveTo(d.x + r, d.y);
              g.arc(d.x, d.y, r, 0, Math.PI * 2);
            }
            g.fill();
          };
          paint((d) => !d.on, "#30363c", 2);
          paint((d) => d.on && tags[d.idx].work !== "authored", TEAL, 2.8);
          paint((d) => d.on && tags[d.idx].work === "authored", ACCENT, 3.6);
          ringLabels();

          // 圆心: 现在
          g.beginPath();
          g.arc(cx, cy, 4, 0, Math.PI * 2);
          g.fillStyle = BG;
          g.fill();
          g.strokeStyle = ACCENT;
          g.lineWidth = 1.5;
          g.stroke();

          const h = dots.find((d) => d.idx === hovered);
          if (h) {
            g.beginPath();
            g.arc(h.x, h.y, 8, 0, Math.PI * 2);
            g.strokeStyle = TEXT;
            g.lineWidth = 1.5;
            g.stroke();
          }
        }}
      />
      <ScopeCaption ctx={c} hover={hover} />
    </View>
  );
}

function ScopeCaption(props: { ctx: AtlasCtx; hover: () => number }) {
  const c = props.ctx;
  const hovered = () => {
    const i = props.hover();
    const e = i >= 0 ? c.repos()[i] : undefined;
    const tg = i >= 0 ? c.tags()[i] : undefined;
    return e && tg ? { e, tg } : null;
  };
  const swatch = (color: string, size: number, label: string) => (
    <View class="flex-row items-center" style={{ gap: 6 }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
      <Text style={{ color: MUTED, fontSize: 12 }}>{label}</Text>
    </View>
  );
  return (
    <View style={{ minHeight: 58, gap: 6, alignItems: "center" }}>
      {hovered() ? (
        <View style={{ gap: 3, alignItems: "center" }}>
          <Text style={{ color: TEXT, fontSize: 13, fontWeight: "600", textAlign: "center" }}>
            {hovered()!.e.name}
            <Text style={{ color: MUTED, fontWeight: "400" }}>
              {"   " + hovered()!.tg.topics.map((id) => t(`topic.${id}`)).join(" · ") + "   " + ageLabel(hovered()!.tg.ageDays)}
            </Text>
          </Text>
          <Text style={{ color: MUTED, fontSize: 11, fontFamily: MONO, numberOfLines: 1 }}>
            {tildify(hovered()!.e.path)}
          </Text>
        </View>
      ) : (
        <View style={{ gap: 8, alignItems: "center" }}>
          <View class="flex-row flex-wrap justify-center" style={{ gap: 18 }}>
            {swatch(ACCENT, 8, t("work.authored"))}
            {swatch(TEAL, 6, t("work.clone"))}
            {swatch("#3a4148", 5, t("atlas.legend_out"))}
          </View>
          <Text style={{ color: MUTED, fontSize: 12, lineHeight: 18, textAlign: "center", maxWidth: 560 }}>
            {t("atlas.scope_hint")}
          </Text>
        </View>
      )}
    </View>
  );
}

// ---------- 筛选结果里最近动过的几个 ----------

const RECENT_LIMIT = 10;

function Recent(props: { ctx: AtlasCtx }) {
  const c = props.ctx;
  const copied = signal("");
  const ids = c.matches;
  const shown = computed(() => ids().slice(0, RECENT_LIMIT));
  const none = computed(() => ids().length === 0);
  const os = platform.os;
  const folderShort = t(`open.${os === "macos" ? "finder" : os === "windows" ? "explorer" : "files"}_short`);

  return (
    <View style={{ gap: 2 }}>
      <View class="flex-row items-center justify-between" style={{ paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: LINE }}>
        <Text role="header" style={{ color: MUTED, fontSize: 11, fontWeight: "600", letterSpacing: 1.2 }}>
          {t("atlas.recent").toUpperCase()}
        </Text>
        {!none() ? (
          <Text role="button" style={{ color: ACCENT_TEXT, fontSize: 12, cursor: "pointer" }} hoverStyle={{ color: ACCENT }} onPress={c.openSearch}>
            {t("atlas.view_all", { n: ids().length })}
          </Text>
        ) : null}
      </View>
      {none() ? (
        <Text style={{ color: MUTED, fontSize: 13, paddingVertical: 16 }}>{t("atlas.no_match")}</Text>
      ) : null}
      <Each of={shown()}>
        {(i) => {
        const e = c.repos()[i()];
        const tg = c.tags()[i()];
        return (
          <View
            role="button"
            accessibilityLabel={`${e.name}, ${t("atlas.copy_path")}`}
            onPress={() => {
              c.copyPath(e.path);
              copied.set(e.path);
              setTimeout(() => { if (copied() === e.path) copied.set(""); }, 1500);
            }}
            hoverStyle={{ backgroundColor: RAISED }}
            class="flex-row items-center"
            style={{ gap: 14, paddingVertical: 8, paddingHorizontal: 8, marginHorizontal: -8, borderRadius: 4, cursor: "pointer" }}
          >
            <Text style={{ color: TEXT, fontSize: 13, fontWeight: "600", maxWidth: 220, numberOfLines: 1 }}>{e.name}</Text>
            <Text style={{ flex: 1, color: MUTED, fontSize: 12, numberOfLines: 1 }}>
              {e.desc || tildify(e.path)}
            </Text>
            <Text style={{ color: ACCENT_TEXT, fontSize: 11, fontFamily: MONO, numberOfLines: 1 }}>
              {tg.langs[0] === NONE ? "" : tg.langs[0]}
            </Text>
            <Text
              role="button"
              accessibilityLabel={`${folderShort}: ${e.name}`}
              style={{ color: MUTED, fontSize: 11, cursor: "pointer" }}
              hoverStyle={{ color: ACCENT }}
              onPress={() => c.openFolder(e.path)}
            >
              {folderShort}
            </Text>
            <Text
              role="button"
              accessibilityLabel={`${t("open.terminal_short")}: ${e.name}`}
              style={{ color: MUTED, fontSize: 11, cursor: "pointer" }}
              hoverStyle={{ color: ACCENT }}
              onPress={() => c.openTerminal(e.path)}
            >
              {t("open.terminal_short")}
            </Text>
            <Text
              style={{
                width: 92, textAlign: "right", fontSize: 11, fontFamily: MONO, fontVariant: ["tabular-nums"],
                color: copied() === e.path ? TEAL : MUTED,
              }}
            >
              {copied() === e.path ? t("atlas.copied") : ageLabel(tg.ageDays)}
            </Text>
          </View>
        );
        }}
      </Each>
    </View>
  );
}

