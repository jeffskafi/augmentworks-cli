export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RequestTemplate = JsonValue;

export interface OperationResponseMap {
  [field: string]: string;
}

export interface HttpOperationConfig {
  method: "GET" | "POST" | "DELETE";
  path: string;
  request?: RequestTemplate;
  response?: OperationResponseMap;
  timeout_ms?: number;
  idempotent?: boolean;
}

export interface HttpAuthConfig {
  bearer_env?: string;
  headers_env?: Record<string, string>;
}

export interface AugmentWorksConfig {
  version: 1;
  target: {
    name: string;
    connector: "http";
    base_url: string;
    allow_insecure_http?: boolean;
    auth?: HttpAuthConfig;
    operations: {
      prepare?: HttpOperationConfig;
      send: HttpOperationConfig;
      observe?: HttpOperationConfig;
      cleanup?: HttpOperationConfig;
    };
    limits?: {
      request_bytes?: number;
      response_bytes?: number;
      operation_timeout_ms?: number;
    };
  };
  telemetry?: {
    allow_tool_events?: boolean;
    allow_observations?: string[];
  };
}

export interface ResolvedConfig {
  readonly config: AugmentWorksConfig;
  readonly configPath: string;
  readonly configDirectory: string;
  readonly configDigest: string;
  readonly baseUrl: URL;
  readonly authHeaders: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
  readonly capabilities: {
    level: "chat-only" | "tool-aware" | "stateful";
    prepare: boolean;
    observation: boolean;
    cleanup: boolean;
    tool_events: boolean;
  };
  readonly warnings: readonly string[];
}

export interface Diagnostic {
  readonly level: "ok" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface InspectConfigOptions {
  readonly configPath?: string;
  readonly cwd?: string;
  readonly processEnv?: Readonly<NodeJS.ProcessEnv>;
}

export interface ConfigInspection {
  readonly diagnostics: readonly Diagnostic[];
  readonly resolvedConfig?: ResolvedConfig;
}
