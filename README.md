# RepoFind

**用自然语言搜索你本地的 git 仓库。** 一个纯客户端原生应用 — 无 server、无 Python、无 Node。

本地 clone 了几百个仓库，忘了名字、忘了放哪？RepoFind 给你建语义索引——输入"浏览器自动化的脚本"，它找到 `tampermonkey-scripts`；输入"向量检索"，它命中相关的推荐系统 / QA / LTR 项目。中文、英文、中英混合都可以。

![screenshot](docs/screenshot.png)

## 特点

- **纯客户端** — 基于 [nsh](https://nsh.dev) (Native Shell)：扫描文件系统、建索引、调 embedding API 全在应用内完成
- **混合检索** — `0.6 × 语义(余弦相似度) + 0.4 × 词法(TF-IDF)`，语义管"意思对了"，词法保"名字精确命中不被稀释"
- **中英混合分词** — 中文 bigram、英文驼峰拆分、路径段单独加权
- **模型可配置** — 任意 OpenAI 兼容 embedding 接口（SiliconFlow 免费 `BAAI/bge-m3`、OpenAI、DashScope、自建代理…），应用内 Settings 面板切换，配置存本机
- **零 git 依赖** — 分支/远端/最近提交直接读 `.git` 内部文件（HEAD / config / logs/HEAD），不调 git 进程
- **一套代码多端** — `nsh run . --target macos` 原生窗口，`--target web` 浏览器，同一份 TSX 还能出 iOS / Android / TUI

## 快速开始

### 1. 安装 nsh CLI

```bash
brew install longbridge/tap/nsh
```

### 2. 跑起来

```bash
git clone https://github.com/ahjdzx/repofind.git
cd repofind/app
nsh run . --target macos     # 原生 macOS 窗口
# 或
nsh run . --target web       # 浏览器
```

### 3. 配置模型（Settings 页）

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| 扫描目录 | `~/work ~/src ~/code` | 空格分隔，`~` 自动展开 |
| Base URL | `https://api.siliconflow.cn/v1` | 任意 OpenAI 兼容接口 |
| 模型名 | `BAAI/bge-m3` | 中文推荐 bge-m3（SiliconFlow 免费） |
| API Key | `sk-...` | 存在本机 Storage，不上传 |

### 4. 建索引 & 搜索

点 **SCAN + INDEX**（扫描 → 读元数据 → 生成向量），回搜索页输入自然语言描述：

- 搜索框 300ms 防抖自动搜
- 每行结果左侧是相关度分数（琥珀 = 语义命中，灰 = 词法命中）
- 点结果行复制路径；GitHub 仓库可直达远端
- 右上 `SEM+` / `LEX` 开关切换混合/纯词法模式

## 架构

```
app/
  lib.ts    # 扫描 (.git 解析) · 分词 · TF-IDF · embedding 客户端 · 混合排序
  App.tsx   # UI: 搜索页 + Settings + 状态栏 (雷达室风格)
```

索引进度、仓库数、向量模型显示在底部状态栏；索引和向量缓存在本机，换模型自动作废旧向量。

## Roadmap

- [x] 词法 + 语义混合检索
- [x] nsh 原生应用（macOS / Web）
- [x] 应用内模型配置
- [ ] 增量扫描（只重扫变化的仓库）
- [ ] 文件名级索引
- [ ] TUI target 适配
- [ ] Raycast 扩展

## License

[MIT](LICENSE)
