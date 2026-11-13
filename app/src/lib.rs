//! RepoFind 的 Rust 部分: 本地 embedding 模型 (下载、管理、推理)。
//! `App.tsx` 从 `repofind/native` 导入 `Local`; 类型声明生成在 `.nsh/types/repofind/native.d.ts`。

use nsh_core::prelude::*;

#[cfg(local_engine)]
mod engine;
#[cfg(local_engine)]
mod models;
#[cfg(not(target_arch = "wasm32"))]
mod shell;

/// The crate's exports (`nsh.json` `"rust"`).
#[native_module("repofind/native")]
fn native(registry: &mut Registry) {
    registry.module::<Local>().module::<Shell>();
}

/// A local embedding model the app can download.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct LocalModel {
    /// Its id (`"multilingual-e5-small"`).
    pub id: SharedString,
    /// What the settings show.
    pub name: SharedString,
    /// The download size in megabytes.
    pub size: f64,
    /// The length of its vectors.
    pub dim: u32,
    /// Whether it is the model the app picks by default.
    pub recommended: bool,
}

/// The download in progress, or the last one.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct DownloadState {
    /// The model being (or last) downloaded; empty before the first download.
    pub id: SharedString,
    /// Bytes downloaded so far.
    pub done: f64,
    /// Bytes expected.
    pub total: f64,
    /// Whether a download is running.
    pub active: bool,
    /// Why the last download failed; empty when it did not.
    pub error: SharedString,
    /// The host it downloads from (`huggingface.co` or `hf-mirror.com`).
    pub source: SharedString,
}

/// Local embedding models: download, remove and run them on this machine.
#[module]
pub struct Local;

/// Opens a folder in the file manager or a terminal.
#[module]
pub struct Shell;

#[module]
impl Shell {
    /// Opens the folder at `path` (absolute) in the file manager: Finder, File Explorer, the desktop's.
    pub async fn open_folder(path: String) -> Result<(), String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            open_path(path).await
        }
        #[cfg(target_arch = "wasm32")]
        {
            let _ = path;
            Err("not available in the browser".into())
        }
    }

    /// Opens a terminal in the folder at `path`; `app` names the terminal on macOS (`"iTerm"`; empty: Terminal).
    pub async fn open_terminal(path: String, app: String) -> Result<(), String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            blocking(move || shell::open_terminal(&path, &app)).await.map_err(|e| e.to_string())?
        }
        #[cfg(target_arch = "wasm32")]
        {
            let _ = (path, app);
            Err("not available in the browser".into())
        }
    }

    /// The terminals installed (macOS; empty elsewhere, where the system's is used), the default first.
    pub fn terminals() -> Vec<String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            shell::terminals()
        }
        #[cfg(target_arch = "wasm32")]
        Vec::new()
    }
}

#[cfg(local_engine)]
mod loaded {
    use super::{engine, models};
    use std::{
        sync::{Mutex, Once},
        time::{Duration, Instant},
    };

    pub struct Loaded {
        pub key: String,
        pub engine: engine::Engine,
        pub last: Instant,
    }

    /// 当前加载着的模型; 一次只留一个
    pub static ENGINE: Mutex<Option<Loaded>> = Mutex::new(None);

    /// 闲置这么久就卸载, 把内存 (一个小模型约 0.5~1GB) 还给系统
    const IDLE: Duration = Duration::from_secs(180);

