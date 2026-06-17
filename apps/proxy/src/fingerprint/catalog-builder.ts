import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { B3itTextBaseline } from "./model-fingerprint-catalog.js";
import { buildOpenAiUpstreamUrl, isObject, nowIso } from "../utils.js";

interface BuilderPromptInput {
  id?: string;
  prompt: string;
}

interface BuilderModelInput {
  id: string;
  label: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  providerTag?: string;
  modelFamily?: string;
  source?: string;
  notes?: string;
  topK?: number;
  samplesPerPrompt?: number;
  permutationIters?: number;
  systemPrompt?: string;
  vector?: Record<string, unknown>;
  prompts?: Array<string | BuilderPromptInput>;
}

interface BuilderDefaultsInput {
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  providerTag?: string;
  source?: string;
  topK?: number;
  samplesPerPrompt?: number;
  permutationIters?: number;
  systemPrompt?: string;
}

export interface CatalogBuildInput {
  defaults?: BuilderDefaultsInput;
  models: BuilderModelInput[];
}

interface PromptSamplingSummary {
  id: string;
  attempts: number;
  successes: number;
  unsupportedCount?: number;
  failureCount?: number;
}

interface B3itPromptSamplingSummary {
  id: string;
  prompt: string;
  discoveryAttempts: number;
  discoverySuccesses: number;
  discoveryUniqueOutputs: number;
  borderScore: number;
  referenceAttempts: number;
  referenceSuccesses: number;
  referenceUniqueOutputs: number;
}

interface B3itRunSummary {
  candidatePromptCount: number;
  discoveryQueriesPerPrompt: number;
  selectedBorderPromptCount: number;
  minRequiredBorderPrompts: number;
  phase1TopCount: number;
  phase2VariantsTested: number;
  phase2SelectedFromVariants: number;
  prompts: B3itPromptSamplingSummary[];
}

interface ModelBuildSummary {
  modelId: string;
  label: string;
  topK: number;
  samplesPerPrompt: number;
  prompts: PromptSamplingSummary[];
  runMode?: "paper_logprob" | "b3it_fallback";
  b3it?: B3itRunSummary;
  logprobsUnsupportedLikely?: boolean;
  totalUnsupportedCount?: number;
  totalFailureCount?: number;
}

export interface CatalogBuildResult {
  ok: boolean;
  dryRun: boolean;
  outputPath: string | null;
  profileCount: number;
  report: ModelBuildSummary[];
  catalogPreview?: unknown;
}

interface BuildOptions {
  dryRun: boolean;
  outputPath?: string;
  samplesPerPrompt?: number;
  topK?: number;
  permutationIters?: number;
  maxAttemptFactor?: number;
  timeoutSeconds?: number;
  sleepMs?: number;
  promptConcurrency?: number;
  sampleConcurrency?: number;
  logger?: FastifyBaseLogger;
}

const CATALOG_EXPORT_RE =
  /(export const BUILTIN_MODEL_FINGERPRINT_CATALOG: ModelFingerprintProfile\[\]\s*=\s*)(\[[\s\S]*?\])(\s*;)/m;

/**
 * 固定题集（内部维护）：强调 one-token logprobs 区分度，不对用户暴露编辑入口。
 * 提示词均为短前缀，适配论文中的重复采样场景。
 */
const FIXED_CATALOG_PROMPTS: BuilderPromptInput[] = [
  { id: "capital_fr", prompt: "The capital of France is" },
  { id: "math_2p2", prompt: "2 + 2 =" },
  { id: "opposite_hot", prompt: "The opposite of hot is" },
  { id: "ocean_large", prompt: "The largest ocean on Earth is" },
  { id: "first_planet", prompt: "The first planet from the Sun is" },
  { id: "water_formula", prompt: "The chemical formula of water is" },
  { id: "speed_light_unit", prompt: "The speed of light is approximately" },
  { id: "file_extension_ts", prompt: "A TypeScript source file usually ends with" },
  { id: "http_429_meaning", prompt: "HTTP status code 429 means" },
  { id: "weekday_after_monday", prompt: "The day after Monday is" },
  { id: "primary_color_blue_mix", prompt: "To make purple, you mix red and" },
  { id: "json_object_start", prompt: "A JSON object starts with" }
];

/**
 * Internal B3IT-style candidate prompts used when logprobs are unavailable.
 * They are intentionally short and ambiguous to increase border-input hit rate.
 */
const FIXED_B3IT_CANDIDATE_PROMPTS: BuilderPromptInput[] = [
  { id: "bi_the", prompt: "The" },
  { id: "bi_a", prompt: "A" },
  { id: "bi_in", prompt: "In" },
  { id: "bi_on", prompt: "On" },
  { id: "bi_for", prompt: "For" },
  { id: "bi_after", prompt: "After" },
  { id: "bi_before", prompt: "Before" },
  { id: "bi_not", prompt: "Not" },
  { id: "bi_very", prompt: "Very" },
  { id: "bi_data", prompt: "Data" },
  { id: "bi_model", prompt: "Model" },
  { id: "bi_token", prompt: "Token" },
  { id: "bi_http", prompt: "HTTP" },
  { id: "bi_json", prompt: "JSON" },
  { id: "bi_api", prompt: "API" },
  { id: "bi_open", prompt: "Open" },
  { id: "bi_write_one_word", prompt: "Write exactly one word:" },
  { id: "bi_day_after", prompt: "The day after Monday is" },
  { id: "bi_opposite_hot", prompt: "The opposite of hot is" },
  { id: "bi_first_month", prompt: "The first month of the year is" },
  { id: "bi_currency_japan", prompt: "The currency used in Japan is" },
  { id: "bi_planet_largest", prompt: "The largest planet in our solar system is" },
  { id: "bi_language_python", prompt: "The file extension for Python is" },
  { id: "bi_binary_two", prompt: "In binary, decimal 2 is" }
];

