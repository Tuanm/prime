// Error taxonomy for the CLI.
//
// Every failure the user can act on gets a distinct exit code so the tool is
// scriptable: a shell can branch on "device offline" (4) without parsing text.

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  OFFLINE: 4,
  TIMEOUT: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A problem with how the command was invoked (bad flags, bad JSON, ...). */
export class UsageError extends Error {
  readonly exitCode = EXIT.USAGE;
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "UsageError";
    this.hint = hint;
  }
}

/** The gateway rejected our credentials. */
export class AuthError extends Error {
  readonly exitCode = EXIT.AUTH;
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "AuthError";
    this.hint = hint;
  }
}

/** The device is not reachable through the gateway (no live tunnel). */
export class OfflineError extends Error {
  readonly exitCode = EXIT.OFFLINE;
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "OfflineError";
    this.hint = hint;
  }
}

/** A call exceeded the configured timeout. */
export class TimeoutError extends Error {
  readonly exitCode = EXIT.TIMEOUT;
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "TimeoutError";
    this.hint = hint;
  }
}

/** A JSON-RPC error returned by the device (the device is online and answered). */
export class McpError extends Error {
  readonly exitCode = EXIT.ERROR;
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.data = data;
  }
}

/** Anything else, with an optional actionable hint. */
export class CliError extends Error {
  readonly exitCode = EXIT.ERROR;
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "CliError";
    this.hint = hint;
  }
}

export function exitCodeOf(err: unknown): number {
  if (err && typeof err === "object" && "exitCode" in err) {
    const code = (err as { exitCode?: unknown }).exitCode;
    if (typeof code === "number") return code;
  }
  return EXIT.ERROR;
}

export function hintOf(err: unknown): string | undefined {
  if (err && typeof err === "object" && "hint" in err) {
    const hint = (err as { hint?: unknown }).hint;
    if (typeof hint === "string" && hint.length > 0) return hint;
  }
  return undefined;
}
