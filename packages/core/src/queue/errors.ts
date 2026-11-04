/** Throw from a handler when retrying cannot help: the entry goes straight to the dead-letter stream. */
export class PermanentFailureError extends Error {
  constructor(
    message: string,
    readonly code: string = "permanent_failure",
  ) {
    super(message);
    this.name = "PermanentFailureError";
  }
}

/** Stable DLQ error codes written by the queue itself (handlers may add their own via PermanentFailureError). */
export const DLQ_CODES = {
  malformed: "malformed_entry",
  invalidEnvelope: "invalid_envelope",
  stageMismatch: "stage_mismatch",
  handlerError: "handler_error",
} as const;
