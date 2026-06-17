import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { PolicyConfig } from "@relayradar/shared";

const policySchema = z.object({
  requiredRedactionFields: z.array(z.string()),
  manualRedactionStrings: z.array(z.string()).default([]),
  manualRedactionRegexes: z.array(z.string().min(1).max(300)).default([]),
  disallowRelaySessionTags: z.array(z.string()),
  blockOnHighRiskResponse: z.boolean(),
  privacyFilterEnabled: z.boolean().default(false),
  privacyFilterThreshold: z.number().min(0).max(1).default(0.85),
  sentinelEnabled: z.boolean(),
  sentinelIntervalMinutes: z.number().int().min(1).max(360),
  sentinelPromptsPerCycle: z.number().int().min(1).max(24),
  canaryEnabled: z.boolean(),
  promptPerturbationEnabled: z.boolean(),
  minimalExposureEnabled: z.boolean(),
  fingerprintPortraitWindowHours: z.number().int().min(1).max(168).default(24),
  fingerprintAuditEnabled: z.boolean().default(false),
  fingerprintAuditDriftThreshold: z.number().min(0).max(1).default(0.72),
  fingerprintAuditCooldownMinutes: z.number().int().min(5).max(1440).default(120)
});

export class PolicyStore {
  private policy: PolicyConfig;

  public constructor(private readonly path: string) {
    this.policy = this.load();
  }

  public get(): PolicyConfig {
    return this.policy;
  }

  public reload(): void {
    this.policy = this.load();
  }

  public update(next: PolicyConfig): PolicyConfig {
    const validated = policySchema.parse(next);
    this.policy = validated;
    writeFileSync(this.path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    return this.policy;
  }

  private load(): PolicyConfig {
    const raw = readFileSync(this.path, "utf8");
    return policySchema.parse(JSON.parse(raw));
  }
}
