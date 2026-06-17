export type EndpointHealthStatus = "Stable" | "Watch" | "Drifted" | "High Risk";
export type EndpointFingerprintBaselineMode = "declared_model" | "manual_baseline";

export interface EndpointConfigRecord {
  id: string;
  name: string;
  baseUrl: string;
  declaredModel?: string;
  fingerprintBaselineMode?: EndpointFingerprintBaselineMode;
  fingerprintBaselineId?: string;
  providerTag?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  passthroughAuth?: boolean;
  isDefault?: boolean;
  enabled?: boolean;
}

export interface EndpointAdminRecord {
  id: string;
  name: string;
  baseUrl: string;
  declaredModel: string;
  fingerprintBaselineMode: EndpointFingerprintBaselineMode;
  fingerprintBaselineId: string;
  fingerprintBaselineName: string | null;
  providerTag: string;
  passthroughAuth: boolean;
  isDefault: boolean;
  enabled: boolean;
  apiKeyEnv: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface EndpointUpsertInput {
  id?: string;
  name: string;
  baseUrl: string;
  declaredModel?: string;
  fingerprintBaselineMode?: EndpointFingerprintBaselineMode;
  fingerprintBaselineId?: string;
  providerTag?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  apiKeyEnv?: string;
  passthroughAuth?: boolean;
  isDefault?: boolean;
  enabled?: boolean;
}

export interface EndpointOverview {
  endpointId: string;
  endpointName: string;
  declaredModel: string;
  providerTag: string;
  status: EndpointHealthStatus;
  requestCount24h: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  driftScore: number;
  stabilityScore: number;
  shieldInterceptions24h: number;
  lastAnomalyAt: string | null;
}

export interface TimelinePoint {
  ts: string;
  value: number;
}

export interface EndpointDetail {
  endpointId: string;
  endpointName: string;
  baseUrl: string;
  declaredModel: string;
  fingerprintBaselineMode: EndpointFingerprintBaselineMode;
  fingerprintBaselineId: string;
  fingerprintBaselineName: string | null;
  providerTag: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  requestCount24h: number;
  errorRate24h: number;
  timeoutRate24h: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgTtftMs: number;
  avgTokensPerSec: number;
  jsonValidRate: number;
  refusalRate: number;
  toolCallRate: number;
  driftScore: number;
  status: EndpointHealthStatus;
  latencySeries: TimelinePoint[];
  errorSeries: TimelinePoint[];
  driftSeries: TimelinePoint[];
  recentAnomalies: RiskEvent[];
}

export type RiskEventType =
  | "request_pii_redacted"
  | "request_secret_redacted"
  | "prompt_asset_protected"
  | "canary_injected"
  | "response_high_risk_blocked"
  | "response_high_risk_detected"
  | "sentinel_divergence"
  | "passive_drift"
  | "protocol_anomaly"
  | "enhanced_fingerprint_audit";

export interface RiskEvent {
  id: string;
  endpointId: string;
  requestId: string | null;
  type: RiskEventType;
  severity: "low" | "medium" | "high";
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ShieldSummary {
  redactedEntities24h: number;
  redactedSecrets24h: number;
  promptProtectionHits24h: number;
  canaryInjected24h: number;
  blockedResponses24h: number;
  topSensitiveTypes: Array<{ type: string; count: number }>;
}

export interface ShieldCenterResponse {
  summary: ShieldSummary;
  recentEvents: RiskEvent[];
}

export type SentinelRunStatus = "ok" | "failed" | "http_error" | "skipped";
export type SentinelDimensionKey = "availability" | "performance" | "contract" | "behavior";

export interface SentinelDimensionStatus {
  key: SentinelDimensionKey;
  label: string;
  status: EndpointHealthStatus | "No Data";
  score: number;
  summary: string;
}

export interface SentinelPromptHealth {
  promptId: string;
  title: string;
  capability: string;
  lastRunAt: string | null;
  lastStatus: SentinelRunStatus | "unknown";
  lastDivergence: number | null;
  lastExpectationPassed: boolean | null;
  successRate24h: number | null;
  avgDivergence24h: number | null;
  consecutiveIssues: number;
  lastIssue: string | null;
  recommendation: string;
}

export interface SentinelHealthResponse {
  endpointId: string;
  enabled: boolean;
  intervalMinutes: number;
  promptsPerCycle: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  runCount24h: number;
  successRate24h: number | null;
  estimatedProbeCallsPerDay: number;
  overallStatus: EndpointHealthStatus | "No Data";
  headline: string;
  recommendedAction: string;
  dimensions: SentinelDimensionStatus[];
  prompts: SentinelPromptHealth[];
}

/** 匿名窗口统计，用于被动行为画像（不含原文） */
export interface FingerprintWindowStats {
  sampleSize: number;
  outputLengthP50: number;
  outputLengthP95: number;
  jsonValidRate: number | null;
  toolCallRate: number;
  refusalRate: number;
  streamShare: number;
  avgStreamEvents: number | null;
  avgStreamPayloadChars: number | null;
  topFinishReasons: Array<{ key: string; share: number }>;
  topUsageShapes: Array<{ key: string; share: number }>;
  topErrorFingerprints: Array<{ key: string; share: number }>;
  topRefusalTemplates: Array<{ key: string; share: number }>;
}

export interface PassiveFingerprintPortrait {
  recent: FingerprintWindowStats;
  previous: FingerprintWindowStats;
  /** 与上一窗口相比的简要提示（启发式，非结论性判词） */
  shiftHints: string[];
}

export type EnhancedFingerprintConclusion =
  | "model_match"
  | "model_mismatch"
  | "inconclusive";

export interface FingerprintAuditRecord {
  id: string;
  endpointId: string;
  trigger: string;
  conclusion: EnhancedFingerprintConclusion;
  confidence: number;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface FingerprintBaselineRecord {
  id: string;
  name: string;
  label: string;
  model: string;
  providerTag: string;
  modelFamily: string;
  notes: string;
  source: string;
  topK: number;
  samplesPerPrompt: number;
  permutationIters: number;
  isPreferred: boolean;
  profile: Record<string, unknown>;
  report: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface FingerprintModelRecord {
  id: string;
  label: string;
  model: string;
  providerTag: string;
  modelFamily: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface FingerprintModelUpsertInput {
  id?: string;
  label: string;
  model: string;
  providerTag?: string;
  modelFamily?: string;
  notes?: string;
}

export type ProbeExpectationMode =
  | "none"
  | "exact_text"
  | "one_of"
  | "regex"
  | "contains_all"
  | "json_required_keys"
  | "word_count"
  | "sentence_count"
  | "bullet_lines"
  | "numbered_steps";

export interface ProbeExpectation {
  mode: ProbeExpectationMode;
  caseSensitive?: boolean;
  value?: string;
  values?: string[];
  pattern?: string;
  flags?: string;
  requiredKeys?: string[];
  exact?: number;
  min?: number;
  max?: number;
}

export interface PolicyConfig {
  requiredRedactionFields: string[];
  /** Literal strings to redact before forwarding requests to upstream relays */
  manualRedactionStrings: string[];
  /** Regex patterns to redact before forwarding requests to upstream relays */
  manualRedactionRegexes: string[];
  disallowRelaySessionTags: string[];
  blockOnHighRiskResponse: boolean;
  privacyFilterEnabled: boolean;
  privacyFilterThreshold: number;
  sentinelEnabled: boolean;
  sentinelIntervalMinutes: number;
  sentinelPromptsPerCycle: number;
  canaryEnabled: boolean;
  promptPerturbationEnabled: boolean;
  minimalExposureEnabled: boolean;
  /** 被动画像对比窗口（小时），默认 24 */
  fingerprintPortraitWindowHours: number;
  /** 是否在漂移超阈时触发指纹匹配审计 */
  fingerprintAuditEnabled: boolean;
  /** 与 sentinel 漂移分数比较，超过则尝试触发审计 */
  fingerprintAuditDriftThreshold: number;
  /** 同一 endpoint 指纹审计最小间隔（分钟） */
  fingerprintAuditCooldownMinutes: number;
}
