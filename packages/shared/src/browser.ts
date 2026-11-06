// Browser-safe entry (@relay/shared/browser): only modules with no node: imports, so client bundles
// (apps/web) can share enums, the ticket state machine and the DTO schemas with the API.
// Do NOT re-export crypto, password, secret or config here. browser.test.ts guards this.
export * from "./enums.js";
export * from "./state-machine.js";
export * from "./contracts.js";
