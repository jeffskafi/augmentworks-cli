const TARGET_PREFIXES = ["CHATBOT_", "AUGMENTWORKS_"] as const;

export function isolatedDemoEnv(options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly parent?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.parent ?? process.env) };
  for (const key of Object.keys(env)) {
    if (TARGET_PREFIXES.some((prefix) => key.startsWith(prefix))) delete env[key];
  }
  env["CHATBOT_BASE_URL"] = options.baseUrl;
  env["CHATBOT_API_KEY"] = options.token;
  env["NO_COLOR"] = "1";
  return env;
}
