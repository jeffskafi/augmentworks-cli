import { sealDocumentHash, canonicalDocumentHash } from "../../src/real-data/canonical.js";
import type {
  DataPolicy,
  ExecutionScope,
  ExecutionScopeResponse,
  LocalExecutionScope,
  RedactionProfile,
  TargetAuthority,
  TargetBoundary
} from "../../src/real-data/documents.js";

export const UUID_A = "11111111-1111-4111-8111-111111111111";
export const UUID_B = "22222222-2222-4222-8222-222222222222";
export const UUID_C = "33333333-3333-4333-8333-333333333333";
export const UUID_D = "44444444-4444-4444-8444-444444444444";
export const UUID_E = "55555555-5555-4555-8555-555555555555";
export const UUID_F = "66666666-6666-4666-8666-666666666666";

export const FUTURE = "2099-12-31T23:59:59Z";

export function sealedBoundary(overrides: Partial<TargetBoundary> = {}): TargetBoundary {
  const draft: TargetBoundary = {
    schemaVersion: "aw-target-boundary/1",
    targetId: UUID_A,
    targetRevision: 1,
    boundaryHash: "0".repeat(64),
    transport: "direct_http",
    assessedOrigin: "https://support.example.com",
    endpoints: [
      {
        method: "POST",
        path: "/chat",
        origin: "https://support.example.com"
      }
    ],
    allowedOperations: ["send"],
    allowPrivateEndpoints: false,
    redirectMode: "manual",
    ...overrides
  };
  return sealDocumentHash(draft, "boundaryHash");
}

export function sealedAuthority(boundary: TargetBoundary): TargetAuthority {
  return sealDocumentHash(
    {
      schemaVersion: "aw-target-authority/1",
      authorityId: UUID_B,
      revision: 1,
      authorityHash: "0".repeat(64),
      workspaceId: UUID_C,
      targetId: boundary.targetId,
      targetRevision: boundary.targetRevision,
      targetBoundaryHash: boundary.boundaryHash,
      authorizationKind: "owned_target",
      permissionRef: "fixture-owned-target",
      effectsAllowed: ["informational"],
      verificationMethod: "reviewed_permission",
      verificationStatus: "verified",
      expiresAt: FUTURE
    },
    "authorityHash"
  );
}

export function sealedPolicy(): DataPolicy {
  return sealDocumentHash(
    {
      schemaVersion: "aw-data-policy/1",
      policyId: UUID_D,
      revision: 1,
      policyHash: "0".repeat(64),
      dataClass: "public",
      contentHandling: "minimized",
      redactionProfileId: UUID_E,
      redactionProfileHash: "0".repeat(64),
      retentionDays: 30,
      externalSharing: "disabled",
      providerProcessing: "openai_standard"
    },
    "policyHash"
  );
}

export function sealedProfile(policy: DataPolicy): RedactionProfile {
  return sealDocumentHash(
    {
      schemaVersion: "aw-redaction-profile/1" as const,
      profileId: policy.redactionProfileId,
      revision: 1,
      profileHash: "0".repeat(64),
      allowedContentFields: ["/answer"],
      rules: [
        { id: "credentials", selector: "/authorization", action: "drop" as const, detector: "credential" as const }
      ],
      maxDocumentBytes: 65_536,
      maxTextChars: 8_000
    },
    "profileHash"
  );
}

export function publicCredentialPolicy(): { policy: DataPolicy; profile: RedactionProfile } {
  const profileDraft = {
    schemaVersion: "aw-redaction-profile/1" as const,
    profileId: UUID_E,
    revision: 1,
    profileHash: "0".repeat(64),
    allowedContentFields: ["/answer"],
    rules: [
      { id: "credentials", selector: "/authorization", action: "drop" as const, detector: "credential" as const }
    ],
    maxDocumentBytes: 65_536,
    maxTextChars: 8_000
  };
  const profile = sealDocumentHash(profileDraft, "profileHash");
  const policy = sealDocumentHash(
    {
      schemaVersion: "aw-data-policy/1" as const,
      policyId: UUID_D,
      revision: 1,
      policyHash: "0".repeat(64),
      dataClass: "public" as const,
      contentHandling: "minimized" as const,
      redactionProfileId: profile.profileId,
      redactionProfileHash: profile.profileHash,
      retentionDays: 30,
      externalSharing: "disabled" as const,
      providerProcessing: "openai_standard" as const
    },
    "policyHash"
  );
  return { policy, profile };
}

