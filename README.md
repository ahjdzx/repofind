<img src="app/icon-macos.png" width="112" alt="RepoFind icon">

# RepoFind

**English** | [简体中文](README.zh-CN.md)

**Search your local git repos in plain language.** A client-only desktop app — no server, no Python, no Node.

Cloned hundreds of repos and forgot what they were called or where you put them? RepoFind builds a semantic index over them. Type "scripts for automating the browser" and puppeteer, your userscripts and playwright come out on top, even when not a single word matches the repo name or README. Works in English, Chinese, or a mix.

![screenshot](docs/screenshot.png)

<sub>The screenshot uses a set of demo repos; the query reads "scripts for automating the browser".</sub>

## Features

- **Client-only** — built on [nsh](https://nsh.dev) (Native Shell): scanning the file system, indexing and running the embedding model all happen inside the app
- **Hybrid ranking** — `0.6 × semantic (cosine similarity) + 0.4 × lexical (TF-IDF)`: semantics finds what you meant, lexical keeps exact name matches on top
- **Mixed English/Chinese tokenizer** — CJK bigrams, camelCase splitting, path segments weighted separately
- **Three ways to get vectors** — a local model that runs inside the app (default: `multilingual-e5-small`, downloaded once, then fully offline), an embedding server already running on your machine (LM Studio, llama.cpp, Ollama), or any OpenAI-compatible API
- **Atlas** (the first page) — repos grouped by topic, language, recency, local commits, source and owner; click any of them to filter, and search only within what you filtered
- **Open where you work** — every result opens in Finder (File Explorer / the file manager) or a terminal; on macOS pick Terminal, iTerm, Ghostty, Warp… in Settings
- **Incremental re-indexing** — rebuilding the index only re-embeds repos whose text changed
- **No git dependency** — branch, remote and last commit are read straight from `.git` internals (HEAD / config / logs/HEAD); no git process is spawned
- **English and Chinese UI** — one click in the top bar

## Download

Pick your platform's file from [Releases](https://github.com/ahjdzx/repofind/releases):

| Platform | File | Needs |
| --- | --- | --- |
| macOS, Apple silicon | `RepoFind-<version>-macos-arm64.zip` | macOS 14+ |
| macOS, Intel | `RepoFind-<version>-macos-x86_64.zip` | macOS 14+ |
| Linux | `RepoFind-<version>-linux-x86_64.tar.gz` / `-linux-arm64.tar.gz` | glibc 2.39+, GTK 4.14+ (Ubuntu 24.04 or later) |
| Windows | `RepoFind-<version>-windows-x86_64.zip` | Windows 10 1809+ |

- **macOS**: unzip and move `RepoFind.app` to Applications. The build is ad hoc signed, not notarized, so macOS blocks the first launch; clear the quarantine flag once with `xattr -dr com.apple.quarantine /Applications/RepoFind.app`.
- **Linux**: extract the archive and run the `RepoFind` executable inside it.
- **Windows**: unzip and run `RepoFind.exe`. It is not code signed, so SmartScreen warns on first launch.

Local models are not available in the Intel Mac build (ONNX Runtime ships no prebuilt library for it); use a local service or an external API there.

Only the Apple silicon build has been run by hand so far; the others are built and tested headlessly in CI. Reports are welcome.

## Run from source

Needs the nsh CLI and a Rust toolchain (the local embedding engine is Rust).

```bash
brew install longbridge/tap/nsh        # the nsh CLI
git clone https://github.com/ahjdzx/repofind.git
cd repofind/app
nsh run --target macos
```

> Scanning local directories needs a desktop target (macOS / Windows / Linux). `--target web` shows the UI, but a browser cannot read your file system, so it cannot build an index.

## Setup (Settings page)

**Scan roots**: space-separated, `~` is expanded, e.g. `~/work ~/code`; must be inside your home directory (see [Permissions](#permissions)).

**Embedding**: pick one of three sources.

| Source | What it is | Setup |
| --- | --- | --- |
| Local model (default) | Inference inside the app with ONNX Runtime | Nothing: the default model downloads on the first index. Others can be downloaded, switched or deleted in Settings |
| Local service | An OpenAI-compatible server on your machine | Base URL (LM Studio `http://127.0.0.1:1234/v1`, llama.cpp `:8080/v1`, Ollama `:11434/v1`) and the model name it lists |
| External API | Any OpenAI-compatible embeddings API | Base URL, model name, API key (stored in plain text in the app's on-device Storage, sent only to that URL) |

Local models (int8-quantized ONNX, timings per repo measured on an Apple M1):

| Model | Download | Speed | Notes |
| --- | --- | --- | --- |
| `multilingual-e5-small` | 135 MB | ~40 ms | Default; 100+ languages, Chinese and English both fine |
| `bge-small-zh-v1.5` | 25 MB | ~20 ms | Smallest; strong on Chinese, weaker on English READMEs |
| `multilingual-e5-base` | 296 MB | ~160 ms | Larger e5 |
| `bge-m3` | 587 MB | ~500 ms | Best results in our tests; about 1.5 GB of memory while loaded |

Models download from huggingface.co, or hf-mirror.com when Hugging Face is unreachable (selectable in Settings); interrupted downloads resume. A loaded model is unloaded after 3 idle minutes. Switching models means rebuilding the index. Without any working source the app still works, with lexical search only.

Press **Build index now** on the search page (or **SCAN + INDEX** in Settings), then describe what you are looking for:

- The search box searches as you type (300 ms debounce)
- The number on the left is the relevance score (amber = semantic hit, grey = lexical only)
- Click a row to copy its path; **Open in Finder** / **Open in Terminal** under each result; GitHub repos link to their remote
- `SEM+` / `LEX` next to the search box switches between hybrid and lexical-only

The index and vectors are kept in the app's data directory and are there after a restart. Cloned something new? Rebuild the index; repos whose text did not change keep their vectors.

## Permissions

The app declares only the capabilities it uses, in `app/nsh.json`:

| Capability | Scope | Used for |
| --- | --- | --- |
| Read files | Home directory, app data directory | Scanning repos, reading the index back |
| Write files | App data directory only | Saving the index, vectors and downloaded models |
| Network | Any host | Model downloads, and the embedding endpoint you choose |
| Clipboard / open URL | https | Copying paths, opening GitHub |

To scan somewhere outside your home directory (an external drive, say), add that path to `capabilities.fs.read` and run from source.

**What leaves your machine**: with a local model, nothing (only the one-time model download). With a local service or an external API: when indexing, each repo's name, path (in `~` form), languages and the first 1500 characters of its README go to the embedding endpoint you configured; when searching, the query does. Lexical-only mode makes no requests.

## Development

```
app/
  lib.ts         # scanning (.git parsing) · tokenizer · TF-IDF · OpenAI-compatible client · hybrid ranking · persistence
  embedder.ts    # the three embedding sources, settings migration
  tags.ts        # topic / language / recency tags for the Atlas
  App.tsx        # UI: search, Atlas, Settings, status bar
  Atlas.tsx      # tag statistics and the radar view
  src/           # Rust: local models (catalog, downloader, ONNX Runtime engine)
  App.test.tsx   # regression tests: fake file system, fake embedding endpoint, stand-in local models
  locales/       # zh-CN / en strings
```

```bash
cd app
nsh check                     # type check
nsh test                      # headless regression tests
cargo test --release -- --ignored   # downloads a real model, checks resume and inference
nsh package --target macos    # build RepoFind.app into .nsh/out
```

## Roadmap

- [x] Lexical + semantic hybrid search
- [x] In-app model configuration, English/Chinese UI
- [x] Index and vectors persisted to disk
- [x] Packaged macOS app
- [ ] Incremental scan (only rescan repos that changed)
- [x] Only re-embed repos whose text changed
- [x] Local embedding models inside the app
- [ ] File-name level index
- [x] Packages for Intel Macs, Linux and Windows
- [ ] Notarized / code-signed builds
- [ ] TUI target

## License

[MIT](LICENSE)
