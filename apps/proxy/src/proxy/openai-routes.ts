import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PolicyConfig } from "@relayradar/shared";
import { extractResponseFeatures, extractUsageShape } from "../metrics/extractor.js";
import type { RelayRadarDb } from "../db.js";
import { EndpointStore } from "../endpoints.js";
import { PolicyStore } from "../policy.js";
import { redactPayload, restorePayload, restoreText, type ReplacementMap } from "../shield/redactor.js";
import { redactPayloadWithPrivacyFilter } from "../shield/privacy-filter.js";
import { detectHighRiskResponse, detectRefusal, extractResponseText } from "../shield/risk.js";
import { buildOpenAiUpstreamUrl, isObject, normalizeText, nowIso, safeJsonParse, shortFingerprint } from "../utils.js";
import type { AppConfig } from "../config.js";

interface ProxyDeps {
  config: AppConfig;
  db: RelayRadarDb;
  endpointStore: EndpointStore;
  policyStore: PolicyStore;
}

interface ForwardContext {
  endpointId: string;
  requestId: string;
  routePath: string;
  replacements: ReplacementMap;
  policy: PolicyConfig;
  startAt: number;
}

function getHeaderString(headers: FastifyRequest["headers"], key: string): string | null {
  const value = headers[key.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return typeof value === "string" ? value : null;
}

function extractModel(requestBody: unknown): string | null {
  if (isObject(requestBody) && typeof requestBody.model === "string") {
    return requestBody.model;
  }
  return null;
}

function hasBlockedSessionTag(requestBody: unknown, policy: PolicyConfig, requestHeaders: FastifyRequest["headers"]): string | null {
  const tags = new Set<string>();
  const headerTags = getHeaderString(requestHeaders, "x-relayradar-session-tags");

  if (headerTags) {
    for (const raw of headerTags.split(",")) {
      const normalized = raw.trim();
      if (normalized.length > 0) {
        tags.add(normalized);
      }
    }
  }

  if (isObject(requestBody) && isObject(requestBody.metadata)) {
    const sessionTag = requestBody.metadata.session_tag;
    if (typeof sessionTag === "string") {
      tags.add(sessionTag);
    }

    const tagList = requestBody.metadata.session_tags;
    if (Array.isArray(tagList)) {
      for (const tag of tagList) {
        if (typeof tag === "string") {
          tags.add(tag);
        }
      }
    }
  }

  for (const tag of policy.disallowRelaySessionTags) {
    if (tags.has(tag)) {
      return tag;
    }
  }

  return null;
}

function stripLocalOnlyMarkers(input: unknown): { payload: unknown; strippedCount: number } {
  let strippedCount = 0;

  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      const next = value.replace(/\[\[LOCAL_ONLY:[\s\S]*?\]\]/g, () => {
        strippedCount += 1;
        return "[LOCAL_RULE_REDACTED]";
      });
      return next;
    }

    if (Array.isArray(value)) {
      return value.map(visit);
    }

    if (isObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        out[key] = visit(child);
      }
      return out;
    }

    return value;
  };

  return {
    payload: visit(input),
    strippedCount
  };
}

function maybeInjectCanary(payload: unknown, enabled: boolean): { payload: unknown; canaryToken: string | null } {
  if (!enabled || !isObject(payload)) {
    return { payload, canaryToken: null };
  }

  const token = `rrc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const next = structuredClone(payload) as Record<string, unknown>;
  const metadata = isObject(next.metadata) ? (next.metadata as Record<string, unknown>) : {};
  metadata.relayradar_canary = token;
  next.metadata = metadata;

  return {
    payload: next,
    canaryToken: token
  };
}

function maybeInjectPromptPerturbation(payload: unknown, enabled: boolean): unknown {
  if (!enabled || !isObject(payload)) {
    return payload;
  }

  const next = structuredClone(payload) as Record<string, unknown>;
  const metadata = isObject(next.metadata) ? (next.metadata as Record<string, unknown>) : {};
  metadata.relayradar_nonce = `rrn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  next.metadata = metadata;
  return next;
}

