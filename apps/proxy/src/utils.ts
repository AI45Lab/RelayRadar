import { createHash } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

/** 短匿名指纹（用于错误形态、脱敏模板聚类，不可逆推原文） */
export function shortFingerprint(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(clamp(p, 0, 1) * (sorted.length - 1));
  return sorted[index] ?? 0;
}

export function avg(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

export function floorToHour(iso: string): string {
  const date = new Date(iso);
  date.setMinutes(0, 0, 0);
  return date.toISOString();
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function diceCoefficient(a: string, b: string): number {
  if (!a && !b) {
    return 1;
  }

  if (!a || !b) {
    return 0;
  }

  const bigrams = (value: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < value.length - 1; i += 1) {
      const bg = value.slice(i, i + 2);
      map.set(bg, (map.get(bg) ?? 0) + 1);
    }
    return map;
  };

  const aMap = bigrams(a);
  const bMap = bigrams(b);
  let overlap = 0;

  for (const [key, aCount] of aMap.entries()) {
    const bCount = bMap.get(key);
    if (bCount) {
      overlap += Math.min(aCount, bCount);
    }
  }

  const total = [...aMap.values()].reduce((sum, n) => sum + n, 0) + [...bMap.values()].reduce((sum, n) => sum + n, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

export function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function buildOpenAiUpstreamUrl(baseUrl: string, routePath: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const path = routePath.startsWith("/") ? routePath : `/${routePath}`;

  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${base}${path.slice(3)}`;
  }

  return `${base}${path}`;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function collectStringValues(input: unknown, acc: string[] = []): string[] {
  if (typeof input === "string") {
    acc.push(input);
    return acc;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      collectStringValues(item, acc);
    }
    return acc;
  }

  if (isObject(input)) {
    for (const value of Object.values(input)) {
      collectStringValues(value, acc);
    }
  }

  return acc;
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
