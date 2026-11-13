//! 本地模型: 可选模型的目录、下载 (断点续传 / 镜像 / 进度 / 取消) 和磁盘上的状态。
//!
//! 文件放在 `<数据目录>/models/<id>/`: `model.onnx`、`tokenizer.json`, 全部下完才写
//! `.complete`, 所以下了一半的模型不会被当成可用。

use crate::engine::{Pooling, Spec};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

pub struct ModelDef {
    pub id: &'static str,
    pub name: &'static str,
    /// Hugging Face 上的仓库 (int8 量化的 ONNX 导出)
    pub repo: &'static str,
    pub onnx: &'static str,
    /// 下载总大小 (MB), 给界面看
    pub size_mb: f64,
    pub dim: u32,
    pub spec: Spec,
}

const E5: (&str, &str) = ("query: ", "passage: ");
const BGE_ZH_QUERY: &str = "为这个句子生成表示以用于检索相关文章：";

pub const MODELS: &[ModelDef] = &[
    ModelDef {
        id: "multilingual-e5-small",
        name: "multilingual-e5-small",
        repo: "Xenova/multilingual-e5-small",
        onnx: "onnx/model_quantized.onnx",
        size_mb: 135.0,
        dim: 384,
        spec: Spec { pooling: Pooling::Mean, query_prefix: E5.0, passage_prefix: E5.1, max_tokens: 256 },
    },
    ModelDef {
        id: "bge-small-zh-v1.5",
        name: "bge-small-zh-v1.5",
        repo: "Xenova/bge-small-zh-v1.5",
        onnx: "onnx/model_quantized.onnx",
        size_mb: 25.0,
        dim: 512,
        spec: Spec { pooling: Pooling::Cls, query_prefix: BGE_ZH_QUERY, passage_prefix: "", max_tokens: 256 },
    },
    ModelDef {
        id: "multilingual-e5-base",
        name: "multilingual-e5-base",
        repo: "Xenova/multilingual-e5-base",
        onnx: "onnx/model_quantized.onnx",
        size_mb: 296.0,
        dim: 768,
        spec: Spec { pooling: Pooling::Mean, query_prefix: E5.0, passage_prefix: E5.1, max_tokens: 256 },
    },
    ModelDef {
        id: "bge-m3",
        name: "bge-m3",
        repo: "Xenova/bge-m3",
        onnx: "onnx/model_quantized.onnx",
        size_mb: 587.0,
        dim: 1024,
        spec: Spec { pooling: Pooling::Cls, query_prefix: "", passage_prefix: "", max_tokens: 256 },
    },
];

pub const DEFAULT_MODEL: &str = "multilingual-e5-small";

pub fn find(id: &str) -> Result<&'static ModelDef, String> {
    MODELS.iter().find(|m| m.id == id).ok_or_else(|| format!("unknown model: {id}"))
}

pub fn model_dir(data_dir: &str, id: &str) -> PathBuf {
    Path::new(data_dir).join("models").join(id)
}

pub fn is_installed(data_dir: &str, id: &str) -> bool {
    model_dir(data_dir, id).join(".complete").exists()
}

pub fn remove(data_dir: &str, id: &str) -> Result<(), String> {
    find(id)?;
    let dir = model_dir(data_dir, id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    Ok(())
}

// ---------- 下载 ----------

#[derive(Clone, Default)]
pub struct Progress {
    pub id: String,
    pub done: u64,
    pub total: u64,
    pub active: bool,
    pub error: String,
    pub source: String,
}

pub static PROGRESS: Mutex<Progress> = Mutex::new(Progress {
    id: String::new(),
    done: 0,
    total: 0,
    active: false,
    error: String::new(),
    source: String::new(),
});
static CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn progress() -> std::sync::MutexGuard<'static, Progress> {
    PROGRESS.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn cancel() {
    CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
}

const HF: &str = "https://huggingface.co";
const MIRROR: &str = "https://hf-mirror.com";

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        // 只限制 「多久没收到数据」: 不能限制整个响应体的时长 (timeout_recv_body),
        // 几百 MB 的模型慢网要下好几分钟
        .timeout_per_read(Some(Duration::from_secs(30)))
        .max_redirects(10)
        .build()
        .into()
}

/// "auto": 先试 huggingface.co (5 秒内连得上就用它), 不行用 hf-mirror.com
fn resolve_source(source: &str) -> &'static str {
    match source {
        "hf" => HF,
        "mirror" => MIRROR,
        _ => {
            let probe: ureq::Agent = ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(5)))
                .build()
                .into();
            if probe.head(format!("{HF}/api/models/{}", MODELS[0].repo)).call().is_ok() { HF } else { MIRROR }
        }
    }
}

/// 下载一个文件到 `dest`: 先写 `.part`, 支持断点续传, 完整了再改名
fn fetch(agent: &ureq::Agent, url: &str, dest: &Path, base_done: u64) -> Result<u64, String> {
    let part = dest.with_extension("part");
    let have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let mut req = agent.get(url);
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let resp = req.call().map_err(|e| format!("{url}: {e}"))?;
    let resumed = resp.status().as_u16() == 206;
    let len: u64 = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let start = if resumed { have } else { 0 };
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&part)
        .map_err(|e| format!("{}: {e}", part.display()))?;
    let mut reader = resp.into_body().into_reader();
    let mut buf = vec![0u8; 256 * 1024];
    let mut got = start;
    loop {
        if CANCEL.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("{url}: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        got += n as u64;
        progress().done = base_done + got;
    }
    file.flush().map_err(|e| e.to_string())?;
    if len > 0 && got != start + len {
        return Err(format!("{url}: incomplete ({got} of {} bytes)", start + len));
    }
    fs::rename(&part, dest).map_err(|e| e.to_string())?;
    Ok(got)
}

/// 下载一个模型 (阻塞, 在后台线程里调用)。进度写进 PROGRESS, 界面轮询读取。
pub fn download(data_dir: &str, id: &str, source: &str) -> Result<(), String> {
    let def = find(id)?;
    {
        let mut p = progress();
        if p.active {
            return Err(format!("already downloading {}", p.id));
        }
        *p = Progress { id: id.into(), active: true, total: (def.size_mb * 1_000_000.0) as u64, ..Default::default() };
    }
    CANCEL.store(false, std::sync::atomic::Ordering::SeqCst);
    let result = (|| -> Result<(), String> {
        let base = resolve_source(source);
        progress().source = base.trim_start_matches("https://").into();
        let dir = model_dir(data_dir, id);
        fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let agent = agent();
        let mut done = 0;
        for (remote, local) in [("tokenizer.json", "tokenizer.json"), (def.onnx, "model.onnx")] {
            let dest = dir.join(local);
            if dest.exists() {
                done += fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
                continue;
            }
            let url = format!("{base}/{}/resolve/main/{remote}", def.repo);
            // 中途断了 (超时 / 连接重置) 就从 .part 接着下, 最多再试 3 次
            let mut attempt = 0;
            let got = loop {
                match fetch(&agent, &url, &dest, done) {
                    Ok(n) => break n,
                    Err(e) if e == "cancelled" || attempt >= 3 => return Err(e),
                    Err(_) => {
                        attempt += 1;
                        std::thread::sleep(Duration::from_secs(2 * attempt));
                    }
                }
            };
            done += got;
        }
        fs::write(dir.join(".complete"), b"").map_err(|e| e.to_string())?;
        Ok(())
    })();
    let mut p = progress();
    p.active = false;
    if let Err(e) = &result {
        p.error = e.clone();
    } else {
        p.done = p.total.max(p.done);
    }
    result
}
