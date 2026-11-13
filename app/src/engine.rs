//! 本地 embedding 推理: ONNX Runtime + tokenizers。
//!
//! 参数是在 M1 / 16GB 上实测出来的 (multilingual-e5-small int8, 64 段仓库文本):
//! - 关掉图优化: 对 int8 动态量化模型, ORT 的图优化会把权重反量化成 fp32 常量,
//!   内存从 0.96GB 涨到 3.3GB, 每条还慢 2~3 倍 (51ms → 136ms)
//! - 关掉 CPU 内存池: 峰值内存跟着实际 batch 走, 推理完就还给系统
//! - 只取前 256 个 token: 仓库文本最有用的名称 / 简介 / 关键词都在开头;
//!   512 个 token 时耗时和内存都翻倍
//! - 先 tokenize 再按长度排序, 按 token 预算分批: padding 最少, 每批内存有上限
//! - 线程数取性能核数量: 再多反而被效率核拖慢
//! - 结果做 L2 归一化, 检索时点积就是余弦

use ndarray::Array2;
use ort::{
    ep,
    session::{builder::GraphOptimizationLevel, Session},
    value::Value,
};
use std::path::Path;
use tokenizers::{Encoding, Tokenizer, TruncationParams};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Pooling {
    Mean,
    Cls,
}

#[derive(Clone, Copy, Debug)]
pub struct Spec {
    pub pooling: Pooling,
    pub query_prefix: &'static str,
    pub passage_prefix: &'static str,
    pub max_tokens: usize,
}

/// 一批里 token 数 (条数 × 最长序列) 的上限: 控制峰值内存
const TOKEN_BUDGET: usize = 2048;
const MAX_BATCH: usize = 16;

pub struct Engine {
    session: Session,
    tokenizer: Tokenizer,
    spec: Spec,
    type_ids: bool,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// ORT 一个进程只能有一个 Environment, 所有模型共用
fn environment() -> Result<ort::environment::Environment, String> {
    static ENV: std::sync::Mutex<Option<ort::environment::Environment>> = std::sync::Mutex::new(None);
    let mut slot = ENV.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(e) = slot.as_ref() {
        return Ok(e.clone());
    }
    let e = ort::init().with_name("repofind").build().map_err(err)?;
    *slot = Some(e.clone());
    Ok(e)
}

/// 推理线程数: 性能核数量 (大多数机器上约为逻辑核的一半), 2~8 个
pub fn default_threads() -> usize {
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    (n / 2).clamp(2, 8)
}

impl Engine {
    pub fn load(model: &Path, tokenizer: &Path, spec: Spec, threads: usize) -> Result<Self, String> {
        let mut tok = Tokenizer::from_file(tokenizer).map_err(err)?;
        tok.with_truncation(Some(TruncationParams { max_length: spec.max_tokens, ..Default::default() }))
            .map_err(err)?;
        tok.with_padding(None);

        let session = Session::builder(&environment()?)
            .map_err(err)?
            .with_optimization_level(GraphOptimizationLevel::Disable)
            .map_err(err)?
            .with_intra_threads(threads.max(1))
            .map_err(err)?
            .with_memory_pattern(false)
            .map_err(err)?
            .with_execution_providers([ep::CPU::default().with_arena_allocator(false).build()])
            .map_err(err)?
            .commit_from_file(model)
            .map_err(err)?;
        let type_ids = session.inputs().iter().any(|i| i.name() == "token_type_ids");
        Ok(Engine { session, tokenizer: tok, spec, type_ids })
    }

    /// 每段文本一个归一化后的向量, 拼成一维 (第 i 个向量在 [i*dim, (i+1)*dim))
    pub fn embed(&mut self, texts: &[String], query: bool) -> Result<(Vec<f32>, usize), String> {
        let prefix = if query { self.spec.query_prefix } else { self.spec.passage_prefix };
        let inputs: Vec<String> = texts.iter().map(|t| format!("{prefix}{t}")).collect();
        let enc = self.tokenizer.encode_batch(inputs, true).map_err(err)?;

        // 按长度排序后分批: 长度相近的放一起, padding 少
        let mut order: Vec<usize> = (0..enc.len()).collect();
        order.sort_by_key(|&i| enc[i].get_ids().len());
        let mut out: Vec<Vec<f32>> = vec![Vec::new(); enc.len()];
        let mut start = 0;
        while start < order.len() {
            let mut end = start + 1;
            while end < order.len() && end - start < MAX_BATCH {
                let longest = enc[order[end]].get_ids().len();
                if longest * (end - start + 1) > TOKEN_BUDGET {
                    break;
                }
                end += 1;
            }
            let idx = &order[start..end];
            let vecs = self.run_batch(idx.iter().map(|&i| &enc[i]).collect())?;
            for (k, v) in idx.iter().zip(vecs) {
                out[*k] = v;
            }
            start = end;
        }
        let dim = out.first().map(|v| v.len()).unwrap_or(0);
        Ok((out.concat(), dim))
    }

    fn run_batch(&mut self, batch: Vec<&Encoding>) -> Result<Vec<Vec<f32>>, String> {
        let n = batch.len();
        let len = batch.iter().map(|e| e.get_ids().len()).max().unwrap_or(1).max(1);
        let mut ids = Array2::<i64>::zeros((n, len));
        let mut mask = Array2::<i64>::zeros((n, len));
        let mut types = Array2::<i64>::zeros((n, len));
        for (r, e) in batch.iter().enumerate() {
            for (c, &id) in e.get_ids().iter().enumerate() {
                ids[[r, c]] = id as i64;
                mask[[r, c]] = 1;
            }
            for (c, &t) in e.get_type_ids().iter().enumerate() {
                types[[r, c]] = t as i64;
            }
        }
        let mut inputs = ort::inputs![
            "input_ids" => Value::from_array(ids).map_err(err)?,
            "attention_mask" => Value::from_array(mask.clone()).map_err(err)?,
        ];
        if self.type_ids {
            inputs.push(("token_type_ids".into(), Value::from_array(types).map_err(err)?.into()));
        }
        let outputs = self.session.run(inputs).map_err(err)?;
        let hidden = outputs[0].try_extract_array::<f32>().map_err(err)?;
        let shape = hidden.shape().to_vec();
        let mut result = Vec::with_capacity(n);
        for r in 0..n {
            let mut v: Vec<f32> = if shape.len() == 2 {
                // 模型已经输出句向量 [batch, dim]
                (0..shape[1]).map(|d| hidden[[r, d]]).collect()
            } else {
                let dim = shape[2];
                match self.spec.pooling {
                    Pooling::Cls => (0..dim).map(|d| hidden[[r, 0, d]]).collect(),
                    Pooling::Mean => {
                        let mut acc = vec![0f32; dim];
                        let mut count = 0f32;
                        for c in 0..len {
                            if mask[[r, c]] == 1 {
                                count += 1.0;
                                for (d, a) in acc.iter_mut().enumerate() {
                                    *a += hidden[[r, c, d]];
                                }
                            }
                        }
                        acc.iter_mut().for_each(|x| *x /= count.max(1.0));
                        acc
                    }
                }
            };
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
            v.iter_mut().for_each(|x| *x /= norm);
            result.push(v);
        }
        Ok(result)
    }
}