/**
 * Expanded candidate prompt pool for adaptive border-input discovery.
 * Organized by category to cover diverse linguistic and semantic dimensions.
 * Phase 1 scans the entire pool; Phase 2 generates variants of top scorers.
 */
const CANDIDATE_PROMPT_POOL: BuilderPromptInput[] = [
  // — Single token / short ambiguous openers —
  { id: "ap_the", prompt: "The" },
  { id: "ap_a", prompt: "A" },
  { id: "ap_in", prompt: "In" },
  { id: "ap_on", prompt: "On" },
  { id: "ap_for", prompt: "For" },
  { id: "ap_after", prompt: "After" },
  { id: "ap_before", prompt: "Before" },
  { id: "ap_not", prompt: "Not" },
  { id: "ap_very", prompt: "Very" },
  { id: "ap_it", prompt: "It" },
  { id: "ap_when", prompt: "When" },
  { id: "ap_but", prompt: "But" },
  { id: "ap_so", prompt: "So" },
  { id: "ap_then", prompt: "Then" },
  { id: "ap_once", prompt: "Once" },
  // — Technical / domain terms —
  { id: "ap_data", prompt: "Data" },
  { id: "ap_model", prompt: "Model" },
  { id: "ap_token", prompt: "Token" },
  { id: "ap_http", prompt: "HTTP" },
  { id: "ap_json", prompt: "JSON" },
  { id: "ap_api", prompt: "API" },
  { id: "ap_open", prompt: "Open" },
  // — Factual completions —
  { id: "ap_day_after", prompt: "The day after Monday is" },
  { id: "ap_opposite_hot", prompt: "The opposite of hot is" },
  { id: "ap_first_month", prompt: "The first month of the year is" },
  { id: "ap_currency_japan", prompt: "The currency used in Japan is" },
  { id: "ap_planet_largest", prompt: "The largest planet in our solar system is" },
  { id: "ap_ext_python", prompt: "The file extension for Python is" },
  { id: "ap_binary_two", prompt: "In binary, decimal 2 is" },
  { id: "ap_boiling_water", prompt: "The boiling point of water in Celsius is" },
  { id: "ap_speed_light", prompt: "The speed of light is approximately" },
  { id: "ap_largest_ocean", prompt: "The largest ocean on Earth is the" },
  { id: "ap_capital_france", prompt: "The capital of France is" },
  { id: "ap_water_formula", prompt: "The chemical formula of water is" },
  // — Code / technical completions —
  { id: "ap_code_def", prompt: "def " },
  { id: "ap_code_select", prompt: "SELECT " },
  { id: "ap_code_import", prompt: "import " },
  { id: "ap_code_function", prompt: "function " },
  { id: "ap_code_return", prompt: "return " },
  { id: "ap_code_const", prompt: "const " },
  { id: "ap_code_if", prompt: "if (" },
  { id: "ap_code_class", prompt: "public class " },
  // — Multi-language triggers —
  { id: "ap_lang_la", prompt: "La" },
  { id: "ap_lang_der", prompt: "Der" },
  { id: "ap_lang_ja", prompt: "日本" },
  { id: "ap_lang_zh", prompt: "这" },
  { id: "ap_lang_le", prompt: "Le" },
  // — Instruction-style —
  { id: "ap_instr_yesno", prompt: "Say yes or no:" },
  { id: "ap_instr_number", prompt: "Answer with a number:" },
  { id: "ap_instr_json", prompt: "Respond in JSON:" },
  { id: "ap_instr_one_word", prompt: "Write exactly one word:" },
  { id: "ap_instr_translate", prompt: "Translate to French:" },
];

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        break;
      }
      results[index] = await mapper(items[index] as T, index);
    }
  });

  await Promise.all(workers);
  return results;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stablePromptId(prompt: string, index: number): string {
  const cleaned = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const tail = cleaned.slice(0, 20) || "prompt";
  return `p${index}_${tail}`;
}

function resolveApiKey(apiKey: string | undefined, apiKeyEnv: string | undefined): string | undefined {
  if (apiKey && apiKey.trim().length > 0) {
    return apiKey.trim();
  }
  if (apiKeyEnv && process.env[apiKeyEnv]) {
    return process.env[apiKeyEnv];
  }
  return undefined;
}

function buildChatCompletionsUrl(baseUrl: string): string {
  return buildOpenAiUpstreamUrl(baseUrl, "/v1/chat/completions");
}

type TokenLimitParam = "max_tokens" | "max_completion_tokens";

