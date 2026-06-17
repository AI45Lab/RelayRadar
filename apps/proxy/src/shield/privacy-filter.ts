import { createHash, randomBytes } from "node:crypto";
import type { TokenClassificationPipeline } from "@huggingface/transformers";
import { isObject } from "../utils.js";
import { isSecretRedactionKey, type ReplacementMap } from "./redactor.js";

const MODEL_ID = process.env.RELAYRADAR_PRIVACY_FILTER_MODEL ?? "openai/privacy-filter";
const DEFAULT_THRESHOLD = 0.85;

interface PrivacyEntity {
  word: string;
  score: number;
  entity_group: string;
  start?: number;
  end?: number;
}

export interface PrivacyFilterRedactionResult {
  sanitizedBody: unknown;
  replacements: ReplacementMap;
  fieldCounts: Record<string, number>;
  piiCount: number;
  secretCount: number;
}

export interface PrivacyFilterOptions {
  threshold?: number;
}

let classifierPromise: Promise<TokenClassificationPipeline> | null = null;

function normalizeThreshold(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return DEFAULT_THRESHOLD;
  }
  return Math.min(1, Math.max(0, value));
}

async function getClassifier(): Promise<TokenClassificationPipeline> {
  if (!classifierPromise) {
    classifierPromise = import("@huggingface/transformers").then(async ({ pipeline }) => {
      const options: Record<string, unknown> = {};
      const dtype = process.env.RELAYRADAR_PRIVACY_FILTER_DTYPE ?? "q4";
      const device = process.env.RELAYRADAR_PRIVACY_FILTER_DEVICE;
      if (dtype) {
        options.dtype = dtype;
      }
      if (device) {
        options.device = device;
      }
      return pipeline("token-classification", MODEL_ID, options) as Promise<TokenClassificationPipeline>;
    });
  }
  return classifierPromise;
}

function normalizeLabel(label: string): string {
  return label.replace(/^B-|^I-/i, "").toLowerCase();
}

function fieldKeyFor(label: string): string {
  return `privacy_filter_${normalizeLabel(label).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "entity"}`;
}

export function isPrivacyFilterRedactionKey(key: string): boolean {
  return key.startsWith("privacy_filter_");
}

export function isPrivacyFilterSecretKey(key: string): boolean {
  return isPrivacyFilterRedactionKey(key) && (
    key.includes("secret") ||
    key.includes("key") ||
    key.includes("token") ||
    key.includes("password")
  );
}

function placeholderFor(key: string, index: number, salt: string): string {
  const token = createHash("sha256")
    .update(`${salt}:${key}`)
    .digest("hex")
    .slice(0, 6)
    .toUpperCase();
  return `[[RR_PF_${token}_${String(index).padStart(4, "0")}]]`;
}

function entityBounds(entity: PrivacyEntity, input: string): { start: number; end: number } | null {
  if (
    typeof entity.start === "number" &&
    typeof entity.end === "number" &&
    entity.start >= 0 &&
    entity.end > entity.start &&
    entity.end <= input.length
  ) {
    return { start: entity.start, end: entity.end };
  }

  const word = entity.word.trim();
  if (word.length === 0) {
    return null;
  }

  const index = input.indexOf(word);
  return index >= 0 ? { start: index, end: index + word.length } : null;
}

function placeholderSpans(input: string): Array<{ start: number; end: number }> {
  return [...input.matchAll(/\[\[RR(?:_PF)?_[A-Z0-9]+_\d{4}\]\]/g)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length
  }));
}

function overlapsAnyPlaceholder(span: { start: number; end: number }, placeholders: Array<{ start: number; end: number }>): boolean {
  return placeholders.some((placeholder) => span.start < placeholder.end && span.end > placeholder.start);
}

function mergeOverlappingSpans(spans: Array<{ start: number; end: number; key: string }>): Array<{ start: number; end: number; key: string }> {
  const sorted = spans
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number; key: string }> = [];

  for (const span of sorted) {
    const previous = merged.at(-1);
    if (!previous || span.start >= previous.end) {
      merged.push({ ...span });
      continue;
    }

    if (span.end > previous.end) {
      previous.end = span.end;
    }
    if (isSecretRedactionKey(span.key) || isPrivacyFilterSecretKey(span.key)) {
      previous.key = span.key;
    }
  }

  return merged;
}

async function redactStringWithPrivacyFilter(
  input: string,
  threshold: number,
  placeholderSalt: string,
  counters: Map<string, number>,
  replacements: ReplacementMap,
  fieldCounts: Record<string, number>
): Promise<string> {
  if (input.trim().length === 0) {
    return input;
  }

  const classifier = await getClassifier();
  const entities = await classifier(input, { aggregation_strategy: "simple" });
  const protectedSpans = placeholderSpans(input);
  const spans = (entities as PrivacyEntity[])
    .filter((entity) => entity.score >= threshold)
    .map((entity) => {
      const bounds = entityBounds(entity, input);
      if (!bounds || overlapsAnyPlaceholder(bounds, protectedSpans)) {
        return null;
      }
      return {
        ...bounds,
        key: fieldKeyFor(entity.entity_group)
      };
    })
    .filter((span): span is { start: number; end: number; key: string } => Boolean(span));

  const merged = mergeOverlappingSpans(spans);
  if (merged.length === 0) {
    return input;
  }

  let output = "";
  let cursor = 0;
  for (const span of merged) {
    output += input.slice(cursor, span.start);

    const current = counters.get(span.key) ?? 0;
    const next = current + 1;
    counters.set(span.key, next);

    const placeholder = placeholderFor(span.key, next, placeholderSalt);
    replacements[placeholder] = input.slice(span.start, span.end);
    fieldCounts[span.key] = (fieldCounts[span.key] ?? 0) + 1;
    output += placeholder;
    cursor = span.end;
  }

  output += input.slice(cursor);
  return output;
}

async function visitAndRedactWithPrivacyFilter(
  value: unknown,
  threshold: number,
  placeholderSalt: string,
  counters: Map<string, number>,
  replacements: ReplacementMap,
  fieldCounts: Record<string, number>
): Promise<unknown> {
  if (typeof value === "string") {
    return redactStringWithPrivacyFilter(value, threshold, placeholderSalt, counters, replacements, fieldCounts);
  }

  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item) => visitAndRedactWithPrivacyFilter(item, threshold, placeholderSalt, counters, replacements, fieldCounts))
    );
  }

  if (isObject(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = await visitAndRedactWithPrivacyFilter(child, threshold, placeholderSalt, counters, replacements, fieldCounts);
    }
    return next;
  }

  return value;
}

export async function redactPayloadWithPrivacyFilter(payload: unknown, options: PrivacyFilterOptions = {}): Promise<PrivacyFilterRedactionResult> {
  const threshold = normalizeThreshold(options.threshold);
  const placeholderSalt = randomBytes(6).toString("hex");
  const counters = new Map<string, number>();
  const replacements: ReplacementMap = {};
  const fieldCounts: Record<string, number> = {};

  const sanitizedBody = await visitAndRedactWithPrivacyFilter(payload, threshold, placeholderSalt, counters, replacements, fieldCounts);
  const secretCount = Object.entries(fieldCounts)
    .filter(([key]) => isPrivacyFilterSecretKey(key))
    .reduce((sum, [, count]) => sum + count, 0);
  const piiCount = Object.entries(fieldCounts)
    .filter(([key]) => !isPrivacyFilterSecretKey(key))
    .reduce((sum, [, count]) => sum + count, 0);

  return {
    sanitizedBody,
    replacements,
    fieldCounts,
    piiCount,
    secretCount
  };
}
