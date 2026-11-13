/**
 * embedder.ts — 向量从哪来: 三选一
 *   local    应用内置推理 (Rust + ONNX Runtime), 模型下载到本机, 不联网也能用
 *   service  本机跑着的 OpenAI 兼容服务 (LM Studio / llama.cpp / Ollama …)
 *   api      外部 OpenAI 兼容接口 (OpenAI / SiliconFlow / DashScope / 自建代理 …)
 */

import { Local } from "repofind/native";
import { embedTexts } from "./lib";

export type Provider = "local" | "service" | "api";
export type Source = "auto" | "hf" | "mirror";

export interface RemoteCfg {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface EmbedSettings {
  provider: Provider;
  local: { model: string; source: Source };
  service: RemoteCfg;
  api: RemoteCfg;
}

export const DEFAULT_LOCAL_MODEL = "multilingual-e5-small";

export const DEFAULT_SETTINGS: EmbedSettings = {
  provider: "local",
  local: { model: DEFAULT_LOCAL_MODEL, source: "auto" },
  service: { baseUrl: "http://127.0.0.1:1234/v1", model: "", apiKey: "" },
  api: { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", apiKey: "" },
};

/** 读 Storage 里存的配置; 也认老版本只有 { baseUrl, model, apiKey } 的格式 (当作外部 API) */
export function parseSettings(raw: string | null, legacy: string | null): EmbedSettings {
  const base = structuredCloneSettings(DEFAULT_SETTINGS);
  try {
    if (raw) {
      const s = JSON.parse(raw);
      return {
        provider: s.provider === "service" || s.provider === "api" ? s.provider : "local",
        local: { ...base.local, ...s.local },
        service: { ...base.service, ...s.service },
        api: { ...base.api, ...s.api },
      };
    }
    if (legacy) {
      const old = JSON.parse(legacy);
      const api = { ...base.api, ...old };
      // 老用户配过 key 就继续用原来的接口, 不打断他已经建好的语义索引
      return { ...base, provider: old.apiKey ? "api" : "local", api };
    }
  } catch { /* 坏数据: 用默认 */ }
  return base;
}

function structuredCloneSettings(s: EmbedSettings): EmbedSettings {
  return { provider: s.provider, local: { ...s.local }, service: { ...s.service }, api: { ...s.api } };
}

/** 生成向量的 "身份": 不同身份的向量不在同一个空间里, 不能混着比 */
export function embedKey(s: EmbedSettings): string {
  if (s.provider === "local") return `local:${s.local.model}`;
  const r = s.provider === "service" ? s.service : s.api;
  return `${s.provider}:${r.baseUrl.replace(/\/+$/, "")}#${r.model}`;
}

/** 现在能不能生成向量 (本地: 模型已下载; 服务: 填了地址和模型; API: 还要有 key) */
export function canEmbed(s: EmbedSettings, installed: string[]): boolean {
  if (s.provider === "local") return installed.includes(s.local.model);
  if (s.provider === "service") return !!s.service.baseUrl && !!s.service.model;
  return !!s.api.baseUrl && !!s.api.model && !!s.api.apiKey;
}

/** 本地推理一次送多少条: 小一点, 进度更新得勤, 每次占用后台线程的时间也短 */
const LOCAL_CHUNK = 24;

/**
 * 生成向量。query: 查询句 (本地模型会按模型要求加 "query: " 之类的前缀)。
 * 返回的向量都已归一化 (本地) 或原样 (远程, 检索时算余弦)。
 */
export async function embed(
  s: EmbedSettings,
  dataDir: string,
  texts: string[],
  query: boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[]> {
  if (!texts.length) return [];
  if (s.provider !== "local") {
    const r = s.provider === "service" ? s.service : s.api;
    return embedTexts(r, texts, 32, onProgress);
  }
  if (!dataDir) throw new Error("no data directory for local models on this platform");
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += LOCAL_CHUNK) {
    const chunk = texts.slice(i, i + LOCAL_CHUNK).map((t) => t.slice(0, 4000));
    const flat = await Local.embed(dataDir, s.local.model, chunk, query);
    const dim = flat.length / chunk.length;
    if (!Number.isInteger(dim) || dim <= 0) throw new Error("local model returned a malformed result");
    const all = Float32Array.from(flat);
    for (let k = 0; k < chunk.length; k++) out.push(all.subarray(k * dim, (k + 1) * dim));
    onProgress?.(Math.min(i + LOCAL_CHUNK, texts.length), texts.length);
  }
  return out;
}

/** 试一次: 成功给出维度和耗时, 失败抛出原因 */
export async function probe(s: EmbedSettings, dataDir: string): Promise<{ dim: number; ms: number }> {
  const t0 = Date.now();
  const [v] = await embed(s, dataDir, ["repository search test"], true);
  return { dim: v.length, ms: Date.now() - t0 };
}
