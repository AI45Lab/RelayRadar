import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { EnhancedFingerprintConclusion, FingerprintAuditRecord, PolicyConfig } from "@relayradar/shared";
import type { RelayRadarDb } from "../db.js";
import { PolicyStore } from "../policy.js";
import { buildOpenAiUpstreamUrl, isObject, nowIso, safeJsonParse } from "../utils.js";
import {
  BUILTIN_MODEL_FINGERPRINT_CATALOG,
  type B3itTextBaseline,
  type ModelFingerprintProfile,
  type PaperLogprobBaseline
} from "./model-fingerprint-catalog.js";

const lastAuditAtMs = new Map<string, number>();

export interface EnhancedAuditDeps {
  db: RelayRadarDb;
  policyStore: PolicyStore;
  logger?: FastifyBaseLogger;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveApiKey(apiKey: string | undefined, apiKeyEnv: string | undefined): string | undefined {
  if (apiKey && apiKey.trim().length > 0) {
    return apiKey.trim();
  }
  if (apiKeyEnv && process.env[apiKeyEnv]) {
    return process.env[apiKeyEnv];
  }
  return undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function avg(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
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
  const out = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        break;
      }
      out[index] = await mapper(items[index] as T, index);
    }
  });

  await Promise.all(workers);
  return out;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
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
  return "";
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
      const content = block.content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const piece of content) {
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

function normalizeModelName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function modelNameLikelySame(a: string, b: string): boolean {
  const na = normalizeModelName(a);
  const nb = normalizeModelName(b);
  if (!na || !nb) {
    return false;
  }
  return na === nb || na.includes(nb) || nb.includes(na);
}

// ---------------------------------------------------------------------------
// Logprob support probe
// ---------------------------------------------------------------------------

function buildChatUrl(baseUrl: string): string {
  return buildOpenAiUpstreamUrl(baseUrl, "/v1/chat/completions");
}

type TokenLimitParam = "max_tokens" | "max_completion_tokens";

/** See `catalog-builder.SAMPLING_MAX_TOKENS` for rationale on the fixed budget. */
const SAMPLING_MAX_TOKENS = 1024;

// Models that reject temperature=0 (e.g. claude-opus-4-7 on Bedrock).
const temperatureUnsupportedModels = new Set<string>();

async function detectTokenLimitParam(url: string, declaredModel: string, apiKey: string): Promise<TokenLimitParam> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: declaredModel || "gpt-4o-mini",
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0,
        max_tokens: 1,
        stream: false
      }),
      signal: AbortSignal.timeout(30_000)
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

async function probeLogprobSupport(baseUrl: string, declaredModel: string, apiKey: string, tokenLimitParam: TokenLimitParam): Promise<boolean> {
  const url = buildChatUrl(baseUrl);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: declaredModel || "gpt-4o-mini",
        messages: [
          { role: "system", content: "Calibration run." },
          { role: "user", content: "The capital of France is" }
        ],
        temperature: 0,
        [tokenLimitParam]: 16,
        stream: false,
        logprobs: true,
        top_logprobs: 5
      }),
      signal: AbortSignal.timeout(30_000)
    });

    if (!response.ok) {
      return false;
    }

    const text = await response.text();
    const json = safeJsonParse<unknown>(text);
    if (!json) {
      return false;
    }

    const vector = extractTopLogprobVector(json, 5);
    return vector !== null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Paper logprob baseline comparison
// ---------------------------------------------------------------------------

interface PaperPromptPlan {
  key: string;
  promptId: string;
  prompt: string;
  topK: number;
  sampleCount: number;
}

interface PaperPromptObservedSummary {
  promptId: string;
  topK: number;
  attempts: number;
  successes: number;
}

interface PaperPromptMatch {
  promptId: string;
  mad: number;
  permutationP: number | null;
  observedSamples: number;
  baselineSamples: number;
}

interface PaperCatalogMatch {
  modelId: string;
  label: string;
  providerTag: string | null;
  modelFamily: string | null;
  score: number;
  similarity: number;
  pSameMean: number | null;
  pSameMin: number | null;
  promptCount: number;
  promptStats: PaperPromptMatch[];
}

interface PaperCatalogComparisonResult {
  enabled: boolean;
  observedPrompts: PaperPromptObservedSummary[];
  bestMatch: PaperCatalogMatch | null;
  topMatches: PaperCatalogMatch[];
}

