# RepoFind App

[nsh](https://nsh.dev) (Native Shell) 应用。

```bash
nsh run --target macos   # 原生窗口
nsh check                # 类型检查
nsh test                 # 无头回归测试
```

- `lib.ts` — 仓库扫描（读 `.git` 内部文件，不调 git 进程）、中英分词、TF-IDF、OpenAI 兼容 embedding 客户端、混合排序、索引/向量落盘
- `App.tsx` — 搜索页、Settings、状态栏
- `App.test.tsx` — 用假文件系统和假 embedding 接口覆盖 扫描 → 索引 → 检索 → 重启恢复
- `locales/` — `zh-CN.yml`、`en.yml`
- `nsh.json` — 应用元数据和 capabilities（文件读写范围、网络、剪贴板）

索引 (`index.json`) 和向量 (`vectors-N.bin` + `vectors.json`) 存在应用数据目录；配置（扫描目录、模型、API Key、语言）存在 Storage。
