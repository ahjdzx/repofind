//! 本地模型: 可选模型的目录、下载 (断点续传 / 镜像 / 进度 / 取消) 和磁盘上的状态。
//!
//! 文件放在 `<数据目录>/models/<id>/`: `model.onnx`、`tokenizer.json`, 全部下完才写
//! `.complete`, 所以下了一半的模型不会被当成可用。

use crate::engine::{Pooling, Spec};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Mutex},
    time::{Duration, Instant},
};

pub struct ModelDef {
    pub id: &'static str,
    pub name: &'static str,
    /// Hugging Face 上的仓库 (int8 量化的 ONNX 导出)
    pub repo: &'static str,
    pub onnx: &'static str,
    /// 下载总大小 (MB), 给界面看
    pub size_mb: f64,
    /// model.onnx 的 sha256 (huggingface 上 LFS 的 oid), 下完校验
    pub sha256: &'static str,
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
        sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
        dim: 384,
        spec: Spec { pooling: Pooling::Mean, query_prefix: E5.0, passage_prefix: E5.1, max_tokens: 256 },
    },
    ModelDef {
        id: "bge-small-zh-v1.5",
        name: "bge-small-zh-v1.5",
        repo: "Xenova/bge-small-zh-v1.5",
        onnx: "onnx/model_quantized.onnx",
        size_mb: 25.0,
        sha256: "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc",
        dim: 512,
        spec: Spec { pooling: Pooling::Cls, query_prefix: BGE_ZH_QUERY, passage_prefix: "", max_tokens: 256 },
    },
    ModelDef {
        id: "multilingual-e5-base",
        name: "multilingual-e5-base",
        repo: "Xenova/multilingual-e5-base",
        onnx: "onnx/model_quantized.onnx",
        size_mb: 296.0,
        sha256: "df7a9a29309e3ad491e1783adf8baee710262cc06079c7cbab63c630277fac94",
        dim: 768,
        spec: Spec { pooling: Pooling::Mean, query_prefix: E5.0, passage_prefix: E5.1, max_tokens: 256 },
    },
    ModelDef {
        id: "bge-m3",
        name: "bge-m3",
        repo: "Xenova/bge-m3",
        onnx: "onnx/model_quantized.onnx",
        size_mb: 587.0,
        sha256: "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d",
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
    /// 最近几秒的平均速度 (字节/秒)
    pub speed: f64,
    /// 下载中途因为太慢 / 断线换过源
    pub switched: bool,
    /// 下完了, 在校验文件
    pub verifying: bool,
}

pub static PROGRESS: Mutex<Progress> = Mutex::new(Progress {
    id: String::new(),
    done: 0,
    total: 0,
    active: false,
    error: String::new(),
    source: String::new(),
    speed: 0.0,
    switched: false,
    verifying: false,
});
static CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn progress() -> std::sync::MutexGuard<'static, Progress> {
    PROGRESS.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

const HF: &str = "https://huggingface.co";
const MIRROR: &str = "https://hf-mirror.com";

/// 两个下载源。测试时可以用环境变量换成本机的假服务器 (只在测试里编译这段)
fn endpoints() -> [String; 2] {
    #[cfg(test)]
    if let (Ok(a), Ok(b)) = (std::env::var("REPOFIND_TEST_HF"), std::env::var("REPOFIND_TEST_MIRROR")) {
        return [a, b];
    }
    [HF.to_string(), MIRROR.to_string()]
}

/// 连续 SLOW_WINDOW 秒平均低于这个速度算 "慢" (200 KB/s: 135 MB 要下十多分钟)
const SLOW_BPS: f64 = 200_000.0;
const SLOW_WINDOW: usize = 8;
/// 已知两个源都慢时, 另一个要快这么多倍才值得再换
const SWITCH_GAIN: f64 = 1.5;

fn host(base: &str) -> String {
    base.trim_start_matches("https://").trim_start_matches("http://").to_string()
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        // 只限制「多久没收到数据」: 不能限制整个响应体的时长 (timeout_recv_body),
        // 几百 MB 的模型慢网要下好几分钟
        .timeout_per_read(Some(Duration::from_secs(30)))
        .max_redirects(10)
        .build()
        .into()
}

