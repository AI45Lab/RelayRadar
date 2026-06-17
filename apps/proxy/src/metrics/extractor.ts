import { detectRefusal, extractResponseText } from "../shield/risk.js";
import { isObject, normalizeText, safeJsonParse, shortFingerprint } from "../utils.js";

export interface ExtractedResponseFeatures {
  model: string | null;
  finishReason: string | null;
  outputText: string;
  outputLength: number;
  jsonValid: boolean | null;
  toolCallCount: number;
  requestTokens: number | null;
  responseTokens: number | null;
  tokensPerSec: number | null;
  refusalDetected: boolean;
  /** usage 对象键名排序后拼接，用于匿名形态画像 */
  usageShape: string | null;
  /** 工具调用 function.name 排序后指纹，不含参数 */
  toolNamesFingerprint: string | null;
  refusalTemplateHash: string | null;
}

function extractUsage(payload: Record<string, unknown>): { requestTokens: number | null; responseTokens: number | null } {
  const usage = payload.usage;
  if (!isObject(usage)) {
    return { requestTokens: null, responseTokens: null };
  }

  const promptTokens =
    typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : typeof usage.input_tokens === "number"
        ? usage.input_tokens
        : null;

  const completionTokens =
    typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : typeof usage.output_tokens === "number"
        ? usage.output_tokens
        : null;

  return {
    requestTokens: promptTokens,
    responseTokens: completionTokens
  };
}

export function extractUsageShape(payload: unknown): string | null {
  if (!isObject(payload)) {
    return null;
  }

  const usage = payload.usage;
  if (!isObject(usage)) {
    return null;
  }

  const keys = Object.keys(usage).sort();
  return keys.length === 0 ? null : keys.join(",");
}

function collectToolFunctionNames(payload: Record<string, unknown>): string[] {
  const names: string[] = [];

  const visitToolCalls = (calls: unknown): void => {
    if (!Array.isArray(calls)) {
      return;
    }

    for (const call of calls) {
      if (!isObject(call)) {
        continue;
      }

      const fn = call.function;
      if (isObject(fn) && typeof fn.name === "string" && fn.name.trim().length > 0) {
        names.push(fn.name.trim());
      }
    }
  };

  const choices = payload.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isObject(choice)) {
        continue;
      }

      const message = choice.message;
      if (isObject(message)) {
        visitToolCalls(message.tool_calls);
      }

      const delta = choice.delta;
      if (isObject(delta)) {
        visitToolCalls(delta.tool_calls);
      }
    }
  }

  const output = payload.output;
  if (Array.isArray(output)) {
    for (const block of output) {
      if (!isObject(block)) {
        continue;
      }

      visitToolCalls(block.tool_calls);
    }
  }

  return names;
}

export function extractToolNamesFingerprint(payload: unknown): string | null {
  if (!isObject(payload)) {
    return null;
  }

  const unique = [...new Set(collectToolFunctionNames(payload))].sort();
  if (unique.length === 0) {
    return null;
  }

  return shortFingerprint(unique.join("|"));
}

function extractToolCallCount(payload: Record<string, unknown>): number {
  let count = 0;
  const choices = payload.choices;

  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isObject(choice)) {
        continue;
      }

      const message = choice.message;
      if (isObject(message) && Array.isArray(message.tool_calls)) {
        count += message.tool_calls.length;
      }

      const delta = choice.delta;
      if (isObject(delta) && Array.isArray(delta.tool_calls)) {
        count += delta.tool_calls.length;
      }
    }
  }

  const output = payload.output;
  if (Array.isArray(output)) {
    for (const block of output) {
      if (!isObject(block)) {
        continue;
      }

      if (Array.isArray(block.tool_calls)) {
        count += block.tool_calls.length;
      }
    }
  }

  return count;
}

function extractFinishReason(payload: Record<string, unknown>): string | null {
  const choices = payload.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isObject(choice)) {
        continue;
      }

      if (typeof choice.finish_reason === "string") {
        return choice.finish_reason;
      }
    }
  }

  if (typeof payload.status === "string") {
    return payload.status;
  }

  return null;
}

function detectJsonValidity(text: string): boolean | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return null;
  }

  return safeJsonParse<unknown>(trimmed) !== null;
}

function refusalTemplateHashFromText(outputText: string, refusalDetected: boolean): string | null {
  if (!refusalDetected) {
    return null;
  }

  const normalized = normalizeText(outputText).slice(0, 200);
  return normalized.length === 0 ? null : shortFingerprint(normalized);
}

export function extractResponseFeatures(payload: unknown, latencyMs: number): ExtractedResponseFeatures {
  if (!isObject(payload)) {
    const outputText = typeof payload === "string" ? payload : "";
    const refusalDetected = detectRefusal(outputText);
    return {
      model: null,
      finishReason: null,
      outputText,
      outputLength: outputText.length,
      jsonValid: detectJsonValidity(outputText),
      toolCallCount: 0,
      requestTokens: null,
      responseTokens: null,
      tokensPerSec: null,
      refusalDetected,
      usageShape: null,
      toolNamesFingerprint: null,
      refusalTemplateHash: refusalTemplateHashFromText(outputText, refusalDetected)
    };
  }

  const usage = extractUsage(payload);
  const outputText = extractResponseText(payload);
  const outputLength = outputText.length;
  const jsonValid = detectJsonValidity(outputText);
  const toolCallCount = extractToolCallCount(payload);
  const refusalDetected = detectRefusal(outputText);

  const tokensPerSec =
    usage.responseTokens && latencyMs > 0
      ? usage.responseTokens / (latencyMs / 1000)
      : null;

  return {
    model: typeof payload.model === "string" ? payload.model : null,
    finishReason: extractFinishReason(payload),
    outputText,
    outputLength,
    jsonValid,
    toolCallCount,
    requestTokens: usage.requestTokens,
    responseTokens: usage.responseTokens,
    tokensPerSec,
    refusalDetected,
    usageShape: extractUsageShape(payload),
    toolNamesFingerprint: extractToolNamesFingerprint(payload),
    refusalTemplateHash: refusalTemplateHashFromText(outputText, refusalDetected)
  };
}
