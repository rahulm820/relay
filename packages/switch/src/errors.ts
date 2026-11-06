/** Base class. Messages and codes never contain URLs, cookies, keys or message text. */
export class SwitchError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SwitchError";
  }
}

/** The admin login was refused, or a session could not be re-established. Retrying will not help. */
export class SwitchAuthError extends SwitchError {
  constructor(code = "switch_auth_failed") {
    super("switch rejected the credentials", code);
    this.name = "SwitchAuthError";
  }
}

/** Switch could not be reached or failed (network, timeout, 5xx, 429). Transient: retry later. */
export class SwitchUnavailableError extends SwitchError {
  constructor(code: string) {
    super("switch is unavailable", code);
    this.name = "SwitchUnavailableError";
  }
}

/** Switch understood the request and refused it (other 4xx). Permanent for this request. */
export class SwitchRequestError extends SwitchError {
  constructor(readonly status: number) {
    super(`switch refused the request (${status})`, `switch_http_${status}`);
    this.name = "SwitchRequestError";
  }
}