/**
 * B3IT samples only the FIRST visible word of each response (see
 * `normalizeTokenSample`), so the output budget only needs to be big enough for
 * reasoning models to finish deliberation and emit at least one visible token.
 * 1024 is comfortably above what gpt-5.x / gemini-3-pro / deepseek-v4 / glm-4.x
 * use for typical B3IT border prompts, while still being a small fraction of
 * any model's context window. Non-reasoning models produce the exact same first
 * word at budget 16 vs 1024 — the extra headroom costs only a few cents per run.
 */
const SAMPLING_MAX_TOKENS = 1024;

// Models that reject temperature=0 (e.g. claude-opus-4-7 on Bedrock).
// Populated on first failure; subsequent calls skip temperature entirely.
const temperatureUnsupportedModels = new Set<string>();

/**
 * Probe whether this model wants `max_tokens` or `max_completion_tokens`.
 * Reasoning models (gpt-5.x, o-series) reject `max_tokens` and demand
 * `max_completion_tokens`. A single 1-token probe is enough to find out.
 */
async function detectTokenLimitParam(args: {
  url: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
}): Promise<TokenLimitParam> {
  try {
    const response = await fetch(args.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.apiKey}`
      },
      body: JSON.stringify({
        model: args.model,
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0,
        max_tokens: 1,
        stream: false
      }),
      signal: AbortSignal.timeout(Math.round(args.timeoutSeconds * 1000))
    });

    if (response.ok) {
      await response.text();
      return "max_tokens";
    }

    const text = await response.text();
    const lower = text.toLowerCase();
    if (
      lower.includes("max_completion_tokens") ||
      (lower.includes("max_tokens") && (lower.includes("not supported") || lower.includes("unsupported")))
    ) {
      return "max_completion_tokens";
    }
    return "max_tokens";
  } catch {
    return "max_tokens";
  }
}

function normalizeTopLogprobVector(values: number[], topK: number): number[] {
  const sorted = [...values].sort((a, b) => b - a).slice(0, topK);
  while (sorted.length < topK) {
    sorted.push(-20);
  }
  return sorted;
}

function extractTopLogprobVector(payload: unknown, topK: number): number[] | null {
  if (!isObject(payload)) {
    return null;
  }

  const choices = payload.choices;
  if (!Array.isArray(choices)) {
    return null;
  }

  for (const choice of choices) {
    if (!isObject(choice)) {
      continue;
    }

    const logprobs = choice.logprobs;
    if (!isObject(logprobs)) {
      continue;
    }

    const content = logprobs.content;
    if (Array.isArray(content)) {
      for (const token of content) {
        if (!isObject(token)) {
          continue;
        }

        const candidates: number[] = [];
        if (typeof token.logprob === "number" && Number.isFinite(token.logprob)) {
          candidates.push(token.logprob);
        }

        const tops = token.top_logprobs;
        if (Array.isArray(tops)) {
          for (const top of tops) {
            if (isObject(top) && typeof top.logprob === "number" && Number.isFinite(top.logprob)) {
              candidates.push(top.logprob);
            }
          }
        }

        if (candidates.length > 0) {
          return normalizeTopLogprobVector(candidates, topK);
        }
      }
    }

    const legacy = logprobs.token_logprobs;
    if (Array.isArray(legacy)) {
      const first = legacy[0];
      if (typeof first === "number" && Number.isFinite(first)) {
        return normalizeTopLogprobVector([first], topK);
      }
    }
  }

  return null;
}

async function requestOneSample(args: {
  url: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  topK: number;
  timeoutSeconds: number;
  tokenLimitParam?: TokenLimitParam;
}): Promise<{ vector: number[] | null; logprobsUnsupported: boolean }> {
  const inferLogprobsUnsupported = (status: number, text: string, parsed: unknown): boolean => {
    if (![400, 404, 422, 501].includes(status)) {
      return false;
    }
    const parts = [text];
    if (isObject(parsed) && isObject(parsed.error)) {
      const error = parsed.error as Record<string, unknown>;
      if (typeof error.message === "string") {
        parts.push(error.message);
      }
      if (typeof error.type === "string") {
        parts.push(error.type);
      }
      if (typeof error.code === "string") {
        parts.push(error.code);
      }
    }
    const normalized = parts.join(" ").toLowerCase();
    return (
      normalized.includes("logprobs") &&
      (normalized.includes("not support") ||
        normalized.includes("unsupported") ||
        normalized.includes("unknown") ||
        normalized.includes("invalid") ||
        normalized.includes("not allowed") ||
        normalized.includes("only allowed when") ||
        normalized.includes("not enabled") ||
        normalized.includes("is disabled"))
    );
  };

  const tlp = args.tokenLimitParam ?? "max_tokens";
  let response: Response;
  try {
    response = await fetch(args.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.apiKey}`
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: "system", content: args.systemPrompt },
          { role: "user", content: args.userPrompt }
        ],
        temperature: 0,
        max_tokens: 1,
        stream: false,
        logprobs: true,
        top_logprobs: args.topK
      }),
      signal: AbortSignal.timeout(Math.round(args.timeoutSeconds * 1000))
    });
  } catch {
    return { vector: null, logprobsUnsupported: false };
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return {
      vector: null,
      logprobsUnsupported: inferLogprobsUnsupported(response.status, text, parsed)
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { vector: null, logprobsUnsupported: false };
  }

  const vector = extractTopLogprobVector(json, args.topK);
  if (vector) {
    return { vector, logprobsUnsupported: false };
  }

  // Some compatible endpoints ignore `logprobs` silently and return choices without logprobs.
  if (isObject(json) && Array.isArray(json.choices)) {
    const hasAnyChoiceLogprobs = json.choices.some((choice) => isObject(choice) && isObject(choice.logprobs));
    if (!hasAnyChoiceLogprobs) {
      return { vector: null, logprobsUnsupported: true };
    }
  }

  return { vector: null, logprobsUnsupported: false };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const piece of content) {
    if (!isObject(piece)) {
      continue;
    }
    if (typeof piece.text === "string") {
      parts.push(piece.text);
    }
  }
  return parts.join("");
}