    pub fn lock() -> std::sync::MutexGuard<'static, Option<Loaded>> {
        ENGINE.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn start_reaper() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            std::thread::spawn(|| loop {
                std::thread::sleep(Duration::from_secs(20));
                let mut slot = lock();
                if slot.as_ref().is_some_and(|l| l.last.elapsed() > IDLE) {
                    *slot = None;
                }
            });
        });
    }

    /// 在后台线程里调用: 需要时加载模型, 然后推理
    pub fn embed(data_dir: &str, id: &str, texts: &[String], query: bool) -> Result<(Vec<f32>, usize), String> {
        let def = models::find(id)?;
        if !models::is_installed(data_dir, id) {
            return Err(format!("model not downloaded: {id}"));
        }
        let key = format!("{data_dir}\u{0}{id}");
        let mut slot = lock();
        if slot.as_ref().map(|l| l.key != key).unwrap_or(true) {
            *slot = None; // 先放掉旧模型再加载新的, 不同时占两份内存
            let dir = models::model_dir(data_dir, id);
            let engine = engine::Engine::load(
                &dir.join("model.onnx"),
                &dir.join("tokenizer.json"),
                def.spec,
                engine::default_threads(),
            )?;
            *slot = Some(Loaded { key, engine, last: Instant::now() });
            start_reaper();
        }
        let l = slot.as_mut().expect("loaded above");
        l.last = Instant::now();
        l.engine.embed(texts, query)
    }
}

#[cfg(not(local_engine))]
const UNSUPPORTED: &str = "local models are not available on this platform";

#[module]
impl Local {
    /// Whether local models run on this platform (not in the browser, not on Intel Macs).
    pub fn supported() -> bool {
        cfg!(local_engine)
    }

    /// The models that can be downloaded, the recommended one first.
    pub fn models() -> Vec<LocalModel> {
        #[cfg(local_engine)]
        {
            models::MODELS
                .iter()
                .map(|m| LocalModel {
                    id: m.id.into(),
                    name: m.name.into(),
                    size: m.size_mb,
                    dim: m.dim,
                    recommended: m.id == models::DEFAULT_MODEL,
                })
                .collect()
        }
        #[cfg(not(local_engine))]
        Vec::new()
    }

    /// The ids of the models fully downloaded into `dataDir`.
    pub fn installed(data_dir: String) -> Vec<String> {
        #[cfg(local_engine)]
        {
            models::MODELS
                .iter()
                .filter(|m| models::is_installed(&data_dir, m.id))
                .map(|m| m.id.to_string())
                .collect()
        }
        #[cfg(not(local_engine))]
        {
            let _ = data_dir;
            Vec::new()
        }
    }

    /// Downloads model `id` into `dataDir` from `source` (`"auto"`, `"hf"` or `"mirror"`); resolves when it is complete. Read `progress()` meanwhile.
    pub async fn download(data_dir: String, id: String, source: String) -> Result<(), String> {
        #[cfg(local_engine)]
        {
            blocking(move || models::download(&data_dir, &id, &source)).await.map_err(|e| e.to_string())?
        }
        #[cfg(not(local_engine))]
        {
            let _ = (data_dir, id, source);
            Err(UNSUPPORTED.into())
        }
    }

    /// The download in progress (or the last one).
    pub fn progress() -> DownloadState {
        #[cfg(local_engine)]
        {
            let p = models::PROGRESS.lock().unwrap_or_else(|p| p.into_inner()).clone();
            DownloadState {
                id: p.id.into(),
                done: p.done as f64,
                total: p.total as f64,
                active: p.active,
                error: p.error.into(),
                source: p.source.into(),
            }
        }
        #[cfg(not(local_engine))]
        DownloadState::default()
    }

    /// Stops the download in progress; what was downloaded is kept and the next download resumes it.
    pub fn cancel() {
        #[cfg(local_engine)]
        models::cancel();
    }

    /// Deletes model `id` from `dataDir` (and unloads it).
    pub fn remove(data_dir: String, id: String) -> Result<(), String> {
        #[cfg(local_engine)]
        {
            let mut slot = loaded::lock();
            if slot.as_ref().is_some_and(|l| l.key.ends_with(&format!("\u{0}{id}"))) {
                *slot = None;
            }
            drop(slot);
            models::remove(&data_dir, &id)
        }
        #[cfg(not(local_engine))]
        {
            let _ = (data_dir, id);
            Err(UNSUPPORTED.into())
        }
    }