function makePaperPromptKey(topK: number, promptId: string): string {
  return `${topK}::${promptId}`;
}

function normalizeTopLogprobVector(raw: number[], topK: number): number[] {
  const cleaned = raw.filter((value) => Number.isFinite(value)).sort((a, b) => b - a);
  const out = cleaned.slice(0, topK);
  while (out.length < topK) {
    out.push(-20);
  }
  return out;
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

        const tops = token.top_logprobs;
        if (Array.isArray(tops)) {
          const values = tops
            .map((item) => (isObject(item) && typeof item.logprob === "number" && Number.isFinite(item.logprob) ? item.logprob : null))
            .filter((value): value is number => value !== null);
          if (values.length > 0) {
            return normalizeTopLogprobVector(values, topK);
          }
        }

        if (typeof token.logprob === "number" && Number.isFinite(token.logprob)) {
          return normalizeTopLogprobVector([token.logprob], topK);
        }
      }
    }

    const legacyTokenLogprobs = logprobs.token_logprobs;
    if (Array.isArray(legacyTokenLogprobs) && legacyTokenLogprobs.length > 0) {
      const first = legacyTokenLogprobs[0];
      if (typeof first === "number" && Number.isFinite(first)) {
        return normalizeTopLogprobVector([first], topK);
      }
    }
  }

  return null;
}

function meanVectorFromSamples(samples: number[][]): number[] {
  if (samples.length === 0) {
    return [];
  }

  const dim = Math.min(...samples.map((row) => row.length));
  if (dim <= 0) {
    return [];
  }

  const sums = new Array(dim).fill(0);
  for (const row of samples) {
    for (let i = 0; i < dim; i += 1) {
      sums[i] += row[i] ?? 0;
    }
  }

  return sums.map((value) => value / samples.length);
}

function meanAbsDistance(a: number[], b: number[]): number {
  const dim = Math.min(a.length, b.length);
  if (dim <= 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < dim; i += 1) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return sum / dim;
}

function permutationMadPValue(samplesA: number[][], samplesB: number[][], iterations: number): number | null {
  if (samplesA.length < 3 || samplesB.length < 3) {
    return null;
  }

  const observed = meanAbsDistance(meanVectorFromSamples(samplesA), meanVectorFromSamples(samplesB));
  const pooled = [...samplesA, ...samplesB];
  const nA = samplesA.length;
  let extreme = 0;

  for (let iter = 0; iter < iterations; iter += 1) {
    const indices = [...Array(pooled.length).keys()];
    for (let i = indices.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = indices[i];
      indices[i] = indices[j]!;
      indices[j] = tmp!;
    }

    const groupA: number[][] = [];
    const groupB: number[][] = [];
    for (let i = 0; i < indices.length; i += 1) {
      const sample = pooled[indices[i]!]!;
      if (i < nA) {
        groupA.push(sample);
      } else {
        groupB.push(sample);
      }
    }

    const stat = meanAbsDistance(meanVectorFromSamples(groupA), meanVectorFromSamples(groupB));
    if (stat >= observed) {
      extreme += 1;
    }
  }

  return (extreme + 1) / (iterations + 1);
}

function buildPaperPromptPlans(models: ModelFingerprintProfile[]): PaperPromptPlan[] {
  const byKey = new Map<string, PaperPromptPlan>();

  for (const model of models) {
    const baseline = model.paperLogprobBaseline;
    if (!baseline) {
      continue;
    }

    const sampleCount = Math.min(Math.max(baseline.samplesPerPrompt, 4), 32);
    for (const prompt of baseline.prompts) {
      const key = makePaperPromptKey(baseline.topK, prompt.id);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          key,
          promptId: prompt.id,
          prompt: prompt.prompt,
          topK: baseline.topK,
          sampleCount
        });
        continue;
      }

      if (sampleCount > existing.sampleCount) {
        existing.sampleCount = sampleCount;
      }
    }
  }

  return [...byKey.values()];
}

