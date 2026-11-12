# Typed errors in `core/src`

Contributor rules for adopting the typed errors from #583 (tracked in #807).
What each error means for callers is in the
[errors guide](../guides/errors/index.md). The per-site inventory is a
point-in-time snapshot and lives on
[#807](https://github.com/google/adk-js/issues/807), not here.

## Picking a class

Follow the meanings in the errors guide, with two rules on top:

- Developer misconfiguration stays a bare `Error` whichever type it resembles,
  as in adk-python, which raises `ValueError`. That covers constructor, agent,
  toolset and plugin options, duplicate names in a tool or plugin list, an
  unknown `model` string, a developer-supplied router returning an unknown key,
  and options a developer passes in their own workflow code, such as an empty
  custom `runId`. Internal invariants, abstract stubs and unreachable code stay
  bare too.
- A bad tool argument rejected before the tool runs is `InputValidationError`,
  including arguments the model generated. `ToolExecutionError` is for a tool
  that ran and failed.

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

## Changing an existing throw

- Keep the message byte-identical and change only the class. Pass the original
  error as `{cause}` when the site rethrows one.
- Convert a whole flow at once, so a caller catching one type is not surprised
  by a sibling check that still throws a bare `Error`.
- Skip throws that never leave their module, for example ones caught and
  turned into a return value.
- State in the PR and in the commit body what a `catch` block now sees.
  Workflow retries (`RetryConfig.exceptions`) and the `errorType` of node error
  events and tool spans match errors by class name, so a config listing
  `'Error'` stops matching.
- Update the errors guide when a new type is added.