function extractAssistantText(payload: unknown): string {
  if (!isObject(payload)) {
    return typeof payload === "string" ? payload : "";
  }

  const chunks: string[] = [];
  const choices = payload.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isObject(choice)) {
        continue;
      }

      const message = choice.message;
      if (isObject(message)) {
        const text = contentToText(message.content);
        if (text.length > 0) {
          chunks.push(text);
        }
        // Reasoning models (DeepSeek V4, GLM 4.x, some GPT-5/Gemini 3) emit empty
        // content and put the visible output in reasoning_content / reasoning / thinking.
        for (const field of ["reasoning_content", "reasoning", "thinking"] as const) {
          const extra = contentToText(message[field]);
          if (extra.length > 0) {
            chunks.push(extra);
          }
        }
      }

      const delta = choice.delta;
      if (isObject(delta)) {
        const text = contentToText(delta.content);
        if (text.length > 0) {
          chunks.push(text);
        }
        for (const field of ["reasoning_content", "reasoning", "thinking"] as const) {
          const extra = contentToText(delta[field]);
          if (extra.length > 0) {
            chunks.push(extra);
          }
        }
      }

      if (typeof choice.text === "string" && choice.text.length > 0) {
        chunks.push(choice.text);
      }
    }
  }

  const output = payload.output;
  if (Array.isArray(output)) {
    for (const block of output) {
      if (!isObject(block)) {
        continue;
      }

      if (typeof block.text === "string" && block.text.length > 0) {
        chunks.push(block.text);
      }

      if (!Array.isArray(block.content)) {
        continue;
      }
      for (const piece of block.content) {
        if (isObject(piece) && typeof piece.text === "string") {
          chunks.push(piece.text);
        }
      }
    }
  }

  return chunks.join("");
}

function normalizeTokenSample(text: string): string | null {
  const clean = text.replace(/\r/g, "");
  if (clean.length === 0) {
    return null;
  }

  const first = clean.match(/^\s*\S+/u)?.[0] ?? clean.slice(0, 24);
  const escaped = first.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  const token = escaped.slice(0, 64);
  return token.length > 0 ? token : null;
}