/// "auto" 时先比一下两个源: 同时各下 256 KB, 先下完的排前面; 都失败就先试 huggingface.co。
/// 下载过程中还会测速, 慢了再换 (见 `download`)。
fn source_order(source: &str, probe_url: &dyn Fn(&str) -> String) -> (Vec<String>, bool) {
    let [hf, mirror] = endpoints();
    match source {
        "hf" => (vec![hf], false),
        "mirror" => (vec![mirror], false),
        _ => {
            let (tx, rx) = std::sync::mpsc::channel();
            for base in [hf.clone(), mirror.clone()] {
                let tx = tx.clone();
                let url = probe_url(&base);
                std::thread::spawn(move || {
                    let a: ureq::Agent =
                        ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(6))).build().into();
                    let ok = a
                        .get(&url)
                        .header("Range", "bytes=0-262143")
                        .call()
                        .ok()
                        .and_then(|r| {
                            let mut buf = Vec::new();
                            r.into_body().into_reader().read_to_end(&mut buf).ok().map(|_| !buf.is_empty())
                        })
                        .unwrap_or(false);
                    let _ = tx.send((base, ok));
                });
            }
            drop(tx);
            // 第一个成功回来的最快
            let first = rx.iter().find(|(_, ok)| *ok).map(|(b, _)| b).unwrap_or_else(|| hf.clone());
            let other = if first == hf { mirror } else { hf };
            (vec![first, other], true)
        }
    }
}

enum FetchErr {
    Cancelled,
    /// 最近 SLOW_WINDOW 秒的平均速度 (字节/秒)
    Slow(f64),
    Other(String),
}

/// 下载一个文件到 `dest`: 先写 `.part`, 支持断点续传 (换了源也接着下, 同一个文件), 完整了再改名。
/// `watch`: 速度持续低于 SLOW_BPS 就停下来报 Slow, 让调用方换源。
fn fetch(agent: &ureq::Agent, url: &str, dest: &Path, base_done: u64, watch: bool) -> Result<u64, FetchErr> {
    let other = |e: String| FetchErr::Other(e);
    let part = dest.with_extension("part");
    let have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let mut req = agent.get(url);
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let resp = req.call().map_err(|e| other(format!("{url}: {e}")))?;
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
        .map_err(|e| other(format!("{}: {e}", part.display())))?;
    let mut reader = resp.into_body().into_reader();
    let mut buf = vec![0u8; 256 * 1024];
    let mut got = start;
    // 每秒记一次速度, 留最近 SLOW_WINDOW 个
    let mut mark = (Instant::now(), got);
    let mut samples: VecDeque<f64> = VecDeque::new();
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Err(FetchErr::Cancelled);
        }
        let n = reader.read(&mut buf).map_err(|e| other(format!("{url}: {e}")))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| other(e.to_string()))?;
        got += n as u64;
        let secs = mark.0.elapsed().as_secs_f64();
        if secs >= 1.0 {
            samples.push_back((got - mark.1) as f64 / secs);
            if samples.len() > SLOW_WINDOW {
                samples.pop_front();
            }
            mark = (Instant::now(), got);
        }
        let avg = if samples.is_empty() { 0.0 } else { samples.iter().sum::<f64>() / samples.len() as f64 };
        {
            let mut p = progress();
            p.done = base_done + got;
            p.speed = avg;
        }
        if watch && samples.len() >= SLOW_WINDOW && avg < SLOW_BPS {
            file.flush().map_err(|e| other(e.to_string()))?;
            return Err(FetchErr::Slow(avg));
        }
    }
    file.flush().map_err(|e| other(e.to_string()))?;
    if len > 0 && got != start + len {
        return Err(other(format!("{url}: incomplete ({got} of {} bytes)", start + len)));
    }
    fs::rename(&part, dest).map_err(|e| other(e.to_string()))?;
    Ok(got)
}

/// 换源决定: 当前源慢 (速度 `slow`), 另一个源测过的速度 `other` (没试过是 None)。
/// 返回 true = 换过去; false = 留下 (两个都慢且另一个快不了多少, 就别来回折腾了)
fn should_switch(slow: f64, other: Option<f64>) -> bool {
    match other {
        None => true,
        Some(o) => o > slow * SWITCH_GAIN,
    }
}

