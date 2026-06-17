import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadConfig } from "./config.js";
import { RelayRadarDb } from "./db.js";
import { EndpointStore } from "./endpoints.js";
import { PolicyStore } from "./policy.js";
import { registerOpenAiProxyRoutes } from "./proxy/openai-routes.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { SentinelService } from "./sentinel/service.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new RelayRadarDb(config.dbPath);
  const endpointStore = new EndpointStore(db);
  const policyStore = new PolicyStore(config.policyPath);

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info"
    },
    bodyLimit: 20 * 1024 * 1024,
    requestTimeout: 15 * 60 * 1000
  });

  await app.register(cors, {
    origin: config.adminCorsOrigin,
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "content-type",
      "authorization",
      "x-relayradar-admin-token",
      "x-relayradar-session-tags"
    ]
  });

  await registerOpenAiProxyRoutes(app, {
    config,
    db,
    endpointStore,
    policyStore
  });

  const sentinel = new SentinelService({
    db,
    endpointStore,
    policyStore,
    logger: app.log
  });

  await registerAdminRoutes(app, {
    db,
    endpointStore,
    policyStore,
    sentinel,
    adminToken: process.env.RELAYRADAR_ADMIN_TOKEN
  });

  sentinel.start();

  app.addHook("onClose", async () => {
    sentinel.stop();
    db.close();
  });

  await app.listen({
    host: config.host,
    port: config.port
  });

  app.log.info({ port: config.port, host: config.host }, "RelayRadar Proxy started");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