function enforceDeclaredModel(
  payload: unknown,
  declaredModel: string | undefined
): { payload: unknown; forwardedModel: string | null } {
  const normalizedDeclaredModel = typeof declaredModel === "string" ? declaredModel.trim() : "";
  if (normalizedDeclaredModel.length === 0) {
    return {
      payload,
      forwardedModel: extractModel(payload)
    };
  }

  if (!isObject(payload)) {
    return {
      payload,
      forwardedModel: null
    };
  }

  const currentModel = extractModel(payload);
  if (currentModel === normalizedDeclaredModel) {
    return {
      payload,
      forwardedModel: currentModel
    };
  }

  const nextPayload = structuredClone(payload) as Record<string, unknown>;
  nextPayload.model = normalizedDeclaredModel;

  return {
    payload: nextPayload,
    forwardedModel: normalizedDeclaredModel
  };
}

function buildBlockedResponse() {
  return {
    error: {
      message: "RelayRadar Shield blocked this response because it appears to solicit sensitive secrets.",
      type: "relayradar_shield_blocked",
      code: "relayradar_blocked"
    }
  };
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function buildUpstreamHeaders(
  request: FastifyRequest,
  endpointApiKey: string | undefined,
  endpointApiKeyEnv: string | undefined,
  passthroughAuth: boolean | undefined,
  minimalExposureEnabled: boolean
): Headers {
  const blocked = new Set(["host", "content-length", "connection", "x-relayradar-session-tags"]);
  if (minimalExposureEnabled) {
    for (const name of ["cookie", "set-cookie", "x-api-key", "x-api-token", "x-auth-token", "x-csrf-token"]) {
      blocked.add(name);
    }
  }
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (blocked.has(lower)) {
      continue;
    }

    if (typeof value === "string") {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      headers.set(name, value.join(","));
    }
  }

  const incomingAuth = getHeaderString(request.headers, "authorization");
  if (passthroughAuth !== false && incomingAuth) {
    headers.set("authorization", incomingAuth);
  } else if (endpointApiKey && endpointApiKey.trim().length > 0) {
    headers.set("authorization", `Bearer ${endpointApiKey.trim()}`);
  } else if (endpointApiKeyEnv && process.env[endpointApiKeyEnv]) {
    headers.set("authorization", `Bearer ${process.env[endpointApiKeyEnv]}`);
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return headers;
}

function extractUpstreamErrorFingerprint(statusCode: number, bodyText: string): string | null {
  if (statusCode < 400) {
    return null;
  }

  const parsed = safeJsonParse<Record<string, unknown>>(bodyText);
  if (parsed && isObject(parsed.error)) {
    const error = parsed.error as Record<string, unknown>;
    const type = typeof error.type === "string" ? error.type : "unknown";
    const message = typeof error.message === "string" ? normalizeText(error.message).slice(0, 160) : "";
    return shortFingerprint(`${type}|${message}`);
  }

  return shortFingerprint(normalizeText(bodyText).slice(0, 200));
}

function maybeRecordProtocolAnomaly(db: RelayRadarDb, endpointId: string, requestId: string, statusCode: number, detail: string): void {
  if (statusCode < 500) {
    return;
  }

  db.insertRiskEvent({
    id: randomUUID(),
    endpointId,
    requestId,
    type: "protocol_anomaly",
    severity: "medium",
    summary: `Upstream returned ${statusCode}: ${detail}`,
    details: { statusCode, detail },
    createdAt: nowIso()
  });
}

async function pipeStreamingResponse(reply: FastifyReply, upstreamResponse: Response, deps: ProxyDeps, context: ForwardContext): Promise<{
  statusCode: number;
  ttftMs: number | null;
  outputText: string;
  toolCallCount: number;
  finishReason: string | null;
  requestTokens: number | null;
  responseTokens: number | null;
  usageShape: string | null;
  streamEventCount: number;
  streamPayloadChars: number;
  toolNamesFingerprint: string | null;
  blocked: boolean;
}> {
  const controller = new AbortController();
  const reader = Readable.fromWeb(upstreamResponse.body as any);
  const decoder = new TextDecoder();

  const copiedHeaders: Record<string, string> = {};
  upstreamResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (["content-length", "transfer-encoding", "connection"].includes(lower)) {
      return;
    }
    copiedHeaders[key] = value;
  });

  copiedHeaders["x-relayradar-request-id"] = context.requestId;
  reply.raw.writeHead(upstreamResponse.status, copiedHeaders);

  let buffer = "";
  let ttftMs: number | null = null;
  let outputText = "";
  let toolCallCount = 0;
  let finishReason: string | null = null;
  let requestTokens: number | null = null;
  let responseTokens: number | null = null;
  let usageShape: string | null = null;
  let toolNamesFingerprint: string | null = null;
  let streamEventCount = 0;
  let streamPayloadChars = 0;
  let blocked = false;

  const onEvent = (eventBlock: string): void => {
    if (eventBlock.trim().length === 0) {
      reply.raw.write("\n\n");
      return;
    }

    const lines = eventBlock.split("\n");
    const nextLines: string[] = [];

    for (const line of lines) {
      if (!line.startsWith("data:")) {
        nextLines.push(line);
        continue;
      }

      const payloadRaw = line.slice(5).trim();
      if (payloadRaw === "[DONE]") {
        nextLines.push(line);
        continue;
      }

      if (payloadRaw.length === 0) {
        nextLines.push(line);
        continue;
      }

      if (ttftMs === null) {
        ttftMs = Date.now() - context.startAt;
      }

      const parsed = safeJsonParse<Record<string, unknown>>(payloadRaw);
      if (!parsed) {
        nextLines.push(line);
        continue;
      }

      streamEventCount += 1;
      streamPayloadChars += payloadRaw.length;

      const restored = restorePayload(parsed, context.replacements);
      const chunkText = extractResponseText(restored);
      if (chunkText) {
        outputText += chunkText;
      }

      const features = extractResponseFeatures(restored, 1);
      toolCallCount += features.toolCallCount;
      if (features.finishReason) {
        finishReason = features.finishReason;
      }
      if (features.requestTokens !== null) {
        requestTokens = features.requestTokens;
      }
      if (features.responseTokens !== null) {
        responseTokens = features.responseTokens;
      }

      const shape = extractUsageShape(restored);
      if (shape) {
        usageShape = shape;
      }

      if (features.toolNamesFingerprint) {
        toolNamesFingerprint = features.toolNamesFingerprint;
      }

      const risk = detectHighRiskResponse(outputText, {
        requiredFields: context.policy.requiredRedactionFields,
        manualRedactionStrings: context.policy.manualRedactionStrings,
        manualRedactionRegexes: context.policy.manualRedactionRegexes
      });
      if (context.policy.blockOnHighRiskResponse && risk.matchedRuleIds.length > 0) {
        blocked = true;
        deps.db.insertRiskEvent({
          id: randomUUID(),
          endpointId: context.endpointId,
          requestId: context.requestId,
          type: "response_high_risk_blocked",
          severity: "high",
          summary: "Streaming response blocked by shield rule",
          details: { matchedRuleIds: risk.matchedRuleIds, riskScore: risk.riskScore },
          createdAt: nowIso()
        });

        nextLines.push(`data: ${JSON.stringify(buildBlockedResponse())}`);
        nextLines.push("data: [DONE]");
        controller.abort();
        break;
      }

      nextLines.push(`data: ${JSON.stringify(restored)}`);
    }

    reply.raw.write(`${nextLines.join("\n")}\n\n`);
  };

  try {
    for await (const chunk of reader) {
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;

      let delimiterIndex = buffer.indexOf("\n\n");
      while (delimiterIndex !== -1) {
        const block = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        onEvent(block);
        if (blocked) {
          break;
        }
        delimiterIndex = buffer.indexOf("\n\n");
      }

      if (blocked) {
        break;
      }
    }

    if (!blocked && buffer.length > 0) {
      onEvent(buffer);
      buffer = "";
    }
  } catch (error) {
    if ((deps as any).logger) {
      (deps as any).logger.error({ err: error }, "Error reading from streaming response");
    } else {
      console.error("Error reading from streaming response:", error);
    }
    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
  } finally {
    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
    controller.abort();
  }

  return {
    statusCode: blocked ? 451 : upstreamResponse.status,
    ttftMs,
    outputText,
    toolCallCount,
    finishReason,
    requestTokens,
    responseTokens,
    usageShape,
    streamEventCount,
    streamPayloadChars,
    toolNamesFingerprint,
    blocked
  };
}

