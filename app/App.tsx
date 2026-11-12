import { mount, signal, effect, Text, View, Scroll, Clipboard, openUrl } from "nsh";
import { Input } from "nsh/base";

// RepoFind — 本地 git 仓库语义搜索
// 数据来自本地 repofind server: python3 server.py (默认 127.0.0.1:8765)

interface RepoResult {
  name: string;
  path: string;
  langs: string[];
  branch: string;
  last_commit: string;
  remote: string;
  score: number;
}

const SERVER = "http://127.0.0.1:8765";

function App() {
  const query = signal("");
  const results = signal<RepoResult[]>([]);
  const status = signal<"idle" | "loading" | "done" | "error">("idle");
  const semantic = signal(false);
  const copied = signal("");
  let seq = 0; // 防止过期响应覆盖新结果

  // 输入防抖 300ms 自动搜索
  effect(() => {
    const q = query().trim();
    if (!q) {
      results.set([]);
      status.set("idle");
      return;
    }
    const mySeq = ++seq;
    status.set("loading");
    const t = setTimeout(() => {
      fetch(`${SERVER}/search?q=${encodeURIComponent(q)}&n=20`)
        .then((r) => r.json())
        .then((data) => {
          if (mySeq !== seq) return;
          results.set(data.results ?? []);
          semantic.set(!!data.semantic);
          status.set("done");
        })
        .catch(() => {
          if (mySeq !== seq) return;
          status.set("error");
        });
    }, 300);
    return () => clearTimeout(t);
  });

  const copyPath = (r: RepoResult) => {
    Clipboard.writeText(r.path);
    copied.set(r.name);
    setTimeout(() => copied.set(""), 1500);
  };

  return (
    <View class="flex-1 bg-background">
      {/* 顶部: 标题 + 搜索框 */}
      <View class="pt-[env(safe-area-inset-top)] px-5 pt-4 pb-3 gap-3 border-b border-border">
        <View class="flex-row items-center justify-between">
          <Text class="text-xl font-bold text-foreground">RepoFind</Text>
          <Text class="text-xs text-muted-foreground">323 个本地仓库 · bge-m3 语义</Text>
        </View>
        <View class="flex-row items-center rounded-(--radius) border border-border bg-muted px-3 py-2 gap-2">
          <Text class="text-muted-foreground">🔍</Text>
          <View class="flex-1">
            <Input
              value={query()}
              onChange={(e: { value: string }) => query.set(e.value)}
              placeholder="描述你想找的仓库, 如: 推荐系统 / 浏览器自动化"
              returnKeyType="search"
              submitBehavior="submit"
              class="text-base text-foreground"
            />
          </View>
          {status() === "loading" && <Text class="text-xs text-muted-foreground">搜索中…</Text>}
        </View>
      </View>

      {/* 结果区 */}
      <Scroll class="flex-1">
        <View class="px-5 py-4 gap-3">
          {status() === "idle" && (
            <View class="items-center gap-2 pt-20">
              <Text class="text-4xl">📦</Text>
              <Text class="text-base text-muted-foreground">输入自然语言描述, 搜你的本地仓库</Text>
              <Text class="text-xs text-muted-foreground">试试: "向量检索" "rust gui" "爬虫"</Text>
            </View>
          )}

          {status() === "error" && (
            <View class="items-center gap-2 pt-20">
              <Text class="text-4xl">⚠️</Text>
              <Text class="text-base text-destructive">连不上搜索服务</Text>
              <Text class="text-xs text-muted-foreground">请先运行: python3 server.py</Text>
            </View>
          )}

          {status() === "done" && results().length === 0 && (
            <Text class="text-center text-muted-foreground pt-20">没有匹配的仓库, 换个说法试试</Text>
          )}

          {results().map((r) => (
            <View
              class="rounded-xl border border-border bg-card p-4 gap-1.5"
              onPress={() => copyPath(r)}
              role="button"
            >
              <View class="flex-row items-center justify-between">
                <Text class="text-base font-semibold text-foreground">{r.name}</Text>
                <Text class="text-xs text-muted-foreground">
                  {copied() === r.name ? "✓ 已复制路径" : `${Math.round(r.score * 100)}%`}
                </Text>
              </View>
              <Text class="text-xs text-muted-foreground">{r.path.replace("~", "")}</Text>
              <View class="flex-row gap-2 flex-wrap items-center">
                {r.langs.map((l) => (
                  <View class="rounded-full bg-primary/10 px-2 py-0.5">
                    <Text class="text-xs text-primary">{l}</Text>
                  </View>
                ))}
                {r.branch && <Text class="text-xs text-muted-foreground">⑂ {r.branch}</Text>}
                {r.last_commit && (
                  <Text class="text-xs text-muted-foreground">{r.last_commit.slice(0, 42)}</Text>
                )}
              </View>
              {r.remote.includes("github.com") && (
                <Text
                  class="text-xs text-primary"
                  onPress={() => {
                    const url = r.remote
                      .replace("git@github.com:", "https://github.com/")
                      .replace(".git", "");
                    openUrl(url);
                  }}
                >
                  在 GitHub 打开 ↗
                </Text>
              )}
            </View>
          ))}
        </View>
      </Scroll>
    </View>
  );
}

mount(App);
