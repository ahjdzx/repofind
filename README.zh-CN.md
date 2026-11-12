# RepoFind

[English](README.md) | **简体中文**

**用自然语言搜索你本地的 git 仓库。** 一个纯客户端桌面应用 — 无 server、无 Python、无 Node。

本地 clone 了几百个仓库，忘了名字、忘了放哪？RepoFind 给它们建语义索引——输入"浏览器自动化的脚本"，排在前面的就是 puppeteer、你的油猴脚本和 playwright，哪怕仓库名和 README 里一个字都对不上。中文、英文、中英混合都可以。

![screenshot](docs/screenshot.png)

<sub>截图用的是一组演示仓库。</sub>

## 特点

- **纯客户端** — 基于 [nsh](https://nsh.dev) (Native Shell)：扫描文件系统、建索引、调 embedding API 全在应用内完成
- **混合检索** — `0.6 × 语义(余弦相似度) + 0.4 × 词法(TF-IDF)`，语义管"意思对了"，词法保"名字精确命中不被稀释"
- **中英混合分词** — 中文 bigram、英文驼峰拆分、路径段单独加权
- **模型可配置** — 任意 OpenAI 兼容 embedding 接口（SiliconFlow 免费的 `BAAI/bge-m3`、OpenAI、DashScope、自建代理…），在 Settings 里切换
- **零 git 依赖** — 分支/远端/最近提交直接读 `.git` 内部文件（HEAD / config / logs/HEAD），不调 git 进程
- **中英双语界面** — 右上角一键切换

## 下载

从 [Releases](https://github.com/ahjdzx/repofind/releases) 下载 `RepoFind-<版本>-macos-arm64.zip`（Apple 芯片，macOS 14+），解压后把 `RepoFind.app` 拖进"应用程序"。

安装包是 ad hoc 签名、没有公证，首次打开会被 macOS 拦住，执行一次下面的命令解除隔离：

```bash
xattr -dr com.apple.quarantine /Applications/RepoFind.app
```

Intel Mac、Windows、Linux 请按下面的方式从源码运行，然后从第 3 步看起。

## 从源码运行

### 1. 安装 nsh CLI

```bash
brew install longbridge/tap/nsh
```

### 2. 跑起来

```bash
git clone https://github.com/ahjdzx/repofind.git
cd repofind/app
nsh run --target macos
```

> 扫描本地目录需要桌面端（macOS / Windows / Linux）。`--target web` 能看界面，但浏览器读不到你的文件系统，建不了索引。

### 3. 配置（Settings 页）

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| 扫描目录 | `~/work ~/code` | 空格分隔，`~` 自动展开；必须在主目录之下（见[权限](#权限)） |
| Base URL | `https://api.siliconflow.cn/v1` | 任意 OpenAI 兼容接口 |
| 模型名 | `BAAI/bge-m3` | 中文推荐 bge-m3 |
| API Key | `sk-...` | 明文存在本机的应用 Storage 里，只发给你填的 Base URL |

不填 API Key 也能用，只是只有词法检索。

### 4. 建索引 & 搜索

点 **SCAN + INDEX**（扫描 → 读元数据 → 生成向量），回搜索页输入描述：

- 搜索框 300ms 防抖自动搜
- 每行左侧是相关度分数（琥珀 = 语义命中，灰 = 仅词法命中）
- 点结果行复制路径；GitHub 仓库可直达远端
- 搜索框右侧 `SEM+` / `LEX` 切换混合 / 纯词法

索引和向量存在应用数据目录里，重启后直接可用；clone 了新仓库就再点一次 SCAN + INDEX。

## 权限

应用在 `app/nsh.json` 里只声明了它用得到的能力：

| 能力 | 范围 | 用途 |
| --- | --- | --- |
| 读文件 | 主目录、应用数据目录 | 扫描仓库、读回索引 |
| 写文件 | 仅应用数据目录 | 保存索引和向量 |
| 网络 | 任意主机 | embedding 接口地址由你配置 |
| 剪贴板 / 打开链接 | https | 复制路径、跳转 GitHub |

要扫主目录以外的位置（比如外接盘），在 `capabilities.fs.read` 里加上那个路径。

**会离开本机的数据**：建索引时，每个仓库的名称、路径（`~` 形式）、语言和 README 前 1500 字会发给你配置的 embedding 接口；搜索时发送查询词。纯词法模式不发任何请求。

## 开发

```
app/
  lib.ts         # 扫描 (.git 解析) · 分词 · TF-IDF · embedding 客户端 · 混合排序 · 落盘
  App.tsx        # UI: 搜索页 + Settings + 状态栏
  App.test.tsx   # 回归测试: 假文件系统 + 假 embedding 接口
  locales/       # zh-CN / en 文案
```

```bash
cd app
nsh check    # 类型检查
nsh test     # 无头回归测试（扫描 → 索引 → 混合检索 → 重启恢复 → 切语言）
nsh package --target macos    # 打包 RepoFind.app 到 .nsh/out
```

## Roadmap

- [x] 词法 + 语义混合检索
- [x] 应用内模型配置、中英双语
- [x] 索引 / 向量落盘
- [x] 打包 macOS 应用
- [ ] 增量扫描（只重扫变化的仓库）
- [ ] 文件名级索引
- [ ] 公证签名，Intel / Windows / Linux 安装包
- [ ] TUI target 适配

## License

[MIT](LICENSE)
