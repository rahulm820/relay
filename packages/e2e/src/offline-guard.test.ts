// The preload shim is what guarantees the E2E suite cannot reach the internet and that production code runs unmodified
// against mocks, so it gets its own tests. No database needed: a child process with the shim plays the part of the
// API or worker.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PRELOAD = fileURLToPath(new URL("./preload/network-boundary.mjs", import.meta.url));
let mock: Server;
let mockUrl = "";
const seen: { path: string; host: string }[] = [];

before(async () => {
  mock = createServer((req, res) => { seen.push({ path: req.url ?? "", host: String(req.headers.host) }); res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'); });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => { mock.closeAllConnections(); mock.close(() => r()); }));

/** Runs `code` in a Node process with the shim loaded; resolves with its stdout, stderr and exit code. */
function inShim(code: string, map: Record<string, string> = { "api.github.com": mockUrl }): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", PRELOAD, "--input-type=module", "-e", code], { env: { PATH: process.env["PATH"] ?? "", E2E_HOST_MAP: JSON.stringify(map) } },
      (error, out, err) => resolve({ out, err, code: error ? ((error as { code?: number }).code ?? 1) : 0 }));
  });
}

describe("network boundary shim", () => {
  it("sends a mapped production host to its mock, keeping the path and query", async () => {
    seen.length = 0;
    const r = await inShim(`const res = await fetch("https://api.github.com/repos/acme/app/issues?state=open"); console.log(res.status, (await res.json()).ok);`);
    assert.equal(r.out.trim(), "200 true");
    assert.deepEqual(seen, [{ path: "/repos/acme/app/issues?state=open", host: new URL(mockUrl).host }]);
  });

  it("handles a Request object as well as a URL string", async () => {
    seen.length = 0;
    const r = await inShim(`const res = await fetch(new Request("https://api.github.com/x", { method: "POST", body: "{}" })); console.log(res.status);`);
    assert.equal(r.out.trim(), "200");
    assert.equal(seen[0]?.path, "/x");
  });

  it("lets loopback addresses through untouched", async () => {
    seen.length = 0;
    const r = await inShim(`console.log((await fetch(${JSON.stringify(`${mockUrl}/health`)})).status);`, {});
    assert.equal(r.out.trim(), "200");
    assert.equal(seen[0]?.path, "/health");
  });

  it("refuses every other host, says so on stderr as a machine-readable line, and never reaches the network", async () => {
    seen.length = 0;
    const r = await inShim(`try { await fetch("https://example.com/secret?token=abc"); console.log("LEAKED"); } catch (e) { console.log("blocked:", e.message); }`);
    assert.match(r.out, /blocked: offline guard: blocked request to example\.com/);
    assert.ok(!r.out.includes("LEAKED"));
    assert.match(r.err, /"event":"e2e_offline_guard_blocked","host":"example\.com"/);
    assert.ok(!r.err.includes("token=abc") && !r.err.includes("/secret"), "only the host is logged, never the path or query");
    assert.equal(seen.length, 0);
  });

  it("an unmapped production host is refused even when another host is mapped", async () => {
    const r = await inShim(`try { await fetch("https://api.telegram.org/bot1:x/sendMessage"); console.log("LEAKED"); } catch (e) { console.log("blocked"); }`);
    assert.equal(r.out.trim(), "blocked");
  });
});
