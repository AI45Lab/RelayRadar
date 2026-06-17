import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  EndpointAdminRecord,
  EndpointConfigRecord,
  EndpointDetail,
  EndpointHealthStatus,
  EndpointOverview,
  FingerprintAuditRecord,
  FingerprintBaselineRecord,
  FingerprintModelRecord,
  FingerprintWindowStats,
  PassiveFingerprintPortrait,
  PolicyConfig,
  RiskEvent,
  SentinelHealthResponse,
  SentinelPromptHealth,
  SentinelRunStatus,
  ShieldCenterResponse
} from "@relayradar/shared";
import { avg, clamp, floorToHour, nowIso, percentile, round, safeJsonParse } from "./utils.js";
import { isPiiRedactionKey, isSecretRedactionKey } from "./shield/redactor.js";

interface EndpointRow {
  id: string;
  name: string;
  base_url: string;
  declared_model: string;
  fingerprint_baseline_mode: string;
  fingerprint_baseline_id: string;
  provider_tag: string;
  api_key: string;
  api_key_env: string;
  passthrough_auth: number;
  is_default: number;
  enabled: number;
  first_seen_at: string;
  last_seen_at: string;
}

interface RequestLogInsert {
  id: string;
  endpointId: string;
  route: string;
  model: string | null;
  statusCode: number;
  success: boolean;
  errorType: string | null;
  latencyMs: number;
  ttftMs: number | null;
  outputLength: number;
  tokensPerSec: number | null;
  requestTokens: number | null;
  responseTokens: number | null;
  finishReason: string | null;
  stream: boolean;
  jsonValid: boolean | null;
  toolCallCount: number;
  refusalDetected: boolean;
  usageShape: string | null;
  streamEventCount: number | null;
  streamPayloadChars: number | null;
  errorFingerprint: string | null;
  refusalTemplateHash: string | null;
  toolNamesFingerprint: string | null;
  createdAt: string;
}

interface RiskEventInsert {
  id: string;
  endpointId: string;
  requestId: string | null;
  type: string;
  severity: "low" | "medium" | "high";
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
}

interface DriftEventInsert {
  id: string;
  endpointId: string;
  score: number;
  status: EndpointHealthStatus;
  reason: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

interface SentinelRunInsert {
  id: string;
  endpointId: string;
  promptId: string;
  similarity: number | null;
  divergence: number | null;
  latencyMs: number | null;
  outputLength: number;
  jsonSuccess: boolean | null;
  refusal: boolean;
  outputSignature: string;
  probeFeaturesJson: string;
  createdAt: string;
}

interface RequestLogRow {
  created_at: string;
  latency_ms: number;
  ttft_ms: number | null;
  success: number;
  status_code: number;
  output_length: number;
  tokens_per_sec: number | null;
  json_valid: number | null;
  tool_call_count: number;
  refusal_detected: number;
  stream: number;
  finish_reason: string | null;
  usage_shape: string | null;
  stream_event_count: number | null;
  stream_payload_chars: number | null;
  error_fingerprint: string | null;
  refusal_template_hash: string | null;
}

interface DriftRow {
  score: number;
  status: EndpointHealthStatus;
  reason: string;
  evidence_json: string;
  created_at: string;
}

interface RiskRow {
  id: string;
  endpoint_id: string;
  request_id: string | null;
  type: string;
  severity: "low" | "medium" | "high";
  summary: string;
  details_json: string;
  created_at: string;
}

interface SentinelRow {
  output_signature: string;
  divergence: number | null;
  created_at: string;
}

interface SentinelHealthPromptMeta {
  id: string;
  title: string;
  capability: string;
}

interface SentinelHealthRunRow {
  prompt_id: string;
  divergence: number | null;
  latency_ms: number | null;
  json_success: number | null;
  output_length: number;
  probe_features_json: string;
  created_at: string;
}

interface FingerprintBaselineRow {
  id: string;
  name: string;
  label: string;
  model_name: string;
  provider_tag: string;
  model_family: string;
  notes: string;
  source: string;
  top_k: number;
  samples_per_prompt: number;
  permutation_iters: number;
  is_preferred: number;
  profile_json: string;
  report_json: string;
  created_at: string;
  updated_at: string;
}

interface FingerprintModelRow {
  id: string;
  label: string;
  model_name: string;
  provider_tag: string;
  model_family: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * ONE_DAY_MS).toISOString();
}

function parseRiskRow(row: RiskRow): RiskEvent {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    requestId: row.request_id,
    type: row.type as RiskEvent["type"],
    severity: row.severity,
    summary: row.summary,
    details: safeJsonParse<Record<string, unknown>>(row.details_json) ?? {},
    createdAt: row.created_at
  };
}

function maskApiKey(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length <= 8) {
    return `${"*".repeat(trimmed.length - 2)}${trimmed.slice(-2)}`;
  }

  return `${trimmed.slice(0, 4)}${"*".repeat(8)}${trimmed.slice(-4)}`;
}

export class RelayRadarDb {
  private readonly db: DatabaseSync;

