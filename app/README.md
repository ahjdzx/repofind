# RepoFind App

nsh (Native Shell) 原生应用 — https://nsh.dev

## 运行

```bash
# 先启动搜索服务 (仓库根目录)
python3 server.py

# macOS 原生窗口
nsh run . --target macos

# 浏览器
nsh run . --target web
```

## 类型检查

```bash
nsh check
```

## 结构

- `App.tsx` — 主界面：搜索框（300ms 防抖）、结果卡片、复制路径、GitHub 直达
- `nsh.json` — 应用元数据（id/version）
