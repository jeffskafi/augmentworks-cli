import { Command } from "commander";

import { getApiOrigin } from "../auth/api-origin.js";
import type { AuthIdentity } from "../auth/types.js";
import { profileRecoveryError, profileRecoveryUrl } from "../billing/errors.js";
import { formatUsageHuman, usageSuccessJson } from "../billing/format.js";
import type { BillingUsage } from "../billing/protocol.js";
import { assertSafeBillingPageUrl, assertUsageWorkspace } from "../billing/validate.js";
import { AwError, exitCodeFor, sanitizeTerminal } from "../errors.js";
import {
  authenticateHostedSession,
  type HostedAuthDependencies,
  type HostedAuthOptions,
  type HostedAuthSession
} from "./hosted-auth.js";

export interface UsageOptions extends HostedAuthOptions {
  readonly json?: boolean;
}

export interface UsageDependencies {
  readonly apiOrigin?: HostedAuthDependencies["apiOrigin"];
  readonly accessToken?: HostedAuthDependencies["accessToken"];
  readonly identity?: HostedAuthDependencies["identity"];
  readonly cloud?: HostedAuthDependencies["cloud"];
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
  readonly setExitCode?: (code: number) => void;
}

export interface UsageResult {
  readonly identity: AuthIdentity;
  readonly usage: BillingUsage;
  readonly apiOrigin: URL;
}

export async function runUsage(
  options: UsageOptions = {},
  dependencies: UsageDependencies = {}
): Promise<UsageResult> {
  const env = options.env ?? process.env;
  const recoveryOrigin = (dependencies.apiOrigin ?? getApiOrigin)(env);
  let session: HostedAuthSession;
  try {
    session = await authenticateHostedSession(options, hostedAuthDependencies(dependencies));
  } catch (error) {
    throw remapProfileRecovery(error, recoveryOrigin);
  }
  const signal = options.signal;
  try {
    if (signal === undefined) await session.cloud.getBillingCapabilities();
    else await session.cloud.getBillingCapabilities(signal);
  } catch (error) {
    throw remapProfileRecovery(error, session.apiOrigin);
  }
  let usage: BillingUsage;
  try {
    usage =
      signal === undefined
        ? await session.cloud.getBillingUsage()
        : await session.cloud.getBillingUsage(signal);
  } catch (error) {
    throw remapProfileRecovery(error, session.apiOrigin);
  }
  assertUsageWorkspace(usage, session.identity.workspaceId);
  assertSafeBillingPageUrl(usage.billingPageUrl, session.apiOrigin);
  return { identity: session.identity, usage, apiOrigin: session.apiOrigin };
}

export function createUsageCommand(dependencies: UsageDependencies = {}): Command {
  return new Command("usage")
    .description("Show authenticated workspace execution-credit usage")
    .option("--json", "write one machine-readable usage object to stdout")
    .action(async (values: UsageOptions) => {
      const stdout = dependencies.stdout ?? console.log;
      const json = values.json === true;
      try {
        const result = await runUsage(values, dependencies);
        if (json) {
          stdout(usageSuccessJson(result.usage).trimEnd());
        } else {
          stdout(
            formatUsageHuman({
              usage: result.usage,
              workspaceLabel: result.identity.workspaceName ?? result.usage.workspaceId,
              apiOrigin: result.apiOrigin
            }).trimEnd()
          );
        }
      } catch (error) {
        if (!json) throw error;
        const awError =
          error instanceof AwError
            ? error
            : new AwError({
                code: "INTERNAL",
                category: "local",
                message: "The usage command could not be completed."
              });
        stdout(
          JSON.stringify({
            ok: false,
            ...awError.toSafeJSON(),
            exit_code: exitCodeFor(awError)
          })
        );
        (dependencies.setExitCode ?? ((code) => {
          process.exitCode = code;
        }))(exitCodeFor(awError));
      }
    });
}

function hostedAuthDependencies(dependencies: UsageDependencies): HostedAuthDependencies {
  return {
    ...(dependencies.apiOrigin === undefined ? {} : { apiOrigin: dependencies.apiOrigin }),
    ...(dependencies.accessToken === undefined ? {} : { accessToken: dependencies.accessToken }),
    ...(dependencies.identity === undefined ? {} : { identity: dependencies.identity }),
    ...(dependencies.cloud === undefined ? {} : { cloud: dependencies.cloud })
  };
}

function remapProfileRecovery(error: unknown, apiOrigin: URL): unknown {
  if (!(error instanceof AwError)) return error;
  if (error.code === "BILLING_UNPROVISIONED" || error.code === "PROFILE_RECOVERY_REQUIRED") {
    return error;
  }
  const haystack = `${error.code} ${error.message}`.toLowerCase();
  if (
    haystack.includes("profile") &&
    (error.code === "AUTH_RESPONSE_ERROR" || error.category === "auth")
  ) {
    return profileRecoveryError(profileRecoveryUrl(apiOrigin), error.details);
  }
  return error;
}

export function sanitizeUsageText(value: string): string {
  return sanitizeTerminal(value);
}
