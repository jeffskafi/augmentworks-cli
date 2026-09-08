import { resolve } from "node:path";

import { Command } from "commander";

import type { AccessTokenProvider, AuthIdentity } from "../auth/types.js";
import {
  RELAY_PROTOCOL_VERSION,
  type CreateRunRequest,
  type CreateRunResponse,
  type RunStatusResponse
} from "../cloud/protocol.js";
import {
  advertisedTargetCapabilities,
  assertConversationSupportsPacket
} from "../config/conversation.js";
import type { ResolvedConfig } from "../config/types.js";
import { targetBoundarySha256 } from "../config/boundary.js";
import { HttpConnector } from "../connector/http.js";
import { AwError, EXIT, exitCodeFor, sanitizeTerminal } from "../errors.js";
import { classifyHostedOutcome } from "../outcome/classify.js";
import {
  loadAssessmentFile,
  packetRequiresMultiTurn,
  type LoadedAssessment
} from "../assessment/index.js";
import {
  loadCustomerSuiteFile,
  assertSuiteUnchanged,
  type LoadedCustomerSuite
} from "../suite/load.js";
import { suiteCreateFields, suitePacketBinding, type SuiteRevisionPin } from "../suite/admit.js";
import { suiteError } from "../suite/errors.js";
import { suiteRequiresMultiTurn, suiteRequiresObservation } from "../suite/schema.js";
import {
  loadInvestigationFile,
  type LoadedInvestigation
} from "../investigation/load.js";
import { evaluateInvestigationPrerequisites } from "../investigation/prerequisites.js";
import { missingReproductionPrerequisitesError, crossWorkspaceInvestigationError } from "../investigation/errors.js";
import { resolvePinnedInvestigationSelection } from "../investigation/pin.js";
import {
  assertCeilingCoversQuote,
  confirmSpending,
  parseMaxCreditsFlag,
  resolveSpendingCeiling
} from "../billing/consent.js";
import { annotateInsufficientCredits, quoteUnsupportedError } from "../billing/errors.js";
import { estimateSuccessJson, formatEstimateHuman, formatQuoteBreakdown } from "../billing/format.js";
import type { BillingQuote } from "../billing/protocol.js";
import {
  assessmentCreateFields,
  buildBillingQuoteRequest,
  primaryAssessmentPacket,
  quotedCreateIntent
} from "../billing/quote-request.js";
import { assertQuoteCapability, assertQuoteWorkspace, firstPartyBillingPageUrl } from "../billing/validate.js";
import {
  prepareCreateAttempt,
  releaseTerminalIfSafe,
  settleCreateFailure,
  type RecoveryContext
} from "../relay/recovery.js";
import {
  RunIntentStore,
  intentRequestMatches,
  type CreateRunIntentRequest,
  type RunIntent
} from "../relay/run-intent.js";
import { RelayRunner, type RelayProgressEvent } from "../relay/runner.js";
import { getStateDirectory } from "../relay/state-dir.js";
import { assertAllowedBrowserUrl, openBrowserUrl, type BrowserOpener } from "../system/browser.js";
import { HOSTED_TEST_KEEP_TERMINAL } from "../release.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import {
  assertMachineHostedAdmission,
  authenticateHostedSession,
  isHeadlessEnvironment,
  type HostedAuthDependencies
} from "./hosted-auth.js";
import {
  formatLocalTestHuman,
  formatLocalTestJson,
  localExitCode,
  runLocalTest,
  type LocalTestDependencies
} from "./local-test.js";

export interface TestOptions {
  readonly config?: string;
  readonly packet?: string;
  readonly assessment?: string;
  readonly suite?: string;
  readonly investigation?: string;
  readonly profile?: string;
  readonly open?: boolean;
  readonly json?: boolean;
  readonly estimate?: boolean;
  readonly maxCredits?: string;
  readonly yes?: boolean;
  readonly headless?: boolean;
  readonly allowFileCredentials?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDirectory?: string;
  readonly signal?: AbortSignal;
  readonly handleSignals?: boolean;
}

export interface TestResult {
  readonly binding: CreateRunResponse;
  readonly run: RunStatusResponse;
}

export interface EstimateResult {
  readonly quote: BillingQuote;
  readonly localPlanHash: string;
  readonly workspaceLabel: string;
  readonly advertisedCapabilities: CreateRunRequest["target"]["capabilities"];
}

export interface SignalHost {
  on(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
  exit(code: number): never;
}

export interface TestDependencies extends HostedAuthDependencies {
  readonly doctor?: (options: Parameters<typeof runDoctor>[0]) => Promise<DoctorReport>;
  readonly connector?: (config: ResolvedConfig) => HttpConnector;
  readonly runner?: (options: ConstructorParameters<typeof RelayRunner>[0]) => RelayRunner;
  readonly intentStore?: (
    options: ConstructorParameters<typeof RunIntentStore>[0]
  ) => RunIntentStore;
  readonly openBrowser?: BrowserOpener;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly signals?: SignalHost;
  readonly setExitCode?: (code: number) => void;
  readonly onProgress?: (event: RelayProgressEvent) => void;
  readonly local?: LocalTestDependencies;
  readonly isInteractive?: () => boolean;
  readonly confirm?: (prompt: string) => Promise<boolean>;
}

export async function runTest(
  options: TestOptions,
  dependencies: TestDependencies = {}
): Promise<TestResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const config = options.config ?? "augmentworks.yaml";
  const doctor = dependencies.doctor ?? runDoctor;
  const report = await doctor({ config, cwd, processEnv: env, offline: true });
  if (!report.ok || report.resolvedConfig === undefined) {
    const error = report.diagnostics.find((diagnostic) => diagnostic.level === "error");
    throw new AwError({
      code: error?.code ?? "DOCTOR_FAILED",
      category: "config",
      message: error?.message ?? "Doctor found configuration errors."
    });
  }

