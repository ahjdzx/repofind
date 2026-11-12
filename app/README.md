# RepoFind App

nsh (Native Shell) 原生应用 — https://nsh.dev

## 运行

```bash
nsh run . --target macos   # 原生窗口
nsh run . --target web     # 浏览器
```

## 类型检查

```bash
nsh check
```

## 结构

- `lib.ts` — 核心逻辑：仓库扫描（读 `.git` 内部文件，不调 git 进程）、中英分词、TF-IDF、OpenAI 兼容 embedding 客户端、混合排序
- `App.tsx` — UI：搜索页（300ms 防抖、SEM+/LEX 模式切换、点按复制路径、GitHub 直达）+ Settings（扫描目录 / Base URL / 模型名 / API Key，存本机 Storage）+ 底部状态栏

无 server、无 Python——所有功能在应用内完成。
