import type {
  EndpointAdminRecord,
  EndpointDetail,
  EndpointOverview,
  EndpointUpsertInput,
  FingerprintAuditRecord,
  FingerprintBaselineRecord,
  FingerprintModelRecord,
  FingerprintModelUpsertInput,
  PassiveFingerprintPortrait,
  PolicyConfig,
  RiskEvent,
  SentinelHealthResponse,
  ShieldCenterResponse
} from "@relayradar/shared";

export interface FingerprintApiResponse {
  portrait: PassiveFingerprintPortrait;
  audits: FingerprintAuditRecord[];
  windowHours: number;
}

export interface FingerprintAuditApiResponse {
  ok: boolean;
  audit: FingerprintAuditRecord | null;
}

export interface FingerprintCatalogBuildRequest {
  config: Record<string, unknown>;
  dryRun?: boolean;
  outputPath?: string;
  samplesPerPrompt?: number;
  topK?: number;
  permutationIters?: number;
  maxAttemptFactor?: number;
  timeoutSeconds?: number;
  sleepMs?: number;
}

export interface FingerprintCatalogBuildPromptSummary {
  id: string;
  attempts: number;
  successes: number;
}

export interface FingerprintCatalogBuildB3itPromptSummary {
  id: string;
  prompt: string;
  discoveryAttempts: number;
  discoverySuccesses: number;
  discoveryUniqueOutputs: number;
  borderScore: number;
  referenceAttempts: number;
  referenceSuccesses: number;
  referenceUniqueOutputs: number;
}

export interface FingerprintCatalogBuildModelSummary {
  modelId: string;
  label: string;
  topK: number;
  samplesPerPrompt: number;
  prompts: FingerprintCatalogBuildPromptSummary[];
  runMode?: "paper_logprob" | "b3it_fallback";
  b3it?: {
    candidatePromptCount: number;
    discoveryQueriesPerPrompt: number;
    selectedBorderPromptCount: number;
    minRequiredBorderPrompts: number;
    prompts: FingerprintCatalogBuildB3itPromptSummary[];
  };
  logprobsUnsupportedLikely?: boolean;
  totalUnsupportedCount?: number;
  totalFailureCount?: number;
}

export interface FingerprintCatalogBuildResponse {
  ok: boolean;
  dryRun: boolean;
  outputPath: string | null;
  profileCount: number;
  report: FingerprintCatalogBuildModelSummary[];
  catalogPreview?: unknown;
}

export interface FingerprintBaselineRunRequest {
  model: {
    id: string;
    label: string;
    model: string;
    providerTag?: string;
    modelFamily?: string;
    notes?: string;
  };
  settings: {
    baseUrl: string;
    apiKey?: string;
    apiKeyEnv?: string;
    samplesPerPrompt?: number;
  };
  baselineName?: string;
}

export interface FingerprintBaselineRunResponse {
  ok: boolean;
  baseline: FingerprintBaselineRecord | null;
  run: FingerprintCatalogBuildModelSummary | null;
}

export interface ModelListRequest {
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

export interface ListedModel {
  id: string;
  created?: number | null;
  ownedBy?: string | null;
}

export interface ModelListResponse {
  models: ListedModel[];
  sourceUrl: string;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";
const ADMIN_TOKEN = import.meta.env.VITE_ADMIN_TOKEN;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (ADMIN_TOKEN && ADMIN_TOKEN.trim().length > 0) {
    headers.set("x-relayradar-admin-token", ADMIN_TOKEN.trim());
  }
  if (options?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed?.error?.message && parsed.error.message.trim().length > 0) {
        message = parsed.error.message;
      }
    } catch {
      // keep raw text
    }
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  return (await response.json()) as T;
}

export function fetchOverview(): Promise<EndpointOverview[]> {
  return request<EndpointOverview[]>("/rr/overview");
}

export function fetchEndpointDetail(endpointId: string): Promise<EndpointDetail> {
  return request<EndpointDetail>(`/rr/endpoints/${encodeURIComponent(endpointId)}`);
}

export function fetchShieldCenter(): Promise<ShieldCenterResponse> {
  return request<ShieldCenterResponse>("/rr/shield");
}

export function fetchEvents(endpointId?: string): Promise<RiskEvent[]> {
  const query = endpointId ? `?endpointId=${encodeURIComponent(endpointId)}` : "";
  return request<RiskEvent[]>(`/rr/events${query}`);
}

export function fetchEndpointAdmins(): Promise<EndpointAdminRecord[]> {
  return request<EndpointAdminRecord[]>("/rr/endpoints");
}