  const selection = await loadHostedSelection(options, cwd, report.resolvedConfig);
  const maxCredits = parseMaxCreditsFlag(options.maxCredits);
  const interactive = (dependencies.isInteractive ?? (() => defaultInteractive(env, options)))();
  if (
    (selection.kind === "suite" || selection.kind === "investigation") &&
    maxCredits === undefined &&
    (options.yes === true || !interactive)
  ) {
    throw new AwError({
      code: "MAX_CREDITS_REQUIRED",
      category: "config",
      message:
        options.yes === true
          ? "--yes is not an unlimited spending budget. Pass --max-credits N with a finite nonnegative integer before a hosted assessment."
          : "Noninteractive hosted tests require --max-credits N. The CLI will not start billed work without an explicit ceiling."
    });
  }
  const session = await authenticateHostedSession(options, dependencies);
  assertMachineHostedAdmission(session.identity, { suite: selection.kind === "suite" });
  const target = hostedTargetBinding(report.resolvedConfig);
  const stderr = dependencies.stderr ?? process.stderr;
  const stateDirectory = options.stateDirectory ?? getStateDirectory(env);
  const intentStore =
    dependencies.intentStore?.({
      apiOrigin: session.apiOrigin,
      tenant: session.tenant,
      stateDirectory,
      env
    }) ??
    new RunIntentStore({
      apiOrigin: session.apiOrigin,
      tenant: session.tenant,
      stateDirectory,
      env
    });
  await intentStore.open();
  try {
    await intentStore.migrateLegacyTenantBinding(async (legacyBinding) => {
      const status = await session.cloud.getRunStatus(legacyBinding.run_id, options.signal);
      return status.run_id === legacyBinding.run_id;
    });
    const recovery: RecoveryContext = {
      cloud: session.cloud,
      intentStore,
      tenant: session.tenant,
      stateDirectory,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    };
    const resolved = await resolveHostedCreateRequest({
      selection,
      configSha256: report.resolvedConfig.configDigest,
      target,
      existing: intentStore.intent,
      maxCredits,
      yes: options.yes === true,
      session,
      stderr,
      workspaceLabel: session.identity.workspaceName ?? session.identity.workspaceId,
      interactive,
      cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(dependencies.confirm === undefined ? {} : { confirm: dependencies.confirm })
    });
    const request = resolved.request;
    let prepared;
    let binding: CreateRunResponse;
    try {
      prepared = await prepareCreateAttempt(recovery, request);
      if (prepared.kind === "resume_bound") {
        binding = prepared.binding;
      } else {
        const loaded =
          prepared.kind === "replay_pending"
            ? { intent: prepared.intent, resumed: true }
            : await intentStore.loadOrCreate(request);
        binding = await createOrRecover(recovery, loaded.intent, options.signal);
      }
    } catch (error) {
      throw annotateHostedAdmissionError(error, {
        apiOrigin: session.apiOrigin,
        workspaceId: session.identity.workspaceId,
        ...(resolved.quote === undefined ? {} : { quote: resolved.quote })
      });
    }
    assertRunBinding(binding, intentStore.intent?.request ?? { ...request, create_request_id: binding.create_request_id });
    if (intentStore.intent?.phase !== "bound") {
      await intentStore.bind(binding);
    }

    const dashboard = dashboardUrl(binding.dashboard_url, session.apiOrigin);
    writeLine(
      stderr,
      `${prepared.kind === "resume_bound" || prepared.kind === "replay_pending" ? "Resuming" : "Run"} ${sanitizeTerminal(binding.run_id)}: ${sanitizeTerminal(dashboard.toString())}`
    );
    writeLine(stderr, HOSTED_TEST_KEEP_TERMINAL);
    if (options.open === true && isHeadlessEnvironment(env, options)) {
      writeLine(stderr, "Headless mode does not open a browser.");
    } else if (options.open === true) {
      try {
        await (dependencies.openBrowser ?? ((url) => openBrowserUrl(url, [session.apiOrigin.origin])))(
          dashboard
        );
      } catch (error) {
        if (!(error instanceof AwError) || error.code !== "BROWSER_OPEN_FAILED") throw error;
        writeLine(stderr, "The dashboard could not be opened automatically; use the URL above.");
      }
    }

    if (isTerminal(binding.status)) {
      const run = await session.cloud.getRunStatus(binding.run_id, options.signal);
      await releaseTerminalIfSafe(recovery, binding, run);
      return { binding, run };
    }

    const connector =
      dependencies.connector?.(report.resolvedConfig) ?? new HttpConnector(report.resolvedConfig);
    const progress =
      dependencies.onProgress ??
      (options.json === true
        ? undefined
        : (event: RelayProgressEvent) => writeProgress(stderr, event));
    const runnerOptions: ConstructorParameters<typeof RelayRunner>[0] = {
      cloud: session.cloud,
      connector,
      binding,
      stateDirectory,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(progress === undefined ? {} : { onProgress: progress })
    };
    const runner = dependencies.runner?.(runnerOptions) ?? new RelayRunner(runnerOptions);
    const removeSignals =
      options.handleSignals === false
        ? () => undefined
        : installRelayInterruptHandler(runner, {
            host: dependencies.signals ?? (process as SignalHost),
            stderr
          });
    try {
      const run = await runner.run();
      await releaseTerminalIfSafe(recovery, binding, run);
      return { binding, run };
    } finally {
      removeSignals();
    }
  } finally {
    await intentStore.close();
  }
}