    /// Embeds `texts` with model `id` (queries when `query`, else documents), loading it if needed: the vectors, normalized, one after another in one array (`dim` numbers each).
    pub async fn embed(data_dir: String, id: String, texts: Vec<String>, query: bool) -> Result<Vec<f64>, String> {
        #[cfg(local_engine)]
        {
            let (flat, _dim) = blocking(move || loaded::embed(&data_dir, &id, &texts, query))
                .await
                .map_err(|e| e.to_string())??;
            Ok(flat.into_iter().map(f64::from).collect())
        }
        #[cfg(not(local_engine))]
        {
            let _ = (data_dir, id, texts, query);
            Err(UNSUPPORTED.into())
        }
    }

    /// The id of the model loaded in memory, empty when none is.
    pub fn loaded() -> String {
        #[cfg(local_engine)]
        {
            loaded::lock().as_ref().map(|l| l.key.split('\u{0}').nth(1).unwrap_or("").to_string()).unwrap_or_default()
        }
        #[cfg(not(local_engine))]
        String::new()
    }

    /// Unloads the model from memory now (it loads again on the next `embed`).
    pub fn release() {
        #[cfg(local_engine)]
        {
            *loaded::lock() = None;
        }
    }
}

/// 真下载、真推理 (要联网, 约 25MB): `cargo test --release -- --ignored`
#[cfg(all(test, local_engine))]
mod tests {
    use super::{loaded, models};
    use std::fs;

    const ID: &str = "bge-small-zh-v1.5";

    fn dot(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    #[test]
    #[ignore = "downloads a model"]
    fn downloads_resumes_embeds_and_removes() {
        let dir = std::env::temp_dir().join(format!("repofind-test-{}", std::process::id()));
        let data = dir.to_str().unwrap().to_string();

        models::download(&data, ID, "auto").expect("download");
        assert!(models::is_installed(&data, ID));
        let p = models::PROGRESS.lock().unwrap().clone();
        assert!(!p.active && p.error.is_empty() && p.done > 20_000_000, "{:?}", (p.done, p.error));
        let model = models::model_dir(&data, ID).join("model.onnx");
        let full = fs::read(&model).unwrap();

        // 断点续传: 只留前一半当作没下完, 再下一次应该接着下, 得到同样的文件
        fs::remove_file(models::model_dir(&data, ID).join(".complete")).unwrap();
        fs::remove_file(&model).unwrap();
        fs::write(model.with_extension("part"), &full[..full.len() / 2]).unwrap();
        assert!(!models::is_installed(&data, ID));
        models::download(&data, ID, "auto").expect("resume");
        assert_eq!(fs::read(&model).unwrap(), full);

        let docs: Vec<String> = [
            "recsys-demo\n基于协同过滤和双塔模型的推荐系统示例，含召回、排序。",
            "geek-crawler\n把付费专栏文章爬下来存成 Markdown 的小工具。",
            "faiss\nA library for efficient similarity search of dense vectors.",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let (flat, dim) = loaded::embed(&data, ID, &docs, false).expect("embed docs");
        assert_eq!(dim, 512);
        assert_eq!(flat.len(), 3 * 512);
        let (q, _) = loaded::embed(&data, ID, &["推荐系统".to_string()], true).expect("embed query");
        let scores: Vec<f32> = (0..3).map(|i| dot(&q, &flat[i * dim..(i + 1) * dim])).collect();
        assert!(scores[0] > scores[1] && scores[0] > scores[2], "{scores:?}");
        assert!((dot(&q, &q) - 1.0).abs() < 1e-4, "query vector is normalized");

        *loaded::lock() = None;
        models::remove(&data, ID).unwrap();
        assert!(!models::is_installed(&data, ID));
        let _ = fs::remove_dir_all(&dir);
    }
}
