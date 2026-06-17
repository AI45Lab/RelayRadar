import { createHash, randomBytes } from "node:crypto";
import { isObject } from "../utils.js";

export interface ReplacementMap {
  [placeholder: string]: string;
}

export interface RedactionResult {
  sanitizedBody: unknown;
  replacements: ReplacementMap;
  fieldCounts: Record<string, number>;
  piiCount: number;
  secretCount: number;
}

type RedactionCategory = "pii" | "secret";

export interface SensitiveMatch {
  key: string;
  category: RedactionCategory;
  count: number;
}

interface PatternRule {
  key: string;
  category: RedactionCategory;
  regex: RegExp;
}

interface ManualRegexRule {
  source: string;
  regex: RegExp;
}

const PATTERNS: PatternRule[] = [
  {
    key: "email",
    category: "pii",
    regex: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
  },
  {
    key: "id_number",
    category: "pii",
    regex: /(?<!\d)(?:\d{15}|\d{6}[-\s]?\d{8}[-\s]?\d{3}[0-9Xx])(?!\d)/g
  },
  {
    key: "phone",
    category: "pii",
    regex: /(?<![A-Za-z0-9])(?:\+?\d{1,3}[-\s]?)?(?:\(?\d{2,4}\)?[-\s])?\d{3,4}[-\s]\d{4}(?![A-Za-z0-9])/g
  },
  {
    key: "api_key",
    category: "secret",
    regex: /\b(?:sk|rk|pk|xoxb|ghp)[_-][A-Za-z0-9_\-]{12,}\b/g
  },
  {
    key: "api_key",
    category: "secret",
    regex: /\bsk-(?:proj|ant|or-v1)-[A-Za-z0-9_\-]{12,}\b/g
  },
  {
    key: "bearer_token",
    category: "secret",
    regex: /\bBearer\s+[A-Za-z0-9._~+\/=-]{20,}\b/g
  },
  {
    key: "token",
    category: "secret",
    regex: /\beyJ[A-Za-z0-9_\-.]{16,}\b/g
  },
  {
    key: "db_uri",
    category: "secret",
    regex: /\b(?:postgres|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/gi
  },
  {
    key: "private_key",
    category: "secret",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g
  }
];

export function isPiiRedactionKey(key: string): boolean {
  return (
    (key.startsWith("privacy_filter_") &&
      !key.includes("secret") &&
      !key.includes("key") &&
      !key.includes("token") &&
      !key.includes("password")) ||
    PATTERNS.some((pattern) => pattern.key === key && pattern.category === "pii")
  );
}

export function isSecretRedactionKey(key: string): boolean {
  return (
    key === "custom_literal" ||
    key === "custom_regex" ||
    (key.startsWith("privacy_filter_") &&
      (key.includes("secret") || key.includes("key") || key.includes("token") || key.includes("password"))) ||
    PATTERNS.some((pattern) => pattern.key === key && pattern.category === "secret")
  );
}

export function detectSensitiveText(
  input: string,
  requiredFields: string[],
  manualRedactionStrings: string[] = [],
  manualRedactionRegexes: string[] = []
): SensitiveMatch[] {
  const enabledRuleKeys = new Set(requiredFields);
  const matches = new Map<string, SensitiveMatch>();
  const addMatch = (key: string, category: RedactionCategory, count = 1): void => {
    const existing = matches.get(key);
    if (existing) {
      existing.count += count;
    } else {
      matches.set(key, { key, category, count });
    }
  };

  for (const literal of manualRedactionStrings) {
    const normalized = literal.trim();
    if (normalized.length === 0) {
      continue;
    }
    const count = input.split(normalized).length - 1;
    if (count > 0) {
      addMatch("custom_literal", "secret", count);
    }
  }

  for (const rule of compileManualRegexes(manualRedactionRegexes)) {
    const count = [...input.matchAll(new RegExp(rule.regex.source, rule.regex.flags))].length;
    if (count > 0) {
      addMatch("custom_regex", "secret", count);
    }
  }

  for (const rule of PATTERNS) {
    if (!enabledRuleKeys.has(rule.key)) {
      continue;
    }
    const count = [...input.matchAll(new RegExp(rule.regex.source, rule.regex.flags))].length;
    if (count > 0) {
      addMatch(rule.key, rule.category, count);
    }
  }

  return [...matches.values()];
}

function placeholderFor(key: string, index: number, salt: string): string {
  // Keep placeholders opaque to reduce semantic leakage to upstream relays.
  const token = createHash("sha256")
    .update(`${salt}:${key}`)
    .digest("hex")
    .slice(0, 6)
    .toUpperCase();
  return `[[RR_${token}_${String(index).padStart(4, "0")}]]`;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRegexLiteral(input: string): { source: string; flags: string } | null {
  if (!input.startsWith("/")) {
    return { source: input, flags: "g" };
  }

  const lastSlash = input.lastIndexOf("/");
  if (lastSlash <= 0) {
    return null;
  }

  const source = input.slice(1, lastSlash);
  const rawFlags = input.slice(lastSlash + 1);
  if (/[^gimsu]/.test(rawFlags)) {
    return null;
  }

  return {
    source,
    flags: rawFlags.includes("g") ? rawFlags : `${rawFlags}g`
  };
}

function compileManualRegexes(patterns: string[]): ManualRegexRule[] {
  const seen = new Set<string>();
  const rules: ManualRegexRule[] = [];

  for (const pattern of patterns) {
    const normalized = pattern.trim();
    if (normalized.length === 0 || normalized.length > 300 || seen.has(normalized)) {
      continue;
    }

    const parsed = parseRegexLiteral(normalized);
    if (!parsed || parsed.source.length === 0) {
      continue;
    }

    try {
      const regex = new RegExp(parsed.source, parsed.flags);
      const emptyMatcher = new RegExp(parsed.source, parsed.flags.replace(/g/g, ""));
      if (emptyMatcher.test("")) {
        continue;
      }
      seen.add(normalized);
      rules.push({ source: normalized, regex });
    } catch {
      // Invalid user-defined regexes are ignored at runtime. The Console validates them before saving.
    }
  }

  return rules;
}

function redactManualLiterals(
  input: string,
  manualLiterals: string[],
  placeholderSalt: string,
  counters: Map<string, number>,
  replacements: ReplacementMap,
  fieldCounts: Record<string, number>
): string {
  let output = input;

  for (const literal of manualLiterals) {
    const normalized = literal.trim();
    if (normalized.length === 0) {
      continue;
    }

    const pattern = new RegExp(escapeRegex(normalized), "g");
    output = output.replace(pattern, (match) => {
      const current = counters.get("custom_literal") ?? 0;
      const next = current + 1;
      counters.set("custom_literal", next);

      const placeholder = placeholderFor("custom_literal", next, placeholderSalt);
      replacements[placeholder] = match;
      fieldCounts.custom_literal = (fieldCounts.custom_literal ?? 0) + 1;
      return placeholder;
    });
  }

  return output;
}

function redactManualRegexes(
  input: string,
  manualRegexes: ManualRegexRule[],
  placeholderSalt: string,
  counters: Map<string, number>,
  replacements: ReplacementMap,
  fieldCounts: Record<string, number>
): string {
  let output = input;

  for (const rule of manualRegexes) {
    output = output.replace(rule.regex, (match) => {
      if (match.length === 0) {
        return match;
      }

      const current = counters.get("custom_regex") ?? 0;
      const next = current + 1;
      counters.set("custom_regex", next);

      const placeholder = placeholderFor("custom_regex", next, placeholderSalt);
      replacements[placeholder] = match;
      fieldCounts.custom_regex = (fieldCounts.custom_regex ?? 0) + 1;
      return placeholder;
    });
  }

  return output;
}

function redactString(
  input: string,
  enabledRuleKeys: Set<string>,
  manualLiterals: string[],
  manualRegexes: ManualRegexRule[],
  placeholderSalt: string,
  counters: Map<string, number>,
  replacements: ReplacementMap,
  fieldCounts: Record<string, number>
): string {
  let output = input;
  output = redactManualLiterals(output, manualLiterals, placeholderSalt, counters, replacements, fieldCounts);
  output = redactManualRegexes(output, manualRegexes, placeholderSalt, counters, replacements, fieldCounts);

  for (const rule of PATTERNS) {
    if (!enabledRuleKeys.has(rule.key)) {
      continue;
    }

    output = output.replace(rule.regex, (match) => {
      const current = counters.get(rule.key) ?? 0;
      const next = current + 1;
      counters.set(rule.key, next);

      const placeholder = placeholderFor(rule.key, next, placeholderSalt);
      replacements[placeholder] = match;
      fieldCounts[rule.key] = (fieldCounts[rule.key] ?? 0) + 1;
      return placeholder;
    });
  }

  return output;
}

function visitAndRedact(
  value: unknown,
  enabledRuleKeys: Set<string>,
  manualLiterals: string[],
  manualRegexes: ManualRegexRule[],
  placeholderSalt: string,
  counters: Map<string, number>,
  replacements: ReplacementMap,
  fieldCounts: Record<string, number>
): unknown {
  if (typeof value === "string") {
    return redactString(value, enabledRuleKeys, manualLiterals, manualRegexes, placeholderSalt, counters, replacements, fieldCounts);
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      visitAndRedact(item, enabledRuleKeys, manualLiterals, manualRegexes, placeholderSalt, counters, replacements, fieldCounts)
    );
  }

  if (isObject(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = visitAndRedact(child, enabledRuleKeys, manualLiterals, manualRegexes, placeholderSalt, counters, replacements, fieldCounts);
    }
    return next;
  }

  return value;
}

export function redactPayload(
  payload: unknown,
  requiredFields: string[],
  manualRedactionStrings: string[] = [],
  manualRedactionRegexes: string[] = []
): RedactionResult {
  const enabledRuleKeys = new Set(requiredFields);
  const manualLiterals = [...new Set(manualRedactionStrings.map((item) => item.trim()).filter((item) => item.length > 0))].sort(
    (a, b) => b.length - a.length
  );
  const manualRegexes = compileManualRegexes(manualRedactionRegexes);
  const placeholderSalt = randomBytes(6).toString("hex");
  const counters = new Map<string, number>();
  const replacements: ReplacementMap = {};
  const fieldCounts: Record<string, number> = {};

  const sanitizedBody = visitAndRedact(
    payload,
    enabledRuleKeys,
    manualLiterals,
    manualRegexes,
    placeholderSalt,
    counters,
    replacements,
    fieldCounts
  );

  const piiCount = Object.entries(fieldCounts)
    .filter(([key]) => isPiiRedactionKey(key))
    .reduce((sum, [, count]) => sum + count, 0);

  const secretCount = Object.entries(fieldCounts)
    .filter(
      ([key]) => isSecretRedactionKey(key)
    )
    .reduce((sum, [, count]) => sum + count, 0);

  return {
    sanitizedBody,
    replacements,
    fieldCounts,
    piiCount,
    secretCount
  };
}

function restoreInString(text: string, replacements: ReplacementMap): string {
  let restored = text;
  for (const [placeholder, original] of Object.entries(replacements)) {
    if (restored.includes(placeholder)) {
      restored = restored.split(placeholder).join(original);
    }

    // Some models may strip wrapper brackets and return bare token forms like RR_XXXXXX_0001.
    const bareToken =
      placeholder.startsWith("[[") && placeholder.endsWith("]]")
        ? placeholder.slice(2, -2)
        : null;
    if (bareToken && restored.includes(bareToken)) {
      const bareTokenPattern = new RegExp(`\\b${escapeRegex(bareToken)}\\b`, "g");
      restored = restored.replace(bareTokenPattern, original);
    }
  }
  return restored;
}

export function restorePayload<T>(payload: T, replacements: ReplacementMap): T {
  if (typeof payload === "string") {
    return restoreInString(payload, replacements) as T;
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => restorePayload(item, replacements)) as T;
  }

  if (isObject(payload)) {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      next[key] = restorePayload(value, replacements);
    }
    return next as T;
  }

  return payload;
}

export function restoreText(text: string, replacements: ReplacementMap): string {
  return restoreInString(text, replacements);
}
