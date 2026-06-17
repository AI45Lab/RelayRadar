import type { ProbeExpectation } from "@relayradar/shared";
import { safeJsonParse } from "../utils.js";

export interface ProbeExpectationEvaluation {
  configured: boolean;
  mode: ProbeExpectation["mode"];
  passed: boolean | null;
  score: number | null;
  reason: string;
}

function normalizeText(input: string, caseSensitive: boolean): string {
  const next = input.trim();
  return caseSensitive ? next : next.toLowerCase();
}

function countWords(input: string): number {
  const words = input.trim().match(/[A-Za-z0-9_]+/g);
  return words ? words.length : 0;
}

function countSentences(input: string): number {
  return input
    .split(/[.!?。！？]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

function extractJsonCandidate(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed
      .replace(/^```[a-zA-Z]*\s*/g, "")
      .replace(/\s*```$/g, "")
      .trim();
  }

  return trimmed;
}

function countBulletLines(input: string): number {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*•]\s+/.test(line)).length;
}

function countNumberedSteps(input: string): number {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+[.)、]\s+/.test(line)).length;
}

function passResult(mode: ProbeExpectation["mode"], reason = "Expectation satisfied"): ProbeExpectationEvaluation {
  return {
    configured: true,
    mode,
    passed: true,
    score: 1,
    reason
  };
}

function failResult(mode: ProbeExpectation["mode"], reason: string): ProbeExpectationEvaluation {
  return {
    configured: true,
    mode,
    passed: false,
    score: 0,
    reason
  };
}

export function evaluateProbeExpectation(outputText: string, expectation: ProbeExpectation): ProbeExpectationEvaluation {
  const mode = expectation.mode;

  if (mode === "none") {
    return {
      configured: false,
      mode,
      passed: null,
      score: null,
      reason: "No strict expectation configured"
    };
  }

  if (mode === "exact_text") {
    const expected = expectation.value ?? "";
    const caseSensitive = expectation.caseSensitive === true;
    return normalizeText(outputText, caseSensitive) === normalizeText(expected, caseSensitive)
      ? passResult(mode)
      : failResult(mode, "Text does not exactly match expected value");
  }

  if (mode === "one_of") {
    const values = expectation.values ?? [];
    const caseSensitive = expectation.caseSensitive === true;
    const actual = normalizeText(outputText, caseSensitive);
    const ok = values.some((value) => normalizeText(value, caseSensitive) === actual);
    return ok ? passResult(mode) : failResult(mode, "Output is not one of the allowed options");
  }

  if (mode === "regex") {
    const pattern = expectation.pattern ?? "";
    if (pattern.trim().length === 0) {
      return failResult(mode, "Missing regex pattern");
    }

    try {
      const re = new RegExp(pattern, expectation.flags ?? "");
      return re.test(outputText.trim()) ? passResult(mode) : failResult(mode, "Regex pattern does not match output");
    } catch (error) {
      return failResult(mode, `Invalid regex: ${String(error)}`);
    }
  }

  if (mode === "contains_all") {
    const values = (expectation.values ?? []).filter((value) => value.trim().length > 0);
    if (values.length === 0) {
      return failResult(mode, "Missing required fragments");
    }

    const caseSensitive = expectation.caseSensitive === true;
    const normalized = normalizeText(outputText, caseSensitive);
    const missing = values.filter((value) => !normalized.includes(normalizeText(value, caseSensitive)));
    return missing.length === 0
      ? passResult(mode)
      : failResult(mode, `Missing required fragments: ${missing.join(", ")}`);
  }

  if (mode === "json_required_keys") {
    const requiredKeys = (expectation.requiredKeys ?? []).filter((key) => key.trim().length > 0);
    if (requiredKeys.length === 0) {
      return failResult(mode, "Missing required JSON keys definition");
    }

    const raw = extractJsonCandidate(outputText);
    const parsed = safeJsonParse<unknown>(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return failResult(mode, "Output is not a valid JSON object");
    }

    const missing = requiredKeys.filter((key) => typeof (parsed as Record<string, unknown>)[key] === "undefined");
    return missing.length === 0
      ? passResult(mode)
      : failResult(mode, `JSON object missing keys: ${missing.join(", ")}`);
  }

  if (mode === "word_count") {
    const value = countWords(outputText);
    const exact = expectation.exact;
    const min = expectation.min;
    const max = expectation.max;

    if (typeof exact === "number") {
      return value === exact
        ? passResult(mode)
        : failResult(mode, `Word count is ${value}, expected exactly ${exact}`);
    }

    if (typeof min === "number" && value < min) {
      return failResult(mode, `Word count is ${value}, below min ${min}`);
    }
    if (typeof max === "number" && value > max) {
      return failResult(mode, `Word count is ${value}, above max ${max}`);
    }
    return passResult(mode);
  }

  if (mode === "sentence_count") {
    const value = countSentences(outputText);
    const exact = expectation.exact;
    const min = expectation.min;
    const max = expectation.max;

    if (typeof exact === "number") {
      return value === exact
        ? passResult(mode)
        : failResult(mode, `Sentence count is ${value}, expected exactly ${exact}`);
    }

    if (typeof min === "number" && value < min) {
      return failResult(mode, `Sentence count is ${value}, below min ${min}`);
    }
    if (typeof max === "number" && value > max) {
      return failResult(mode, `Sentence count is ${value}, above max ${max}`);
    }
    return passResult(mode);
  }

  if (mode === "bullet_lines") {
    const bullets = countBulletLines(outputText);
    const exact = expectation.exact;
    const min = expectation.min;
    const max = expectation.max;

    if (typeof exact === "number") {
      return bullets === exact
        ? passResult(mode)
        : failResult(mode, `Bullet line count is ${bullets}, expected exactly ${exact}`);
    }
    if (typeof min === "number" && bullets < min) {
      return failResult(mode, `Bullet line count is ${bullets}, below min ${min}`);
    }
    if (typeof max === "number" && bullets > max) {
      return failResult(mode, `Bullet line count is ${bullets}, above max ${max}`);
    }
    return passResult(mode);
  }

  if (mode === "numbered_steps") {
    const steps = countNumberedSteps(outputText);
    const exact = expectation.exact;
    const min = expectation.min;
    const max = expectation.max;

    if (typeof exact === "number") {
      return steps === exact
        ? passResult(mode)
        : failResult(mode, `Numbered step count is ${steps}, expected exactly ${exact}`);
    }
    if (typeof min === "number" && steps < min) {
      return failResult(mode, `Numbered step count is ${steps}, below min ${min}`);
    }
    if (typeof max === "number" && steps > max) {
      return failResult(mode, `Numbered step count is ${steps}, above max ${max}`);
    }
    return passResult(mode);
  }

  return failResult(mode, "Unsupported expectation mode");
}