async function createOrRecover(
  recovery: RecoveryContext,
  intent: RunIntent,
  signal?: AbortSignal
): Promise<CreateRunResponse> {
  try {
    return await recovery.cloud.createRun(intent.request, signal);
  } catch (error) {
    return await settleCreateFailure(recovery, intent, error);
  }
}

export async function runEstimate(
  options: TestOptions,
  dependencies: TestDependencies = {}
): Promise<EstimateResult> {
  if (options.assessment === undefined && options.suite === undefined && options.investigation === undefined) {
    throw new AwError({
      code: "ESTIMATE_REQUIRES_ASSESSMENT",
      category: "config",
      message: "test --estimate requires --assessment, --suite, or --investigation. Packet-only hosted tests do not use quotes."
    });
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const config = options.config ?? "augmentworks.yaml";
  const doctor = dependencies.doctor ?? runDoctor;
  const report = await doctor({ config, cwd, processEnv: env, offline: true });
  if (!report.ok || report.resolvedConfig === undefined) {
    const error = report.diagnostics.find((diagnostic) => diagnostic.level === "error");
    throw new AwError({
      code: error?.code ?? "DOCTOR_FAILED",
      category: "config",
      message: error?.message ?? "Doctor found configuration errors."
    });
  }
  const selection = await loadHostedSelection(options, cwd, report.resolvedConfig);
  const session = await authenticateHostedSession(options, dependencies);
  assertMachineHostedAdmission(session.identity, { suite: selection.kind === "suite" });
  const target = hostedTargetBinding(report.resolvedConfig);
  const prepared = await prepareQuotedAssessment({
    selection,
    session,
    cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  const quote = await requestHostedQuote({
    session,
    assessment: prepared.assessment,
    packet: selection.packet,
    configSha256: report.resolvedConfig.configDigest,
    target,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  return {
    quote,
    localPlanHash: prepared.localPlanHash,
    workspaceLabel: session.identity.workspaceName ?? session.identity.workspaceId,
    advertisedCapabilities: target.capabilities
  };
}

type HostedSelection =
  | {
      readonly kind: "packet";
      readonly packet: { key: string; version: string };
      readonly assessment?: undefined;
      readonly suite?: undefined;
      readonly investigation?: undefined;
    }
  | {
      readonly kind: "assessment";
      readonly packet: { key: string; version: string };
      readonly assessment: LoadedAssessment;
      readonly suite?: undefined;
      readonly investigation?: undefined;
    }
  | {
      readonly kind: "suite";
      readonly packet: { key: string; version: string };
      readonly assessment?: undefined;
      readonly suite: LoadedCustomerSuite;
      readonly investigation?: undefined;
    }
  | {
      readonly kind: "investigation";
      readonly packet: { key: string; version: string };
      readonly assessment?: undefined;
      readonly suite?: undefined;
      readonly investigation: LoadedInvestigation;
    };

async function loadHostedSelection(
  options: TestOptions,
  cwd: string,
  resolved: ResolvedConfig
): Promise<HostedSelection> {
  if (options.investigation !== undefined) {
    const investigation = await loadInvestigationFile(options.investigation, cwd);
    const prerequisites = evaluateInvestigationPrerequisites(investigation.document, resolved);
    if (!prerequisites.readyForPaidExecution) {
      throw missingReproductionPrerequisitesError(prerequisites.blocking.map((finding) => finding.message));
    }
    const sessionRequired = investigation.document.prerequisites.mapping?.session === true;
    assertConversationSupportsPacket({
      resolved,
      packetRequiresMultiTurn: sessionRequired,
      packetLabel: `investigation case ${investigation.document.identities.caseId}`
    });
    return { kind: "investigation", packet: suitePacketBinding(), investigation };
  }
  if (options.suite !== undefined) {
    const suite = await loadCustomerSuiteFile(options.suite, cwd);
    assertConversationSupportsPacket({
      resolved,
      packetRequiresMultiTurn: suiteRequiresMultiTurn(suite.document),
      packetLabel: `suite ${suite.document.suiteId}`
    });
    if (suiteRequiresObservation(suite.document) && !resolved.capabilities.observation) {
      throw suiteError(
        "SUITE_OBSERVATION_INCOMPATIBLE",
        `Suite ${suite.document.suiteId} requires deterministic observations, but this connector does not advertise observation. Configure target.operations.observe. No quote, reservation, or run was created.`
      );
    }
    return { kind: "suite", packet: suitePacketBinding(), suite };
  }
  if (options.assessment !== undefined) {
    const assessment = await loadAssessmentFile({
      path: options.assessment,
      cwd,
      ...(options.profile === undefined ? {} : { profile: options.profile })
    });
    const packet = primaryAssessmentPacket(assessment);
    await assertHostedConversationAdmission(resolved, packet);
    return { kind: "assessment", packet, assessment };
  }
  const packet = parsePacketReference(requirePacket(options.packet));
  await assertHostedConversationAdmission(resolved, packet);
  return { kind: "packet", packet };
}

async function pinCustomerSuite(options: {
  readonly suite: LoadedCustomerSuite;
  readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}): Promise<{
  assessment: import("../cloud/protocol.js").CreateRunAssessment;
  localPlanHash: string;
  pin: SuiteRevisionPin;
}> {
  const created = await options.session.cloud.createSuiteRevision(
    {
      contentHash: options.suite.contentHash,
      document: options.suite.canonicalDocument
    },
    options.signal
  );
  if (created.contentHash !== options.suite.contentHash) {
    throw suiteError(
      "SUITE_REVISION_HASH_MISMATCH",
      "The server-accepted suite content hash does not match the locally validated file. Admission will not pin a different revision.",
      { localHash: options.suite.contentHash, serverHash: created.contentHash }
    );
  }
  const current = await loadCustomerSuiteFile(options.suite.sourcePath, options.cwd);
  assertSuiteUnchanged(options.suite, current);
  const pin: SuiteRevisionPin = {
    suiteId: created.suiteId,
    revisionId: created.revisionId,
    contentHash: created.contentHash
  };
  return {
    assessment: suiteCreateFields(options.suite, pin),
    localPlanHash: options.suite.contentHash,
    pin
  };
}

async function pinInvestigationCase(options: {
  readonly investigation: LoadedInvestigation;
  readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}): Promise<{
  assessment: import("../cloud/protocol.js").CreateRunAssessment;
  localPlanHash: string;
}> {
  if (options.investigation.document.workspaceId !== options.session.identity.workspaceId) {
    throw crossWorkspaceInvestigationError();
  }
  const pinned = await resolvePinnedInvestigationSelection({
    document: options.investigation.document,
    cloud: options.session.cloud,
    cwd: options.cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  return {
    assessment: pinned.assessment,
    localPlanHash: options.investigation.document.identities.suiteContentHash
  };
}

async function prepareQuotedAssessment(options: {
  readonly selection: HostedSelection;
  readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}): Promise<{
  assessment: import("../cloud/protocol.js").CreateRunAssessment;
  localPlanHash: string;
}> {
  if (options.selection.kind === "assessment") {
    return {
      assessment: assessmentCreateFields(options.selection.assessment),
      localPlanHash: options.selection.assessment.freezeSha256
    };
  }
  if (options.selection.kind === "investigation") {
    return pinInvestigationCase({
      investigation: options.selection.investigation,
      session: options.session,
      cwd: options.cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  }
  if (options.selection.kind !== "suite") {
    throw new AwError({
      code: "ESTIMATE_REQUIRES_ASSESSMENT",
      category: "config",
      message: "Quoted hosted tests require --assessment, --suite, or --investigation."
    });
  }
  const pinned = await pinCustomerSuite({
    suite: options.selection.suite,
    session: options.session,
    cwd: options.cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  return { assessment: pinned.assessment, localPlanHash: pinned.localPlanHash };
}

async function resolveHostedCreateRequest(options: {
  readonly selection: HostedSelection;
  readonly configSha256: string;
  readonly target: CreateRunRequest["target"];
  readonly existing: RunIntent | undefined;
  readonly maxCredits: number | undefined;
  readonly yes: boolean;
  readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  readonly signal?: AbortSignal;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly workspaceLabel: string;
  readonly interactive: boolean;
  readonly cwd: string;
  readonly confirm?: (prompt: string) => Promise<boolean>;
}): Promise<{ request: CreateRunIntentRequest; quote?: BillingQuote }> {
  if (options.selection.kind === "packet") {
    return {
      request: {
        protocol_version: RELAY_PROTOCOL_VERSION,
        packet: options.selection.packet,
        config_sha256: options.configSha256,
        target: options.target
      }
    };
  }

  const assessmentFields =
    options.selection.kind === "assessment"
      ? assessmentCreateFields(options.selection.assessment)
      : undefined;
  const existing = options.existing?.request;
  if (assessmentFields !== undefined && existing?.protocol_version === "aw-relay/0.3") {
    const replayCeiling = options.maxCredits ?? existing.max_credits;
    const candidate = quotedCreateIntent({
      packet: options.selection.packet,
      configSha256: options.configSha256,
      target: options.target,
      assessment: assessmentFields,
      quoteId: existing.quote_id,
      ...(replayCeiling === undefined ? {} : { maxCredits: replayCeiling })
    });
    if (options.existing !== undefined && intentRequestMatches(options.existing, candidate)) {
      return { request: candidate };
    }
  }
  if (options.maxCredits === undefined && (options.yes || !options.interactive)) {
    throw new AwError({
      code: "MAX_CREDITS_REQUIRED",
      category: "config",
      message: options.yes
        ? "--yes is not an unlimited spending budget. Pass --max-credits N with a finite nonnegative integer before a hosted assessment."
        : "Noninteractive hosted tests require --max-credits N. The CLI will not start billed work without an explicit ceiling."
    });
  }

  const prepared =
    options.selection.kind === "suite"
      ? await pinCustomerSuite({
          suite: options.selection.suite,
          session: options.session,
          cwd: options.cwd,
          ...(options.signal === undefined ? {} : { signal: options.signal })
        })
      : options.selection.kind === "investigation"
        ? await pinInvestigationCase({
            investigation: options.selection.investigation,
            session: options.session,
            cwd: options.cwd,
            ...(options.signal === undefined ? {} : { signal: options.signal })
          })
        : {
            assessment: assessmentFields!,
            localPlanHash: options.selection.assessment.freezeSha256
          };

  const quote = await requestHostedQuote({
    session: options.session,
    assessment: prepared.assessment,
    packet: options.selection.packet,
    configSha256: options.configSha256,
    target: options.target,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  if (options.selection.kind === "suite") {
    const current = await loadCustomerSuiteFile(options.selection.suite.sourcePath, options.cwd);
    assertSuiteUnchanged(options.selection.suite, current);
  }
  if (options.selection.kind === "investigation") {
    const confirmedPin = await resolvePinnedInvestigationSelection({
      document: options.selection.investigation.document,
      cloud: options.session.cloud,
      cwd: options.cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    if (
      confirmedPin.pin.revisionId !== options.selection.investigation.document.identities.suiteRevisionId ||
      confirmedPin.caseId !== options.selection.investigation.document.identities.caseId ||
      confirmedPin.pin.contentHash !== options.selection.investigation.document.identities.suiteContentHash
    ) {
      throw suiteError(
        "PINNED_REVISION_UNAVAILABLE",
        "The pinned suite revision changed after the quote. Reproduction will not silently select another revision or reuse the quote."
      );
    }
    writeLine(
      options.stderr,
      `Reproducing pinned case ${sanitizeTerminal(options.selection.investigation.document.identities.caseId)} at suite revision ${sanitizeTerminal(options.selection.investigation.document.identities.suiteRevisionId)}. This is a new quoted run. The original investigation run is unchanged.`
    );
  }
  const ceiling = resolveSpendingCeiling({
    quote,
    maxCredits: options.maxCredits,
    yes: options.yes,
    interactive: options.interactive
  });
  assertCeilingCoversQuote(ceiling, quote);
  writeConsentExplanation(options.stderr, {
    quote,
    workspaceLabel: options.workspaceLabel,
    maxCredits: ceiling
  });
  if (!options.yes) {
    if (!options.interactive) {
      throw new AwError({
        code: "MAX_CREDITS_REQUIRED",
        category: "config",
        message:
          "Noninteractive hosted tests require --max-credits N. The CLI will not start billed work without an explicit ceiling."
      });
    }
    const prompt = `Start this hosted test using at most ${String(ceiling)} credits? [y/N] `;
    const confirmed =
      options.confirm === undefined
        ? await confirmSpending({
            prompt,
            stdin: process.stdin,
            stdout: process.stderr
          })
        : await options.confirm(prompt);
    if (!confirmed) {
      throw new AwError({
        code: "SPENDING_CONSENT_DECLINED",
        category: "billing",
        message: "Hosted test cancelled before admission. No run was created and no credits were reserved."
      });
    }
  }
  return {
    request: quotedCreateIntent({
      packet: options.selection.packet,
      configSha256: options.configSha256,
      target: options.target,
      assessment: prepared.assessment,
      quoteId: quote.quoteId,
      maxCredits: ceiling
    }),
    quote
  };
}

async function requestHostedQuote(options: {
  readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  readonly assessment: import("../cloud/protocol.js").CreateRunAssessment;
  readonly packet: { key: string; version: string };
  readonly configSha256: string;
  readonly target: CreateRunRequest["target"];
  readonly signal?: AbortSignal;
}): Promise<BillingQuote> {
  let capabilities;
  try {
    capabilities =
      options.signal === undefined
        ? await options.session.cloud.getBillingCapabilities()
        : await options.session.cloud.getBillingCapabilities(options.signal);
  } catch (error) {
    if (error instanceof AwError && error.code === "USAGE_UNSUPPORTED") {
      throw quoteUnsupportedError(error.details);
    }
    throw error;
  }
  assertQuoteCapability(capabilities.capabilities);
  const quote = await options.session.cloud.createBillingQuote(
    buildBillingQuoteRequest({
      packet: options.packet,
      configSha256: options.configSha256,
      target: options.target,
      assessment: options.assessment
    }),
    options.signal
  );
  assertQuoteWorkspace(quote, options.session.identity.workspaceId);
  return quote;
}

function hostedTargetBinding(resolved: ResolvedConfig): CreateRunRequest["target"] {
  return {
    name: resolved.config.target.name,
    boundary_sha256: targetBoundarySha256(resolved),
    capabilities: advertisedTargetCapabilities(resolved)
  };
}

async function assertHostedConversationAdmission(
  resolved: ResolvedConfig,
  packet: { key: string; version: string }
): Promise<void> {
  const requiresMultiTurn = await packetRequiresMultiTurn(packet.key, packet.version);
  assertConversationSupportsPacket({
    resolved,
    packetRequiresMultiTurn: requiresMultiTurn,
    packetLabel: `${packet.key}@${packet.version}`
  });
}

function writeConsentExplanation(
  stderr: Pick<NodeJS.WriteStream, "write">,
  input: { quote: BillingQuote; workspaceLabel: string; maxCredits: number }
): void {
  const remaining =
    input.quote.availableUnitsAtQuote >= input.quote.executionUnits
      ? input.quote.availableUnitsAtQuote - input.quote.executionUnits
      : 0;
  writeLine(stderr, `Workspace: ${sanitizeTerminal(input.workspaceLabel)}`);
  writeLine(stderr, `Quoted credits: ${String(input.quote.executionUnits)}`);
  const breakdown = formatQuoteBreakdown(input.quote);
  if (breakdown !== undefined) writeLine(stderr, breakdown);
  writeLine(
    stderr,
    `Available credits at quote: ${String(input.quote.availableUnitsAtQuote)} (snapshot, not a hold)`
  );
  writeLine(stderr, `Estimated remaining: ${String(remaining)} (estimate only)`);
  writeLine(stderr, `Spending ceiling for this run: ${String(input.maxCredits)}`);
  writeLine(
    stderr,
    "AugmentWorks grading is included in standard credits. Your target provider may have separate costs."
  );
  writeLine(
    stderr,
    "This quote is not a reservation. Another run may use credits before this assessment starts."
  );
}

function defaultInteractive(
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly headless?: boolean } = {}
): boolean {
  if (isHeadlessEnvironment(env, options)) return false;
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

function annotateHostedAdmissionError(
  error: unknown,
  options: {
    readonly quote?: BillingQuote;
    readonly apiOrigin: URL;
    readonly workspaceId: string;
  }
): unknown {
  if (!(error instanceof AwError) || error.code !== "INSUFFICIENT_CREDITS") return error;
  let billingPageUrl: string | undefined;
  try {
    billingPageUrl = firstPartyBillingPageUrl(options.apiOrigin, options.workspaceId).toString();
  } catch {
    billingPageUrl = undefined;
  }
  return annotateInsufficientCredits(error, {
    ...(options.quote === undefined
      ? {}
      : { requiredUnits: options.quote.executionUnits, availableUnits: options.quote.availableUnitsAtQuote }),
    ...(billingPageUrl === undefined ? {} : { billingPageUrl })
  });
}

export function createTestCommand(dependencies: TestDependencies = {}): Command {
  return new Command("test")
    .description("Run a deterministic hosted or customer-executed local assessment")
    .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
    .option(
      "--packet <reference>",
      "hosted key@version, or a bundled/local JSON packet with --local"
    )
    .option(
      "--assessment <path>",
      "hosted assessment file (quoted aw-relay/0.3 on source 0.3.3; published 0.3.2 uses aw-relay/0.2)"
    )
    .option(
      "--suite <path>",
      "customer-owned hosted suite file (aw-suite/1). Admission uses the server-accepted revision, not a later file edit"
    )
    .option(
      "--investigation <path>",
      "reproduce the exact pinned case from an aw-investigation-export/1 file. Uses a new quote; never selects latest or reuses a consumed quote"
    )
    .option("--profile <profile>", "quick, full, combined, or custom")
    .option("--estimate", "compile and quote the hosted assessment without creating a run")
    .option("--max-credits <n>", "explicit maximum customer credits for this hosted run")
    .option("--yes", "skip the interactive spending prompt; still requires --max-credits")
    .option(
      "--headless",
      "explicit noninteractive hosted mode: require AUGMENTWORKS_API_KEY or AUGMENTWORKS_TOKEN, never load a keychain, and never open a browser"
    )
    .option("--local", "run entirely in the customer environment without AugmentWorks services")
    .option("--output-dir <path>", "fresh exact report directory for --local")
    .option("--open", "open the hosted dashboard or generated local HTML report")
    .option("--json", "emit the final run status as JSON")
    .option(
      "--allow-file-credentials",
      "allow a warned mode-0600 credential file when OS credential storage is unavailable"
    )
    .action(
      async (values: {
        config: string;
        packet?: string;
        assessment?: string;
        suite?: string;
        investigation?: string;
        profile?: string;
        estimate?: boolean;
        maxCredits?: string;
        yes?: boolean;
        headless?: boolean;
        local?: boolean;
        outputDir?: string;
        open?: boolean;
        json?: boolean;
        allowFileCredentials?: boolean;
      }) => {
        const stdout = dependencies.stdout ?? process.stdout;
        const stderr = dependencies.stderr ?? process.stderr;
        const setExitCode =
          dependencies.setExitCode ??
          ((code: number) => {
            process.exitCode = code;
          });
        assertTestSelection(values);
        if (values.local === true) {
          if (values.allowFileCredentials === true) {
            throw new AwError({
              code: "LOCAL_FILE_CREDENTIALS_UNSUPPORTED",
              category: "config",
              message:
                "--allow-file-credentials applies only to hosted AugmentWorks authentication and cannot be used with --local."
            });
          }
          const local = await runLocalTest(
            {
              config: values.config,
              packet: requirePacket(values.packet),
              ...(values.outputDir === undefined ? {} : { outputDirectory: values.outputDir }),
              ...(values.open === undefined ? {} : { open: values.open }),
              ...(values.json === undefined ? {} : { json: values.json })
            },
            {
              ...dependencies.local,
              stdout,
              stderr
            }
          );
          stdout.write(values.json === true ? formatLocalTestJson(local) : formatLocalTestHuman(local));
          const exitCode = localExitCode(local);
          if (exitCode !== EXIT.OK) setExitCode(exitCode);
          return;
        }
        if (values.outputDir !== undefined) {
          throw new AwError({
            code: "LOCAL_OUTPUT_REQUIRES_LOCAL_MODE",
            category: "config",
            message: "--output-dir can be used only with --local."
          });
        }
        if (values.estimate === true) {
          try {
            const estimate = await runEstimate(
              {
                config: values.config,
                ...(values.assessment === undefined ? {} : { assessment: values.assessment }),
                ...(values.suite === undefined ? {} : { suite: values.suite }),
                ...(values.investigation === undefined ? {} : { investigation: values.investigation }),
                ...(values.profile === undefined ? {} : { profile: values.profile }),
                ...(values.allowFileCredentials === undefined
                  ? {}
                  : { allowFileCredentials: values.allowFileCredentials }),
                ...(values.headless === undefined ? {} : { headless: values.headless })
              },
              dependencies
            );
            if (values.json === true) {
              const payload = JSON.parse(
                estimateSuccessJson({
                  quote: estimate.quote,
                  localPlanHash: estimate.localPlanHash
                })
              ) as Record<string, unknown>;
              payload["advertisedCapabilities"] = estimate.advertisedCapabilities;
              stdout.write(`${JSON.stringify(payload)}\n`);
            } else {
              stdout.write(
                `${formatEstimateHuman({
                  quote: estimate.quote,
                  workspaceLabel: estimate.workspaceLabel,
                  localPlanHash: estimate.localPlanHash
                }).trimEnd()}\n${formatAdvertisedConversation(estimate.advertisedCapabilities)}\n`
              );
            }
          } catch (error) {
            if (values.json !== true) throw error;
            const awError =
              error instanceof AwError
                ? error
                : new AwError({
                    code: "INTERNAL",
                    category: "local",
                    message: "The estimate command could not be completed."
                  });
            stdout.write(
              `${JSON.stringify({
                ok: false,
                ...awError.toSafeJSON(),
                exit_code: exitCodeFor(awError)
              })}\n`
            );
            setExitCode(exitCodeFor(awError));
          }
          return;
        }
        try {
          const result = await runTest(
            {
              config: values.config,
              ...(values.packet === undefined ? {} : { packet: values.packet }),
              ...(values.assessment === undefined ? {} : { assessment: values.assessment }),
              ...(values.suite === undefined ? {} : { suite: values.suite }),
              ...(values.investigation === undefined ? {} : { investigation: values.investigation }),
              ...(values.profile === undefined ? {} : { profile: values.profile }),
              ...(values.open === undefined ? {} : { open: values.open }),
              ...(values.json === undefined ? {} : { json: values.json }),
              ...(values.maxCredits === undefined ? {} : { maxCredits: values.maxCredits }),
              ...(values.yes === undefined ? {} : { yes: values.yes }),
              ...(values.allowFileCredentials === undefined
                ? {}
                : { allowFileCredentials: values.allowFileCredentials }),
              ...(values.headless === undefined ? {} : { headless: values.headless })
            },
            dependencies
          );
          if (values.json === true) {
            stdout.write(`${JSON.stringify(hostedJsonResult(result))}\n`);
          } else {
            writeHostedResult(stdout, result);
          }
          const exitCode = hostedExitCode(result.run);
          if (exitCode !== EXIT.OK) setExitCode(exitCode);
        } catch (error) {
          if (values.json !== true) throw error;
          const awError =
            error instanceof AwError
              ? error
              : new AwError({
                  code: "INTERNAL",
                  category: "local",
                  message: "The hosted test command could not be completed."
                });
          stdout.write(
            `${JSON.stringify({
              ok: false,
              ...awError.toSafeJSON(),
              exit_code: exitCodeFor(awError)
            })}\n`
          );
          setExitCode(exitCodeFor(awError));
        }
      }
    );
}

export function installRelayInterruptHandler(
  runner: Pick<RelayRunner, "requestCancellation">,
  options: { host: SignalHost; stderr: Pick<NodeJS.WriteStream, "write"> }
): () => void {
  let count = 0;
  const listener = () => {
    count += 1;
    if (count >= 2) options.host.exit(EXIT.INTERRUPTED);
    writeLine(
      options.stderr,
      "Cancellation requested; draining cleanup. Press Ctrl+C again to exit now."
    );
    void runner.requestCancellation("sigint").catch((error: unknown) => {
      const message =
        error instanceof AwError ? error.message : "Could not send cancellation to AugmentWorks.";
      writeLine(options.stderr, message);
    });
  };
  options.host.on("SIGINT", listener);
  return () => {
    options.host.off("SIGINT", listener);
  };
}

export function parsePacketReference(value: string): {
  key: string;
  version: string;
} {
  const match =
    /^([A-Za-z0-9][A-Za-z0-9._:/-]{0,159})@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(
      value.trim()
    );
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new AwError({
      code: "INVALID_PACKET_REFERENCE",
      category: "config",
      message: "Packet must use the form key@version, for example support-refunds@0.1.0."
    });
  }
  return { key: match[1], version: match[2] };
}

export function hostedExitCode(run: RunStatusResponse): number {
  return classifyHostedOutcome({
    executionStatus: run.status,
    evaluationStatus: run.evaluation_status,
    outcome: run.outcome ?? null
  }).exitCode;
}

function assertTestSelection(values: {
  packet?: string;
  assessment?: string;
  suite?: string;
  investigation?: string;
  profile?: string;
  local?: boolean;
  estimate?: boolean;
  maxCredits?: string;
  yes?: boolean;
  headless?: boolean;
}): void {
  if (values.estimate === true && values.local === true) {
    throw new AwError({
      code: "ESTIMATE_LOCAL_UNSUPPORTED",
      category: "config",
      message: "--estimate cannot be used with --local. Local tests make no billing calls."
    });
  }
  if (values.maxCredits !== undefined && values.local === true) {
    throw new AwError({
      code: "MAX_CREDITS_LOCAL_UNSUPPORTED",
      category: "config",
      message: "--max-credits applies only to hosted tests."
    });
  }
  if (
    values.maxCredits !== undefined &&
    values.assessment === undefined &&
    values.suite === undefined &&
    values.investigation === undefined
  ) {
    throw new AwError({
      code: "MAX_CREDITS_REQUIRES_ASSESSMENT",
      category: "config",
      message:
        "--max-credits applies to quoted hosted assessments, suites, and investigation reproductions. Packet-only tests do not send a spending ceiling."
    });
  }
  if (values.yes === true && values.local === true) {
    throw new AwError({
      code: "YES_LOCAL_UNSUPPORTED",
      category: "config",
      message: "--yes spending consent applies only to hosted tests."
    });
  }
  if (values.headless === true && values.local === true) {
    throw new AwError({
      code: "HEADLESS_LOCAL_UNSUPPORTED",
      category: "config",
      message:
        "--headless applies only to hosted AugmentWorks authentication. Local tests do not use a workspace API key."
    });
  }
  if (
    values.estimate === true &&
    values.assessment === undefined &&
    values.suite === undefined &&
    values.investigation === undefined
  ) {
    throw new AwError({
      code: "ESTIMATE_REQUIRES_ASSESSMENT",
      category: "config",
      message: "test --estimate requires --assessment, --suite, or --investigation."
    });
  }
  if (values.assessment !== undefined && values.local === true) {
    throw new AwError({
      code: "ASSESSMENT_LOCAL_UNSUPPORTED",
      category: "config",
      message:
        "--assessment is a hosted compiler and cannot be used with --local. Hybrid packets are also rejected in local mode."
    });
  }
  if (values.suite !== undefined && values.local === true) {
    throw new AwError({
      code: "HOSTED_SUITE_UNSUPPORTED_LOCAL",
      category: "config",
      message:
        "--suite is a hosted customer-owned suite and cannot be used with --local. Validate offline with `augmentworks suite validate` / `suite preview`."
    });
  }
  if (values.investigation !== undefined && values.local === true) {
    throw new AwError({
      code: "HOSTED_INVESTIGATION_UNSUPPORTED_LOCAL",
      category: "config",
      message:
        "--investigation reproduces a hosted semantic case and cannot be used with --local. Inspect offline with `augmentworks investigation inspect`."
    });
  }
  if (values.assessment !== undefined && values.packet !== undefined) {
    throw new AwError({
      code: "ASSESSMENT_PACKET_CONFLICT",
      category: "config",
      message: "Use either --assessment or --packet, not both."
    });
  }
  if (values.suite !== undefined && (values.assessment !== undefined || values.packet !== undefined)) {
    throw new AwError({
      code: "SUITE_SELECTION_CONFLICT",
      category: "config",
      message: "Use either --suite, --assessment, or --packet, not a combination."
    });
  }
  if (
    values.investigation !== undefined &&
    (values.suite !== undefined || values.assessment !== undefined || values.packet !== undefined)
  ) {
    throw new AwError({
      code: "INVESTIGATION_SELECTION_CONFLICT",
      category: "config",
      message: "Use either --investigation, --suite, --assessment, or --packet, not a combination."
    });
  }
  if (values.profile !== undefined && values.assessment === undefined) {
    throw new AwError({
      code: "ASSESSMENT_PROFILE_REQUIRES_FILE",
      category: "config",
      message: "--profile requires --assessment."
    });
  }
  if (
    values.assessment === undefined &&
    values.packet === undefined &&
    values.suite === undefined &&
    values.investigation === undefined
  ) {
    throw new AwError({
      code: "PACKET_OR_ASSESSMENT_REQUIRED",
      category: "config",
      message: "Provide --packet, --assessment, --suite, or --investigation."
    });
  }
}

function requirePacket(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new AwError({
      code: "PACKET_OR_ASSESSMENT_REQUIRED",
      category: "config",
      message: "Provide --packet, --assessment, --suite, or --investigation."
    });
  }
  return value;
}

function hostedJsonResult(result: TestResult): Record<string, unknown> {
  return {
    run_id: result.run.run_id,
    status: result.run.status,
    credit_state: result.run.credit_state,
    outcome: result.run.outcome ?? null,
    dashboard_url: result.binding.dashboard_url,
    ...(result.run.evaluation_status === undefined
      ? {}
      : { evaluation_status: result.run.evaluation_status })
  };
}

function formatAdvertisedConversation(
  capabilities: CreateRunRequest["target"]["capabilities"]
): string {
  if (capabilities.multi_turn === true && capabilities.conversation?.strategy === "explicit_session_v1") {
    return "Advertised conversation: explicit_session_v1 (multi_turn=true). Estimate and execute send this same declaration.";
  }
  return "Advertised conversation: single-turn (multi_turn omitted). Estimate and execute send this same declaration.";
}

function writeHostedResult(stdout: Pick<NodeJS.WriteStream, "write">, result: TestResult): void {
  writeLine(stdout, `Run ${sanitizeTerminal(result.binding.dashboard_url)}`);
  if (result.run.evaluation_status !== undefined) {
    writeLine(stdout, `Grading: ${sanitizeTerminal(result.run.evaluation_status)}`);
  }
  if (
    result.run.evaluation_status === "pending" ||
    result.run.evaluation_status === "partial"
  ) {
    writeLine(
      stdout,
      "Your test evidence is saved. Grading is pending on the original run. Do not re-run the test command."
    );
    writeLine(
      stdout,
      `Wait: augmentworks run wait ${sanitizeTerminal(result.run.run_id)}`
    );
    writeLine(
      stdout,
      `Status: augmentworks run status ${sanitizeTerminal(result.run.run_id)}`
    );
    return;
  }
  if (result.run.evaluation_status === "error") {
    writeLine(
      stdout,
      `Required response evaluation did not complete. Inspect the original run with: augmentworks run status ${sanitizeTerminal(result.run.run_id)}`
    );
    return;
  }
  writeLine(
    stdout,
    `Assessment ${sanitizeTerminal(result.run.status)}${
      result.run.outcome == null ? "" : ` (${sanitizeTerminal(result.run.outcome)})`
    }.`
  );
}

function assertRunBinding(binding: CreateRunResponse, request: CreateRunRequest): void {
  if (
    binding.create_request_id !== request.create_request_id ||
    binding.packet.key !== request.packet.key ||
    binding.packet.version !== request.packet.version ||
    binding.config_sha256 !== request.config_sha256
  ) {
    throw new AwError({
      code: "RUN_BINDING_MISMATCH",
      category: "protocol",
      message: "AugmentWorks created a run with a different packet or configuration binding."
    });
  }
}

function isTerminal(status: CreateRunResponse["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function dashboardUrl(value: string, apiOrigin: URL): URL {
  const url = new URL(value);
  assertAllowedBrowserUrl(url, [apiOrigin.origin]);
  if (url.search !== "" || url.hash !== "") {
    throw new AwError({
      code: "UNSAFE_DASHBOARD_URL",
      category: "protocol",
      message: "The dashboard URL cannot contain a query string or fragment."
    });
  }
  return url;
}

function writeProgress(stream: Pick<NodeJS.WriteStream, "write">, event: RelayProgressEvent): void {
  if (event.type === "operation_started") {
    writeLine(stream, `→ ${event.kind} (${event.sequence})`);
  } else if (event.type === "operation_completed") {
    writeLine(stream, `✓ ${event.kind}${event.replayed ? " (replayed safely)" : ""}`);
  } else if (event.type === "operation_failed") {
    writeLine(stream, `✗ ${event.kind}: ${sanitizeTerminal(event.code)}`);
  }
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, value: string): void {
  stream.write(`${sanitizeTerminal(value)}\n`);
}

export type { AccessTokenProvider, AuthIdentity };
