// apps/worker: queue consumers, outbox dispatcher and reconcile job.
// Scaffold only: a health endpoint so Compose can probe the process.
// Consumers arrive in Issues #4 and #6.
import { createServer } from "node:http";
import { PIPELINE_VERSION } from "@relay/shared";

const port = Number(process.env["WORKER_PORT"] ?? 8081);

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ status: "ok", service: "worker", pipelineVersion: PIPELINE_VERSION }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ msg: "worker listening", port }));
});

const shutdown = (signal: string) => {
  console.log(JSON.stringify({ msg: "shutting down", signal }));
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