fn sha256_hex(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// tokenizer.json 一定是 JSON, 模型一定不是: 防止两个文件错位 / 下到一半的残片被当成完整文件
fn looks_like_tokenizer(path: &Path) -> bool {
    let mut head = [0u8; 1];
    fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && head[0] == b'{'
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
    CANCEL.store(false, Ordering::SeqCst);
    let result = (|| -> Result<(), String> {
        let (order, auto) = source_order(source, &|base| format!("{base}/{}/resolve/main/{}", def.repo, def.onnx));
        let mut cur = 0;
        // 每个源测到的速度 (被判为慢时的), 用来决定要不要换
        let mut speeds: Vec<Option<f64>> = vec![None; order.len()];
        let mut watch = auto && order.len() > 1;
        progress().source = host(&order[cur]);
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
            let mut failures = 0;
            let got = loop {
                let url = format!("{}/{}/resolve/main/{remote}", order[cur], def.repo);
                progress().source = host(&order[cur]);
                match fetch(&agent, &url, &dest, done, watch) {
                    Ok(n) => break n,
                    Err(FetchErr::Cancelled) => return Err("cancelled".into()),
                    Err(FetchErr::Slow(bps)) => {
                        speeds[cur] = Some(bps);
                        let next = (cur + 1) % order.len();
                        if should_switch(bps, speeds[next]) {
                            cur = next;
                            progress().switched = true;
                        } else {
                            if speeds[next].is_some_and(|o| o > bps) {
                                cur = next;
                            }
                            // 两个都慢: 留在快一点的那个上, 不再测速换源
                            watch = false;
                        }
                    }
                    Err(FetchErr::Other(e)) => {
                        // 断线 / 超时: 等一下再试; 自动模式下顺便换到另一个源
                        failures += 1;
                        if failures > 4 {
                            return Err(e);
                        }
                        if auto && order.len() > 1 {
                            cur = (cur + 1) % order.len();
                            progress().switched = true;
                        }
                        std::thread::sleep(Duration::from_secs(2 * failures));
                    }
                }
            };
            done += got;
        }
        // 校验: 模型对得上官方 sha256, tokenizer 是 JSON; 不对就删掉, 下次重下
        progress().verifying = true;
        let model = dir.join("model.onnx");
        let tok = dir.join("tokenizer.json");
        let sum = sha256_hex(&model)?;
        if sum != def.sha256 {
            let _ = fs::remove_file(&model);
            return Err(format!("model.onnx checksum mismatch ({}…), deleted; download again", &sum[..12]));
        }
        if !looks_like_tokenizer(&tok) {
            let _ = fs::remove_file(&tok);
            return Err("tokenizer.json is damaged, deleted; download again".into());
        }
        fs::write(dir.join(".complete"), b"").map_err(|e| e.to_string())?;
        Ok(())
    })();
    let mut p = progress();
    p.active = false;
    p.verifying = false;
    p.speed = 0.0;
    if let Err(e) = &result {
        p.error = e.clone();
    } else {
        p.done = p.total.max(p.done);
    }
    result
}

#[cfg(test)]
mod switch_tests {
    use super::should_switch;

    /// 要先在本机起两个替身源 (一个中途变慢, 一个正常), 用环境变量指过去:
    /// REPOFIND_TEST_HF=http://127.0.0.1:18701 REPOFIND_TEST_MIRROR=http://127.0.0.1:18702 \
    ///   cargo test --release switches_mid_download -- --ignored --nocapture
    #[test]
    #[ignore = "needs two local stand-in hosts"]
    fn switches_mid_download_when_the_host_gets_slow() {
        let dir = std::env::temp_dir().join(format!("repofind-switch-{}", std::process::id()));
        let data = dir.to_str().unwrap().to_string();
        let t0 = std::time::Instant::now();
        super::download(&data, "bge-small-zh-v1.5", "auto").expect("download");
        let p = super::PROGRESS.lock().unwrap().clone();
        println!("{:.0}s, ended on {} (switched: {})", t0.elapsed().as_secs_f64(), p.source, p.switched);
        assert!(p.switched, "should have left the slow host");
        assert_eq!(p.source, std::env::var("REPOFIND_TEST_MIRROR").unwrap().trim_start_matches("http://"));
        // 前半段来自慢的源, 后半段来自另一个, 拼起来的文件仍要和官方 sha256 一致 (download 里校验过)
        assert!(super::is_installed(&data, "bge-small-zh-v1.5"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn switches_to_an_untried_source() {
        assert!(should_switch(25_000.0, None));
    }

    #[test]
    fn stays_when_both_are_about_as_slow() {
        assert!(!should_switch(25_000.0, Some(30_000.0)));
    }

    #[test]
    fn switches_back_when_the_other_is_clearly_faster() {
        assert!(should_switch(25_000.0, Some(150_000.0)));
    }
}
