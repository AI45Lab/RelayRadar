import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EndpointUpsertInput, PolicyConfig } from "@relayradar/shared";
import type { RelayRadarDb } from "../db.js";
import { EndpointStore } from "../endpoints.js";
import { runEnhancedFingerprintAudit } from "../fingerprint/enhanced-audit.js";
import { buildModelFingerprintCatalog } from "../fingerprint/catalog-builder.js";
import { PolicyStore } from "../policy.js";
import { SENTINEL_PROMPTS } from "../sentinel/prompts.js";
import { buildOpenAiUpstreamUrl, isObject } from "../utils.js";

interface SentinelRunner {
  runCycle(): Promise<void>;
  runEndpoint(endpointId: string): Promise<boolean>;
  resetSchedule(): void;
}

interface AdminDeps {
  db: RelayRadarDb;
  endpointStore: EndpointStore;
  policyStore: PolicyStore;
  sentinel?: SentinelRunner;
  adminToken?: string;
}

const catalogBuildSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  dryRun: z.boolean().default(false),
  outputPath: z.string().min(1).optional(),
  samplesPerPrompt: z.number().int().min(1).max(200).optional(),
  topK: z.number().int().min(1).max(20).optional(),
  permutationIters: z.number().int().min(100).max(50000).optional(),
  maxAttemptFactor: z.number().min(1).max(10).optional(),
  timeoutSeconds: z.number().min(5).max(300).optional(),
  sleepMs: z.number().int().min(0).max(2000).optional()
});

const baselineRunSchema = z.object({
  model: z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    model: z.string().min(1),
    providerTag: z.string().optional(),
    modelFamily: z.string().optional(),
    notes: z.string().optional()
  }),
  settings: z.object({
    baseUrl: z.string().url(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    samplesPerPrompt: z.number().int().min(1).max(200).optional(),
    topK: z.number().int().min(1).max(20).optional(),
    permutationIters: z.number().int().min(100).max(50000).optional(),
    maxAttemptFactor: z.number().min(1).max(10).optional(),
    timeoutSeconds: z.number().min(5).max(300).optional(),
    sleepMs: z.number().int().min(0).max(2000).optional()
  }),
  baselineName: z.string().min(1).max(180).optional()
});

const fingerprintModelUpsertSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  label: z.string().min(1).max(120),
  model: z.string().min(1).max(200),
  providerTag: z.string().max(120).optional(),
  modelFamily: z.string().max(120).optional(),
  notes: z.string().max(500).optional()
});

const modelListSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional()
});

interface ListedModel {
  id: string;
  created?: number | null;
  ownedBy?: string | null;
}

