import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { runEnhancedFingerprintAudit, shouldTriggerFingerprintAudit } from "../fingerprint/enhanced-audit.js";
import { extractResponseFeatures } from "../metrics/extractor.js";
import type { RelayRadarDb } from "../db.js";
import { EndpointStore } from "../endpoints.js";
import { PolicyStore } from "../policy.js";
import { detectRefusal } from "../shield/risk.js";
import { buildOpenAiUpstreamUrl, diceCoefficient, normalizeText, nowIso, safeJsonParse } from "../utils.js";
import { evaluateProbeExpectation } from "./evaluator.js";
import { SENTINEL_PROMPTS, type SentinelPrompt } from "./prompts.js";

interface SentinelDeps {
  db: RelayRadarDb;
  endpointStore: EndpointStore;
  policyStore: PolicyStore;
  logger: FastifyBaseLogger;
}

export class SentinelService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cursor = 0;
  private readonly lastSentinelRisk = new Map<string, { atMs: number; severity: "low" | "medium" | "high" }>();
  private readonly sentinelRiskCooldownMs = 15 * 60 * 1000;
  private readonly tokenLimitParamCache = new Map<string, { param: "max_tokens" | "max_completion_tokens"; expiresAt: number }>();

  public constructor(private readonly deps: SentinelDeps) {}

  private async detectTokenLimitParam(url: string, model: string, apiKey: string): Promise<"max_tokens" | "max_completion_tokens"> {
    const cacheKey = `${url}::${model}`;
    const cached = this.tokenLimitParamCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.param;
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || "gpt-4o-mini",
          messages: [{ role: "user", content: "Hi" }],
          temperature: 0,
          max_tokens: 10,
          stream: false
        }),
        signal: AbortSignal.timeout(30_000)
      });
      if (response.ok) {
        await response.text();
        this.tokenLimitParamCache.set(cacheKey, { param: "max_tokens", expiresAt: Date.now() + 3600_000 });
        return "max_tokens";
      }
      const text = await response.text();
      const lower = text.toLowerCase();
      if (lower.includes("max_completion_tokens") || (lower.includes("max_tokens") && (lower.includes("not supported") || lower.includes("unsupported")))) {
        this.tokenLimitParamCache.set(cacheKey, { param: "max_completion_tokens", expiresAt: Date.now() + 3600_000 });
        return "max_completion_tokens";
      }
      this.tokenLimitParamCache.set(cacheKey, { param: "max_tokens", expiresAt: Date.now() + 3600_000 });
      return "max_tokens";
    } catch {
      return "max_tokens";
    }
  }

  public start(): void {
    this.resetSchedule();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public resetSchedule(): void {
    this.stop();
    const policy = this.deps.policyStore.get();

    if (!policy.sentinelEnabled) {
      this.deps.logger.info("Sentinel disabled by policy");
      return;
    }

    const intervalMs = policy.sentinelIntervalMinutes * 60 * 1000;
    this.timer = setInterval(() => {
      void this.runCycle();
    }, intervalMs);

    void this.runCycle();
    this.deps.logger.info({ intervalMinutes: policy.sentinelIntervalMinutes }, "Sentinel scheduler started");
  }

  public async runCycle(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const policy = this.deps.policyStore.get();
      if (!policy.sentinelEnabled) {
        return;
      }

      const endpoints = this.deps.endpointStore.listEnabled();
      if (endpoints.length === 0) {
        return;
      }

      for (const endpoint of endpoints) {
        await this.runEndpointConfig(endpoint.id, endpoint.baseUrl, endpoint.declaredModel ?? "", endpoint.apiKey, endpoint.apiKeyEnv, policy.sentinelPromptsPerCycle);
      }
    } catch (error) {
      this.deps.logger.error({ err: error }, "Sentinel cycle failed");
    } finally {
      this.running = false;
    }
  }

  public async runEndpoint(endpointId: string): Promise<boolean> {
    const policy = this.deps.policyStore.get();
    if (!policy.sentinelEnabled) {
      return false;
    }

    const endpoint = this.deps.endpointStore.getEndpoint(endpointId);
    if (!endpoint) {
      return false;
    }

    await this.runEndpointConfig(
      endpoint.id,
      endpoint.baseUrl,
      endpoint.declaredModel ?? "",
      endpoint.apiKey,
      endpoint.apiKeyEnv,
      policy.sentinelPromptsPerCycle
    );
    return true;
  }

  private async runEndpointConfig(
    endpointId: string,
    baseUrl: string,
    declaredModel: string,
    apiKey: string | undefined,
    apiKeyEnv: string | undefined,
    promptCount: number
  ): Promise<void> {
    const prompts = this.pickPrompts(promptCount);
    await Promise.all(
      prompts.map((prompt) =>
        this.runPrompt(endpointId, baseUrl, declaredModel, apiKey, apiKeyEnv, prompt)
      )
    );
  }

  private insertSentinelSkippedRun(endpointId: string, prompt: SentinelPrompt, reason: string, detail: string): void {
    this.deps.db.insertSentinelRun({
      id: randomUUID(),
      endpointId,
      promptId: prompt.id,
      similarity: null,
      divergence: null,
      latencyMs: null,
      outputLength: 0,
      jsonSuccess: prompt.expectJson ? false : null,
      refusal: false,
      outputSignature: "",
      probeFeaturesJson: JSON.stringify({
        run: {
          status: "skipped",
          reason,
          detail
        },
        expectation: {
          summary: prompt.expectationSummary,
          configured: prompt.expectation.mode !== "none",
          passed: null,
          reason: "Probe did not run"
        }
      }),
      createdAt: nowIso()
    });
  }

  private insertSentinelFailedRun(endpointId: string, prompt: SentinelPrompt, latencyMs: number, errorType: string, message: string): void {
    this.deps.db.insertSentinelRun({
      id: randomUUID(),
      endpointId,
      promptId: prompt.id,
      similarity: null,
      divergence: null,
      latencyMs,
      outputLength: 0,
      jsonSuccess: prompt.expectJson ? false : null,
      refusal: false,
      outputSignature: "",
      probeFeaturesJson: JSON.stringify({
        run: {
          status: "failed",
          errorType,
          message: message.slice(0, 240),
          route: "/v1/chat/completions"
        },
        expectation: {
          summary: prompt.expectationSummary,
          configured: prompt.expectation.mode !== "none",
          passed: null,
          reason: "Probe request failed"
        }
      }),
      createdAt: nowIso()
    });
  }

  private insertSentinelHttpErrorRun(endpointId: string, prompt: SentinelPrompt, latencyMs: number, httpStatus: number, bodyText: string): void {
    this.deps.db.insertSentinelRun({
      id: randomUUID(),
      endpointId,
      promptId: prompt.id,
      similarity: null,
      divergence: null,
      latencyMs,
      outputLength: bodyText.length,
      jsonSuccess: prompt.expectJson ? false : null,
      refusal: false,
      outputSignature: normalizeText(bodyText).slice(0, 512),
      probeFeaturesJson: JSON.stringify({
        run: {
          status: "http_error",
          httpStatus,
          bodyPreview: normalizeText(bodyText).slice(0, 240),
          route: "/v1/chat/completions"
        },
        expectation: {
          summary: prompt.expectationSummary,
          configured: prompt.expectation.mode !== "none",
          passed: null,
          reason: "Upstream returned a non-OK response"
        }
      }),
      createdAt: nowIso()
    });
  }

  private pickPrompts(count: number): SentinelPrompt[] {
    if (SENTINEL_PROMPTS.length === 0) {
      this.deps.logger.warn("No sentinel prompts configured; sentinel skips this cycle");
      return [];
    }

    const picked: SentinelPrompt[] = [];
    for (let i = 0; i < count; i += 1) {
      const row = SENTINEL_PROMPTS[this.cursor % SENTINEL_PROMPTS.length];
      if (row) {
        picked.push(row);
      }
      this.cursor += 1;
    }
    return picked;
  }

  private async runPrompt(
    endpointId: string,
    baseUrl: string,
    declaredModel: string,
    apiKey: string | undefined,
    apiKeyEnv: string | undefined,
    prompt: SentinelPrompt
  ): Promise<void> {
    const resolvedApiKey = apiKey && apiKey.trim().length > 0 ? apiKey.trim() : apiKeyEnv ? process.env[apiKeyEnv] : undefined;
    if (!resolvedApiKey) {
      this.deps.logger.warn({ endpointId, promptId: prompt.id, apiKeyEnv }, "Skipping sentinel prompt because endpoint API key is missing");
      this.insertSentinelSkippedRun(endpointId, prompt, "missing_api_key", apiKeyEnv ? `Missing API key env ${apiKeyEnv}` : "Missing endpoint API key");
      return;
    }

    const url = buildOpenAiUpstreamUrl(baseUrl, "/v1/chat/completions");

    // Detect token limit parameter style (reasoning models need max_completion_tokens)
    const tokenLimitParam = await this.detectTokenLimitParam(url, declaredModel, resolvedApiKey);

    const startAt = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${resolvedApiKey}`
        },
        body: JSON.stringify({
          model: declaredModel || "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "You are being evaluated for endpoint stability. Follow format constraints exactly."
            },
            {
              role: "user",
              content: prompt.prompt
            }
          ],
          temperature: 0,
          [tokenLimitParam]: 220,
          stream: false
        }),
        signal: AbortSignal.timeout(45_000)
      });
    } catch (error) {
      this.deps.logger.warn({ endpointId, promptId: prompt.id, err: error }, "Sentinel challenge request failed");
      this.insertSentinelFailedRun(endpointId, prompt, Date.now() - startAt, "failed", error instanceof Error ? error.message : String(error));
      return;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      this.deps.logger.warn(
        { endpointId, promptId: prompt.id, status: response.status },
        "Sentinel challenge returned non-OK status"
      );
      this.insertSentinelHttpErrorRun(endpointId, prompt, Date.now() - startAt, response.status, errorText);
      return;
    }

    const latencyMs = Date.now() - startAt;
    const text = await response.text();
    const json = safeJsonParse<unknown>(text);
    const features = extractResponseFeatures(json ?? text, latencyMs);
    const signature = normalizeText(features.outputText).slice(0, 512);

    const previous = this.deps.db.getLatestSentinelSignature(endpointId, prompt.id);
    const similarity = previous ? diceCoefficient(previous.signature, signature) : 1;
    const divergence = 1 - similarity;
    const expectationEval = evaluateProbeExpectation(features.outputText, prompt.expectation);
    // Divergence is purely based on Dice coefficient — expectation results are recorded
    // as metadata but do not inflate the drift score. Format constraint failures are
    // common with relay-proxied models and are not reliable drift signals.
    const effectiveDivergence = divergence;

    const challengeFeatures = {
      run: {
        status: "ok",
        route: "/v1/chat/completions"
      },
      usageShape: features.usageShape,
      finishReason: features.finishReason,
      jsonValid: features.jsonValid,
      toolNamesFingerprint: features.toolNamesFingerprint,
      refusalTemplateHash: features.refusalTemplateHash,
      model: features.model,
      expectation: {
        summary: prompt.expectationSummary,
        mode: expectationEval.mode,
        configured: expectationEval.configured,
        passed: expectationEval.passed,
        score: expectationEval.score,
        reason: expectationEval.reason
      }
    };

    this.deps.db.insertSentinelRun({
      id: randomUUID(),
      endpointId,
      promptId: prompt.id,
      similarity,
      divergence: effectiveDivergence,
      latencyMs,
      outputLength: features.outputLength,
      jsonSuccess: prompt.expectJson ? features.jsonValid : null,
      refusal: detectRefusal(features.outputText),
      outputSignature: signature,
      probeFeaturesJson: JSON.stringify(challengeFeatures),
      createdAt: nowIso()
    });

    const auditPolicy = this.deps.policyStore.get();
    if (shouldTriggerFingerprintAudit(effectiveDivergence, auditPolicy)) {
      void runEnhancedFingerprintAudit(
        { db: this.deps.db, policyStore: this.deps.policyStore, logger: this.deps.logger },
        endpointId,
        `sentinel_divergence:${prompt.id}`
      );
    }

    const divergenceDetected = effectiveDivergence >= 0.42;

    if (divergenceDetected) {
      const status = effectiveDivergence >= 0.75 ? "High Risk" : effectiveDivergence >= 0.62 ? "Drifted" : "Watch";

      this.deps.db.insertDriftEvent({
        id: randomUUID(),
        endpointId,
        score: effectiveDivergence,
        status,
        reason: `sentinel/${prompt.id}`,
        evidence: {
          promptId: prompt.id,
          capability: prompt.capability,
          similarity,
          divergence: effectiveDivergence,
          rawDivergence: divergence,
          latencyMs,
          promptExpectJson: prompt.expectJson,
          expectation: {
            mode: expectationEval.mode,
            configured: expectationEval.configured,
            passed: expectationEval.passed,
            reason: expectationEval.reason
          }
        },
        createdAt: nowIso()
      });
    }

    // Emit risk event only on actual text divergence (not on expectation failure alone).
    if (divergenceDetected) {
      const summary = `Sentinel divergence detected for ${prompt.id} (score=${effectiveDivergence.toFixed(3)})`;
      const severity: "low" | "medium" | "high" = effectiveDivergence >= 0.8 ? "high" : "medium";
      const severityOrder: Record<"low" | "medium" | "high", number> = {
        low: 1,
        medium: 2,
        high: 3
      };
      const riskKey = `${endpointId}::${prompt.id}`;
      const nowMs = Date.now();
      const prev = this.lastSentinelRisk.get(riskKey);
      const withinCooldown = prev ? nowMs - prev.atMs < this.sentinelRiskCooldownMs : false;
      const shouldSuppress =
        withinCooldown && prev ? severityOrder[severity] <= severityOrder[prev.severity] : false;
      if (shouldSuppress) {
        this.deps.logger.debug(
          { endpointId, promptId: prompt.id, severity, cooldownMs: this.sentinelRiskCooldownMs },
          "Suppressing repeated sentinel risk event in cooldown window"
        );
        return;
      }

      this.deps.db.insertRiskEvent({
        id: randomUUID(),
        endpointId,
        requestId: null,
        type: "sentinel_divergence",
        severity,
        summary,
        details: {
          promptId: prompt.id,
          capability: prompt.capability,
          divergence: effectiveDivergence,
          rawDivergence: divergence,
          similarity,
          expectation: {
            mode: expectationEval.mode,
            configured: expectationEval.configured,
            passed: expectationEval.passed,
            reason: expectationEval.reason,
            summary: prompt.expectationSummary
          }
        },
        createdAt: nowIso()
      });
      this.lastSentinelRisk.set(riskKey, { atMs: nowMs, severity });
    }
  }
}
