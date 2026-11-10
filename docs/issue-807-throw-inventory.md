# Typed errors in `core/src` (#807)

Design note for adopting the typed errors from #583. The per-site inventory
is a point-in-time snapshot and lives on
[#807](https://github.com/google/adk-js/issues/807), not here.

## When to use which error

| Error                  | Use when                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InputValidationError` | A value supplied at call time is invalid: a method argument (id, name, path, URI), file or payload content being parsed, or model-generated arguments. Matches adk-python's use. |
| `NotFoundError`        | The requested resource does not exist.                                                                                                                                           |
| `SessionNotFoundError` | The requested session does not exist.                                                                                                                                            |
| `AlreadyExistsError`   | Creating something whose id is already taken.                                                                                                                                    |
| `ToolExecutionError`   | A tool fails while running; set `ToolErrorType` when the failure maps to one.                                                                                                    |
| bare `Error`           | Developer misconfiguration (constructor, agent or toolset options), internal invariants, abstract stubs and unreachable code.                                                    |

Developer misconfiguration stays a bare `Error`, as it does in adk-python,
where it raises `ValueError`. It is not `InputValidationError`.

## Proposed new types

These are flat (`extends Error`), like the #583 types, and pending team
review. adk-python has no equivalent for any of them.

| Type                        | For                                                                               |
| --------------------------- | --------------------------------------------------------------------------------- |
| `UnsupportedFeatureError`   | The model, backend or runtime does not support the requested capability.          |
| `UpstreamServiceError`      | An external service or model failed or returned unusable data.                    |
| `AuthenticationError`       | Credentials are missing or rejected, or a token fetch or exchange failed.         |
| `ServiceNotConfiguredError` | The operation needs an optional service (artifact, memory, speech) that is unset. |
| `InvalidWorkflowGraphError` | A workflow graph definition cannot be parsed or fails validation.                 |

`InvalidWorkflowGraphError` covers developer configuration, so it is an
exception to the rule above. It is worth adding only if callers need to catch
graph errors. Otherwise those sites stay a bare `Error`.

`_stale_session_error.py` is not needed: adk-js reloads a stale session in
`DatabaseSessionService.appendEvent` instead of throwing.

## Rules for Stage 2

- Keep messages byte-identical; change only the class.
- Split PRs by area. Do `sessions/`, `agents/`, `artifacts/` and `runner/`
  last, because other PRs are in flight there.
- State in each PR what a `catch` block now sees. Two places match errors by
  class name: workflow retries (`RetryConfig.exceptions`) and the `errorType`
  of node error events and tool spans.