function slugifyModelId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function allocateFingerprintModelId(
  deps: AdminDeps,
  preferredId: string | undefined,
  label: string,
  model: string
): string {
  const base = slugifyModelId(preferredId ?? `${label}-${model}`) || "model";
  let candidate = base;
  let n = 2;
  while (deps.db.getFingerprintModel(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

function enforceAdminAuth(app: FastifyInstance, adminToken?: string): void {
  if (!adminToken) {
    return;
  }

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/rr/")) {
      return;
    }

    const token = request.headers["x-relayradar-admin-token"];
    const provided = Array.isArray(token) ? token[0] : token;
    if (provided !== adminToken) {
      return reply.code(401).send({ error: { message: "Invalid admin token" } });
    }
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getModelListData(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (isObject(payload) && Array.isArray(payload.data)) {
    return payload.data;
  }
  return [];
}

function mapListedModel(item: unknown): ListedModel | null {
  if (!isObject(item) || typeof item.id !== "string" || item.id.trim().length === 0) {
    return null;
  }

  return {
    id: item.id,
    created: typeof item.created === "number" ? item.created : null,
    ownedBy: typeof item.owned_by === "string" ? item.owned_by : typeof item.ownedBy === "string" ? item.ownedBy : null
  };
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  enforceAdminAuth(app, deps.adminToken);

  app.get("/rr/health", async () => ({
    ok: true,
    now: new Date().toISOString()
  }));

  app.get("/rr/overview", async () => deps.db.getOverview());

  app.get("/rr/endpoints", async () => deps.db.listEndpointAdmins());

  app.post<{ Body: unknown }>("/rr/models/list", async (request, reply) => {
    const parsed = modelListSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: { message: parsed.error.message } });
      return;
    }

    const body = parsed.data;
    const apiKey = body.apiKey?.trim() || (body.apiKeyEnv?.trim() ? process.env[body.apiKeyEnv.trim()] : undefined);
    if (body.apiKeyEnv?.trim() && !apiKey) {
      reply.code(400).send({ error: { message: `API key env '${body.apiKeyEnv.trim()}' is not set.` } });
      return;
    }

    const sourceUrl = buildOpenAiUpstreamUrl(body.baseUrl.trim(), "/v1/models");
    try {
      const upstream = await fetch(sourceUrl, {
        method: "GET",
        headers: {
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
        },
        signal: AbortSignal.timeout(30000)
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        reply.code(upstream.status).send({
          error: {
            message: text.trim().length > 0 ? text.slice(0, 600) : `Model list request failed with HTTP ${upstream.status}`
          }
        });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        reply.code(502).send({ error: { message: "Model list response was not valid JSON." } });
        return;
      }

      const seen = new Set<string>();
      const models = getModelListData(payload)
        .map((item) => mapListedModel(item))
        .filter((item): item is ListedModel => Boolean(item))
        .filter((item) => {
          const key = item.id.trim();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => a.id.localeCompare(b.id));

      return { models, sourceUrl };
    } catch (error) {
      reply.code(502).send({ error: { message: `Model list request failed: ${toErrorMessage(error)}` } });
      return;
    }
  });

  app.post<{ Body: EndpointUpsertInput }>("/rr/endpoints", async (request, reply) => {
    let endpointId: string;
    try {
      endpointId = deps.endpointStore.resolveInputId(request.body);
    } catch (error) {
      reply.code(400).send({ error: { message: toErrorMessage(error) } });
      return;
    }

    if (deps.db.getEndpointConfig(endpointId)) {
      reply.code(409).send({ error: { message: `Endpoint with id '${endpointId}' already exists` } });
      return;
    }

    try {
      const endpoint = deps.endpointStore.upsertFromAdmin(request.body);
      const created = deps.db.listEndpointAdmins().find((item) => item.id === endpoint.id);
      if (!created) {
        reply.code(500).send({ error: { message: "Failed to persist endpoint" } });
        return;
      }
      return created;
    } catch (error) {
      reply.code(400).send({ error: { message: toErrorMessage(error) } });
      return;
    }
  });

  app.put<{ Params: { endpointId: string }; Body: EndpointUpsertInput }>("/rr/endpoints/:endpointId", async (request, reply) => {
    const exists = deps.db.getEndpointConfig(request.params.endpointId);
    if (!exists) {
      reply.code(404).send({ error: { message: "Endpoint not found" } });
      return;
    }

    try {
      const endpoint = deps.endpointStore.upsertFromAdmin({
        ...request.body,
        id: request.params.endpointId
      });
      const updated = deps.db.listEndpointAdmins().find((item) => item.id === endpoint.id);
      if (!updated) {
        reply.code(500).send({ error: { message: "Failed to update endpoint" } });
        return;
      }
      return updated;
    } catch (error) {
      reply.code(400).send({ error: { message: toErrorMessage(error) } });
      return;
    }
  });

  app.post<{ Params: { endpointId: string } }>("/rr/endpoints/:endpointId/default", async (request, reply) => {
    const exists = deps.db.getEndpointConfig(request.params.endpointId);
    if (!exists) {
      reply.code(404).send({ error: { message: "Endpoint not found" } });
      return;
    }

    deps.endpointStore.setDefault(request.params.endpointId);
    return { ok: true };
  });

  app.post<{ Params: { endpointId: string }; Body: { baselineId?: string | null } }>(
    "/rr/endpoints/:endpointId/fingerprint-baseline",
    async (request, reply) => {
      const exists = deps.db.getEndpointConfig(request.params.endpointId);
      if (!exists) {
        reply.code(404).send({ error: { message: "Endpoint not found" } });
        return;
      }

      const baselineId = typeof request.body?.baselineId === "string" ? request.body.baselineId.trim() : "";
      if (baselineId.length > 0) {
        const baseline = deps.db.getFingerprintBaseline(baselineId);
        if (!baseline) {
          reply.code(404).send({ error: { message: "Baseline not found" } });
          return;
        }
      }

      deps.db.upsertEndpoint({
        ...exists,
        fingerprintBaselineMode: baselineId.length > 0 ? "manual_baseline" : "declared_model",
        fingerprintBaselineId: baselineId.length > 0 ? baselineId : ""
      });

      const detail = deps.db.getEndpointDetail(request.params.endpointId);
      if (!detail) {
        reply.code(500).send({ error: { message: "Failed to refresh endpoint detail" } });
        return;
      }
      return { ok: true, detail };
    }
  );

  app.delete<{ Params: { endpointId: string } }>("/rr/endpoints/:endpointId", async (request, reply) => {
    const all = deps.db.listEndpointAdmins();
    if (all.length <= 1) {
      reply.code(400).send({ error: { message: "Cannot delete the last endpoint" } });
      return;
    }

    const exists = all.some((item) => item.id === request.params.endpointId);
    if (!exists) {
      reply.code(404).send({ error: { message: "Endpoint not found" } });
      return;
    }

    deps.endpointStore.delete(request.params.endpointId);
    return { ok: true };
  });

  app.get<{ Params: { endpointId: string } }>("/rr/endpoints/:endpointId", async (request, reply) => {
    const detail = deps.db.getEndpointDetail(request.params.endpointId);
    if (!detail) {
      reply.code(404).send({ error: { message: "Endpoint not found" } });
      return;
    }

    return detail;
  });

  app.get<{ Params: { endpointId: string } }>("/rr/fingerprint/:endpointId", async (request, reply) => {
    const exists = deps.db.getEndpointConfig(request.params.endpointId);
    if (!exists) {
      reply.code(404).send({ error: { message: "Endpoint not found" } });
      return;
    }

    const windowHours = deps.policyStore.get().fingerprintPortraitWindowHours;
    const portrait = deps.db.getFingerprintPortrait(request.params.endpointId, windowHours);
    const audits = deps.db.listFingerprintAudits(request.params.endpointId, 20);
    return { portrait, audits, windowHours };
  });

  app.get<{ Params: { endpointId: string } }>("/rr/sentinel/:endpointId", async (request, reply) => {
    const health = deps.db.getSentinelHealth(
      request.params.endpointId,
      deps.policyStore.get(),
      SENTINEL_PROMPTS.map((prompt) => ({
        id: prompt.id,
        title: prompt.title,
        capability: prompt.capability
      }))
    );
    if (!health) {
      reply.code(404).send({ error: { message: "Endpoint not found" } });
      return;
    }
    return health;
  });

  app.post<{ Params: { endpointId: string }; Body: { force?: boolean } }>(
    "/rr/fingerprint/:endpointId/audit",
    async (request, reply) => {
      const exists = deps.db.getEndpointConfig(request.params.endpointId);
      if (!exists) {
        reply.code(404).send({ error: { message: "Endpoint not found" } });
        return;
      }

      const audit = await runEnhancedFingerprintAudit(
        { db: deps.db, policyStore: deps.policyStore, logger: request.log },
        request.params.endpointId,
        "manual",
        { force: request.body?.force === true }
      );

      return { ok: audit !== null, audit };
    }
  );

  app.post<{ Body: unknown }>("/rr/fingerprint/catalog/build", async (request, reply) => {
    const parsed = catalogBuildSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: { message: parsed.error.message } });
      return;
    }

    const body = parsed.data;
    try {
      const result = await buildModelFingerprintCatalog(body.config, {
        dryRun: body.dryRun,
        outputPath: body.outputPath,
        samplesPerPrompt: body.samplesPerPrompt,
        topK: body.topK,
        permutationIters: body.permutationIters,
        maxAttemptFactor: body.maxAttemptFactor,
        timeoutSeconds: body.timeoutSeconds,
        sleepMs: body.sleepMs,
        logger: request.log
      });
      return result;
    } catch (error) {
      reply.code(400).send({
        error: {
          message: error instanceof Error ? error.message : String(error)
        }
      });
      return;
    }
  });

  app.get("/rr/fingerprint/baselines", async () => deps.db.listFingerprintBaselines());

  app.get("/rr/fingerprint/models", async () => deps.db.listFingerprintModels());

  app.post<{ Body: unknown }>("/rr/fingerprint/models", async (request, reply) => {
    const parsed = fingerprintModelUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: { message: parsed.error.message } });
      return;
    }

    const body = parsed.data;
    const modelId = allocateFingerprintModelId(deps, body.id, body.label, body.model);
    const saved = deps.db.upsertFingerprintModel({
      id: modelId,
      label: body.label,
      model: body.model,
      providerTag: body.providerTag,
      modelFamily: body.modelFamily,
      notes: body.notes
    });
    return saved;
  });

  app.put<{ Params: { modelId: string }; Body: unknown }>("/rr/fingerprint/models/:modelId", async (request, reply) => {
    const exists = deps.db.getFingerprintModel(request.params.modelId);
    if (!exists) {
      reply.code(404).send({ error: { message: "Fingerprint model not found" } });
      return;
    }

    const parsed = fingerprintModelUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: { message: parsed.error.message } });
      return;
    }

    const body = parsed.data;
    const saved = deps.db.upsertFingerprintModel({
      id: request.params.modelId,
      label: body.label,
      model: body.model,
      providerTag: body.providerTag,
      modelFamily: body.modelFamily,
      notes: body.notes
    });
    return saved;
  });

  app.delete<{ Params: { modelId: string } }>("/rr/fingerprint/models/:modelId", async (request, reply) => {
    const ok = deps.db.deleteFingerprintModel(request.params.modelId);
    if (!ok) {
      reply.code(404).send({ error: { message: "Fingerprint model not found" } });
      return;
    }
    return { ok: true };
  });

  app.post<{ Body: unknown }>("/rr/fingerprint/baselines/run", async (request, reply) => {
    const parsed = baselineRunSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: { message: parsed.error.message } });
      return;
    }

    const { model, settings, baselineName } = parsed.data;
    try {
      const result = await buildModelFingerprintCatalog(
        {
          defaults: {
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            apiKeyEnv: settings.apiKeyEnv,
            topK: settings.topK,
            samplesPerPrompt: settings.samplesPerPrompt,
            permutationIters: settings.permutationIters,
            source: "fingerprint_lab_run",
            systemPrompt: "Calibration run. Continue naturally using one-token completion only."
          },
          models: [
            {
              id: model.id,
              label: model.label,
              model: model.model,
              providerTag: model.providerTag,
              modelFamily: model.modelFamily,
              notes: model.notes
            }
          ]
        },
        {
          dryRun: true,
          samplesPerPrompt: settings.samplesPerPrompt,
          topK: settings.topK,
          permutationIters: settings.permutationIters,
          maxAttemptFactor: settings.maxAttemptFactor,
          timeoutSeconds: settings.timeoutSeconds,
          sleepMs: settings.sleepMs,
          logger: request.log
        }
      );

      const preview = Array.isArray(result.catalogPreview) ? result.catalogPreview[0] : null;
      if (!preview || typeof preview !== "object") {
        reply.code(500).send({ error: { message: "Failed to generate baseline profile preview" } });
        return;
      }

      const profile = preview as Record<string, unknown>;
      const modelRun = result.report[0];
      const runMode = modelRun?.runMode === "b3it_fallback" ? "b3it_fallback" : "paper_logprob";
      const paper = profile.paperLogprobBaseline;
      const paperObj = paper && typeof paper === "object" ? (paper as Record<string, unknown>) : {};
      const b3it = profile.paperB3itBaseline;
      const b3itObj = b3it && typeof b3it === "object" ? (b3it as Record<string, unknown>) : {};
      const topK = typeof paperObj.topK === "number" ? paperObj.topK : settings.topK ?? 5;
      const samplesPerPrompt =
        (typeof paperObj.samplesPerPrompt === "number"
          ? paperObj.samplesPerPrompt
          : typeof b3itObj.samplesPerPrompt === "number"
            ? b3itObj.samplesPerPrompt
            : settings.samplesPerPrompt) ?? 20;
      const permutationIters =
        (typeof paperObj.permutationIters === "number"
          ? paperObj.permutationIters
          : typeof b3itObj.permutationIters === "number"
            ? b3itObj.permutationIters
            : settings.permutationIters) ?? 1200;
      const promptReport = modelRun?.prompts ?? [];
      const logprobsUnsupportedLikely = modelRun?.logprobsUnsupportedLikely === true;
      const totalUnsupportedCount = modelRun?.totalUnsupportedCount ?? 0;
      const totalFailureCount = modelRun?.totalFailureCount ?? 0;
      if (runMode === "paper_logprob") {
        const totalSuccesses = promptReport.reduce((acc, row) => acc + row.successes, 0);
        const usablePromptCount = promptReport.filter((row) => row.successes >= 3).length;
        const minUsablePrompts = Math.max(3, Math.floor(promptReport.length * 0.5));
        const minTotalSuccesses = Math.max(24, promptReport.length * 3);
        if (usablePromptCount < minUsablePrompts || totalSuccesses < minTotalSuccesses) {
          const unsupportedHint = logprobsUnsupportedLikely
            ? "Upstream likely does not support logprobs for this model/endpoint."
            : "Sampling failed, but unsupported-logprobs signal is not dominant.";
          reply.code(400).send({
            error: {
              message:
                `Baseline sampling quality is too low (usablePrompts=${usablePromptCount}/${promptReport.length}, ` +
                `totalSuccesses=${totalSuccesses}). ${unsupportedHint}`
            },
            diagnostics: {
              runMode,
              usablePromptCount,
              totalPrompts: promptReport.length,
              totalSuccesses,
              minUsablePrompts,
              minTotalSuccesses,
              logprobsUnsupportedLikely,
              totalUnsupportedCount,
              totalFailureCount,
              prompts: promptReport
            }
          });
          return;
        }
      } else {
        const b3itPrompts = Array.isArray(b3itObj.prompts) ? b3itObj.prompts : [];
        const usablePromptCount = b3itPrompts.filter((row) => {
          if (!row || typeof row !== "object") {
            return false;
          }
          const samples = (row as Record<string, unknown>).referenceSamples;
          return Array.isArray(samples) && samples.length >= 3;
        }).length;
        const totalSuccesses = b3itPrompts.reduce((acc, row) => {
          if (!row || typeof row !== "object") {
            return acc;
          }
          const samples = (row as Record<string, unknown>).referenceSamples;
          return acc + (Array.isArray(samples) ? samples.length : 0);
        }, 0);
        const minUsablePrompts = 3;
        const minTotalSuccesses = Math.max(18, usablePromptCount * 4);
        if (usablePromptCount < minUsablePrompts || totalSuccesses < minTotalSuccesses) {
          reply.code(400).send({
            error: {
              message:
                `B3IT fallback sampling quality is too low (usableBorderPrompts=${usablePromptCount}, ` +
                `totalSuccesses=${totalSuccesses}). Upstream likely does not support logprobs, and fallback data was insufficient.`
            },
            diagnostics: {
              runMode,
              usablePromptCount,
              totalPrompts: b3itPrompts.length,
              totalSuccesses,
              minUsablePrompts,
              minTotalSuccesses,
              logprobsUnsupportedLikely,
              totalUnsupportedCount,
              totalFailureCount,
              b3it: modelRun?.b3it ?? null
            }
          });
          return;
        }
      }

      const created = deps.db.createFingerprintBaseline({
        name: baselineName?.trim() || `${model.label} baseline ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
        label: model.label,
        model: model.model,
        providerTag: model.providerTag,
        modelFamily: model.modelFamily,
        notes: model.notes,
        source: typeof profile.source === "string" ? profile.source : "fingerprint_lab_run",
        topK,
        samplesPerPrompt,
        permutationIters,
        profile,
        report: {
          modelId: result.report[0]?.modelId ?? model.id,
          runMode,
          prompts: promptReport,
          b3it: modelRun?.b3it ?? null
        }
      });

      if (deps.db.listFingerprintBaselines().length === 1) {
        deps.db.setPreferredFingerprintBaseline(created.id);
      }

      return {
        ok: true,
        baseline: deps.db.getFingerprintBaseline(created.id),
        run: result.report[0] ?? null
      };
    } catch (error) {
      reply.code(400).send({
        error: {
          message: error instanceof Error ? error.message : String(error)
        }
      });
      return;
    }
  });

  app.post<{ Params: { baselineId: string } }>("/rr/fingerprint/baselines/:baselineId/preferred", async (request, reply) => {
    const updated = deps.db.setPreferredFingerprintBaseline(request.params.baselineId);
    if (!updated) {
      reply.code(404).send({ error: { message: "Baseline not found" } });
      return;
    }
    return { ok: true, baseline: updated };
  });

  app.delete<{ Params: { baselineId: string } }>("/rr/fingerprint/baselines/:baselineId", async (request, reply) => {
    const ok = deps.db.deleteFingerprintBaseline(request.params.baselineId);
    if (!ok) {
      reply.code(404).send({ error: { message: "Baseline not found" } });
      return;
    }
    return { ok: true };
  });

  app.get<{ Querystring: { endpointId?: string; limit?: string } }>("/rr/events", async (request) => {
    const limit = request.query.limit ? Number.parseInt(request.query.limit, 10) : 200;
    const boundedLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 200;
    return deps.db.listRiskEvents(boundedLimit, request.query.endpointId);
  });

  app.get("/rr/shield", async () => deps.db.getShieldCenter());

  app.get("/rr/policy", async () => deps.policyStore.get());

  app.put<{ Body: PolicyConfig }>("/rr/policy", async (request, reply) => {
    try {
      const updated = deps.policyStore.update(request.body);
      deps.sentinel?.resetSchedule();
      return updated;
    } catch (error) {
      reply.code(400).send({ error: { message: toErrorMessage(error) } });
      return;
    }
  });

  app.post("/rr/reload", async () => {
    deps.policyStore.reload();
    deps.sentinel?.resetSchedule();
    return { ok: true };
  });

  app.post("/rr/sentinel/run", async () => {
    if (!deps.sentinel) {
      return { ok: false, message: "Sentinel service not available" };
    }

    await deps.sentinel.runCycle();
    return { ok: true };
  });

  app.post<{ Params: { endpointId: string } }>("/rr/sentinel/:endpointId/run", async (request, reply) => {
    if (!deps.sentinel) {
      return { ok: false, message: "Sentinel service not available" };
    }

    const ok = await deps.sentinel.runEndpoint(request.params.endpointId);
    if (!ok) {
      reply.code(404).send({ error: { message: "Endpoint not found or Sentinel disabled" } });
      return;
    }
    return { ok: true };
  });
}
