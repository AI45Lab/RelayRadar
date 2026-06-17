import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  policyPath: string;
  requestTimeoutMs: number;
  adminCorsOrigin: string;
}

const moduleDerivedRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function detectRepoRoot(): string {
  const envRoot = process.env.RELAYRADAR_ROOT;
  const candidates = [
    envRoot,
    process.cwd(),
    moduleDerivedRoot,
    resolve(moduleDerivedRoot, ".."),
    resolve(moduleDerivedRoot, "..", ".."),
    resolve(moduleDerivedRoot, "..", "..", "..")
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, "config/policy.json"))) {
      return candidate;
    }
  }

  return process.cwd();
}

const repoRoot = detectRepoRoot();

function resolveOrDefault(pathValue: string | undefined, fallbackPathFromRoot: string): string {
  if (pathValue && pathValue.trim().length > 0) {
    return resolve(pathValue);
  }

  return resolve(repoRoot, fallbackPathFromRoot);
}

export function loadConfig(): AppConfig {
  const config: AppConfig = {
    host: process.env.RELAYRADAR_HOST ?? "0.0.0.0",
    port: Number(process.env.RELAYRADAR_PORT ?? "8080"),
    dbPath: resolveOrDefault(process.env.RELAYRADAR_DB_PATH, "data/relayradar.sqlite"),
    policyPath: resolveOrDefault(process.env.RELAYRADAR_POLICY_PATH, "config/policy.json"),
    requestTimeoutMs: Number(process.env.RELAYRADAR_REQUEST_TIMEOUT_MS ?? "120000"),
    adminCorsOrigin: process.env.RELAYRADAR_ADMIN_CORS_ORIGIN ?? "*"
  };

  mkdirSync(dirname(config.dbPath), { recursive: true });

  if (!existsSync(config.policyPath)) {
    throw new Error(`Policy config not found: ${config.policyPath}`);
  }

  return config;
}
