import { collectStringValues, isObject, normalizeText } from "../utils.js";
import { detectSensitiveText } from "./redactor.js";

const highRiskRules: Array<{ id: string; regex: RegExp }> = [
  { id: "ask_api_key", regex: /(api\s*key|secret\s*key).{0,40}(send|paste|provide|share|告诉我|贴|提供)/i },
  { id: "ask_env_file", regex: /(\.env|environment variables?|环境变量).{0,30}(send|paste|upload|share|提供|发我)/i },
  { id: "ask_db_password", regex: /(database|db|mysql|postgres|redis).{0,30}(password|credential|connection string|口令|密码)/i },
  { id: "ask_cookie_or_token", regex: /(cookie|session token|access token|jwt|refresh token).{0,25}(paste|share|send|提供|贴)/i },
  { id: "danger_command", regex: /(sudo\s+rm\s+-rf\s+\/|curl\s+.*\|\s*sh|powershell.+iex|wget.+\|\s*bash)/i },
  { id: "ask_full_internal_doc", regex: /(full\s+internal\s+doc|entire\s+document|完整内部文档|全部文档).{0,20}(upload|paste|share|贴)/i }
];

const refusalPatterns = [
  /i\s+can(?:not|'t)\s+assist/i,
  /i\s+can(?:not|'t)\s+help\s+with\s+that/i,
  /cannot comply/i,
  /抱歉[，,]我不能/i,
  /无法帮助你/i,
  /不能提供/i
];

export function detectHighRiskResponse(
  text: string,
  options?: { requiredFields?: string[]; manualRedactionStrings?: string[]; manualRedactionRegexes?: string[] }
): { matchedRuleIds: string[]; riskScore: number } {
  const matchedRuleIds = highRiskRules.filter((rule) => rule.regex.test(text)).map((rule) => rule.id);
  const sensitiveMatches = detectSensitiveText(
    text,
    options?.requiredFields ?? [],
    options?.manualRedactionStrings ?? [],
    options?.manualRedactionRegexes ?? []
  );
  for (const match of sensitiveMatches) {
    matchedRuleIds.push(`response_leaked_${match.key}`);
  }
  return {
    matchedRuleIds: [...new Set(matchedRuleIds)],
    riskScore: matchedRuleIds.length === 0 ? 0 : Math.min(1, matchedRuleIds.length * 0.35 + 0.3)
  };
}

export function detectRefusal(text: string): boolean {
  const normalized = normalizeText(text);
  return refusalPatterns.some((pattern) => pattern.test(normalized));
}

function pushReasoningFields(values: string[], source: Record<string, unknown>): void {
  // Reasoning models (DeepSeek V4, GLM 4.x, some GPT-5/Gemini 3) emit empty
  // content and put the visible output in reasoning_content / reasoning / thinking.
  // Shield must scan these for leaked secrets/PII just like regular content.
  for (const field of ["reasoning_content", "reasoning", "thinking"] as const) {
    const value = source[field];
    if (typeof value === "string") {
      values.push(value);
    } else if (Array.isArray(value)) {
      for (const part of value) {
        if (isObject(part) && typeof part.text === "string") {
          values.push(part.text);
        }
      }
    }
  }
}

function collectChatContent(payload: Record<string, unknown>): string[] {
  const values: string[] = [];
  const choices = payload.choices;
  if (!Array.isArray(choices)) {
    return values;
  }

  for (const choice of choices) {
    if (!isObject(choice)) {
      continue;
    }

    const message = choice.message;
    if (isObject(message)) {
      const content = message.content;
      if (typeof content === "string") {
        values.push(content);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (isObject(part) && typeof part.text === "string") {
            values.push(part.text);
          }
        }
      }
      pushReasoningFields(values, message);
    }

    const delta = choice.delta;
    if (isObject(delta)) {
      const deltaContent = delta.content;
      if (typeof deltaContent === "string") {
        values.push(deltaContent);
      } else if (Array.isArray(deltaContent)) {
        for (const part of deltaContent) {
          if (isObject(part) && typeof part.text === "string") {
            values.push(part.text);
          }
        }
      }
      pushReasoningFields(values, delta);
    }
  }

  return values;
}

function collectResponsesApiContent(payload: Record<string, unknown>): string[] {
  const values: string[] = [];
  const output = payload.output;
  if (!Array.isArray(output)) {
    return values;
  }

  for (const block of output) {
    if (!isObject(block)) {
      continue;
    }

    const content = block.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const piece of content) {
      if (isObject(piece) && typeof piece.text === "string") {
        values.push(piece.text);
      }
    }
  }

  return values;
}

export function extractResponseText(payload: unknown): string {
  if (!isObject(payload)) {
    if (typeof payload === "string") {
      return payload;
    }
    return "";
  }

  const chunks = [...collectChatContent(payload), ...collectResponsesApiContent(payload), ...collectStringValues(payload)];
  return chunks.join("\n");
}
