/** No ticket with this id is visible to the current tenant (row-level security hides other tenants'). */
export class TicketNotFoundError extends Error {
  constructor() {
    super("ticket not found");
    this.name = "TicketNotFoundError";
  }
}

/** The caller said which status it expected and the ticket was already somewhere else. */
export class StatusConflictError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`ticket is ${actual}, not ${expected}`);
    this.name = "StatusConflictError";
  }
}

/** The request is well-formed but refers to something that does not exist (e.g. an unknown assignee). */
export class TicketValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TicketValidationError";
  }
}
