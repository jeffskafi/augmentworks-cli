# Configuration reference

The v1 configuration describes a local application boundary. It is input to a
deterministic HTTP connector, not an instruction language. No Python adapter or
AugmentWorks target SDK is required: expose the mapped endpoints in the
application's existing framework. The relay cannot change the configured host,
path, method, headers, environment-variable names, or mappings during a run.

## File and environment resolution

The default filename is `augmentworks.yaml`. Select another file with `-c` or
`--config`.

The CLI loads `.env` from the selected configuration file's directory before it
resolves `${NAME}` references. Existing process environment values take
precedence. Keep `.env` out of source control; commit `.env.example` containing
names and placeholder values only.

`base_url` may use a whole-value environment reference:

```yaml
base_url: ${CHATBOT_BASE_URL}
```

Authentication values must always be indirect:

```yaml
auth:
  bearer_env: CHATBOT_API_KEY
  headers_env:
    X-Tenant-ID: CHATBOT_TENANT_ID
```

`bearer_env` and `headers_env` values name environment variables. They are not
secret values. `doctor` rejects credential-like literal values in these fields.
These credentials authenticate CLI-to-target calls and are separate from the
revocable connector credential created by `augmentworks login`.

## Top-level shape

```yaml
version: 1
target: {}
telemetry: {}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | Yes | Configuration schema version; v0.1 accepts `1` |
| `target` | Yes | Local connector and operation mappings |
| `telemetry` | No | Explicit evidence allowlist |

Unknown fields are rejected so a typo cannot silently weaken a boundary.

## Target

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | Yes | Stable human-readable target name |
| `connector` | Yes | Must be `http` in v1 |
| `base_url` | Yes | Target origin; public targets should use HTTPS, while loopback/private IP targets may use HTTP |
| `allow_insecure_http` | For public plain HTTP | Explicit high-risk opt-in; loopback and private IP targets are allowed without it |
| `auth` | No | Bearer or additional header environment-variable names |
| `operations` | Yes | Lifecycle mappings |
| `limits` | No | Stricter per-target byte and timeout limits |

Example limits:

```yaml
limits:
  request_bytes: 65536
  response_bytes: 1048576
  operation_timeout_ms: 30000
```

Configured values can only tighten the CLI's hard safety ceilings. Operation
timeouts must be between 100 and 120,000 milliseconds.

### Target boundary checksum

At run creation, the CLI hashes a canonical boundary containing the connector,
the fully resolved and normalized base URL, and each configured operation's
kind, method, and fixed path. Only `boundary_sha256` leaves the machine; the raw
URL, paths, and any environment-variable names do not.

The checksum excludes credentials, auth headers, mappings/selectors, bodies,
limits, telemetry, and target state. Rotating a secret leaves it stable, while
changing the resolved base URL or an operation method/path changes it and
prevents an active run from resuming against that different boundary. This is
an unkeyed drift-binding checksum, not target identity or execution proof.

## Operations

`send` is always required. `prepare`, `observe`, and `cleanup` are required as a
set for a stateful assessment.

```yaml
operations:
  send:
    method: POST
    path: /chat
    request:
      message: $input.message.content
      attempt_id: $input.attempt_id
    response:
      content: $.answer
      tool_events: $.events
    timeout_ms: 30000
    idempotent: false
```

| Field | Required | Meaning |
| --- | --- | --- |
| `method` | Yes | `GET` or `POST`; `DELETE` is accepted only for `cleanup` |
| `path` | Yes | Fixed path joined to `base_url` |
| `request` | No | JSON-compatible request body template |
| `response` | No | Named output fields mapped from the JSON response |
| `timeout_ms` | No | Per-operation timeout |
| `idempotent` | No | Declares whether replay after a known non-delivery is safe; defaults to `false` for every operation |

Paths are configuration constants. They cannot contain `$input` templates, a
second origin, credentials, fragments, or cloud-provided URLs.

`GET` operations cannot define a request body. `DELETE` is restricted to
`cleanup` so a cloud-selected semantic operation cannot turn another lifecycle
step into a destructive request.

### Request templates

A request template is JSON-compatible YAML. Scalar strings beginning with
`$input.` copy a value from the typed operation input:

```yaml
request:
  message: $input.message.content
  attempt_id: $input.attempt_id
  metadata:
    turn_id: $input.turn_id
```

The supported accessor is a dotted object path. There are no expressions,
functions, conditionals, filters, JavaScript, shell commands, or dynamic keys.
Missing required input fails the operation before an HTTP request is made.

### Response mappings

Responses must be JSON when a `response` mapping is present. Each output field
uses the safe subset `$.field.nested` (with simple array indexes where
supported):

```yaml
response:
  content: $.answer
  tool_events: $.events
```

No recursive descent, predicates, script expressions, or arbitrary JSONPath
evaluation is supported. A missing required mapped value produces a bounded,
redacted target error.

### Lifecycle meaning

| Operation | Purpose | Retry rule |
| --- | --- | --- |
| `prepare` | Create a synthetic fixture and return its identifiers | An ambiguous outcome is indeterminate unless explicitly idempotent |
| `send` | Deliver a scenario message to the application | An ambiguous outcome is indeterminate unless explicitly idempotent |
| `observe` | Read allowlisted synthetic state through the configured observer | An ambiguous outcome is indeterminate unless explicitly idempotent |
| `cleanup` | Remove the synthetic fixture | An ambiguous outcome is indeterminate unless explicitly idempotent |

Target authors should make lifecycle operations idempotent by the attempt or
fixture identifier wherever the application contract permits it, and declare
that guarantee explicitly.

Set `idempotent: true` only when the target contract actually guarantees that
repeating the same idempotency/attempt key cannot duplicate a consequence. The
CLI treats every operation as non-idempotent when the field is absent.

## Telemetry

Telemetry is denied unless enabled:

```yaml
telemetry:
  allow_tool_events: true
  allow_observations:
    - order.status
    - order.refunded_amount
```

`allow_tool_events` permits structured tool-event results from `send`.
`allow_observations` is a field-level allowlist applied to observation output.
It does not permit arbitrary database records or logs. At run creation, the CLI
sends only these public key aliases, sorted and deduplicated, for hosted packet
preflight. Observation values, local response selectors, environment-variable
names, and the target URL remain local. Returned values leave the connector
only for a typed relay request whose keys passed this allowlist.

## Capability levels

| Level | Required config | What an assessment can claim |
| --- | --- | --- |
| Chat-only | `send` | Conversational behavior |
| Tool-aware | `send` and allowed structured events | Attempted tool invocation |
| Stateful | `prepare`, `send`, `observe`, `cleanup`, and allowed observation fields | Values reported by the configured state observer |

If state observation is absent or fails, state is `unknown`; the chatbot's
message is not substituted as proof. An observation is customer-reported
evidence, not independent verification that the observer is correct or that a
test environment matches production.

## Validation

Use offline validation while editing:

```bash
npx --yes @augmentworks/cli@0.1.0 doctor \
  -c augmentworks.yaml
```

`doctor` is always offline in v0.1. It makes no target or cloud network request,
never invokes `prepare`, `send`, `observe`, or `cleanup`, and consumes no
assessment credit.

The canonical machine-readable definition is
[`schemas/v1/augmentworks.schema.json`](../schemas/v1/augmentworks.schema.json).