export function sealedScope(
  boundary: TargetBoundary,
  authority: TargetAuthority,
  policy: DataPolicy
): ExecutionScope {
  return sealDocumentHash(
    {
      schemaVersion: "aw-execution-scope/1",
      scopeId: UUID_F,
      revision: 1,
      scopeHash: "0".repeat(64),
      workspaceId: authority.workspaceId,
      targetId: boundary.targetId,
      targetRevision: boundary.targetRevision,
      targetBoundaryHash: boundary.boundaryHash,
      environment: "staging",
      dataOrigin: "customer_records",
      effects: "informational",
      authority: { id: authority.authorityId, revision: authority.revision, hash: authority.authorityHash },
      dataPolicy: { id: policy.policyId, revision: policy.revision, hash: policy.policyHash },
      actionPolicy: null,
      budget: {
        maxMessages: 3,
        maxActions: 0,
        maxCommands: 60,
        maxRuntimeSeconds: 600,
        maxCredits: 6
      },
      expiresAt: FUTURE
    },
    "scopeHash"
  );
}

export function hostedScopeResponse(): ExecutionScopeResponse {
  const { policy, profile } = publicCredentialOnlyPolicy();
  const boundary = sealedBoundary();
  const authority = sealedAuthority(boundary);
  const scope = sealedScope(boundary, authority, policy);
  return {
    schemaVersion: "aw-execution-scope-response/1",
    scope,
    authority,
    dataPolicy: policy,
    redactionProfile: profile,
    actionPolicy: null,
    targetBoundary: boundary,
    availability: "ready"
  };
}

/** Credential-only profile so the fail-closed default privacy service can accept public content. */
export function publicCredentialOnlyPolicy(): { policy: DataPolicy; profile: RedactionProfile } {
  const profile = sealDocumentHash(
    {
      schemaVersion: "aw-redaction-profile/1" as const,
      profileId: UUID_E,
      revision: 1,
      profileHash: "0".repeat(64),
      allowedContentFields: ["/answer"],
      rules: [{ id: "credentials", selector: "/token", action: "drop" as const, detector: "credential" as const }],
      maxDocumentBytes: 65_536,
      maxTextChars: 8_000
    },
    "profileHash"
  );
  const policy = sealDocumentHash(
    {
      schemaVersion: "aw-data-policy/1" as const,
      policyId: UUID_D,
      revision: 1,
      policyHash: "0".repeat(64),
      dataClass: "public" as const,
      contentHandling: "verbatim" as const,
      redactionProfileId: profile.profileId,
      redactionProfileHash: profile.profileHash,
      retentionDays: 30,
      externalSharing: "disabled" as const,
      providerProcessing: "openai_standard" as const
    },
    "policyHash"
  );
  return { policy, profile };
}

export function canaryRedactionPolicy(
  options: {
    readonly dataClass?: DataPolicy["dataClass"];
    readonly contentHandling?: DataPolicy["contentHandling"];
  } = {}
): { policy: DataPolicy; profile: RedactionProfile } {
  const profile = sealDocumentHash(
    {
      schemaVersion: "aw-redaction-profile/1" as const,
      profileId: UUID_E,
      revision: 1,
      profileHash: "0".repeat(64),
      allowedContentFields: [],
      rules: [
        { id: "mask-email-message", selector: "/message/content", action: "mask" as const, detector: "email" as const },
        { id: "mask-phone-message", selector: "/message/content", action: "mask" as const, detector: "phone" as const },
        {
          id: "mask-email-assistant",
          selector: "/attempts/*/turns/*/assistant_content",
          action: "mask" as const,
          detector: "email" as const
        },
        {
          id: "mask-phone-assistant",
          selector: "/attempts/*/turns/*/assistant_content",
          action: "mask" as const,
          detector: "phone" as const
        }
      ],
      maxDocumentBytes: 65_536,
      maxTextChars: 8_000
    },
    "profileHash"
  );
  const policy = sealDocumentHash(
    {
      schemaVersion: "aw-data-policy/1" as const,
      policyId: UUID_D,
      revision: 1,
      policyHash: "0".repeat(64),
      dataClass: options.dataClass ?? "business",
      contentHandling: options.contentHandling ?? "minimized",
      redactionProfileId: profile.profileId,
      redactionProfileHash: profile.profileHash,
      retentionDays: 30,
      externalSharing: "disabled" as const,
      providerProcessing: "openai_standard" as const
    },
    "policyHash"
  );
  return { policy, profile };
}

