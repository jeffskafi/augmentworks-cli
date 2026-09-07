import { Command } from "commander";

import { getApiOrigin } from "../auth/api-origin.js";
import type { AuthIdentity } from "../auth/types.js";
import {
  billingPortalUnsupportedError,
  profileRecoveryError,
  profileRecoveryUrl,
  workspaceMismatchError
} from "../billing/errors.js";
import { billingSuccessJson, formatBillingHuman } from "../billing/format.js";
import type { BillingUsage } from "../billing/protocol.js";
import { BILLING_PORTAL_LINK_V1, capabilityIsAvailable } from "../billing/protocol.js";
import { assertSafeBillingPageUrl } from "../billing/validate.js";
import { AwError, exitCodeFor, sanitizeTerminal } from "../errors.js";
import { openBrowserUrl, type BrowserOpener } from "../system/browser.js";
import {
  authenticateHostedSession,
  type HostedAuthDependencies
} from "./hosted-auth.js";
import {
  runUsage,
  type UsageDependencies,
  type UsageOptions
} from "./usage.js";

export interface BillingOptions extends UsageOptions {
  readonly print?: boolean;
  readonly open?: boolean;
}

export interface BillingDependencies extends UsageDependencies {
  readonly openBrowser?: BrowserOpener;
  readonly isTty?: () => boolean;
}

export interface BillingResult {
  readonly identity: AuthIdentity;
  readonly usage: BillingUsage;
  readonly apiOrigin: URL;
  readonly billingPageUrl: URL;
  readonly openedBrowser: boolean;
}

export async function runBilling(
  options: BillingOptions = {},
  dependencies: BillingDependencies = {}
): Promise<BillingResult> {
  const result = await runUsage(options, dependencies);
  const identity = await confirmBillingIdentity(result.identity, result.usage.workspaceId, options, dependencies);
  if (!capabilityIsAvailable(result.usage.capabilities, BILLING_PORTAL_LINK_V1)) {
    throw billingPortalUnsupportedError();
  }
  const billingPageUrl = assertSafeBillingPageUrl(
    result.usage.billingPageUrl,
    result.apiOrigin,
    identity.workspaceId
  );
  const openedBrowser = await maybeOpenBillingPage(billingPageUrl, options, dependencies, result.apiOrigin);
  return { ...result, identity, billingPageUrl, openedBrowser };
}

export function createBillingCommand(dependencies: BillingDependencies = {}): Command {
  return new Command("billing")
    .description(
      "Open or print the first-party workspace billing page. Does not create subscriptions, cancellations, or collect payment methods"
    )
    .option("--json", "write one machine-readable billing navigation object to stdout without opening a browser")
    .option("--print", "print the first-party billing URL without opening a browser")
    .option("--open", "open the first-party billing page in a browser")
    .action(async (values: BillingOptions) => {
      const stdout = dependencies.stdout ?? console.log;
      const stderr = dependencies.stderr ?? console.error;
      const json = values.json === true;
      try {
        const result = await runBilling(values, dependencies);
        if (json) {
          stdout(billingSuccessJson(result).trimEnd());
        } else if (values.print === true) {
          stderr(
            "Open this first-party billing page in a signed-in browser. Opening it does not authorize payment."
          );
          stdout(sanitizeTerminal(result.billingPageUrl.toString()));
        } else {
          stdout(
            formatBillingHuman({
              usage: result.usage,
              workspaceLabel: result.identity.workspaceName ?? result.usage.workspaceId,
              billingPageUrl: result.billingPageUrl,
              openedBrowser: result.openedBrowser
            }).trimEnd()
          );
        }
      } catch (error) {
        const remapped = remapBillingRecovery(error, (dependencies.apiOrigin ?? getApiOrigin)(values.env ?? process.env));
        if (!json) throw remapped;
        const awError =
          remapped instanceof AwError
            ? remapped
            : new AwError({
                code: "INTERNAL",
                category: "local",
                message: "The billing command could not be completed."
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

async function maybeOpenBillingPage(
  url: URL,
  options: BillingOptions,
  dependencies: BillingDependencies,
  apiOrigin: URL
): Promise<boolean> {
  if (!shouldOpenBillingBrowser(options, dependencies)) return false;
  const opener =
    dependencies.openBrowser ?? ((value) => openBrowserUrl(value, [url.origin, apiOrigin.origin]));
  try {
    await opener(url);
    return true;
  } catch (cause) {
    if (!(cause instanceof AwError) || cause.code !== "BROWSER_OPEN_FAILED") throw cause;
    const stderr = dependencies.stderr ?? console.error;
    stderr(
      "The browser could not be opened. Open the printed first-party billing URL in a signed-in browser. Credentials were not changed, and no purchase was recorded."
    );
    return false;
  }
}

export function shouldOpenBillingBrowser(
  options: BillingOptions,
  dependencies: BillingDependencies = {}
): boolean {
  if (options.json === true || options.print === true) return false;
  if (options.open === true) return true;
  if ((options.env ?? process.env)["CI"] === "1") return false;
  const tty = dependencies.isTty ?? (() => process.stderr.isTTY === true);
  return tty();
}

async function confirmBillingIdentity(
  expected: AuthIdentity,
  usageWorkspaceId: string,
  options: BillingOptions,
  dependencies: BillingDependencies
): Promise<AuthIdentity> {
  const confirmed = await authenticateHostedSession(options, hostedAuthDependencies(dependencies));
  if (
    confirmed.identity.workspaceId !== expected.workspaceId ||
    confirmed.identity.connectorId !== expected.connectorId ||
    usageWorkspaceId !== confirmed.identity.workspaceId
  ) {
    throw workspaceMismatchError({
      authenticated_workspace: expected.workspaceId,
      confirmed_workspace: confirmed.identity.workspaceId
    });
  }
  return confirmed.identity;
}

function hostedAuthDependencies(dependencies: BillingDependencies): HostedAuthDependencies {
  return {
    ...(dependencies.apiOrigin === undefined ? {} : { apiOrigin: dependencies.apiOrigin }),
    ...(dependencies.accessToken === undefined ? {} : { accessToken: dependencies.accessToken }),
    ...(dependencies.identity === undefined ? {} : { identity: dependencies.identity }),
    ...(dependencies.cloud === undefined ? {} : { cloud: dependencies.cloud })
  };
}

function remapBillingRecovery(error: unknown, apiOrigin: URL): unknown {
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