async function handleOpenAiProxyRoute(request: FastifyRequest, reply: FastifyReply, routePath: string, deps: ProxyDeps): Promise<void> {
  const requestedModel = extractModel(request.body);
  const endpoint = deps.endpointStore.resolveByModel(requestedModel);
  if (!endpoint) {
    reply.code(400).send({
      error: {
        message: requestedModel
          ? `No enabled endpoint available for model '${requestedModel}'.`
          : "No enabled endpoint configured.",
        type: "relayradar_endpoint_not_found"
      }
    });
    return;
  }

  const policy = deps.policyStore.get();
  const blockedTag = hasBlockedSessionTag(request.body, policy, request.headers);
  if (blockedTag) {
    reply.code(403).send({
      error: {
        message: `Session tagged as '${blockedTag}' is blocked from third-party relay by policy.`,
        type: "relayradar_policy_blocked"
      }
    });
    return;
  }

  const requestId = randomUUID();
  const startAt = Date.now();

  const stripped = stripLocalOnlyMarkers(request.body);
  const patternRedaction = redactPayload(
    stripped.payload,
    policy.requiredRedactionFields,
    policy.manualRedactionStrings,
    policy.manualRedactionRegexes
  );
  let sanitizedBody = patternRedaction.sanitizedBody;
  const replacements: ReplacementMap = { ...patternRedaction.replacements };
  const fieldCounts: Record<string, number> = { ...patternRedaction.fieldCounts };
  let piiCount = patternRedaction.piiCount;
  let secretCount = patternRedaction.secretCount;

  if (policy.privacyFilterEnabled) {
    try {
      const privacyFilterRedaction = await redactPayloadWithPrivacyFilter(sanitizedBody, {
        threshold: policy.privacyFilterThreshold
      });
      sanitizedBody = privacyFilterRedaction.sanitizedBody;
      Object.assign(replacements, privacyFilterRedaction.replacements);
      mergeCounts(fieldCounts, privacyFilterRedaction.fieldCounts);
      piiCount += privacyFilterRedaction.piiCount;
      secretCount += privacyFilterRedaction.secretCount;
    } catch (error) {
      deps.db.insertRiskEvent({
        id: randomUUID(),
        endpointId: endpoint.id,
        requestId,
        type: "protocol_anomaly",
        severity: "medium",
        summary: "Privacy filter model failed; continued with pattern redaction only",
        details: { message: error instanceof Error ? error.message : String(error) },
        createdAt: nowIso()
      });
    }
  }

  const modelRewrite = enforceDeclaredModel(sanitizedBody, endpoint.declaredModel);
  const perturbedPayload = maybeInjectPromptPerturbation(modelRewrite.payload, policy.promptPerturbationEnabled);
  const canary = maybeInjectCanary(perturbedPayload, policy.canaryEnabled);

  if (stripped.strippedCount > 0) {
    deps.db.insertRiskEvent({
      id: randomUUID(),
      endpointId: endpoint.id,
      requestId,
      type: "prompt_asset_protected",
      severity: "medium",
      summary: `Stripped ${stripped.strippedCount} LOCAL_ONLY prompt fragments before forwarding`,
      details: { strippedCount: stripped.strippedCount },
      createdAt: nowIso()
    });
  }

  if (canary.canaryToken) {
    deps.db.insertRiskEvent({
      id: randomUUID(),
      endpointId: endpoint.id,
      requestId,
      type: "canary_injected",
      severity: "low",
      summary: "Canary token injected into metadata",
      details: { canary: canary.canaryToken },
      createdAt: nowIso()
    });
  }

  if (piiCount > 0) {
    deps.db.insertRiskEvent({
      id: randomUUID(),
      endpointId: endpoint.id,
      requestId,
      type: "request_pii_redacted",
      severity: "medium",
      summary: `Redacted ${piiCount} PII entities from outbound request`,
      details: { fieldCounts, piiCount },
      createdAt: nowIso()
    });
  }

  if (secretCount > 0) {
    deps.db.insertRiskEvent({
      id: randomUUID(),
      endpointId: endpoint.id,
      requestId,
      type: "request_secret_redacted",
      severity: "high",
      summary: `Redacted ${secretCount} secrets from outbound request`,
      details: { fieldCounts, secretCount },
      createdAt: nowIso()
    });
  }

  const upstreamUrl = buildOpenAiUpstreamUrl(endpoint.baseUrl, routePath);
  const headers = buildUpstreamHeaders(
    request,
    endpoint.apiKey,
    endpoint.apiKeyEnv,
    endpoint.passthroughAuth,
    policy.minimalExposureEnabled
  );

  let upstreamResponse: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(deps.config.requestTimeoutMs);
    upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: JSON.stringify(canary.payload),
      signal: timeoutSignal
    });
  } catch (error: any) {
    const latencyMs = Date.now() - startAt;
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    const statusCode = isTimeout ? 504 : 502;
    const errorType = isTimeout ? "upstream_timeout" : "upstream_fetch_error";
    
    deps.db.insertRequestLog({
      id: requestId,
      endpointId: endpoint.id,
      route: routePath,
      model: modelRewrite.forwardedModel ?? requestedModel,
      statusCode,
      success: false,
      errorType,
      latencyMs,
      ttftMs: null,
      outputLength: 0,
      tokensPerSec: null,
      requestTokens: null,
      responseTokens: null,
      finishReason: null,
      stream: false,
      jsonValid: null,
      toolCallCount: 0,
      refusalDetected: false,
      usageShape: null,
      streamEventCount: null,
      streamPayloadChars: null,
      errorFingerprint: null,
      refusalTemplateHash: null,
      toolNamesFingerprint: null,
      createdAt: nowIso()
    });

    deps.db.insertRiskEvent({
      id: randomUUID(),
      endpointId: endpoint.id,
      requestId,
      type: "protocol_anomaly",
      severity: "high",
      summary: isTimeout ? "Upstream request timed out" : "Failed to reach upstream endpoint",
      details: { message: String(error) },
      createdAt: nowIso()
    });

    reply.code(statusCode).send({
      error: {
        message: isTimeout ? "RelayRadar upstream request timed out." : "RelayRadar could not reach upstream endpoint.",
        type: isTimeout ? "relayradar_upstream_timeout" : "relayradar_upstream_unavailable"
      }
    });
    return;
  }

  const streamRequested = isObject(canary.payload) && canary.payload.stream === true;
  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  const isSse = contentType.includes("text/event-stream");

  if (streamRequested && isSse && upstreamResponse.body) {
    const streamingResult = await pipeStreamingResponse(reply, upstreamResponse, deps, {
      endpointId: endpoint.id,
      requestId,
      routePath,
      replacements,
      policy,
      startAt
    });

    const latencyMs = Date.now() - startAt;
    const streamTextFeatures = extractResponseFeatures(
      { choices: [{ message: { content: streamingResult.outputText } }] } as unknown,
      latencyMs
    );

    deps.db.insertRequestLog({
      id: requestId,
      endpointId: endpoint.id,
      route: routePath,
      model: modelRewrite.forwardedModel ?? requestedModel,
      statusCode: streamingResult.statusCode,
      success: streamingResult.statusCode < 400,
      errorType: streamingResult.statusCode >= 400 ? "stream_blocked_or_error" : null,
      latencyMs,
      ttftMs: streamingResult.ttftMs,
      outputLength: streamingResult.outputText.length,
      tokensPerSec:
        streamingResult.responseTokens && latencyMs > 0
          ? streamingResult.responseTokens / (latencyMs / 1000)
          : null,
      requestTokens: streamingResult.requestTokens,
      responseTokens: streamingResult.responseTokens,
      finishReason: streamingResult.finishReason,
      stream: true,
      jsonValid: null,
      toolCallCount: streamingResult.toolCallCount,
      refusalDetected: streamTextFeatures.refusalDetected,
      usageShape: streamingResult.usageShape,
      streamEventCount: streamingResult.streamEventCount,
      streamPayloadChars: streamingResult.streamPayloadChars,
      errorFingerprint: null,
      refusalTemplateHash: streamTextFeatures.refusalTemplateHash,
      toolNamesFingerprint: streamingResult.toolNamesFingerprint,
      createdAt: nowIso()
    });

    if (!streamingResult.blocked) {
      maybeRecordProtocolAnomaly(deps.db, endpoint.id, requestId, upstreamResponse.status, "upstream streaming returned server error");
    }

    return;
  }

    let rawBody: string;
  try {
    rawBody = await upstreamResponse.text();
  } catch (error) {
    if ((deps as any).logger) {
      (deps as any).logger.error({ err: error }, "Failed to read upstream response body");
    } else {
      console.error("Failed to read upstream response body:", error);
    }
    reply.code(502).send({
      error: {
        message: "RelayRadar failed to read upstream response body.",
        type: "relayradar_upstream_read_error"
      }
    });
    return;
  }
  const restoredText = restoreText(rawBody, replacements);
  const restoredJson = safeJsonParse<unknown>(restoredText);
  const latencyMs = Date.now() - startAt;

  const features = extractResponseFeatures(restoredJson ?? restoredText, latencyMs);
  const highRisk = detectHighRiskResponse(features.outputText, {
    requiredFields: policy.requiredRedactionFields,
    manualRedactionStrings: policy.manualRedactionStrings,
    manualRedactionRegexes: policy.manualRedactionRegexes
  });

  if (highRisk.matchedRuleIds.length > 0) {
    deps.db.insertRiskEvent({
      id: randomUUID(),
      endpointId: endpoint.id,
      requestId,
      type: policy.blockOnHighRiskResponse ? "response_high_risk_blocked" : "response_high_risk_detected",
      severity: policy.blockOnHighRiskResponse ? "high" : "medium",
      summary: policy.blockOnHighRiskResponse
        ? "Shield blocked high-risk upstream response"
        : "Shield detected high-risk instructions in upstream response",
      details: {
        matchedRuleIds: highRisk.matchedRuleIds,
        riskScore: highRisk.riskScore
      },
      createdAt: nowIso()
    });

    if (policy.blockOnHighRiskResponse) {
      const blockedPayload = buildBlockedResponse();
      reply.code(451).header("x-relayradar-request-id", requestId).send(blockedPayload);

      deps.db.insertRequestLog({
        id: requestId,
        endpointId: endpoint.id,
        route: routePath,
        model: features.model ?? modelRewrite.forwardedModel ?? requestedModel,
        statusCode: 451,
        success: false,
        errorType: "response_high_risk_blocked",
        latencyMs,
        ttftMs: null,
        outputLength: 0,
        tokensPerSec: null,
        requestTokens: features.requestTokens,
        responseTokens: features.responseTokens,
        finishReason: "relayradar_blocked",
        stream: false,
        jsonValid: null,
        toolCallCount: features.toolCallCount,
        refusalDetected: false,
        usageShape: features.usageShape,
        streamEventCount: null,
        streamPayloadChars: null,
        errorFingerprint: null,
        refusalTemplateHash: null,
        toolNamesFingerprint: features.toolNamesFingerprint,
        createdAt: nowIso()
      });

      return;
    }
  }

  maybeRecordProtocolAnomaly(deps.db, endpoint.id, requestId, upstreamResponse.status, "upstream non-stream returned server error");

  const errorFingerprint = extractUpstreamErrorFingerprint(upstreamResponse.status, restoredText);

  deps.db.insertRequestLog({
    id: requestId,
    endpointId: endpoint.id,
    route: routePath,
    model: features.model ?? modelRewrite.forwardedModel ?? requestedModel,
    statusCode: upstreamResponse.status,
    success: upstreamResponse.status < 400,
    errorType: upstreamResponse.status >= 400 ? "upstream_error" : null,
    latencyMs,
    ttftMs: null,
    outputLength: features.outputLength,
    tokensPerSec: features.tokensPerSec,
    requestTokens: features.requestTokens,
    responseTokens: features.responseTokens,
    finishReason: features.finishReason,
    stream: false,
    jsonValid: features.jsonValid,
    toolCallCount: features.toolCallCount,
    refusalDetected: features.refusalDetected,
    usageShape: features.usageShape,
    streamEventCount: null,
    streamPayloadChars: null,
    errorFingerprint: upstreamResponse.status >= 400 ? errorFingerprint : null,
    refusalTemplateHash: features.refusalTemplateHash,
    toolNamesFingerprint: features.toolNamesFingerprint,
    createdAt: nowIso()
  });

  reply
    .code(upstreamResponse.status)
    .header("x-relayradar-request-id", requestId)
    .header("content-type", contentType.includes("application/json") ? "application/json" : contentType || "application/json")
    .send(restoredJson ?? restoredText);
}