export function sealedLocalScope(boundary: TargetBoundary, policy: DataPolicy): LocalExecutionScope {
  return sealDocumentHash(
    {
      schemaVersion: "aw-local-execution-scope/1",
      scopeId: UUID_F,
      revision: 1,
      scopeHash: "0".repeat(64),
      targetId: boundary.targetId,
      targetRevision: boundary.targetRevision,
      targetBoundaryHash: boundary.boundaryHash,
      environment: "development",
      dataOrigin: "customer_records",
      effects: "informational",
      verification: "customer_declared_local",
      authority: {
        id: UUID_B,
        revision: 1,
        hash: canonicalDocumentHash({ id: UUID_B, revision: 1 }),
        verification: "customer_declared_local"
      },
      dataPolicy: { id: policy.policyId, revision: policy.revision, hash: policy.policyHash },
      actionPolicy: null,
      budget: {
        maxMessages: 3,
        maxActions: 0,
        maxCommands: 8,
        maxRuntimeSeconds: 600,
        maxCredits: 0
      },
      expiresAt: FUTURE,
      targetBoundary: boundary,
      revocation: { localOnly: true, remoteRevocationWhileOffline: "not_observed" }
    },
    "scopeHash"
  );
}

export const ENABLED_CAPABILITIES = {
  schemaVersion: "aw-capabilities/1" as const,
  executionScopes: ["aw-execution-scope/1"],
  suiteSchemas: ["aw-suite/1", "aw-suite/2", "aw-suite/3"],
  packetSchemas: ["aw-packet/0.1", "aw-packet/live-informational-1", "aw-packet/authorized-1"],
  reportScopes: ["authorized-1"],
  dataPolicies: ["aw-data-policy/1"],
  enabledEffects: ["informational" as const],
  runtimeEnforced: true,
  releaseEnabled: true
};

export const ADVERTISED_DISABLED_CAPABILITIES = {
  ...ENABLED_CAPABILITIES,
  runtimeEnforced: false,
  releaseEnabled: false
};

export function localAuthorizedPacketManifest(
  overrides: {
    readonly boundary?: TargetBoundary;
    readonly cleanup?: boolean;
    readonly maxMessages?: number;
    readonly policy?: DataPolicy;
    readonly profile?: RedactionProfile;
  } = {}
) {
  const { policy, profile } = overrides.policy && overrides.profile
    ? { policy: overrides.policy, profile: overrides.profile }
    : publicCredentialOnlyPolicy();
  const boundary =
    overrides.boundary ??
    sealedBoundary({
      allowPrivateEndpoints: true,
      assessedOrigin: "http://127.0.0.1:8000",
      endpoints: [{ method: "POST" as const, path: "/send", origin: "http://127.0.0.1:8000" }]
    });
  const scope = sealedLocalScope(boundary, policy);
  const budget = {
    ...scope.budget,
    ...(overrides.maxMessages === undefined ? {} : { maxMessages: overrides.maxMessages })
  };
  const scoped =
    overrides.maxMessages === undefined
      ? scope
      : sealDocumentHash({ ...scope, budget, scopeHash: "0".repeat(64) }, "scopeHash");
  return {
    schema_version: "aw-packet/local-authorized-1" as const,
    packet_id: "local-authorized",
    version: "1.0.0",
    name: "Local authorized packet",
    description: "Customer-declared local real-data packet. No AugmentWorks network calls.",
    domain: "records",
    synthetic_only: false as const,
    execution_scope: scoped,
    data_policy: policy,
    redaction_profile: profile,
    required_capabilities: {
      multi_turn: false,
      observation: false,
      tool_events: false,
      cleanup: overrides.cleanup === true
    },
    scenarios: [
      {
        key: "local-authorized.hours",
        name: "Hours",
        category: "records",
        severity: "medium" as const,
        description: "Ask weekday hours against the local target.",
        expected_behavior: "State weekday hours.",
        fixture: {},
        turns: [{ content: "What are your weekday support hours?" }],
        observation_keys: [] as string[],
        assertions: [
          {
            kind: "assistant_contains" as const,
            key: "hours",
            description: "Mentions weekday hours.",
            value: "9"
          }
        ],
        repetitions: 1,
        pass_threshold: 1
      }
    ]
  };
}