async function fetchPaperPromptObservedVectors(args: {
  baseUrl: string;
  declaredModel: string;
  apiKey: string;
  systemPrompt: string;
  prompt: string;
  topK: number;
  sampleCount: number;
  sampleConcurrency: number;
  tokenLimitParam?: TokenLimitParam;
}): Promise<{ vectors: number[][]; attempts: number; successes: number }> {
  const url = buildChatUrl(args.baseUrl);
  const tlp = args.tokenLimitParam ?? "max_tokens";
  const vectors: number[][] = [];

  let attempts = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(args.sampleConcurrency, args.sampleCount)) }, async () => {
    while (true) {
      if (attempts >= args.sampleCount) {
        break;
      }
      attempts += 1;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${args.apiKey}`
          },
          body: JSON.stringify({
            model: args.declaredModel || "gpt-4o-mini",
            messages: [
              { role: "system", content: args.systemPrompt },
              { role: "user", content: args.prompt }
            ],
            temperature: 0,
            max_tokens: 1,
            stream: false,
            logprobs: true,
            top_logprobs: args.topK
          }),
          signal: AbortSignal.timeout(45_000)
        });
      } catch {
        continue;
      }

      if (!response.ok) {
        continue;
      }

      const text = await response.text();
      const json = safeJsonParse<unknown>(text);
      if (!json) {
        continue;
      }

      const vector = extractTopLogprobVector(json, args.topK);
      if (vector) {
        vectors.push(vector);
      }
    }
  });
  await Promise.all(workers);

  return {
    vectors,
    attempts,
    successes: vectors.length
  };
}

function compareModelWithPaperBaseline(
  model: ModelFingerprintProfile,
  observedByPrompt: Map<string, number[][]>
): PaperCatalogMatch | null {
  const baseline: PaperLogprobBaseline | undefined = model.paperLogprobBaseline;
  if (!baseline || baseline.prompts.length === 0) {
    return null;
  }

  const promptStats: PaperPromptMatch[] = [];
  for (const prompt of baseline.prompts) {
    const key = makePaperPromptKey(baseline.topK, prompt.id);
    const observed = observedByPrompt.get(key) ?? [];
    const baselineSamples = prompt.sampleVectors
      .map((row) => normalizeTopLogprobVector(row, baseline.topK))
      .filter((row) => row.length > 0);

    if (observed.length < 3 || baselineSamples.length < 3) {
      continue;
    }

    const mad = meanAbsDistance(meanVectorFromSamples(observed), meanVectorFromSamples(baselineSamples));
    const permutationP = permutationMadPValue(observed, baselineSamples, baseline.permutationIters ?? 900);
    promptStats.push({
      promptId: prompt.id,
      mad: round4(mad),
      permutationP: permutationP === null ? null : round4(permutationP),
      observedSamples: observed.length,
      baselineSamples: baselineSamples.length
    });
  }

  if (promptStats.length === 0) {
    return null;
  }

  const madValues = promptStats.map((row) => row.mad);
  const pValues = promptStats.map((row) => row.permutationP ?? 0.5);
  const meanMad = avg(madValues);
  const pSameMean = avg(pValues);
  const pSameMin = Math.min(...pValues);
  const similarity = clamp01(1 - meanMad / 1.35);
  const score = clamp01(similarity * 0.7 + pSameMean * 0.3);

  return {
    modelId: model.id,
    label: model.label,
    providerTag: model.providerTag ?? null,
    modelFamily: model.modelFamily ?? null,
    score: round4(score),
    similarity: round4(similarity),
    pSameMean: round4(pSameMean),
    pSameMin: round4(pSameMin),
    promptCount: promptStats.length,
    promptStats
  };
}

async function runPaperCatalogComparison(args: {
  baseUrl: string;
  declaredModel: string;
  apiKey: string;
  models: ModelFingerprintProfile[];
  tokenLimitParam?: TokenLimitParam;
  logger?: FastifyBaseLogger;
}): Promise<PaperCatalogComparisonResult> {
  const models = args.models.filter(
    (row) => row.paperLogprobBaseline && row.paperLogprobBaseline.prompts.length > 0
  );
  if (models.length === 0) {
    return {
      enabled: false,
      observedPrompts: [],
      bestMatch: null,
      topMatches: []
    };
  }

  const promptPlans = buildPaperPromptPlans(models);
  const observedByPrompt = new Map<string, number[][]>();
  const observedPrompts: PaperPromptObservedSummary[] = [];
  const systemPrompt = "Calibration run. Continue naturally using one-token completion only.";
  const promptConcurrency = 2;
  const sampleConcurrency = 4;

  const observedResults = await mapWithConcurrency(promptPlans, promptConcurrency, async (plan) => {
    const observed = await fetchPaperPromptObservedVectors({
      baseUrl: args.baseUrl,
      declaredModel: args.declaredModel,
      apiKey: args.apiKey,
      systemPrompt,
      prompt: plan.prompt,
      topK: plan.topK,
      sampleCount: plan.sampleCount,
      sampleConcurrency,
      tokenLimitParam: args.tokenLimitParam
    });
    args.logger?.info(
      {
        promptId: plan.promptId,
        topK: plan.topK,
        attempts: observed.attempts,
        successes: observed.successes,
        sampleCount: plan.sampleCount,
        sampleConcurrency
      },
      "Paper baseline sampling prompt finished"
    );
    return { plan, observed };
  });

  for (const { plan, observed } of observedResults) {
    observedByPrompt.set(plan.key, observed.vectors);
    observedPrompts.push({
      promptId: plan.promptId,
      topK: plan.topK,
      attempts: observed.attempts,
      successes: observed.successes
    });
  }

  const matches = models
    .map((model) => compareModelWithPaperBaseline(model, observedByPrompt))
    .filter((row): row is PaperCatalogMatch => row !== null)
    .sort((a, b) => b.score - a.score);

  return {
    enabled: true,
    observedPrompts,
    bestMatch: matches[0] ?? null,
    topMatches: matches.slice(0, 5)
  };
}

// ---------------------------------------------------------------------------
// B3IT fallback baseline comparison
// ---------------------------------------------------------------------------

interface B3itPromptPlan {
  key: string;
  promptId: string;
  prompt: string;
  sampleCount: number;
}

interface B3itPromptObservedSummary {
  promptId: string;
  attempts: number;
  successes: number;
}

interface B3itPromptMatch {
  promptId: string;
  tvDistance: number;
  permutationP: number | null;
  observedSamples: number;
  baselineSamples: number;
}

interface B3itCatalogMatch {
  modelId: string;
  label: string;
  providerTag: string | null;
  modelFamily: string | null;
  score: number;
  similarity: number;
  pSameMean: number | null;
  pSameMin: number | null;
  promptCount: number;
  promptStats: B3itPromptMatch[];
}

interface B3itCatalogComparisonResult {
  enabled: boolean;
  observedPrompts: B3itPromptObservedSummary[];
  bestMatch: B3itCatalogMatch | null;
  topMatches: B3itCatalogMatch[];
}

function makeB3itPromptKey(promptId: string): string {
  return promptId.trim();
}

function countsFromTokenSamples(samples: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    counts.set(sample, (counts.get(sample) ?? 0) + 1);
  }
  return counts;
}

function totalVariationDistanceFromSamples(samplesA: string[], samplesB: string[]): number {
  if (samplesA.length === 0 || samplesB.length === 0) {
    return 1;
  }
  const countsA = countsFromTokenSamples(samplesA);
  const countsB = countsFromTokenSamples(samplesB);
  const allTokens = new Set<string>([...countsA.keys(), ...countsB.keys()]);
  let tv = 0;
  for (const token of allTokens) {
    const pa = (countsA.get(token) ?? 0) / samplesA.length;
    const pb = (countsB.get(token) ?? 0) / samplesB.length;
    tv += Math.abs(pa - pb);
  }
  return tv / 2;
}

function permutationTvPValue(samplesA: string[], samplesB: string[], iterations: number): number | null {
  if (samplesA.length < 3 || samplesB.length < 3) {
    return null;
  }
  const observed = totalVariationDistanceFromSamples(samplesA, samplesB);
  const pooled = [...samplesA, ...samplesB];
  const nA = samplesA.length;
  let extreme = 0;

  for (let iter = 0; iter < iterations; iter += 1) {
    const indices = [...Array(pooled.length).keys()];
    for (let i = indices.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = indices[i];
      indices[i] = indices[j]!;
      indices[j] = tmp!;
    }

    const groupA: string[] = [];
    const groupB: string[] = [];
    for (let i = 0; i < indices.length; i += 1) {
      const sample = pooled[indices[i]!]!;
      if (i < nA) {
        groupA.push(sample);
      } else {
        groupB.push(sample);
      }
    }

    const stat = totalVariationDistanceFromSamples(groupA, groupB);
    if (stat >= observed) {
      extreme += 1;
    }
  }

  return (extreme + 1) / (iterations + 1);
}

function buildB3itPromptPlans(models: ModelFingerprintProfile[]): B3itPromptPlan[] {
  const byKey = new Map<string, B3itPromptPlan>();
  for (const model of models) {
    const baseline = model.paperB3itBaseline;
    if (!baseline) {
      continue;
    }

    const sampleCount = Math.min(Math.max(baseline.samplesPerPrompt, 4), 32);
    for (const prompt of baseline.prompts) {
      const key = makeB3itPromptKey(prompt.id);
      if (key.length === 0) {
        continue;
      }
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          key,
          promptId: prompt.id,
          prompt: prompt.prompt,
          sampleCount
        });
        continue;
      }
      if (sampleCount > existing.sampleCount) {
        existing.sampleCount = sampleCount;
      }
    }
  }
  return [...byKey.values()];
}

async function fetchB3itPromptObservedSamples(args: {
  baseUrl: string;
  declaredModel: string;
  apiKey: string;
  systemPrompt: string;
  prompt: string;
  sampleCount: number;
  sampleConcurrency: number;
  tokenLimitParam?: TokenLimitParam;
}): Promise<{ samples: string[]; attempts: number; successes: number }> {
  const url = buildChatUrl(args.baseUrl);
  const tlp = args.tokenLimitParam ?? "max_tokens";
  const samples: string[] = [];
  let attempts = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(args.sampleConcurrency, args.sampleCount)) }, async () => {
    while (true) {
      if (attempts >= args.sampleCount) {
        break;
      }
      attempts += 1;

      const useTemp = !temperatureUnsupportedModels.has(args.declaredModel);
      const buildBody = (includeTemperature: boolean) =>
        JSON.stringify({
          model: args.declaredModel || "gpt-4o-mini",
          messages: [
            { role: "system", content: args.systemPrompt },
            { role: "user", content: args.prompt }
          ],
          ...(includeTemperature ? { temperature: 0 } : {}),
          [tlp]: SAMPLING_MAX_TOKENS,
          stream: false
        });

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${args.apiKey}`
          },
          body: buildBody(useTemp),
          signal: AbortSignal.timeout(45_000)
        });
      } catch {
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        if (useTemp && errText.toLowerCase().includes("temperature")) {
          temperatureUnsupportedModels.add(args.declaredModel);
          try {
            response = await fetch(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${args.apiKey}`
              },
              body: buildBody(false),
              signal: AbortSignal.timeout(45_000)
            });
          } catch {
            continue;
          }
          if (!response.ok) continue;
        } else {
          continue;
        }
      }

      const text = await response.text();
      const json = safeJsonParse<unknown>(text);
      const output = json ? extractAssistantText(json) : text;
      const sample = normalizeTokenSample(output);
      if (sample !== null) {
        samples.push(sample);
      }
    }
  });
  await Promise.all(workers);

  return {
    samples,
    attempts,
    successes: samples.length
  };
}

function compareModelWithB3itBaseline(
  model: ModelFingerprintProfile,
  observedByPrompt: Map<string, string[]>
): B3itCatalogMatch | null {
  const baseline: B3itTextBaseline | undefined = model.paperB3itBaseline;
  if (!baseline || baseline.prompts.length === 0) {
    return null;
  }

  const promptStats: B3itPromptMatch[] = [];
  for (const prompt of baseline.prompts) {
    const key = makeB3itPromptKey(prompt.id);
    const observed = observedByPrompt.get(key) ?? [];
    const baselineSamples = prompt.referenceSamples
      .map((sample) => normalizeTokenSample(sample))
      .filter((sample): sample is string => sample !== null);
    if (observed.length < 3 || baselineSamples.length < 3) {
      continue;
    }

    const tvDistance = totalVariationDistanceFromSamples(observed, baselineSamples);
    const permutationP = permutationTvPValue(observed, baselineSamples, baseline.permutationIters ?? 900);
    promptStats.push({
      promptId: prompt.id,
      tvDistance: round4(tvDistance),
      permutationP: permutationP === null ? null : round4(permutationP),
      observedSamples: observed.length,
      baselineSamples: baselineSamples.length
    });
  }

  if (promptStats.length === 0) {
    return null;
  }

  const tvValues = promptStats.map((row) => row.tvDistance);
  const pValues = promptStats.map((row) => row.permutationP ?? 0.5);
  const meanTv = avg(tvValues);
  const pSameMean = avg(pValues);
  const pSameMin = Math.min(...pValues);
  const similarity = clamp01(1 - meanTv);
  const score = clamp01(similarity * 0.7 + pSameMean * 0.3);

  return {
    modelId: model.id,
    label: model.label,
    providerTag: model.providerTag ?? null,
    modelFamily: model.modelFamily ?? null,
    score: round4(score),
    similarity: round4(similarity),
    pSameMean: round4(pSameMean),
    pSameMin: round4(pSameMin),
    promptCount: promptStats.length,
    promptStats
  };
}

async function runB3itCatalogComparison(args: {
  baseUrl: string;
  declaredModel: string;
  apiKey: string;
  models: ModelFingerprintProfile[];
  tokenLimitParam?: TokenLimitParam;
  logger?: FastifyBaseLogger;
}): Promise<B3itCatalogComparisonResult> {
  const models = args.models.filter((row) => row.paperB3itBaseline && row.paperB3itBaseline.prompts.length > 0);
  if (models.length === 0) {
    return {
      enabled: false,
      observedPrompts: [],
      bestMatch: null,
      topMatches: []
    };
  }

  const promptPlans = buildB3itPromptPlans(models);
  const observedByPrompt = new Map<string, string[]>();
  const observedPrompts: B3itPromptObservedSummary[] = [];
  const calibrationPrompt = "Calibration run. Continue naturally using one-token completion only.";
  const systemPrompt = calibrationPrompt;
  const promptConcurrency = 4;
  const sampleConcurrency = 4;

  const observedResults = await mapWithConcurrency(promptPlans, promptConcurrency, async (plan) => {
    const observed = await fetchB3itPromptObservedSamples({
      baseUrl: args.baseUrl,
      declaredModel: args.declaredModel,
      apiKey: args.apiKey,
      systemPrompt,
      prompt: plan.prompt,
      sampleCount: plan.sampleCount,
      sampleConcurrency,
      tokenLimitParam: args.tokenLimitParam
    });
    args.logger?.info(
      {
        promptId: plan.promptId,
        attempts: observed.attempts,
        successes: observed.successes,
        sampleCount: plan.sampleCount,
        sampleConcurrency
      },
      "B3IT fallback prompt sampling finished"
    );
    return { plan, observed };
  });

  for (const { plan, observed } of observedResults) {
    observedByPrompt.set(plan.key, observed.samples);
    observedPrompts.push({
      promptId: plan.promptId,
      attempts: observed.attempts,
      successes: observed.successes
    });
  }

  const matches = models
    .map((model) => compareModelWithB3itBaseline(model, observedByPrompt))
    .filter((row): row is B3itCatalogMatch => row !== null)
    .sort((a, b) => b.score - a.score);

  return {
    enabled: true,
    observedPrompts,
    bestMatch: matches[0] ?? null,
    topMatches: matches.slice(0, 5)
  };
}

// ---------------------------------------------------------------------------
// Baseline profile conversion
// ---------------------------------------------------------------------------

function toModelFingerprintProfileFromBaseline(
  baseline: { id: string; label: string; model: string; providerTag: string; modelFamily: string; notes: string; profile: Record<string, unknown> }
): ModelFingerprintProfile {
  const raw = isObject(baseline.profile) ? baseline.profile : {};
  const rawPaper = isObject(raw.paperLogprobBaseline)
    ? (raw.paperLogprobBaseline as unknown as PaperLogprobBaseline)
    : undefined;
  const rawB3it = isObject(raw.paperB3itBaseline)
    ? (raw.paperB3itBaseline as unknown as B3itTextBaseline)
    : undefined;

  return {
    id: typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id : `baseline:${baseline.id}`,
    label: typeof raw.label === "string" && raw.label.trim().length > 0 ? raw.label : baseline.label,
    providerTag:
      typeof raw.providerTag === "string" && raw.providerTag.trim().length > 0 ? raw.providerTag : baseline.providerTag || undefined,
    modelFamily:
      typeof raw.modelFamily === "string" && raw.modelFamily.trim().length > 0 ? raw.modelFamily : baseline.modelFamily || undefined,
    vector: {},
    paperLogprobBaseline: rawPaper,
    paperB3itBaseline: rawB3it,
    notes: typeof raw.notes === "string" && raw.notes.trim().length > 0 ? raw.notes : baseline.notes || undefined,
    source: typeof raw.source === "string" && raw.source.trim().length > 0 ? raw.source : "fingerprint_lab_run",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined
  };
}

// ---------------------------------------------------------------------------
// Simplified conclusion: purely catalog-based
// ---------------------------------------------------------------------------

function computeFingerprintConclusion(args: {
  paperCatalog: PaperCatalogComparisonResult;
  b3itCatalog: B3itCatalogComparisonResult;
  selectedProfile: ModelFingerprintProfile | null;
  declaredModel: string | null;
}): { conclusion: EnhancedFingerprintConclusion; confidence: number; matchScore: number | null } {
  // Try to find the selected profile's match in paper/b3it results
  const selectedPaperMatch = args.selectedProfile
    ? args.paperCatalog.topMatches.find((row) => row.modelId === args.selectedProfile!.id) ?? null
    : null;
  const selectedB3itMatch = args.selectedProfile
    ? args.b3itCatalog.topMatches.find((row) => row.modelId === args.selectedProfile!.id) ?? null
    : null;

  // Combine available scores with weights
  const parts: Array<{ pMatch: number; weight: number }> = [];

  if (selectedPaperMatch && Number.isFinite(selectedPaperMatch.score) && selectedPaperMatch.promptCount >= 2) {
    parts.push({
      pMatch: clamp01(selectedPaperMatch.score),
      weight: selectedPaperMatch.promptCount >= 4 ? 0.6 : 0.45
    });
  }
  if (selectedB3itMatch && Number.isFinite(selectedB3itMatch.score) && selectedB3itMatch.promptCount >= 2) {
    parts.push({
      pMatch: clamp01(selectedB3itMatch.score),
      weight: selectedB3itMatch.promptCount >= 4 ? 0.55 : 0.42
    });
  }

  // If we have catalog signals, compute weighted match score
  if (parts.length > 0) {
    const totalWeight = parts.reduce((acc, row) => acc + row.weight, 0);
    const pMatch = parts.reduce((acc, row) => acc + row.pMatch * row.weight, 0) / totalWeight;
    const conclusion: EnhancedFingerprintConclusion = pMatch >= 0.55 ? "model_match" : pMatch <= 0.40 ? "model_mismatch" : "inconclusive";
    const confidence = round4(clamp01(0.5 + Math.abs(pMatch - 0.5) * 1.2));
    return { conclusion, confidence, matchScore: round4(clamp01(pMatch)) };
  }

  // No selected profile match — check if best catalog match is a different model
  const bestPaper = args.paperCatalog.bestMatch;
  const bestB3it = args.b3itCatalog.bestMatch;
  const bestMatch = bestPaper && bestB3it
    ? (bestPaper.score >= bestB3it.score ? bestPaper : bestB3it)
    : bestPaper ?? bestB3it;

  if (bestMatch && bestMatch.score >= 0.55 && args.declaredModel) {
    const bestIsDeclared = modelNameLikelySame(bestMatch.label, args.declaredModel)
      || (bestMatch.modelFamily ? modelNameLikelySame(bestMatch.modelFamily, args.declaredModel) : false);
    if (bestIsDeclared) {
      return { conclusion: "model_match", confidence: round4(clamp01(bestMatch.score)), matchScore: round4(bestMatch.score) };
    }
    return { conclusion: "model_mismatch", confidence: round4(clamp01(bestMatch.score)), matchScore: round4(1 - bestMatch.score) };
  }

  return { conclusion: "inconclusive", confidence: 0.3, matchScore: null };
}

// ---------------------------------------------------------------------------
// Main audit entry point
// ---------------------------------------------------------------------------

export async function runEnhancedFingerprintAudit(
  deps: EnhancedAuditDeps,
  endpointId: string,
  trigger: string,
  options?: { force?: boolean }
): Promise<FingerprintAuditRecord | null> {
  const policy: PolicyConfig = deps.policyStore.get();
  if (!policy.fingerprintAuditEnabled && !options?.force) {
    return null;
  }

  const now = Date.now();
  if (!options?.force) {
    const last = lastAuditAtMs.get(endpointId) ?? 0;
    const cooldownMs = policy.fingerprintAuditCooldownMinutes * 60 * 1000;
    if (now - last < cooldownMs) {
      deps.logger?.info({ endpointId }, "Skipping fingerprint audit (cooldown)");
      return null;
    }
    lastAuditAtMs.set(endpointId, now);
  }

  const target = deps.db.getEndpointConfig(endpointId);
  if (!target) {
    deps.logger?.warn({ endpointId }, "Fingerprint audit: endpoint not found");
    lastAuditAtMs.delete(endpointId);
    return null;
  }

  const targetKey = resolveApiKey(target.apiKey, target.apiKeyEnv);
  if (!targetKey) {
    deps.logger?.warn({ endpointId }, "Fingerprint audit: missing API key");
    return null;
  }

  // Resolve baseline profile from DB or builtin catalog
  const selectedBaseline = deps.db.resolveFingerprintBaselineForEndpoint(target);
  const selectedProfile = selectedBaseline ? toModelFingerprintProfileFromBaseline(selectedBaseline) : null;
  const catalogProfiles: ModelFingerprintProfile[] = selectedProfile
    ? [selectedProfile, ...BUILTIN_MODEL_FINGERPRINT_CATALOG.filter((row) => row.id !== selectedProfile.id)]
    : BUILTIN_MODEL_FINGERPRINT_CATALOG;
  const compareProfiles = selectedProfile ? [selectedProfile] : catalogProfiles;

  // Detect which token-limit parameter the model wants (reasoning models need max_completion_tokens).
  const auditUrl = buildChatUrl(target.baseUrl);
  const tokenLimitParam = await detectTokenLimitParam(auditUrl, target.declaredModel ?? "", targetKey);
  deps.logger?.info(
    { endpointId, tokenLimitParam, maxTokens: SAMPLING_MAX_TOKENS },
    "Fingerprint audit: probe results"
  );

  // Always use B3IT method — more robust across relays than paper logprob
  const paperCatalog = { enabled: false, observedPrompts: [] as PaperPromptObservedSummary[], bestMatch: null, topMatches: [] as PaperCatalogMatch[] };

  const b3itCatalog = await runB3itCatalogComparison({
    baseUrl: target.baseUrl,
    declaredModel: target.declaredModel ?? "",
    apiKey: targetKey,
    models: compareProfiles,
    tokenLimitParam,
    logger: deps.logger,
  });

  // Compute conclusion purely from catalog matching
  const decision = computeFingerprintConclusion({
    paperCatalog,
    b3itCatalog,
    selectedProfile,
    declaredModel: target.declaredModel ?? null
  });

  const { conclusion, confidence } = decision;

  const evidence: Record<string, unknown> = {
    disclaimer:
      "This conclusion is heuristic and probabilistic. It supports operations review and is not an identity attestation.",
    b3itTest: {
      enabled: b3itCatalog.enabled,
      observedPrompts: b3itCatalog.observedPrompts,
      bestMatch: b3itCatalog.bestMatch,
      topMatches: b3itCatalog.topMatches
    },
    selectedBaseline: selectedBaseline
      ? {
          id: selectedBaseline.id,
          name: selectedBaseline.name,
          model: selectedBaseline.model,
          source: selectedBaseline.source,
          preferred: selectedBaseline.isPreferred
        }
      : null,
    decision: {
      conclusion,
      confidence,
      matchScore: decision.matchScore
    }
  };

  const record: FingerprintAuditRecord = {
    id: randomUUID(),
    endpointId,
    trigger,
    conclusion,
    confidence: round4(confidence),
    evidence,
    createdAt: nowIso()
  };

  deps.db.insertFingerprintAudit({
    id: record.id,
    endpointId: record.endpointId,
    trigger: record.trigger,
    conclusion: record.conclusion,
    confidence: record.confidence,
    evidence: record.evidence,
    createdAt: record.createdAt
  });

  deps.db.insertRiskEvent({
    id: randomUUID(),
    endpointId,
    requestId: null,
    type: "enhanced_fingerprint_audit",
    severity: conclusion === "model_mismatch" ? (record.confidence >= 0.75 ? "high" : "medium") : "low",
    summary: `Fingerprint audit: ${conclusion === "model_match" ? "model match" : conclusion === "model_mismatch" ? "model mismatch" : "inconclusive"} (confidence ${record.confidence})`,
    details: {
      auditId: record.id,
      conclusion,
      confidence: record.confidence,
      trigger
    },
    createdAt: record.createdAt
  });

  return record;
}

export function shouldTriggerFingerprintAudit(divergence: number, policy: PolicyConfig): boolean {
  return policy.fingerprintAuditEnabled && divergence >= policy.fingerprintAuditDriftThreshold;
}