export async function registerOpenAiProxyRoutes(app: FastifyInstance, deps: ProxyDeps): Promise<void> {
  app.post("/v1/chat/completions", async (request, reply) => handleOpenAiProxyRoute(request, reply, "/v1/chat/completions", deps));
  app.post("/v1/responses", async (request, reply) => handleOpenAiProxyRoute(request, reply, "/v1/responses", deps));

  app.get("/v1/models", async (request, reply) => {
    const endpoint = deps.endpointStore.resolveByModel(null);
    if (!endpoint) {
      reply.code(400).send({ error: { message: "No enabled endpoint configured", type: "relayradar_endpoint_not_found" } });
      return;
    }

    const requestId = randomUUID();
    try {
      const upstreamResponse = await fetch(buildOpenAiUpstreamUrl(endpoint.baseUrl, "/v1/models"), {
        method: "GET",
        headers: buildUpstreamHeaders(request, endpoint.apiKey, endpoint.apiKeyEnv, endpoint.passthroughAuth, deps.policyStore.get().minimalExposureEnabled),
        signal: AbortSignal.timeout(deps.config.requestTimeoutMs)
      });

      const text = await upstreamResponse.text();
      reply
        .code(upstreamResponse.status)
        .header("x-relayradar-request-id", requestId)
        .header("content-type", upstreamResponse.headers.get("content-type") ?? "application/json")
        .send(safeJsonParse<unknown>(text) ?? text);
    } catch (error) {
      reply.code(502).send({ error: { message: "Failed to fetch upstream models", detail: String(error) } });
    }
  });
}
