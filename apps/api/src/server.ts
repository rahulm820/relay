// apps/api: HTTP API, webhooks and admin API. Scaffold only: health endpoint.
// Webhook and admin routes arrive in Issues #5 and #17.
import Fastify from "fastify";
import { PIPELINE_VERSION } from "@relay/shared";

const port = Number(process.env["API_PORT"] ?? 8080);
const host = process.env["API_HOST"] ?? "0.0.0.0";

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => ({
    status: "ok",
    service: "api",
    pipelineVersion: PIPELINE_VERSION,
  }));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildServer();
  app.listen({ port, host }).catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
}
