<img src="app/icon-macos.png" width="112" alt="RepoFind icon">

# RepoFind

**English** | [简体中文](README.zh-CN.md)

**Search your local git repos in plain language.** A client-only desktop app — no server, no Python, no Node.

Cloned hundreds of repos and forgot what they were called or where you put them? RepoFind builds a semantic index over them. Type "scripts for automating the browser" and puppeteer, your userscripts and playwright come out on top, even when not a single word matches the repo name or README. Works in English, Chinese, or a mix.

![screenshot](docs/screenshot.png)

<sub>The screenshot uses a set of demo repos; the query reads "scripts for automating the browser".</sub>

## Features

- **Client-only** — built on [nsh](https://nsh.dev) (Native Shell): scanning the file system, indexing and calling the embedding API all happen inside the app
- **Hybrid ranking** — `0.6 × semantic (cosine similarity) + 0.4 × lexical (TF-IDF)`: semantics finds what you meant, lexical keeps exact name matches on top
- **Mixed English/Chinese tokenizer** — CJK bigrams, camelCase splitting, path segments weighted separately
- **Bring your own model** — any OpenAI-compatible embeddings endpoint (SiliconFlow's free `BAAI/bge-m3`, OpenAI, DashScope, your own proxy…), switched in Settings
- **No git dependency** — branch, remote and last commit are read straight from `.git` internals (HEAD / config / logs/HEAD); no git process is spawned
- **English and Chinese UI** — one click in the top bar

## Download

Grab `RepoFind-<version>-macos-arm64.zip` from [Releases](https://github.com/ahjdzx/repofind/releases) (Apple silicon, macOS 14+), unzip it and move `RepoFind.app` to Applications.

The build is ad hoc signed, not notarized, so macOS blocks it on first launch. Clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/RepoFind.app
```

Intel Macs, Windows and Linux: run from source (below).

## Run from source

```bash
brew install longbridge/tap/nsh        # the nsh CLI
git clone https://github.com/ahjdzx/repofind.git
cd repofind/app
nsh run --target macos
```

> Scanning local directories needs a desktop target (macOS / Windows / Linux). `--target web` shows the UI, but a browser cannot read your file system, so it cannot build an index.

## Setup (Settings page)

| Field | Example | Notes |
| --- | --- | --- |
| Scan roots | `~/work ~/code` | Space-separated, `~` is expanded; must be inside your home directory (see [Permissions](#permissions)) |
| Base URL | `https://api.siliconflow.cn/v1` | Any OpenAI-compatible endpoint |
| Model name | `BAAI/bge-m3` | bge-m3 is a good pick for Chinese |
| API Key | `sk-...` | Stored in plain text in the app's on-device Storage; sent only to the Base URL you set |

Without an API key the app still works, with lexical search only.

Press **SCAN + INDEX** (scan → read metadata → generate vectors), then go back and describe what you are looking for:

- The search box searches as you type (300 ms debounce)
- The number on the left is the relevance score (amber = semantic hit, grey = lexical only)
- Click a row to copy its path; GitHub repos link to their remote
- `SEM+` / `LEX` next to the search box switches between hybrid and lexical-only

The index and vectors are kept in the app's data directory and are there after a restart. Cloned something new? Press SCAN + INDEX again.

## Permissions

The app declares only the capabilities it uses, in `app/nsh.json`:

| Capability | Scope | Used for |
| --- | --- | --- |
| Read files | Home directory, app data directory | Scanning repos, reading the index back |
| Write files | App data directory only | Saving the index and vectors |
| Network | Any host | The embedding endpoint is yours to choose |
| Clipboard / open URL | https | Copying paths, opening GitHub |

To scan somewhere outside your home directory (an external drive, say), add that path to `capabilities.fs.read` and run from source.

**What leaves your machine**: when indexing, each repo's name, path (in `~` form), languages and the first 1500 characters of its README go to the embedding endpoint you configured; when searching, the query does. Lexical-only mode makes no requests.

## Development

```
app/
  lib.ts         # scanning (.git parsing) · tokenizer · TF-IDF · embedding client · hybrid ranking · persistence
  App.tsx        # UI: search, Settings, status bar
  App.test.tsx   # regression tests: fake file system + fake embedding endpoint
  locales/       # zh-CN / en strings
```

```bash
cd app
nsh check                     # type check
nsh test                      # headless regression tests
nsh package --target macos    # build RepoFind.app into .nsh/out
```

## Roadmap

- [x] Lexical + semantic hybrid search
- [x] In-app model configuration, English/Chinese UI
- [x] Index and vectors persisted to disk
- [x] Packaged macOS app
- [ ] Incremental scan (only rescan repos that changed)
- [ ] File-name level index
- [ ] Notarized builds, Intel / Windows / Linux packages
- [ ] TUI target

## License

[MIT](LICENSE)