async function requestOneTextTokenSample(args: {
  url: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutSeconds: number;
  tokenLimitParam?: TokenLimitParam;
}): Promise<string | null> {
  const tlp = args.tokenLimitParam ?? "max_tokens";

  const doFetch = async (includeTemperature: boolean): Promise<Response | null> => {
    try {
      return await fetch(args.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${args.apiKey}`
        },
        body: JSON.stringify({
          model: args.model,
          messages: [
            { role: "system", content: args.systemPrompt },
            { role: "user", content: args.userPrompt }
          ],
          ...(includeTemperature ? { temperature: 0 } : {}),
          [tlp]: SAMPLING_MAX_TOKENS,
          stream: false
        }),
        signal: AbortSignal.timeout(Math.round(args.timeoutSeconds * 1000))
      });
    } catch {
      return null;
    }
  };

  const useTemp = !temperatureUnsupportedModels.has(args.model);
  let response = await doFetch(useTemp);
  if (!response) return null;

  if (!response.ok) {
    const errText = await response.text();
    if (useTemp && errText.toLowerCase().includes("temperature")) {
      temperatureUnsupportedModels.add(args.model);
      response = await doFetch(false);
      if (!response || !response.ok) return null;
    } else {
      return null;
    }
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const output = parsed ? extractAssistantText(parsed) : text;
  return normalizeTokenSample(output);
}

function countsFromSamples(samples: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    counts.set(sample, (counts.get(sample) ?? 0) + 1);
  }
  return counts;
}

function entropyFromCounts(counts: Map<string, number>, total: number): number {
  if (total <= 0 || counts.size === 0) {
    return 0;
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    if (p > 0) {
      entropy -= p * Math.log(p);
    }
  }
  return entropy;
}

function scoreBorderPrompt(samples: string[]): { uniqueOutputs: number; score: number } {
  const total = samples.length;
  if (total === 0) {
    return { uniqueOutputs: 0, score: 0 };
  }
  const counts = countsFromSamples(samples);
  const uniqueOutputs = counts.size;
  const maxShare = Math.max(...counts.values()) / total;
  const entropy = entropyFromCounts(counts, total);
  const normalizedEntropy = uniqueOutputs > 1 ? entropy / Math.log(uniqueOutputs) : 0;
  const score = (1 - maxShare) * 0.7 + normalizedEntropy * 0.3;
  return {
    uniqueOutputs,
    score
  };
}

/**
 * Generate prompt variants to explore nearby border inputs.
 * Strategies: shorten (increase ambiguity), instruct (add prefix), reframe (wrap in quotes).
 */
function generatePromptVariants(prompt: BuilderPromptInput): BuilderPromptInput[] {
  const baseId = prompt.id ?? "p";
  const variants: BuilderPromptInput[] = [];
  const words = prompt.prompt.trim().split(/\s+/);

  // Shorten: truncate to first half — increases ambiguity
  if (words.length >= 3) {
    const half = words.slice(0, Math.ceil(words.length / 2)).join(" ");
    variants.push({ id: `${baseId}_short`, prompt: half });
  }

  // Instruct: add instruction prefix to change model interpretation
  variants.push({
    id: `${baseId}_instr`,
    prompt: `Complete in one word: ${prompt.prompt}`
  });

  // Reframe: wrap in quotes with continuation marker
  variants.push({
    id: `${baseId}_reframe`,
    prompt: `"${prompt.prompt}" —`
  });

  return variants;
}

async function samplePromptTextTokens(args: {
  url: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  targetSamples: number;
  maxAttempts: number;
  timeoutSeconds: number;
  sleepMs: number;
  sampleConcurrency: number;
  tokenLimitParam?: TokenLimitParam;
}): Promise<{ samples: string[]; attempts: number }> {
  const samples: string[] = [];
  let attempts = 0;
  let stop = false;
  const workerCount = Math.max(1, Math.min(args.sampleConcurrency, args.maxAttempts));

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (stop) {
        break;
      }
      if (attempts >= args.maxAttempts) {
        break;
      }
      attempts += 1;

      const sample = await requestOneTextTokenSample({
        url: args.url,
        apiKey: args.apiKey,
        model: args.model,
        systemPrompt: args.systemPrompt,
        userPrompt: args.prompt,
        timeoutSeconds: args.timeoutSeconds,
        tokenLimitParam: args.tokenLimitParam
      });
      if (sample !== null) {
        samples.push(sample);
        if (samples.length >= args.targetSamples) {
          stop = true;
        }
      }

      if (args.sleepMs > 0) {
        await sleep(args.sleepMs);
      }
    }
  });

  await Promise.all(workers);
  return {
    samples: samples.slice(0, args.targetSamples),
    attempts
  };
}

async function buildB3itFallbackBaseline(args: {
  modelId: string;
  modelName: string;
  url: string;
  apiKey: string;
  systemPrompt: string;
  samplesPerPrompt: number;
  permutationIters: number;
  timeoutSeconds: number;
  sleepMs: number;
  promptConcurrency: number;
  sampleConcurrency: number;
  maxAttemptFactor: number;
  tokenLimitParam?: TokenLimitParam;
  logger?: FastifyBaseLogger;
}): Promise<{ baseline: B3itTextBaseline; summary: B3itRunSummary }> {
  const phase1Prompts = CANDIDATE_PROMPT_POOL;
  const phase1SamplesPerPrompt = 3;
  const phase1TopCount = 8;
  const maxBorderPrompts = 8;
  const minRequiredBorderPrompts = 3;
  const phase1MaxAttempts = Math.max(phase1SamplesPerPrompt, Math.floor(phase1SamplesPerPrompt * args.maxAttemptFactor));

  // ── Phase 1: Broad scan of the full candidate pool ──
  args.logger?.info(
    { modelId: args.modelId, candidateCount: phase1Prompts.length, samplesPerPrompt: phase1SamplesPerPrompt },
    "Adaptive discovery Phase 1: broad scan starting"
  );

  const phase1Rows = await mapWithConcurrency(phase1Prompts, args.promptConcurrency, async (prompt) => {
    const sampled = await samplePromptTextTokens({
      url: args.url,
      apiKey: args.apiKey,
      model: args.modelName,
      systemPrompt: args.systemPrompt,
      prompt: prompt.prompt,
      targetSamples: phase1SamplesPerPrompt,
      maxAttempts: phase1MaxAttempts,
      timeoutSeconds: args.timeoutSeconds,
      sleepMs: args.sleepMs,
      sampleConcurrency: args.sampleConcurrency,
      tokenLimitParam: args.tokenLimitParam
    });
    const scored = scoreBorderPrompt(sampled.samples);
    return {
      promptId: prompt.id ?? stablePromptId(prompt.prompt, 1),
      prompt: prompt.prompt,
      discoveryAttempts: sampled.attempts,
      discoverySuccesses: sampled.samples.length,
      discoveryUniqueOutputs: scored.uniqueOutputs,
      borderScore: scored.score,
      isVariant: false
    };
  });

  // Select top candidates from Phase 1
  const phase1Top = phase1Rows
    .filter((row) => row.discoverySuccesses >= 2)
    .sort((a, b) => b.borderScore - a.borderScore)
    .slice(0, phase1TopCount);

  args.logger?.info(
    { modelId: args.modelId, phase1Top: phase1Top.map((r) => ({ id: r.promptId, score: r.borderScore, unique: r.discoveryUniqueOutputs })) },
    "Adaptive discovery Phase 1: top candidates selected"
  );

  // ── Phase 2: Generate and test variants of top candidates ──
  const variantInputs: BuilderPromptInput[] = [];
  for (const row of phase1Top) {
    const variants = generatePromptVariants({ id: row.promptId, prompt: row.prompt });
    variantInputs.push(...variants);
  }

  args.logger?.info(
    { modelId: args.modelId, variantCount: variantInputs.length },
    "Adaptive discovery Phase 2: variant exploration starting"
  );

  const phase2Rows = await mapWithConcurrency(variantInputs, args.promptConcurrency, async (prompt) => {
    const sampled = await samplePromptTextTokens({
      url: args.url,
      apiKey: args.apiKey,
      model: args.modelName,
      systemPrompt: args.systemPrompt,
      prompt: prompt.prompt,
      targetSamples: phase1SamplesPerPrompt,
      maxAttempts: phase1MaxAttempts,
      timeoutSeconds: args.timeoutSeconds,
      sleepMs: args.sleepMs,
      sampleConcurrency: args.sampleConcurrency,
      tokenLimitParam: args.tokenLimitParam
    });
    const scored = scoreBorderPrompt(sampled.samples);
    return {
      promptId: prompt.id ?? stablePromptId(prompt.prompt, 1),
      prompt: prompt.prompt,
      discoveryAttempts: sampled.attempts,
      discoverySuccesses: sampled.samples.length,
      discoveryUniqueOutputs: scored.uniqueOutputs,
      borderScore: scored.score,
      isVariant: true
    };
  });

  // ── Final selection: pick top prompts from Phase 1 + Phase 2 combined ──
  const allCandidates = [...phase1Top, ...phase2Rows];

  // Prefer border prompts (diverse outputs), but fall back to deterministic prompts
  // if the model is too confident. Deterministic outputs are still valid fingerprints.
  let selected = allCandidates
    .filter((row) => row.discoveryUniqueOutputs >= 2 && row.discoverySuccesses >= 2)
    .sort((a, b) => b.borderScore - a.borderScore)
    .slice(0, maxBorderPrompts);

  if (selected.length < minRequiredBorderPrompts) {
    // Fall back: use prompts with consistent outputs (uniqueOutputs == 1 is fine)
    const deterministic = allCandidates
      .filter((row) => row.discoverySuccesses >= 2 && !selected.some((s) => s.promptId === row.promptId))
      .sort((a, b) => b.discoverySuccesses - a.discoverySuccesses)
      .slice(0, maxBorderPrompts - selected.length);
    selected = [...selected, ...deterministic].slice(0, maxBorderPrompts);
  }

  const selectedFromVariants = selected.filter((row) => row.isVariant).length;
  args.logger?.info(
    {
      modelId: args.modelId,
      selectedCount: selected.length,
      selectedFromVariants,
      selected: selected.map((r) => ({ id: r.promptId, score: r.borderScore, unique: r.discoveryUniqueOutputs, variant: r.isVariant }))
    },
    "Adaptive discovery: final prompt selection"
  );

  // ── Phase 3: Reference sampling on selected prompts ──
  const referenceMaxAttempts = Math.max(args.samplesPerPrompt, Math.floor(args.samplesPerPrompt * args.maxAttemptFactor));
  const selectedWithReference = await mapWithConcurrency(selected, args.promptConcurrency, async (row) => {
    const sampled = await samplePromptTextTokens({
      url: args.url,
      apiKey: args.apiKey,
      model: args.modelName,
      systemPrompt: args.systemPrompt,
      prompt: row.prompt,
      targetSamples: args.samplesPerPrompt,
      maxAttempts: referenceMaxAttempts,
      timeoutSeconds: args.timeoutSeconds,
      sleepMs: args.sleepMs,
      sampleConcurrency: args.sampleConcurrency,
      tokenLimitParam: args.tokenLimitParam
    });
    const uniqueOutputs = countsFromSamples(sampled.samples).size;
    args.logger?.info(
      {
        modelId: args.modelId,
        promptId: row.promptId,
        discoverySuccesses: row.discoverySuccesses,
        discoveryUniqueOutputs: row.discoveryUniqueOutputs,
        borderScore: row.borderScore,
        referenceSuccesses: sampled.samples.length,
        referenceUniqueOutputs: uniqueOutputs
      },
      "Adaptive discovery Phase 3: reference sampling finished"
    );
    return {
      ...row,
      referenceAttempts: sampled.attempts,
      referenceSuccesses: sampled.samples.length,
      referenceUniqueOutputs: uniqueOutputs,
      referenceSamples: sampled.samples
    };
  });

  const baselinePrompts = selectedWithReference
    .filter((row) => row.referenceSuccesses >= 3)
    .map((row) => ({
      id: row.promptId,
      prompt: row.prompt,
      referenceSamples: row.referenceSamples
    }));

  const summaryPrompts: B3itPromptSamplingSummary[] = selectedWithReference.map((row) => ({
    id: row.promptId,
    prompt: row.prompt,
    discoveryAttempts: row.discoveryAttempts,
    discoverySuccesses: row.discoverySuccesses,
    discoveryUniqueOutputs: row.discoveryUniqueOutputs,
    borderScore: Math.round(row.borderScore * 10_000) / 10_000,
    referenceAttempts: row.referenceAttempts,
    referenceSuccesses: row.referenceSuccesses,
    referenceUniqueOutputs: row.referenceUniqueOutputs
  }));

  if (baselinePrompts.length < minRequiredBorderPrompts) {
    throw new Error(
      `Adaptive discovery did not find enough usable prompts (usable=${baselinePrompts.length}, required=${minRequiredBorderPrompts}).`
    );
  }

  return {
    baseline: {
      discoveryQueriesPerPrompt: phase1SamplesPerPrompt,
      samplesPerPrompt: args.samplesPerPrompt,
      permutationIters: args.permutationIters,
      candidatePromptCount: phase1Prompts.length + variantInputs.length,
      phase1CandidateCount: phase1Prompts.length,
      phase2VariantCount: variantInputs.length,
      selectedFromVariants,
      prompts: baselinePrompts
    },
    summary: {
      candidatePromptCount: phase1Prompts.length + variantInputs.length,
      discoveryQueriesPerPrompt: phase1SamplesPerPrompt,
      selectedBorderPromptCount: baselinePrompts.length,
      minRequiredBorderPrompts,
      phase1TopCount: phase1Top.length,
      phase2VariantsTested: phase2Rows.length,
      phase2SelectedFromVariants: selectedFromVariants,
      prompts: summaryPrompts
    }
  };
}

function resolveCatalogPath(explicitPath?: string): string {
  if (explicitPath && explicitPath.trim().length > 0) {
    return path.resolve(explicitPath.trim());
  }

  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "apps/proxy/src/fingerprint/model-fingerprint-catalog.ts"),
    path.resolve(cwd, "src/fingerprint/model-fingerprint-catalog.ts"),
    path.resolve(cwd, "../src/fingerprint/model-fingerprint-catalog.ts")
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
}

function normalizePrompts(raw: Array<string | BuilderPromptInput>): BuilderPromptInput[] {
  const out: BuilderPromptInput[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item) {
      continue;
    }
    if (typeof item === "string") {
      const prompt = item.trim();
      if (prompt.length === 0) {
        continue;
      }
      out.push({ id: stablePromptId(prompt, i + 1), prompt });
      continue;
    }
    if (!isObject(item)) {
      continue;
    }

    const prompt = item.prompt?.trim() ?? "";
    if (prompt.length === 0) {
      continue;
    }
    out.push({
      id: item.id?.trim() || stablePromptId(prompt, i + 1),
      prompt
    });
  }
  return out;
}

function ensureBuildInput(input: unknown): CatalogBuildInput {
  if (!isObject(input)) {
    throw new Error("config must be an object");
  }

  const rawModels = input.models;
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    throw new Error("config.models must be a non-empty array");
  }

  const defaults = isObject(input.defaults) ? (input.defaults as BuilderDefaultsInput) : undefined;

  const models: BuilderModelInput[] = rawModels.map((row, idx) => {
    if (!isObject(row)) {
      throw new Error(`models[${idx}] must be an object`);
    }

    const id = typeof row.id === "string" ? row.id.trim() : "";
    const label = typeof row.label === "string" ? row.label.trim() : "";
    const model = typeof row.model === "string" ? row.model.trim() : "";
    const prompts = Array.isArray(row.prompts) ? (row.prompts as Array<string | BuilderPromptInput>) : undefined;

    if (!id || !label || !model) {
      throw new Error(`models[${idx}] requires id/label/model`);
    }

    return {
      id,
      label,
      model,
      baseUrl: typeof row.baseUrl === "string" ? row.baseUrl : undefined,
      apiKey: typeof row.apiKey === "string" ? row.apiKey : undefined,
      apiKeyEnv: typeof row.apiKeyEnv === "string" ? row.apiKeyEnv : undefined,
      providerTag: typeof row.providerTag === "string" ? row.providerTag : undefined,
      modelFamily: typeof row.modelFamily === "string" ? row.modelFamily : undefined,
      source: typeof row.source === "string" ? row.source : undefined,
      notes: typeof row.notes === "string" ? row.notes : undefined,
      topK: typeof row.topK === "number" ? row.topK : undefined,
      samplesPerPrompt: typeof row.samplesPerPrompt === "number" ? row.samplesPerPrompt : undefined,
      permutationIters: typeof row.permutationIters === "number" ? row.permutationIters : undefined,
      systemPrompt: typeof row.systemPrompt === "string" ? row.systemPrompt : undefined,
      vector: isObject(row.vector) ? (row.vector as Record<string, unknown>) : undefined,
      prompts
    };
  });

  return { defaults, models };
}

export async function buildModelFingerprintCatalog(
  rawInput: unknown,
  options: BuildOptions
): Promise<CatalogBuildResult> {
  const input = ensureBuildInput(rawInput);
  const defaults = input.defaults ?? {};
  const maxAttemptFactor = options.maxAttemptFactor ?? 2.5;
  const timeoutSeconds = options.timeoutSeconds ?? 45;
  const sleepMs = options.sleepMs ?? 120;
  const promptConcurrency = clampInt(options.promptConcurrency ?? 4, 1, 12);
  const sampleConcurrency = clampInt(options.sampleConcurrency ?? 4, 1, 32);

  const profileObjects: Record<string, unknown>[] = [];
  const report: ModelBuildSummary[] = [];

  for (const modelCfg of input.models) {
    const modelId = modelCfg.id;
    const label = modelCfg.label;
    const baseUrl = modelCfg.baseUrl ?? defaults.baseUrl;
    if (!baseUrl || baseUrl.trim().length === 0) {
      throw new Error(`[${modelId}] missing baseUrl`);
    }

    const apiKey = resolveApiKey(modelCfg.apiKey ?? defaults.apiKey, modelCfg.apiKeyEnv ?? defaults.apiKeyEnv);
    if (!apiKey) {
      throw new Error(`[${modelId}] missing apiKey/apiKeyEnv`);
    }

    const topK = clampInt(options.topK ?? modelCfg.topK ?? defaults.topK ?? 5, 1, 20);
    const samplesPerPrompt = clampInt(
      options.samplesPerPrompt ?? modelCfg.samplesPerPrompt ?? defaults.samplesPerPrompt ?? 20,
      1,
      200
    );
    const permutationIters = clampInt(
      options.permutationIters ?? modelCfg.permutationIters ?? defaults.permutationIters ?? 1200,
      100,
      50000
    );
    const maxAttempts = Math.max(samplesPerPrompt, Math.floor(samplesPerPrompt * maxAttemptFactor));
    const systemPrompt =
      modelCfg.systemPrompt ??
      defaults.systemPrompt ??
      "Calibration run. Continue naturally using one-token completion only.";

    const prompts = normalizePrompts(modelCfg.prompts ?? FIXED_CATALOG_PROMPTS);
    if (prompts.length === 0) {
      throw new Error(`[${modelId}] no effective prompts available`);
    }
    const url = buildChatCompletionsUrl(baseUrl);
    const tokenLimitParam = await detectTokenLimitParam({ url, apiKey, model: modelCfg.model, timeoutSeconds });
    options.logger?.info(
      { modelId, tokenLimitParam, maxTokens: SAMPLING_MAX_TOKENS },
      "Detected token limit parameter"
    );

    // Always use B3IT method — more robust across relays and model variants than paper logprob.
    const runMode: "paper_logprob" | "b3it_fallback" = "b3it_fallback";
    const promptRows: Array<{ id: string; prompt: string; sampleVectors: number[][] }> = [];
    const promptReport: PromptSamplingSummary[] = [];
    const totalUnsupportedCount = 0;
    const totalFailureCount = 0;
    const logprobsUnsupportedLikely = false;
    let b3itSummary: B3itRunSummary | undefined;
    let paperB3itBaseline: B3itTextBaseline | undefined;

    {
      const b3it = await buildB3itFallbackBaseline({
        modelId,
        modelName: modelCfg.model,
        url,
        apiKey,
        systemPrompt,
        samplesPerPrompt,
        permutationIters,
        timeoutSeconds,
        sleepMs,
        promptConcurrency,
        sampleConcurrency,
        maxAttemptFactor,
        tokenLimitParam,
        logger: options.logger
      });
      paperB3itBaseline = b3it.baseline;
      b3itSummary = b3it.summary;
    }

    report.push({
      modelId,
      label,
      topK,
      samplesPerPrompt,
      prompts: promptReport,
      runMode,
      b3it: b3itSummary,
      logprobsUnsupportedLikely,
      totalUnsupportedCount,
      totalFailureCount
    });

    const profileObject: Record<string, unknown> = {
      id: modelId,
      label,
      providerTag: modelCfg.providerTag ?? defaults.providerTag,
      modelFamily: modelCfg.modelFamily,
      source: modelCfg.source ?? defaults.source ?? (runMode === "b3it_fallback" ? "paper_b3it_sampling" : "paper_logprob_sampling"),
      createdAt: nowIso(),
      notes: modelCfg.notes ?? `auto-sampled via console, model=${modelCfg.model}`,
      vector: modelCfg.vector ?? {}
    };
    if (runMode === "b3it_fallback" && paperB3itBaseline) {
      profileObject.paperB3itBaseline = paperB3itBaseline;
    } else {
      profileObject.paperLogprobBaseline = {
        topK,
        samplesPerPrompt,
        permutationIters,
        prompts: promptRows
      };
    }
    profileObjects.push(profileObject);
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      outputPath: null,
      profileCount: profileObjects.length,
      report,
      catalogPreview: profileObjects
    };
  }

  const outputPath = resolveCatalogPath(options.outputPath);
  const source = await readFile(outputPath, "utf8");
  const match = source.match(CATALOG_EXPORT_RE);
  if (!match) {
    throw new Error(`Cannot find BUILTIN_MODEL_FINGERPRINT_CATALOG export in ${outputPath}`);
  }

  const arrayLiteral = JSON.stringify(profileObjects, null, 2);
  const updated = source.replace(CATALOG_EXPORT_RE, `$1${arrayLiteral}$3`);
  await writeFile(outputPath, updated, "utf8");

  return {
    ok: true,
    dryRun: false,
    outputPath,
    profileCount: profileObjects.length,
    report
  };
}
