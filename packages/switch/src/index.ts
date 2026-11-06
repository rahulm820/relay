// @relay/switch: Switch client, ticket-room outbox handler, bootstrap (Issue #15).
// Switch is consumed, never modified. See docs in the PR for the contracts relied on.
export { SwitchClient, type SwitchClientOptions, type SwitchBridge, type SwitchRoom, type CreateRoomInput, type RegisteredAgent } from "./client.js";
export { SwitchError, SwitchAuthError, SwitchUnavailableError, SwitchRequestError } from "./errors.js";
export { createSwitchMessageHandler, type MessageHandlerDeps } from "./room-handler.js";
export { createSwitchRoomHandler, type RoomHandlerDeps } from "./room-handler.js";
export { switchFromConfig } from "./config.js";
export { buildKickoff, roomName, roomMarker, roomDescription, sanitizeUntrusted, ROOM_INSTRUCTIONS, type TicketForRoom } from "./kickoff.js";
