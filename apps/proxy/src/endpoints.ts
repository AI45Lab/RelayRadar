import { z } from "zod";
import type { EndpointConfigRecord, EndpointUpsertInput } from "@relayradar/shared";
import type { RelayRadarDb } from "./db.js";

const endpointUpsertSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  declaredModel: z.string().optional(),
  fingerprintBaselineMode: z.enum(["declared_model", "manual_baseline"]).optional(),
  fingerprintBaselineId: z.string().optional(),
  providerTag: z.string().optional(),
  apiKey: z.string().optional(),
  clearApiKey: z.boolean().optional(),
  apiKeyEnv: z.string().optional(),
  passthroughAuth: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional()
});

const endpointIdInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1)
});

const DEFAULT_ENDPOINT: EndpointConfigRecord = {
  id: "official-openai",
  name: "OpenAI Official",
  baseUrl: "https://api.openai.com/v1",
  declaredModel: "gpt-4o",
  providerTag: "openai",
  apiKeyEnv: "OPENAI_API_KEY",
  passthroughAuth: false,
  isDefault: true,
  enabled: true
};

function toEndpointId(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized.length > 0 ? normalized : "endpoint";
}

function normalizeForMatch(raw: string): string {
  return raw.trim().toLowerCase();
}

function compactAlphaNum(raw: string): string {
  return normalizeForMatch(raw).replace(/[^a-z0-9]+/g, "");
}

function tokenize(raw: string): string[] {
  return normalizeForMatch(raw).split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

function endpointMatchKeys(endpoint: EndpointConfigRecord): string[] {
  const keys = [endpoint.name, endpoint.id, endpoint.providerTag ?? "", endpoint.declaredModel ?? ""]
    .map((value) => normalizeForMatch(value))
    .filter((value) => value.length > 0);
  return [...new Set(keys)];
}

function computeMatchScore(modelName: string, endpoint: EndpointConfigRecord): number {
  const model = normalizeForMatch(modelName);
  const modelCompact = compactAlphaNum(model);
  const modelTokens = new Set(tokenize(model));
  let best = -1;

  for (const key of endpointMatchKeys(endpoint)) {
    if (key.length < 2) {
      continue;
    }

    if (model === key) {
      best = Math.max(best, 10_000 + key.length);
    }

    if (model.endsWith(key)) {
      best = Math.max(best, 7_000 + key.length);
    }

    if (model.includes(key)) {
      best = Math.max(best, 5_000 + key.length);
    }

    const keyCompact = compactAlphaNum(key);
    if (keyCompact.length >= 2 && modelCompact.includes(keyCompact)) {
      best = Math.max(best, 3_000 + keyCompact.length);
    }

    const keyTokens = tokenize(key).filter((token) => token.length >= 2);
    for (const token of keyTokens) {
      if (modelTokens.has(token)) {
        best = Math.max(best, 1_000 + token.length);
      }
    }
  }

  return best;
}

export class EndpointStore {
  public constructor(private readonly db: RelayRadarDb) {
    this.ensureSeedEndpoint();
  }

  public getDefaultEndpointId(): string {
    return this.db.getDefaultEndpointId() ?? "";
  }

  public list(): EndpointConfigRecord[] {
    return this.db.listEndpointConfigs();
  }

  public listEnabled(): EndpointConfigRecord[] {
    return this.list().filter((endpoint) => endpoint.enabled !== false);
  }

  public getEndpoint(endpointId?: string | null): EndpointConfigRecord | null {
    const fallbackId = this.getDefaultEndpointId();
    const id = endpointId && endpointId.length > 0 ? endpointId : fallbackId;
    if (!id) {
      return null;
    }

    const endpoint = this.db.getEndpointConfig(id);
    if (!endpoint || endpoint.enabled === false) {
      return null;
    }

    return endpoint;
  }

  public resolveByModel(modelName?: string | null): EndpointConfigRecord | null {
    const enabled = this.listEnabled();
    if (enabled.length === 0) {
      return null;
    }

    if (modelName && modelName.trim().length > 0) {
      let bestEndpoint: EndpointConfigRecord | null = null;
      let bestScore = -1;

      for (const endpoint of enabled) {
        const score = computeMatchScore(modelName, endpoint);
        if (score > bestScore) {
          bestScore = score;
          bestEndpoint = endpoint;
        } else if (score === bestScore && score >= 0 && endpoint.isDefault) {
          bestEndpoint = endpoint;
        }
      }

      if (bestEndpoint && bestScore >= 0) {
        return bestEndpoint;
      }
    }

    const fallback = this.getEndpoint(this.getDefaultEndpointId());
    return fallback ?? enabled[0] ?? null;
  }

  public resolveInputId(input: Pick<EndpointUpsertInput, "id" | "name">): string {
    const parsed = endpointIdInputSchema.parse(input);
    return parsed.id && parsed.id.trim().length > 0 ? parsed.id.trim() : toEndpointId(parsed.name);
  }

  public upsertFromAdmin(input: EndpointUpsertInput): EndpointConfigRecord {
    const parsed = endpointUpsertSchema.parse(input);
    const endpointId = this.resolveInputId(parsed);

    const endpoint: EndpointConfigRecord = {
      id: endpointId,
      name: parsed.name,
      baseUrl: parsed.baseUrl,
      declaredModel: parsed.declaredModel,
      fingerprintBaselineMode: parsed.fingerprintBaselineMode,
      fingerprintBaselineId: parsed.fingerprintBaselineId,
      providerTag: parsed.providerTag,
      apiKey: parsed.apiKey,
      apiKeyEnv: parsed.apiKeyEnv,
      passthroughAuth: parsed.passthroughAuth,
      isDefault: parsed.isDefault,
      enabled: parsed.enabled
    };

    this.db.upsertEndpoint(endpoint, { clearApiKey: parsed.clearApiKey === true });
    return this.db.getEndpointConfig(endpointId) ?? endpoint;
  }

  public delete(endpointId: string): void {
    this.db.deleteEndpoint(endpointId);
  }

  public setDefault(endpointId: string): void {
    this.db.setDefaultEndpoint(endpointId);
  }

  private ensureSeedEndpoint(): void {
    if (this.db.listEndpointConfigs().length > 0) {
      return;
    }
    this.db.upsertEndpoint(DEFAULT_ENDPOINT, { clearApiKey: false });
  }
}
