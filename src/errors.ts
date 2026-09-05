export type ErrorCategory =
  | "config"
  | "auth"
  | "relay"
  | "protocol"
  | "target"
  | "evidence"
  | "cleanup"
  | "local";

export type OperationKind = "prepare" | "send" | "observe" | "cleanup";

export class AwError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly operation: OperationKind | undefined;
  readonly commandId: string | undefined;
  readonly details: Readonly<Record<string, string | number | boolean>> | undefined;

  constructor(options: {
    code: string;
    category: ErrorCategory;
    message: string;
    retryable?: boolean | undefined;
    operation?: OperationKind | undefined;
    commandId?: string | undefined;
    details?: Readonly<Record<string, string | number | boolean>> | undefined;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "AwError";
    this.code = options.code;
    this.category = options.category;
    this.retryable = options.retryable ?? false;
    this.operation = options.operation;
    this.commandId = options.commandId;
    this.details = options.details;
  }

  toSafeJSON(): Record<string, unknown> {
    return {
      code: this.code,
      category: this.category,
      safe_message: this.message,
      retryable: this.retryable,
      ...(this.operation === undefined ? {} : { operation: this.operation }),
      ...(this.commandId === undefined ? {} : { command_id: this.commandId }),
      ...(this.details === undefined ? {} : { details: this.details })
    };
  }
}

export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  CONFIG: 2,
  AUTH: 3,
  RELAY: 4,
  TARGET: 5,
  CLEANUP: 6,
  ASSESSMENT_FAILED: 10,
  EVALUATION_INCOMPLETE: 11,
  EVALUATION_ERROR: 12,
  INTERRUPTED: 130
} as const;

export function exitCodeFor(error: unknown): number {
  if (!(error instanceof AwError)) return EXIT.INTERNAL;
  if (error.code === "EVALUATION_INCOMPLETE") return EXIT.EVALUATION_INCOMPLETE;
  if (error.code === "EVALUATION_ERROR") return EXIT.EVALUATION_ERROR;
  switch (error.category) {
    case "config":
      return EXIT.CONFIG;
    case "auth":
      return EXIT.AUTH;
    case "relay":
    case "protocol":
      return EXIT.RELAY;
    case "target":
    case "evidence":
      return EXIT.TARGET;
    case "cleanup":
      return EXIT.CLEANUP;
    case "local":
      return error.code === "INTERRUPTED" ? EXIT.INTERRUPTED : EXIT.INTERNAL;
  }
}

export function sanitizeTerminal(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