export function postListModels(body: ModelListRequest): Promise<ModelListResponse> {
  return request<ModelListResponse>("/rr/models/list", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function createEndpoint(input: EndpointUpsertInput): Promise<EndpointAdminRecord> {
  return request<EndpointAdminRecord>("/rr/endpoints", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateEndpoint(endpointId: string, input: EndpointUpsertInput): Promise<EndpointAdminRecord> {
  return request<EndpointAdminRecord>(`/rr/endpoints/${encodeURIComponent(endpointId)}`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function setDefaultEndpoint(endpointId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/rr/endpoints/${encodeURIComponent(endpointId)}/default`, {
    method: "POST"
  });
}

export function deleteEndpoint(endpointId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/rr/endpoints/${encodeURIComponent(endpointId)}`, {
    method: "DELETE"
  });
}

export function postEndpointFingerprintBaseline(
  endpointId: string,
  body: { baselineId?: string | null }
): Promise<{ ok: boolean; detail: EndpointDetail }> {
  return request<{ ok: boolean; detail: EndpointDetail }>(`/rr/endpoints/${encodeURIComponent(endpointId)}/fingerprint-baseline`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function fetchFingerprint(endpointId: string): Promise<FingerprintApiResponse> {
  return request<FingerprintApiResponse>(`/rr/fingerprint/${encodeURIComponent(endpointId)}`);
}

export function postFingerprintAudit(endpointId: string, body?: { force?: boolean }): Promise<FingerprintAuditApiResponse> {
  return request<FingerprintAuditApiResponse>(`/rr/fingerprint/${encodeURIComponent(endpointId)}/audit`, {
    method: "POST",
    body: JSON.stringify(body ?? {})
  });
}

export function fetchSentinelHealth(endpointId: string): Promise<SentinelHealthResponse> {
  return request<SentinelHealthResponse>(`/rr/sentinel/${encodeURIComponent(endpointId)}`);
}

export function postRunSentinel(endpointId: string): Promise<{ ok: boolean; message?: string }> {
  return request<{ ok: boolean; message?: string }>(`/rr/sentinel/${encodeURIComponent(endpointId)}/run`, {
    method: "POST"
  });
}

export function postFingerprintCatalogBuild(
  body: FingerprintCatalogBuildRequest
): Promise<FingerprintCatalogBuildResponse> {
  return request<FingerprintCatalogBuildResponse>("/rr/fingerprint/catalog/build", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function fetchFingerprintBaselines(): Promise<FingerprintBaselineRecord[]> {
  return request<FingerprintBaselineRecord[]>("/rr/fingerprint/baselines");
}

export function fetchFingerprintModels(): Promise<FingerprintModelRecord[]> {
  return request<FingerprintModelRecord[]>("/rr/fingerprint/models");
}

export function createFingerprintModel(body: FingerprintModelUpsertInput): Promise<FingerprintModelRecord> {
  return request<FingerprintModelRecord>("/rr/fingerprint/models", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function updateFingerprintModel(modelId: string, body: FingerprintModelUpsertInput): Promise<FingerprintModelRecord> {
  return request<FingerprintModelRecord>(`/rr/fingerprint/models/${encodeURIComponent(modelId)}`, {
    method: "PUT",
    body: JSON.stringify(body)
  });
}

export function deleteFingerprintModel(modelId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/rr/fingerprint/models/${encodeURIComponent(modelId)}`, {
    method: "DELETE"
  });
}

export function postFingerprintBaselineRun(body: FingerprintBaselineRunRequest): Promise<FingerprintBaselineRunResponse> {
  return request<FingerprintBaselineRunResponse>("/rr/fingerprint/baselines/run", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function postSetPreferredFingerprintBaseline(baselineId: string): Promise<{ ok: boolean; baseline: FingerprintBaselineRecord }> {
  return request<{ ok: boolean; baseline: FingerprintBaselineRecord }>(
    `/rr/fingerprint/baselines/${encodeURIComponent(baselineId)}/preferred`,
    { method: "POST" }
  );
}

export function deleteFingerprintBaseline(baselineId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/rr/fingerprint/baselines/${encodeURIComponent(baselineId)}`, {
    method: "DELETE"
  });
}

export function fetchPolicy(): Promise<PolicyConfig> {
  return request<PolicyConfig>("/rr/policy");
}

export function updatePolicy(policy: PolicyConfig): Promise<PolicyConfig> {
  return request<PolicyConfig>("/rr/policy", {
    method: "PUT",
    body: JSON.stringify(policy)
  });
}
