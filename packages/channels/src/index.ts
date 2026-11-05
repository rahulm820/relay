// @relay/channels: channel-agnostic gateway core (registry, ingest, baseline redaction) and the
// Telegram adapter (Issue #5). The core never imports from ./telegram.
export { ChannelRegistry, type BotContext, type AdapterFactory } from "./registry.js";
export { ingestMessage, type IngestDeps, type IngestResult } from "./ingest.js";
export { baselineRedact, type Redactor } from "./redact.js";
export * from "./telegram/index.js";
export { createClientSendHandler, createPgClientSendStore, type ClientSendStore, type ClientSendDeps, type SendContext } from "./client-send.js";
export { ticketRef, ackText, refusalText, statusText, cleanClarificationItems } from "./client-messages.js";