  public constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.initSchema();
  }

  public close(): void {
    this.db.close();
  }

  public upsertEndpoint(endpoint: EndpointConfigRecord, options?: { clearApiKey?: boolean }): void {
    const now = nowIso();
    const statement = this.db.prepare(`
      INSERT INTO endpoints (
        id, name, base_url, declared_model, fingerprint_baseline_mode, fingerprint_baseline_id, provider_tag, api_key, api_key_env,
        passthrough_auth, is_default, enabled, first_seen_at, last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        base_url = excluded.base_url,
        declared_model = excluded.declared_model,
        fingerprint_baseline_mode = excluded.fingerprint_baseline_mode,
        fingerprint_baseline_id = excluded.fingerprint_baseline_id,
        provider_tag = excluded.provider_tag,
        api_key_env = excluded.api_key_env,
        passthrough_auth = excluded.passthrough_auth,
        enabled = excluded.enabled,
        last_seen_at = excluded.last_seen_at,
        api_key = CASE
          WHEN ? = 1 THEN ''
          WHEN ? <> '' THEN ?
          ELSE endpoints.api_key
        END
    `);

    const rawApiKey = endpoint.apiKey?.trim() ?? "";
    const clearApiKey = options?.clearApiKey === true;

    statement.run(
      endpoint.id,
      endpoint.name,
      endpoint.baseUrl,
      endpoint.declaredModel ?? "",
      endpoint.fingerprintBaselineMode === "manual_baseline" ? "manual_baseline" : "declared_model",
      endpoint.fingerprintBaselineMode === "manual_baseline" ? (endpoint.fingerprintBaselineId ?? "") : "",
      endpoint.providerTag ?? "",
      clearApiKey ? "" : rawApiKey,
      endpoint.apiKeyEnv ?? "",
      endpoint.passthroughAuth === false ? 0 : 1,
      endpoint.isDefault === true ? 1 : 0,
      endpoint.enabled === false ? 0 : 1,
      now,
      now,
      clearApiKey ? 1 : 0,
      rawApiKey,
      rawApiKey
    );

    if (endpoint.isDefault === true) {
      this.setDefaultEndpoint(endpoint.id);
    } else {
      this.ensureDefaultEndpoint();
    }
  }

  public listEndpointConfigs(): EndpointConfigRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, name, base_url, declared_model, fingerprint_baseline_mode, fingerprint_baseline_id, provider_tag, api_key, api_key_env, passthrough_auth, is_default, enabled
        FROM endpoints
        ORDER BY is_default DESC, name ASC
      `
      )
      .all() as Array<{
      id: string;
      name: string;
      base_url: string;
      declared_model: string;
      fingerprint_baseline_mode: string;
      fingerprint_baseline_id: string;
      provider_tag: string;
      api_key: string;
      api_key_env: string;
      passthrough_auth: number;
      is_default: number;
      enabled: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      declaredModel: row.declared_model,
      fingerprintBaselineMode: row.fingerprint_baseline_mode === "manual_baseline" ? "manual_baseline" : "declared_model",
      fingerprintBaselineId: row.fingerprint_baseline_id ?? "",
      providerTag: row.provider_tag,
      apiKey: row.api_key || undefined,
      apiKeyEnv: row.api_key_env || undefined,
      passthroughAuth: row.passthrough_auth === 1,
      isDefault: row.is_default === 1,
      enabled: row.enabled === 1
    }));
  }

  public listEndpointAdmins(): EndpointAdminRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM endpoints ORDER BY is_default DESC, name ASC`)
      .all() as unknown as EndpointRow[];
    const baselineNameMap = this.getFingerprintBaselineNameMap();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      declaredModel: row.declared_model || "",
      fingerprintBaselineMode: row.fingerprint_baseline_mode === "manual_baseline" ? "manual_baseline" : "declared_model",
      fingerprintBaselineId: row.fingerprint_baseline_id ?? "",
      fingerprintBaselineName: baselineNameMap.get(row.fingerprint_baseline_id ?? "") ?? null,
      providerTag: row.provider_tag || "",
      passthroughAuth: row.passthrough_auth === 1,
      isDefault: row.is_default === 1,
      enabled: row.enabled === 1,
      apiKeyEnv: row.api_key_env || "",
      hasApiKey: row.api_key.trim().length > 0,
      apiKeyMasked: maskApiKey(row.api_key),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at
    }));
  }

  private getFingerprintBaselineNameMap(): Map<string, string> {
    const rows = this.db
      .prepare(`SELECT id, name FROM fingerprint_baselines ORDER BY created_at DESC`)
      .all() as Array<{ id: string; name: string }>;
    const out = new Map<string, string>();
    for (const row of rows) {
      out.set(row.id, row.name);
    }
    return out;
  }

  public getEndpointConfig(endpointId: string): EndpointConfigRecord | null {
    const row = this.db.prepare(`SELECT * FROM endpoints WHERE id = ? LIMIT 1`).get(endpointId) as unknown as EndpointRow | undefined;
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      declaredModel: row.declared_model,
      fingerprintBaselineMode: row.fingerprint_baseline_mode === "manual_baseline" ? "manual_baseline" : "declared_model",
      fingerprintBaselineId: row.fingerprint_baseline_id ?? "",
      providerTag: row.provider_tag,
      apiKey: row.api_key || undefined,
      apiKeyEnv: row.api_key_env || undefined,
      passthroughAuth: row.passthrough_auth === 1,
      isDefault: row.is_default === 1,
      enabled: row.enabled === 1
    };
  }

  public getDefaultEndpointId(): string | null {
    const row = this.db
      .prepare(`SELECT id FROM endpoints WHERE is_default = 1 ORDER BY last_seen_at DESC LIMIT 1`)
      .get() as { id: string } | undefined;

    if (row) {
      return row.id;
    }

    const fallback = this.db
      .prepare(`SELECT id FROM endpoints WHERE enabled = 1 ORDER BY name ASC LIMIT 1`)
      .get() as { id: string } | undefined;

    return fallback?.id ?? null;
  }

  public setDefaultEndpoint(endpointId: string): void {
    this.db.prepare(`UPDATE endpoints SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END`).run(endpointId);
  }

  public deleteEndpoint(endpointId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM request_logs WHERE endpoint_id = ?`).run(endpointId);
      this.db.prepare(`DELETE FROM risk_events WHERE endpoint_id = ?`).run(endpointId);
      this.db.prepare(`DELETE FROM drift_events WHERE endpoint_id = ?`).run(endpointId);
      this.db.prepare(`DELETE FROM sentinel_runs WHERE endpoint_id = ?`).run(endpointId);
      this.db.prepare(`DELETE FROM fingerprint_audits WHERE endpoint_id = ?`).run(endpointId);
      this.db.prepare(`DELETE FROM endpoints WHERE id = ?`).run(endpointId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.ensureDefaultEndpoint();
  }

  public insertRequestLog(log: RequestLogInsert): void {
    const statement = this.db.prepare(`
      INSERT INTO request_logs (
        id, endpoint_id, route, model, status_code, success, error_type, latency_ms, ttft_ms, output_length,
        tokens_per_sec, request_tokens, response_tokens, finish_reason, stream, json_valid, tool_call_count,
        refusal_detected, usage_shape, stream_event_count, stream_payload_chars, error_fingerprint,
        refusal_template_hash, tool_names_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    statement.run(
      log.id,
      log.endpointId,
      log.route,
      log.model,
      log.statusCode,
      log.success ? 1 : 0,
      log.errorType,
      round(log.latencyMs),
      log.ttftMs === null ? null : round(log.ttftMs),
      log.outputLength,
      log.tokensPerSec === null ? null : round(log.tokensPerSec),
      log.requestTokens,
      log.responseTokens,
      log.finishReason,
      log.stream ? 1 : 0,
      log.jsonValid === null ? null : log.jsonValid ? 1 : 0,
      log.toolCallCount,
      log.refusalDetected ? 1 : 0,
      log.usageShape,
      log.streamEventCount,
      log.streamPayloadChars,
      log.errorFingerprint,
      log.refusalTemplateHash,
      log.toolNamesFingerprint,
      log.createdAt
    );
  }

  public insertRiskEvent(event: RiskEventInsert): void {
    this.db
      .prepare(`
        INSERT INTO risk_events (id, endpoint_id, request_id, type, severity, summary, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.endpointId,
        event.requestId,
        event.type,
        event.severity,
        event.summary,
        JSON.stringify(event.details),
        event.createdAt
      );
  }

  public insertDriftEvent(event: DriftEventInsert): void {
    this.db
      .prepare(`
        INSERT INTO drift_events (id, endpoint_id, score, status, reason, evidence_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(event.id, event.endpointId, round(event.score, 4), event.status, event.reason, JSON.stringify(event.evidence), event.createdAt);
  }

  public insertSentinelRun(run: SentinelRunInsert): void {
    this.db
      .prepare(`
        INSERT INTO sentinel_runs (
          id, endpoint_id, prompt_id, similarity, divergence, latency_ms,
          output_length, json_success, refusal, output_signature, probe_features_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.id,
        run.endpointId,
        run.promptId,
        run.similarity,
        run.divergence,
        run.latencyMs === null ? null : round(run.latencyMs),
        run.outputLength,
        run.jsonSuccess === null ? null : run.jsonSuccess ? 1 : 0,
        run.refusal ? 1 : 0,
        run.outputSignature,
        run.probeFeaturesJson,
        run.createdAt
      );
  }

  public getLatestSentinelSignature(endpointId: string, promptId: string): { signature: string; createdAt: string } | null {
    const row = this.db
      .prepare(
        `SELECT output_signature, created_at FROM sentinel_runs WHERE endpoint_id = ? AND prompt_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(endpointId, promptId) as unknown as SentinelRow | undefined;

    if (!row) {
      return null;
    }

    return {
      signature: row.output_signature,
      createdAt: row.created_at
    };
  }

  public getOverview(): EndpointOverview[] {
    const endpoints = this.db.prepare(`SELECT * FROM endpoints WHERE enabled = 1 ORDER BY name ASC`).all() as unknown as EndpointRow[];
    const lowerBound = daysAgo(1);

    return endpoints.map((endpoint) => {
      const logs = this.getRequestLogs(endpoint.id, lowerBound);
      const latencies = logs.map((log) => log.latency_ms);
      const requestCount = logs.length;
      const errorRate = requestCount === 0 ? 0 : logs.filter((log) => log.success === 0).length / requestCount;
      const p50 = percentile(latencies, 0.5);
      const p95 = percentile(latencies, 0.95);
      const driftScore = this.computeDriftScore(endpoint.id);
      const status = this.resolveStatus(endpoint.id, driftScore);
      const stabilityScore = clamp(100 - driftScore * 100 - errorRate * 60, 0, 100);
      const shieldInterceptions24h = this.countRiskEvents(endpoint.id, lowerBound, ["medium", "high"]);
      const lastAnomalyAt = this.getLastAnomalyTimestamp(endpoint.id);

      return {
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        declaredModel: endpoint.declared_model || "unknown",
        providerTag: endpoint.provider_tag || "unknown",
        status,
        requestCount24h: requestCount,
        p50LatencyMs: round(p50),
        p95LatencyMs: round(p95),
        driftScore: round(driftScore, 4),
        stabilityScore: round(stabilityScore, 2),
        shieldInterceptions24h,
        lastAnomalyAt
      };
    });
  }

  public getEndpointDetail(endpointId: string): EndpointDetail | null {
    const endpoint = this.db.prepare(`SELECT * FROM endpoints WHERE id = ? LIMIT 1`).get(endpointId) as unknown as EndpointRow | undefined;
    if (!endpoint) {
      return null;
    }
    const baselineNameMap = this.getFingerprintBaselineNameMap();

    const lowerBound24h = daysAgo(1);
    const logs24h = this.getRequestLogs(endpointId, lowerBound24h);
    const requestCount24h = logs24h.length;
    const errors24h = logs24h.filter((log) => log.success === 0).length;
    const timeouts24h = logs24h.filter((log) => log.status_code === 408 || log.status_code === 504).length;
    const latencies = logs24h.map((log) => log.latency_ms);
    const ttftValues = logs24h.map((log) => log.ttft_ms).filter((value): value is number => value !== null);
    const tokensPerSecValues = logs24h.map((log) => log.tokens_per_sec).filter((value): value is number => value !== null);
    const jsonRows = logs24h.filter((log) => log.json_valid !== null);

    const driftScore = this.computeDriftScore(endpointId);
    const status = this.resolveStatus(endpointId, driftScore);

    const latencySeries = this.aggregateHourlySeries(logs24h, (row) => row.latency_ms);
    const errorSeries = this.aggregateHourlyErrorSeries(logs24h);
    const driftSeries = this.getDriftSeries(endpointId);
    const recentAnomalies = this.getRecentAnomalies(endpointId, 30);

    return {
      endpointId,
      endpointName: endpoint.name,
      baseUrl: endpoint.base_url,
      declaredModel: endpoint.declared_model || "unknown",
      fingerprintBaselineMode: endpoint.fingerprint_baseline_mode === "manual_baseline" ? "manual_baseline" : "declared_model",
      fingerprintBaselineId: endpoint.fingerprint_baseline_id ?? "",
      fingerprintBaselineName: baselineNameMap.get(endpoint.fingerprint_baseline_id ?? "") ?? null,
      providerTag: endpoint.provider_tag || "unknown",
      firstSeenAt: endpoint.first_seen_at,
      lastSeenAt: endpoint.last_seen_at,
      requestCount24h,
      errorRate24h: requestCount24h === 0 ? 0 : round(errors24h / requestCount24h, 4),
      timeoutRate24h: requestCount24h === 0 ? 0 : round(timeouts24h / requestCount24h, 4),
      p50LatencyMs: round(percentile(latencies, 0.5)),
      p95LatencyMs: round(percentile(latencies, 0.95)),
      avgTtftMs: round(avg(ttftValues)),
      avgTokensPerSec: round(avg(tokensPerSecValues)),
      jsonValidRate: jsonRows.length === 0 ? 0 : round(jsonRows.filter((row) => row.json_valid === 1).length / jsonRows.length, 4),
      refusalRate: requestCount24h === 0 ? 0 : round(logs24h.filter((log) => log.refusal_detected === 1).length / requestCount24h, 4),
      toolCallRate: requestCount24h === 0 ? 0 : round(logs24h.filter((log) => log.tool_call_count > 0).length / requestCount24h, 4),
      driftScore: round(driftScore, 4),
      status,
      latencySeries,
      errorSeries,
      driftSeries,
      recentAnomalies
    };
  }

  public getShieldCenter(): ShieldCenterResponse {
    const lowerBound = daysAgo(1);
    const rows = this.db
      .prepare(`SELECT * FROM risk_events WHERE created_at >= ? ORDER BY created_at DESC LIMIT 200`)
      .all(lowerBound) as unknown as RiskRow[];

    const recentEvents = rows.slice(0, 60).map(parseRiskRow);
    const redactedEntities24h = rows
      .filter((row) => row.type === "request_pii_redacted")
      .reduce((sum, row) => {
        const details = safeJsonParse<Record<string, unknown>>(row.details_json);
        return sum + (typeof details?.piiCount === "number" ? details.piiCount : 1);
      }, 0);
    const redactedSecrets24h = rows
      .filter((row) => row.type === "request_secret_redacted")
      .reduce((sum, row) => {
        const details = safeJsonParse<Record<string, unknown>>(row.details_json);
        return sum + (typeof details?.secretCount === "number" ? details.secretCount : 1);
      }, 0);
    const promptProtectionHits24h = rows.filter((row) => row.type === "prompt_asset_protected").length;
    const canaryInjected24h = rows.filter((row) => row.type === "canary_injected").length;
    const blockedResponses24h = rows.filter((row) => row.type === "response_high_risk_blocked").length;

    const fieldCount = new Map<string, number>();
    for (const row of rows) {
      const details = safeJsonParse<Record<string, unknown>>(row.details_json);
      const fields = details?.fieldCounts;
      if (fields && typeof fields === "object") {
        for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
          if (typeof value === "number") {
            const shouldCount =
              (row.type === "request_pii_redacted" && isPiiRedactionKey(key)) ||
              (row.type === "request_secret_redacted" && isSecretRedactionKey(key));
            if (shouldCount) {
              fieldCount.set(key, (fieldCount.get(key) ?? 0) + value);
            }
          }
        }
      }
    }

    const topSensitiveTypes = [...fieldCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([type, count]) => ({ type, count }));

    return {
      summary: {
        redactedEntities24h,
        redactedSecrets24h,
        promptProtectionHits24h,
        canaryInjected24h,
        blockedResponses24h,
        topSensitiveTypes
      },
      recentEvents
    };
  }

  public listRiskEvents(limit = 200, endpointId?: string): RiskEvent[] {
    const rows = endpointId
      ? ((this.db
          .prepare(`SELECT * FROM risk_events WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT ?`)
          .all(endpointId, limit) as unknown as RiskRow[])
      )
      : ((this.db.prepare(`SELECT * FROM risk_events ORDER BY created_at DESC LIMIT ?`).all(limit) as unknown as RiskRow[]));

    return rows.map(parseRiskRow);
  }

  private getRequestLogs(endpointId: string, fromIso: string): RequestLogRow[] {
    return this.db
      .prepare(`
        SELECT created_at, latency_ms, ttft_ms, success, status_code, output_length, tokens_per_sec, json_valid,
               tool_call_count, refusal_detected, stream, finish_reason, usage_shape, stream_event_count,
               stream_payload_chars, error_fingerprint, refusal_template_hash
        FROM request_logs
        WHERE endpoint_id = ? AND created_at >= ?
        ORDER BY created_at ASC
      `)
      .all(endpointId, fromIso) as unknown as RequestLogRow[];
  }

  private getRequestLogsRange(endpointId: string, fromIso: string, toIso: string): RequestLogRow[] {
    return this.db
      .prepare(`
        SELECT created_at, latency_ms, ttft_ms, success, status_code, output_length, tokens_per_sec, json_valid,
               tool_call_count, refusal_detected, stream, finish_reason, usage_shape, stream_event_count,
               stream_payload_chars, error_fingerprint, refusal_template_hash
        FROM request_logs
        WHERE endpoint_id = ? AND created_at >= ? AND created_at < ?
        ORDER BY created_at ASC
      `)
      .all(endpointId, fromIso, toIso) as unknown as RequestLogRow[];
  }

  public getFingerprintPortrait(endpointId: string, windowHours: number): PassiveFingerprintPortrait | null {
    const endpoint = this.db.prepare(`SELECT id FROM endpoints WHERE id = ? LIMIT 1`).get(endpointId) as { id: string } | undefined;
    if (!endpoint) {
      return null;
    }

    const windowMs = windowHours * 60 * 60 * 1000;
    const recentStart = new Date(Date.now() - windowMs).toISOString();
    const previousStart = new Date(Date.now() - 2 * windowMs).toISOString();
    const previousEnd = recentStart;

    const recent = this.buildFingerprintWindowStats(this.getRequestLogsRange(endpointId, recentStart, new Date().toISOString()));
    const previous = this.buildFingerprintWindowStats(this.getRequestLogsRange(endpointId, previousStart, previousEnd));
    const shiftHints = this.buildFingerprintShiftHints(recent, previous);

    return { recent, previous, shiftHints };
  }

  public insertFingerprintAudit(record: {
    id: string;
    endpointId: string;
    trigger: string;
    conclusion: FingerprintAuditRecord["conclusion"];
    confidence: number;
    evidence: Record<string, unknown>;
    createdAt: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO fingerprint_audits (
          id, endpoint_id, trigger, conclusion, confidence, evidence_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.endpointId,
        record.trigger,
        record.conclusion,
        round(record.confidence, 4),
        JSON.stringify(record.evidence),
        record.createdAt
      );
  }

  public listFingerprintAudits(endpointId: string, limit = 20): FingerprintAuditRecord[] {
    const bounded = Math.min(Math.max(limit, 1), 100);
    const rows = this.db
      .prepare(
        `SELECT id, endpoint_id, trigger, conclusion, confidence, evidence_json, created_at FROM fingerprint_audits WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(endpointId, bounded) as Array<{
      id: string;
      endpoint_id: string;
      trigger: string;
      conclusion: FingerprintAuditRecord["conclusion"];
      confidence: number;
      evidence_json: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      endpointId: row.endpoint_id,
      trigger: row.trigger,
      conclusion: row.conclusion,
      confidence: row.confidence,
      evidence: safeJsonParse<Record<string, unknown>>(row.evidence_json) ?? {},
      createdAt: row.created_at
    }));
  }

  private mapFingerprintBaselineRow(row: FingerprintBaselineRow): FingerprintBaselineRecord {
    return {
      id: row.id,
      name: row.name,
      label: row.label,
      model: row.model_name,
      providerTag: row.provider_tag,
      modelFamily: row.model_family,
      notes: row.notes,
      source: row.source,
      topK: row.top_k,
      samplesPerPrompt: row.samples_per_prompt,
      permutationIters: row.permutation_iters,
      isPreferred: row.is_preferred === 1,
      profile: safeJsonParse<Record<string, unknown>>(row.profile_json) ?? {},
      report: safeJsonParse<Record<string, unknown>>(row.report_json) ?? {},
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapFingerprintModelRow(row: FingerprintModelRow): FingerprintModelRecord {
    return {
      id: row.id,
      label: row.label,
      model: row.model_name,
      providerTag: row.provider_tag,
      modelFamily: row.model_family,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public listFingerprintModels(): FingerprintModelRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM fingerprint_models ORDER BY updated_at DESC, created_at DESC`)
      .all() as unknown as FingerprintModelRow[];
    return rows.map((row) => this.mapFingerprintModelRow(row));
  }

  public getFingerprintModel(id: string): FingerprintModelRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM fingerprint_models WHERE id = ? LIMIT 1`)
      .get(id) as unknown as FingerprintModelRow | undefined;
    return row ? this.mapFingerprintModelRow(row) : null;
  }

  public upsertFingerprintModel(input: {
    id: string;
    label: string;
    model: string;
    providerTag?: string;
    modelFamily?: string;
    notes?: string;
  }): FingerprintModelRecord {
    const now = nowIso();
    this.db
      .prepare(
        `
        INSERT INTO fingerprint_models (
          id, label, model_name, provider_tag, model_family, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          model_name = excluded.model_name,
          provider_tag = excluded.provider_tag,
          model_family = excluded.model_family,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `
      )
      .run(
        input.id.trim(),
        input.label.trim(),
        input.model.trim(),
        input.providerTag?.trim() ?? "",
        input.modelFamily?.trim() ?? "",
        input.notes?.trim() ?? "",
        now,
        now
      );

    const saved = this.getFingerprintModel(input.id.trim());
    if (!saved) {
      throw new Error("Failed to save fingerprint model");
    }
    return saved;
  }

  public deleteFingerprintModel(id: string): boolean {
    const target = this.getFingerprintModel(id);
    if (!target) {
      return false;
    }
    this.db.prepare(`DELETE FROM fingerprint_models WHERE id = ?`).run(id);
    return true;
  }

  public listFingerprintBaselines(): FingerprintBaselineRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM fingerprint_baselines ORDER BY is_preferred DESC, created_at DESC`)
      .all() as unknown as FingerprintBaselineRow[];
    return rows.map((row) => this.mapFingerprintBaselineRow(row));
  }

  public getFingerprintBaseline(id: string): FingerprintBaselineRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM fingerprint_baselines WHERE id = ? LIMIT 1`)
      .get(id) as unknown as FingerprintBaselineRow | undefined;
    return row ? this.mapFingerprintBaselineRow(row) : null;
  }

  public createFingerprintBaseline(input: {
    name: string;
    label: string;
    model: string;
    providerTag?: string;
    modelFamily?: string;
    notes?: string;
    source?: string;
    topK: number;
    samplesPerPrompt: number;
    permutationIters: number;
    profile: Record<string, unknown>;
    report?: Record<string, unknown>;
  }): FingerprintBaselineRecord {
    const now = nowIso();
    const id = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO fingerprint_baselines (
          id, name, label, model_name, provider_tag, model_family, notes, source,
          top_k, samples_per_prompt, permutation_iters, is_preferred,
          profile_json, report_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.name.trim(),
        input.label.trim(),
        input.model.trim(),
        input.providerTag?.trim() ?? "",
        input.modelFamily?.trim() ?? "",
        input.notes?.trim() ?? "",
        input.source?.trim() || "lab_run",
        input.topK,
        input.samplesPerPrompt,
        input.permutationIters,
        JSON.stringify(input.profile),
        JSON.stringify(input.report ?? {}),
        now,
        now
      );

    const created = this.getFingerprintBaseline(id);
    if (!created) {
      throw new Error("Failed to create fingerprint baseline");
    }
    return created;
  }

  public setPreferredFingerprintBaseline(id: string): FingerprintBaselineRecord | null {
    const target = this.getFingerprintBaseline(id);
    if (!target) {
      return null;
    }

    this.db.prepare(`UPDATE fingerprint_baselines SET is_preferred = 0`).run();
    this.db.prepare(`UPDATE fingerprint_baselines SET is_preferred = 1, updated_at = ? WHERE id = ?`).run(nowIso(), id);
    return this.getFingerprintBaseline(id);
  }

  public deleteFingerprintBaseline(id: string): boolean {
    const target = this.getFingerprintBaseline(id);
    if (!target) {
      return false;
    }

    this.db.prepare(`DELETE FROM fingerprint_baselines WHERE id = ?`).run(id);
    this.db
      .prepare(
        `UPDATE endpoints SET fingerprint_baseline_mode = 'declared_model', fingerprint_baseline_id = '' WHERE fingerprint_baseline_id = ?`
      )
      .run(id);
    return true;
  }

  public resolveFingerprintBaselineForEndpoint(endpoint: EndpointConfigRecord): FingerprintBaselineRecord | null {
    if (endpoint.fingerprintBaselineMode === "manual_baseline" && endpoint.fingerprintBaselineId) {
      const manual = this.getFingerprintBaseline(endpoint.fingerprintBaselineId);
      if (manual) {
        return manual;
      }
    }

    const declared = endpoint.declaredModel?.trim() ?? "";
    if (declared.length === 0) {
      return null;
    }

    const all = this.listFingerprintBaselines();
    if (all.length === 0) {
      return null;
    }

    const needle = declared.toLowerCase();
    const preferred = all.filter((row) => row.isPreferred);
    const exactPreferred =
      preferred.find((row) => row.model.toLowerCase() === needle) ??
      preferred.find((row) => row.modelFamily.toLowerCase() === needle);
    if (exactPreferred) {
      return exactPreferred;
    }

    const fuzzyPreferred = preferred.find((row) => {
      const model = row.model.toLowerCase();
      const family = row.modelFamily.toLowerCase();
      return (
        (model.length > 0 && (needle.includes(model) || model.includes(needle))) ||
        (family.length > 0 && (needle.includes(family) || family.includes(needle)))
      );
    });
    if (fuzzyPreferred) {
      return fuzzyPreferred;
    }

    const exactAny =
      all.find((row) => row.model.toLowerCase() === needle) ?? all.find((row) => row.modelFamily.toLowerCase() === needle);
    if (exactAny) {
      return exactAny;
    }

    const fuzzyAny = all.find((row) => {
      const model = row.model.toLowerCase();
      const family = row.modelFamily.toLowerCase();
      return (
        (model.length > 0 && (needle.includes(model) || model.includes(needle))) ||
        (family.length > 0 && (needle.includes(family) || family.includes(needle)))
      );
    });
    return fuzzyAny ?? null;
  }

  public listSentinelRunsForPrompt(endpointId: string, promptId: string, limit: number): Array<{
    outputLength: number;
    latencyMs: number | null;
    jsonSuccess: boolean | null;
    refusal: boolean;
    divergence: number | null;
    createdAt: string;
  }> {
    const bounded = Math.min(Math.max(limit, 1), 200);
    const rows = this.db
      .prepare(
        `
        SELECT output_length, latency_ms, json_success, refusal, divergence, created_at
        FROM sentinel_runs
        WHERE endpoint_id = ? AND prompt_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(endpointId, promptId, bounded) as Array<{
      output_length: number;
      latency_ms: number | null;
      json_success: number | null;
      refusal: number;
      divergence: number | null;
      created_at: string;
    }>;

    return rows.map((row) => ({
      outputLength: row.output_length,
      latencyMs: row.latency_ms,
      jsonSuccess: row.json_success === null ? null : row.json_success === 1,
      refusal: row.refusal === 1,
      divergence: row.divergence,
      createdAt: row.created_at
    }));
  }

  public getSentinelHealth(
    endpointId: string,
    policy: PolicyConfig,
    promptCatalog: SentinelHealthPromptMeta[]
  ): SentinelHealthResponse | null {
    const endpoint = this.db.prepare(`SELECT id FROM endpoints WHERE id = ? LIMIT 1`).get(endpointId) as { id: string } | undefined;
    if (!endpoint) {
      return null;
    }

    const rows = this.db
      .prepare(`
        SELECT prompt_id, divergence, latency_ms, json_success, output_length, probe_features_json, created_at
        FROM sentinel_runs
        WHERE endpoint_id = ? AND created_at >= ?
        ORDER BY created_at DESC
      `)
      .all(endpointId, daysAgo(1)) as unknown as SentinelHealthRunRow[];

    const promptMeta = new Map(promptCatalog.map((prompt) => [prompt.id, prompt]));
    const rowsByPrompt = new Map<string, SentinelHealthRunRow[]>();
    for (const row of rows) {
      const list = rowsByPrompt.get(row.prompt_id) ?? [];
      list.push(row);
      rowsByPrompt.set(row.prompt_id, list);
    }

    const successRows = rows.filter((row) => this.getSentinelRunStatus(row) === "ok");
    const successRate = rows.length === 0 ? null : successRows.length / rows.length;
    const lastRunAt = rows[0]?.created_at ?? null;
    const lastSuccessAt = successRows[0]?.created_at ?? null;
    const runCount24h = rows.length;
    const estimatedProbeCallsPerDay = Math.ceil(1440 / Math.max(policy.sentinelIntervalMinutes, 1)) * policy.sentinelPromptsPerCycle;

    const contractRows = rows.filter((row) => this.getSentinelExpectation(row)?.configured === true);
    const contractFailures = contractRows.filter((row) => this.getSentinelExpectation(row)?.passed === false);
    const divergences = rows
      .map((row) => row.divergence)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const latencies = rows
      .map((row) => row.latency_ms)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    const availabilityScore = successRate === null ? 0 : clamp(1 - successRate, 0, 1);
    const contractScore = contractRows.length === 0 ? 0 : clamp(contractFailures.length / contractRows.length, 0, 1);
    const behaviorScore = divergences.length === 0 ? 0 : clamp(percentile(divergences, 0.95), 0, 1);
    const latencyP95 = percentile(latencies, 0.95);
    const performanceScore =
      latencies.length === 0
        ? 0
        : latencyP95 >= 30_000
          ? 0.8
          : latencyP95 >= 15_000
            ? 0.45
            : latencyP95 >= 8_000
              ? 0.25
              : 0;

    const dimensions = [
      {
        key: "availability" as const,
        label: "Availability",
        status: rows.length === 0 ? "No Data" as const : this.scoreToStatus(availabilityScore),
        score: round(availabilityScore, 4),
        summary:
          rows.length === 0
            ? "No Sentinel checks have completed in the last 24 hours."
            : `${round((successRate ?? 0) * 100, 1)}% of Sentinel checks reached the upstream successfully.`
      },
      {
        key: "performance" as const,
        label: "Performance",
        status: latencies.length === 0 ? "No Data" as const : this.scoreToStatus(performanceScore),
        score: round(performanceScore, 4),
        summary: latencies.length === 0 ? "No latency samples yet." : `Probe latency P95 is ${round(latencyP95)} ms.`
      },
      {
        key: "contract" as const,
        label: "Contract",
        status: contractRows.length === 0 ? "No Data" as const : this.scoreToStatus(contractScore),
        score: round(contractScore, 4),
        summary:
          contractRows.length === 0
            ? "No format or schema expectations were checked."
            : `${contractFailures.length}/${contractRows.length} contract checks failed in the last 24 hours.`
      },
      {
        key: "behavior" as const,
        label: "Behavior",
        status: divergences.length === 0 ? "No Data" as const : this.scoreToStatus(behaviorScore),
        score: round(behaviorScore, 4),
        summary:
          divergences.length === 0
            ? "No comparable probe output yet."
            : `P95 behavior divergence is ${round(behaviorScore, 3)} across comparable probe runs.`
      }
    ];

    const overallScore = Math.max(availabilityScore, performanceScore, contractScore, behaviorScore);
    const overallStatus = rows.length === 0 ? "No Data" : this.scoreToStatus(overallScore);
    const worstDimension = dimensions
      .filter((item) => item.status !== "No Data")
      .sort((a, b) => b.score - a.score)[0];

    const promptIds = new Set([...promptCatalog.map((prompt) => prompt.id), ...rowsByPrompt.keys()]);
    const prompts: SentinelPromptHealth[] = [...promptIds]
      .map((promptId) => {
        const promptRows = rowsByPrompt.get(promptId) ?? [];
        const meta = promptMeta.get(promptId);
        return this.buildSentinelPromptHealth(promptId, meta, promptRows);
      })
      .sort((a, b) => {
        if (a.consecutiveIssues !== b.consecutiveIssues) {
          return b.consecutiveIssues - a.consecutiveIssues;
        }
        return (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "");
      });

    return {
      endpointId,
      enabled: policy.sentinelEnabled,
      intervalMinutes: policy.sentinelIntervalMinutes,
      promptsPerCycle: policy.sentinelPromptsPerCycle,
      lastRunAt,
      lastSuccessAt,
      runCount24h,
      successRate24h: successRate === null ? null : round(successRate, 4),
      estimatedProbeCallsPerDay,
      overallStatus,
      headline: this.buildSentinelHeadline(overallStatus, worstDimension?.label ?? null, runCount24h),
      recommendedAction: this.buildSentinelRecommendation(overallStatus, worstDimension?.key ?? null, policy.sentinelEnabled),
      dimensions,
      prompts
    };
  }

  private scoreToStatus(score: number): EndpointHealthStatus {
    if (score >= 0.75) {
      return "High Risk";
    }
    if (score >= 0.5) {
      return "Drifted";
    }
    if (score >= 0.25) {
      return "Watch";
    }
    return "Stable";
  }

  private buildSentinelHeadline(status: EndpointHealthStatus | "No Data", worstDimension: string | null, runCount24h: number): string {
    if (status === "No Data" || runCount24h === 0) {
      return "Sentinel has not collected enough recent checks to judge this endpoint.";
    }
    if (status === "Stable") {
      return "Recent Sentinel checks look stable for this endpoint.";
    }
    if (worstDimension) {
      return `${worstDimension} is the main area to review before trusting this endpoint.`;
    }
    return "Sentinel found endpoint changes that need review.";
  }

  private buildSentinelRecommendation(
    status: EndpointHealthStatus | "No Data",
    worstDimension: SentinelHealthResponse["dimensions"][number]["key"] | null,
    enabled: boolean
  ): string {
    if (!enabled) {
      return "Turn Sentinel on to resume scheduled endpoint checks.";
    }
    if (status === "No Data") {
      return "Run a check now, then wait for a few cycles before treating the status as reliable.";
    }
    if (status === "Stable") {
      return "No action needed. Keep the endpoint in service and continue scheduled checks.";
    }
    if (worstDimension === "availability") {
      return "Check the upstream key, rate limits, and relay availability. Consider switching the default endpoint if failures continue.";
    }
    if (worstDimension === "contract") {
      return "Review JSON, label, and tool-call contracts before using this endpoint for structured production traffic.";
    }
    if (worstDimension === "performance") {
      return "Compare latency with a backup endpoint and lower traffic or switch routes if the slowdown affects users.";
    }
    if (worstDimension === "behavior") {
      return "Run Fingerprint Audit or rebuild the accepted baseline if this was an expected model update.";
    }
    return "Review the prompt-level evidence and rerun Sentinel to confirm the issue.";
  }

  private buildSentinelPromptHealth(
    promptId: string,
    meta: SentinelHealthPromptMeta | undefined,
    rows: SentinelHealthRunRow[]
  ): SentinelPromptHealth {
    const last = rows[0];
    const successRows = rows.filter((row) => this.getSentinelRunStatus(row) === "ok");
    const divergences = rows
      .map((row) => row.divergence)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    let consecutiveIssues = 0;
    for (const row of rows) {
      if (!this.isSentinelIssue(row)) {
        break;
      }
      consecutiveIssues += 1;
    }

    const lastIssue = last && this.isSentinelIssue(last) ? this.describeSentinelIssue(last) : null;
    return {
      promptId,
      title: meta?.title ?? promptId,
      capability: meta?.capability ?? "unknown",
      lastRunAt: last?.created_at ?? null,
      lastStatus: last ? this.getSentinelRunStatus(last) : "unknown",
      lastDivergence: last?.divergence ?? null,
      lastExpectationPassed: last ? (this.getSentinelExpectation(last)?.passed ?? null) : null,
      successRate24h: rows.length === 0 ? null : round(successRows.length / rows.length, 4),
      avgDivergence24h: divergences.length === 0 ? null : round(avg(divergences), 4),
      consecutiveIssues,
      lastIssue,
      recommendation: this.buildPromptRecommendation(last, consecutiveIssues)
    };
  }

  private buildPromptRecommendation(row: SentinelHealthRunRow | undefined, consecutiveIssues: number): string {
    if (!row) {
      return "Waiting for this probe to run.";
    }
    const status = this.getSentinelRunStatus(row);
    if (status !== "ok") {
      return "Check upstream connectivity, credentials, or rate limits before reading this as model drift.";
    }
    const expectation = this.getSentinelExpectation(row);
    if (expectation?.passed === false) {
      return consecutiveIssues >= 2 ? "Treat this as a contract risk for structured workloads." : "Rerun to confirm whether the contract failure repeats.";
    }
    if ((row.divergence ?? 0) >= 0.42) {
      return consecutiveIssues >= 2 ? "Run Fingerprint Audit or compare with a backup endpoint." : "Watch for another cycle before switching traffic.";
    }
    return "No action needed for this probe.";
  }

  private getSentinelRunStatus(row: SentinelHealthRunRow): SentinelRunStatus {
    const features = safeJsonParse<Record<string, unknown>>(row.probe_features_json) ?? {};
    const run = features.run;
    if (run && typeof run === "object" && !Array.isArray(run)) {
      const status = (run as Record<string, unknown>).status;
      if (status === "ok" || status === "failed" || status === "http_error" || status === "skipped") {
        return status;
      }
    }
    return "ok";
  }

  private getSentinelExpectation(row: SentinelHealthRunRow): { configured?: boolean; passed?: boolean | null; reason?: string } | null {
    const features = safeJsonParse<Record<string, unknown>>(row.probe_features_json) ?? {};
    const expectation = features.expectation;
    if (!expectation || typeof expectation !== "object" || Array.isArray(expectation)) {
      return null;
    }
    return expectation as { configured?: boolean; passed?: boolean | null; reason?: string };
  }

  private isSentinelIssue(row: SentinelHealthRunRow): boolean {
    const status = this.getSentinelRunStatus(row);
    if (status !== "ok") {
      return true;
    }
    const expectation = this.getSentinelExpectation(row);
    return expectation?.passed === false || (row.divergence ?? 0) >= 0.42;
  }

  private describeSentinelIssue(row: SentinelHealthRunRow): string {
    const status = this.getSentinelRunStatus(row);
    const features = safeJsonParse<Record<string, unknown>>(row.probe_features_json) ?? {};
    const run = features.run && typeof features.run === "object" && !Array.isArray(features.run)
      ? features.run as Record<string, unknown>
      : {};
    if (status === "failed") {
      return typeof run.errorType === "string" ? run.errorType : "Sentinel request failed";
    }
    if (status === "http_error") {
      return typeof run.httpStatus === "number" ? `Upstream returned HTTP ${run.httpStatus}` : "Upstream returned an error";
    }
    if (status === "skipped") {
      return typeof run.reason === "string" ? run.reason : "Sentinel skipped this probe";
    }
    const expectation = this.getSentinelExpectation(row);
    if (expectation?.passed === false) {
      return expectation.reason ?? "Probe contract failed";
    }
    return `Behavior divergence ${round(row.divergence ?? 0, 3)}`;
  }

  private buildFingerprintWindowStats(logs: RequestLogRow[]): FingerprintWindowStats {
    const sampleSize = logs.length;
    const lengths = logs.map((row) => row.output_length);
    const jsonRows = logs.filter((row) => row.json_valid !== null);
    const streamRows = logs.filter((row) => row.stream === 1);
    const streamWithEvents = streamRows.filter((row) => row.stream_event_count !== null && row.stream_event_count > 0);
    const errorRows = logs.filter((row) => row.success === 0 && row.error_fingerprint);

    const topFinishReasons = this.topCategoricalShares(
      logs.filter((row) => row.finish_reason && row.finish_reason.length > 0).map((row) => row.finish_reason as string),
      6
    );

    const topUsageShapes = this.topCategoricalShares(
      logs.filter((row) => row.usage_shape && row.usage_shape.length > 0).map((row) => row.usage_shape as string),
      6
    );

    const topErrorFingerprints = this.topCategoricalShares(
      errorRows.map((row) => row.error_fingerprint as string),
      6
    );

    const topRefusalTemplates = this.topCategoricalShares(
      logs.filter((row) => row.refusal_detected === 1 && row.refusal_template_hash).map((row) => row.refusal_template_hash as string),
      6
    );

    return {
      sampleSize,
      outputLengthP50: round(percentile(lengths, 0.5)),
      outputLengthP95: round(percentile(lengths, 0.95)),
      jsonValidRate:
        jsonRows.length === 0 ? null : round(jsonRows.filter((row) => row.json_valid === 1).length / jsonRows.length, 4),
      toolCallRate: sampleSize === 0 ? 0 : round(logs.filter((row) => row.tool_call_count > 0).length / sampleSize, 4),
      refusalRate: sampleSize === 0 ? 0 : round(logs.filter((row) => row.refusal_detected === 1).length / sampleSize, 4),
      streamShare: sampleSize === 0 ? 0 : round(streamRows.length / sampleSize, 4),
      avgStreamEvents:
        streamWithEvents.length === 0
          ? null
          : round(avg(streamWithEvents.map((row) => row.stream_event_count as number))),
      avgStreamPayloadChars:
        streamWithEvents.length === 0
          ? null
          : round(avg(streamWithEvents.map((row) => row.stream_payload_chars as number))),
      topFinishReasons,
      topUsageShapes,
      topErrorFingerprints,
      topRefusalTemplates
    };
  }

  private topCategoricalShares(values: string[], maxEntries: number): Array<{ key: string; share: number }> {
    if (values.length === 0) {
      return [];
    }

    const counts = new Map<string, number>();
    for (const value of values) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    const total = values.length;
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxEntries)
      .map(([key, count]) => ({ key, share: round(count / total, 4) }));
  }

  private buildFingerprintShiftHints(recent: FingerprintWindowStats, previous: FingerprintWindowStats): string[] {
    const hints: string[] = [];

    if (recent.sampleSize >= 8 && previous.sampleSize >= 8) {
      const lenShift = Math.abs(recent.outputLengthP95 - previous.outputLengthP95) / Math.max(previous.outputLengthP95, 1);
      if (lenShift >= 0.45) {
        hints.push(`Output length P95 changed by about ${round(lenShift * 100, 1)}% vs previous window`);
      }

      if (recent.jsonValidRate !== null && previous.jsonValidRate !== null && previous.jsonValidRate - recent.jsonValidRate >= 0.2) {
        hints.push("JSON valid rate dropped sharply vs previous window (on JSON-assessable samples)");
      }

      const recentTopUsage = recent.topUsageShapes[0];
      const previousTopUsage = previous.topUsageShapes[0];
      if (recentTopUsage && previousTopUsage && recentTopUsage.key !== previousTopUsage.key && recentTopUsage.share >= 0.35 && previousTopUsage.share >= 0.35) {
        hints.push("Dominant usage shape switched to a different pattern");
      }

      const recentTopFinish = recent.topFinishReasons[0];
      const previousTopFinish = previous.topFinishReasons[0];
      if (recentTopFinish && previousTopFinish && recentTopFinish.key !== previousTopFinish.key && recentTopFinish.share >= 0.3 && previousTopFinish.share >= 0.3) {
        hints.push("Primary finish_reason distribution shifted");
      }

      if (recent.streamShare >= 0.15 && previous.streamShare >= 0.15) {
        if (recent.avgStreamEvents !== null && previous.avgStreamEvents !== null) {
          const evShift = Math.abs(recent.avgStreamEvents - previous.avgStreamEvents) / Math.max(previous.avgStreamEvents, 1);
          if (evShift >= 0.35) {
            hints.push("Streaming SSE event granularity (events per request) changed significantly");
          }
        }
      }
    }

    return hints;
  }

  private aggregateHourlySeries(logs: RequestLogRow[], mapper: (log: RequestLogRow) => number): Array<{ ts: string; value: number }> {
    const bucket = new Map<string, number[]>();
    for (const log of logs) {
      const hour = floorToHour(log.created_at);
      const list = bucket.get(hour) ?? [];
      list.push(mapper(log));
      bucket.set(hour, list);
    }

    return [...bucket.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ts, values]) => ({ ts, value: round(avg(values)) }));
  }

  private aggregateHourlyErrorSeries(logs: RequestLogRow[]): Array<{ ts: string; value: number }> {
    const bucket = new Map<string, { total: number; errors: number }>();
    for (const log of logs) {
      const hour = floorToHour(log.created_at);
      const entry = bucket.get(hour) ?? { total: 0, errors: 0 };
      entry.total += 1;
      if (log.success === 0) {
        entry.errors += 1;
      }
      bucket.set(hour, entry);
    }

    return [...bucket.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ts, value]) => ({ ts, value: value.total === 0 ? 0 : round(value.errors / value.total, 4) }));
  }

  private getDriftSeries(endpointId: string): Array<{ ts: string; value: number }> {
    const driftRows = this.db
      .prepare(`SELECT created_at, score FROM drift_events WHERE endpoint_id = ? AND created_at >= ? ORDER BY created_at ASC`)
      .all(endpointId, daysAgo(7)) as Array<{ created_at: string; score: number }>;

    if (driftRows.length > 0) {
      return driftRows.map((row) => ({ ts: row.created_at, value: round(row.score, 4) }));
    }

    const sentinelRows = this.db
      .prepare(`
        SELECT created_at, divergence
        FROM sentinel_runs
        WHERE endpoint_id = ? AND created_at >= ? AND divergence IS NOT NULL
        ORDER BY created_at ASC
      `)
      .all(endpointId, daysAgo(7)) as Array<{ created_at: string; divergence: number }>;

    return sentinelRows.map((row) => ({ ts: row.created_at, value: round(row.divergence, 4) }));
  }

  private getRecentAnomalies(endpointId: string, limit: number): RiskEvent[] {
    const riskRows = this.db
      .prepare(`SELECT * FROM risk_events WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(endpointId, limit) as unknown as RiskRow[];

    const driftRows = this.db
      .prepare(`SELECT * FROM drift_events WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(endpointId, limit) as unknown as DriftRow[];

    // Sentinel prompt runs already emit risk events directly; do not mirror them from drift rows.
    const mappedDrifts: RiskEvent[] = driftRows
      .filter((row) => !row.reason.includes("sentinel"))
      .map((row) => {
      const details = safeJsonParse<Record<string, unknown>>(row.evidence_json) ?? {};
      return {
        id: `drift-${row.created_at}-${row.reason}`,
        endpointId,
        requestId: null,
        type: row.reason.includes("sentinel") ? "sentinel_divergence" : "passive_drift",
        severity: row.score >= 0.8 ? "high" : row.score >= 0.5 ? "medium" : "low",
        summary: `${row.reason} (score=${round(row.score, 3)})`,
        details,
        createdAt: row.created_at
      };
      });

    return [...riskRows.map(parseRiskRow), ...mappedDrifts]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  private countRiskEvents(endpointId: string, fromIso: string, severities: Array<"low" | "medium" | "high">): number {
    const placeholders = severities.map(() => "?").join(",");
    const query = `
      SELECT COUNT(*) AS count
      FROM risk_events
      WHERE endpoint_id = ?
        AND created_at >= ?
        AND severity IN (${placeholders})
    `;

    const row = this.db.prepare(query).get(endpointId, fromIso, ...severities) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private getLastAnomalyTimestamp(endpointId: string): string | null {
    const risk = this.db
      .prepare(`SELECT created_at FROM risk_events WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(endpointId) as { created_at: string } | undefined;

    const drift = this.db
      .prepare(`SELECT created_at FROM drift_events WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(endpointId) as { created_at: string } | undefined;

    const latest = [risk?.created_at, drift?.created_at].filter((value): value is string => Boolean(value)).sort((a, b) => b.localeCompare(a))[0];
    return latest ?? null;
  }

  private resolveStatus(endpointId: string, driftScore: number): EndpointHealthStatus {
    const latestHighRisk = this.db
      .prepare(`
        SELECT id FROM risk_events
        WHERE endpoint_id = ? AND severity = 'high' AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(endpointId, daysAgo(1)) as { id: string } | undefined;

    if (latestHighRisk || driftScore >= 0.8) {
      return "High Risk";
    }

    if (driftScore >= 0.6) {
      return "Drifted";
    }

    if (driftScore >= 0.35) {
      return "Watch";
    }

    return "Stable";
  }

  private computeUsageShapeShiftScore(curr: RequestLogRow[], prev: RequestLogRow[]): number {
    const dominantKey = (rows: RequestLogRow[]): string | null => {
      const shapes = rows.filter((row) => row.usage_shape && row.usage_shape.length > 0).map((row) => row.usage_shape as string);
      if (shapes.length < 6) {
        return null;
      }

      const top = this.topCategoricalShares(shapes, 1)[0];
      if (!top || top.share < 0.28) {
        return null;
      }

      return top.key;
    };

    const currDom = dominantKey(curr);
    const prevDom = dominantKey(prev);
    if (!currDom || !prevDom || currDom === prevDom) {
      return 0;
    }

    return 0.38;
  }

  private computeDriftScore(endpointId: string): number {
    const nowIsoBound = new Date().toISOString();
    const curr = this.getRequestLogsRange(endpointId, daysAgo(1), nowIsoBound);
    const prev = this.getRequestLogsRange(endpointId, daysAgo(2), daysAgo(1));

    const sentinel = this.db
      .prepare(`SELECT AVG(divergence) AS avg_divergence FROM sentinel_runs WHERE endpoint_id = ? AND created_at >= ?`)
      .get(endpointId, daysAgo(1)) as { avg_divergence: number | null } | undefined;

    const sentinelScore = sentinel?.avg_divergence ?? null;

    if (curr.length < 12 || prev.length < 12) {
      return clamp(sentinelScore ?? 0, 0, 1);
    }

    const currP95 = percentile(curr.map((row) => row.latency_ms), 0.95);
    const prevP95 = percentile(prev.map((row) => row.latency_ms), 0.95);
    const currErrorRate = curr.filter((row) => row.success === 0).length / curr.length;
    const prevErrorRate = prev.filter((row) => row.success === 0).length / prev.length;

    const currJsonRows = curr.filter((row) => row.json_valid !== null);
    const prevJsonRows = prev.filter((row) => row.json_valid !== null);
    const currJsonRate = currJsonRows.length === 0 ? 1 : currJsonRows.filter((row) => row.json_valid === 1).length / currJsonRows.length;
    const prevJsonRate = prevJsonRows.length === 0 ? 1 : prevJsonRows.filter((row) => row.json_valid === 1).length / prevJsonRows.length;

    const latencyShift = Math.max(0, (currP95 - prevP95) / Math.max(prevP95, 1));
    const errorShift = Math.max(0, currErrorRate - prevErrorRate);
    const jsonDrop = Math.max(0, prevJsonRate - currJsonRate);
    const usageShapeShift = this.computeUsageShapeShiftScore(curr, prev);

    const passiveScore = clamp(latencyShift * 0.34 + errorShift * 0.28 + jsonDrop * 0.2 + usageShapeShift * 0.18, 0, 1);

    if (sentinelScore === null) {
      return passiveScore;
    }

    return clamp(passiveScore * 0.6 + sentinelScore * 0.4, 0, 1);
  }

  private ensureDefaultEndpoint(): void {
    const existing = this.db
      .prepare(`SELECT id FROM endpoints WHERE is_default = 1 LIMIT 1`)
      .get() as { id: string } | undefined;

    if (existing) {
      return;
    }

    const fallback = this.db
      .prepare(`SELECT id FROM endpoints WHERE enabled = 1 ORDER BY name ASC LIMIT 1`)
      .get() as { id: string } | undefined;

    if (fallback) {
      this.db.prepare(`UPDATE endpoints SET is_default = 1 WHERE id = ?`).run(fallback.id);
      return;
    }

    const anyRow = this.db.prepare(`SELECT id FROM endpoints ORDER BY name ASC LIMIT 1`).get() as { id: string } | undefined;
    if (anyRow) {
      this.db.prepare(`UPDATE endpoints SET is_default = 1 WHERE id = ?`).run(anyRow.id);
    }
  }

  private columnExists(tableName: string, columnName: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === columnName);
  }

  private ensureEndpointColumns(): void {
    const alterStatements: string[] = [];
    if (!this.columnExists("endpoints", "api_key")) {
      alterStatements.push(`ALTER TABLE endpoints ADD COLUMN api_key TEXT NOT NULL DEFAULT ''`);
    }
    if (!this.columnExists("endpoints", "api_key_env")) {
      alterStatements.push(`ALTER TABLE endpoints ADD COLUMN api_key_env TEXT NOT NULL DEFAULT ''`);
    }
    if (!this.columnExists("endpoints", "passthrough_auth")) {
      alterStatements.push(`ALTER TABLE endpoints ADD COLUMN passthrough_auth INTEGER NOT NULL DEFAULT 1`);
    }
    if (!this.columnExists("endpoints", "is_default")) {
      alterStatements.push(`ALTER TABLE endpoints ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`);
    }
    if (!this.columnExists("endpoints", "fingerprint_baseline_mode")) {
      alterStatements.push(`ALTER TABLE endpoints ADD COLUMN fingerprint_baseline_mode TEXT NOT NULL DEFAULT 'declared_model'`);
    }
    if (!this.columnExists("endpoints", "fingerprint_baseline_id")) {
      alterStatements.push(`ALTER TABLE endpoints ADD COLUMN fingerprint_baseline_id TEXT NOT NULL DEFAULT ''`);
    }

    for (const sql of alterStatements) {
      this.db.exec(sql);
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS endpoints (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        declared_model TEXT NOT NULL DEFAULT '',
        fingerprint_baseline_mode TEXT NOT NULL DEFAULT 'declared_model',
        fingerprint_baseline_id TEXT NOT NULL DEFAULT '',
        provider_tag TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        api_key_env TEXT NOT NULL DEFAULT '',
        passthrough_auth INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        route TEXT NOT NULL,
        model TEXT,
        status_code INTEGER NOT NULL,
        success INTEGER NOT NULL,
        error_type TEXT,
        latency_ms REAL NOT NULL,
        ttft_ms REAL,
        output_length INTEGER NOT NULL DEFAULT 0,
        tokens_per_sec REAL,
        request_tokens INTEGER,
        response_tokens INTEGER,
        finish_reason TEXT,
        stream INTEGER NOT NULL,
        json_valid INTEGER,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        refusal_detected INTEGER NOT NULL DEFAULT 0,
        usage_shape TEXT,
        stream_event_count INTEGER,
        stream_payload_chars INTEGER,
        error_fingerprint TEXT,
        refusal_template_hash TEXT,
        tool_names_fingerprint TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(endpoint_id) REFERENCES endpoints(id)
      );

      CREATE TABLE IF NOT EXISTS risk_events (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        request_id TEXT,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(endpoint_id) REFERENCES endpoints(id)
      );

      CREATE TABLE IF NOT EXISTS drift_events (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        score REAL NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(endpoint_id) REFERENCES endpoints(id)
      );

      CREATE TABLE IF NOT EXISTS sentinel_runs (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        similarity REAL,
        divergence REAL,
        latency_ms REAL,
        output_length INTEGER NOT NULL,
        json_success INTEGER,
        refusal INTEGER NOT NULL,
        output_signature TEXT NOT NULL,
        probe_features_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY(endpoint_id) REFERENCES endpoints(id)
      );

      CREATE TABLE IF NOT EXISTS fingerprint_audits (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        reference_endpoint_id TEXT,
        trigger TEXT NOT NULL,
        conclusion TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(endpoint_id) REFERENCES endpoints(id)
      );

      CREATE TABLE IF NOT EXISTS fingerprint_baselines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        label TEXT NOT NULL,
        model_name TEXT NOT NULL,
        provider_tag TEXT NOT NULL DEFAULT '',
        model_family TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'lab_run',
        top_k INTEGER NOT NULL,
        samples_per_prompt INTEGER NOT NULL,
        permutation_iters INTEGER NOT NULL,
        is_preferred INTEGER NOT NULL DEFAULT 0,
        profile_json TEXT NOT NULL,
        report_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fingerprint_models (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        model_name TEXT NOT NULL,
        provider_tag TEXT NOT NULL DEFAULT '',
        model_family TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      DROP INDEX IF EXISTS idx_probe_questions_enabled_sort;
      DROP TABLE IF EXISTS probe_questions;

      CREATE INDEX IF NOT EXISTS idx_request_logs_endpoint_created_at ON request_logs(endpoint_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_risk_events_endpoint_created_at ON risk_events(endpoint_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_drift_events_endpoint_created_at ON drift_events(endpoint_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sentinel_runs_endpoint_prompt_created_at ON sentinel_runs(endpoint_id, prompt_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_fingerprint_audits_endpoint_created_at ON fingerprint_audits(endpoint_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_fingerprint_baselines_model_preferred ON fingerprint_baselines(model_name, is_preferred, created_at);
      CREATE INDEX IF NOT EXISTS idx_fingerprint_models_updated_at ON fingerprint_models(updated_at, created_at);
    `);

    this.ensureEndpointColumns();
    this.ensureRequestLogFingerprintColumns();
    this.ensureSentinelProbeFeaturesColumn();
    this.ensureDefaultEndpoint();
  }

  private ensureRequestLogFingerprintColumns(): void {
    const columns: Array<{ name: string; ddl: string }> = [
      { name: "usage_shape", ddl: "ALTER TABLE request_logs ADD COLUMN usage_shape TEXT" },
      { name: "stream_event_count", ddl: "ALTER TABLE request_logs ADD COLUMN stream_event_count INTEGER" },
      { name: "stream_payload_chars", ddl: "ALTER TABLE request_logs ADD COLUMN stream_payload_chars INTEGER" },
      { name: "error_fingerprint", ddl: "ALTER TABLE request_logs ADD COLUMN error_fingerprint TEXT" },
      { name: "refusal_template_hash", ddl: "ALTER TABLE request_logs ADD COLUMN refusal_template_hash TEXT" },
      { name: "tool_names_fingerprint", ddl: "ALTER TABLE request_logs ADD COLUMN tool_names_fingerprint TEXT" }
    ];

    for (const column of columns) {
      if (!this.columnExists("request_logs", column.name)) {
        this.db.exec(column.ddl);
      }
    }
  }

  private ensureSentinelProbeFeaturesColumn(): void {
    if (!this.columnExists("sentinel_runs", "probe_features_json")) {
      this.db.exec(`ALTER TABLE sentinel_runs ADD COLUMN probe_features_json TEXT NOT NULL DEFAULT '{}'` );
    }
  }
}

export type { DriftEventInsert, RequestLogInsert, RiskEventInsert, SentinelRunInsert };
