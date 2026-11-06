// Loaded with `node --import` into the real API and worker during E2E tests. It sits at the network boundary, so the
// production code runs unmodified (real hostnames, real paths) while nothing can leave the machine:
//   - a request to a host in E2E_HOST_MAP is sent to the local mock instead (api.github.com -> the mock GitHub, ...)
//   - a request to a loopback address passes through (the Switch mock, other local services)
//   - every other host is refused, and the refusal is logged so a test can assert it never happened.
// Plain JavaScript on purpose: it runs before any TypeScript tooling.
const map = JSON.parse(process.env.E2E_HOST_MAP ?? "{}");
const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const url = new URL(isRequest ? input.url : String(input));
  const mock = map[url.hostname];
  if (mock) {
    const target = new URL(mock);
    url.protocol = target.protocol;
    url.host = target.host;
  } else if (!loopback.has(url.hostname)) {
    console.error(JSON.stringify({ event: "e2e_offline_guard_blocked", host: url.hostname }));
    throw new TypeError(`offline guard: blocked request to ${url.hostname}`);
  }
  return realFetch(isRequest ? new Request(url, input) : url, init);
};
