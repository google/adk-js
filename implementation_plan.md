## Task

### User intent with respect to ADK
Implement a `NullContextCompactor` for the `adk-js` package that conforms to the `BaseContextCompactor` interface. This compactor is designed to aggressively discard all session context, wiping out all events whenever invoked, ensuring a completely ephemeral or memoryless interaction session.

### Feature Description
A new class `NullContextCompactor` in `adk-js` that implements the `BaseContextCompactor` interface. 
- It implements `shouldCompact(invocationContext: InvocationContext)` to return `true` whenever session events are present (or simply unconditionally `true` for a faster path).
- It implements `compact(invocationContext: InvocationContext)` to completely clear the `invocationContext.session.events` array in-place without generating errors.

### Use Cases & Examples
- **Memoryless Agents:** When developers want to instantiate an agent that acts strictly on the current prompt and has no grounding or recollection of previous turns.
- **Testing and Debugging:** To isolate issues related to token flooding or context memory size and establish a baseline memoryless performance mode.

## Context

### ADK Context
- **Documentation context:** The contract is established by `BaseContextCompactor` (`adk-js/core/src/context/base_context_compactor.ts`). 
- **Reference context:** Existing compactors (e.g., `TruncatingContextCompactor`) mutate the `invocationContext.session.events` array in place using functions like `events.splice`. This is proven to cleanly eliminate history.
- **General context:** The goal is a strict wipe. There's no preservation of arbitrary events, avoiding edge-cases during partial truncations.

### Language Specific Context
- **Target language:** TypeScript
- **Target repo:** `adk-js`
- **Location:** The implementation should reside at `adk-js/core/src/context/null_context_compactor.ts` and its tests at `adk-js/core/test/context/null_context_compactor_test.ts`. 
- **Language Idioms:** Array wiping can be done safely through `invocationContext.session.events.length = 0;` or `invocationContext.session.events.splice(0, events.length);`.

## Definition

### Data Models 
- `NullContextCompactor` class
- No additional structs or data types are needed.

### Inputs
- `InvocationContext` object passed from the orchestration layer.

### Outputs
- `shouldCompact`: Returns `boolean`.
- `compact`: Returns `void`.

### Side Effects
- Mutates the `invocationContext.session.events` array, clearing all internal references, guaranteeing length equals `0`.

## Constraints

### Invariants
The array length of `invocationContext.session.events` strictly equals `0` after `compact` executes.

### Preconditions
- The `InvocationContext` must be instantiated and properly contain a valid `Session` containing an `events` array.

### Postconditions
- All events within the session are purged.
- No exceptions are thrown.

### Error Handling Protocols
Native array wiping is syntactically safe in JS/TS as long as the array is initialized. No custom try/catch or error bubbling is strictly necessary here.

### Breaking Change Analysis
**None.** This is a purely additive class implementation on an existing interface.

### Testing

- #### Unit tests with >=95% New Line Coverage
A targeted test suite must be placed in `adk-js/core/test/context/null_context_compactor_test.ts`.
- Mock an `InvocationContext` populated with mocked elements in the `session.events` array.
- Assert that `shouldCompact` successfully identifies events to compact (or evaluates to true).
- Trigger `compact` and assert: 
  1. `events.length === 0`.
  2. No errors are raised during the execution.

- #### Integration tests
Not explicitly necessary. This is an implementation detail strictly bound to the context layer whose guarantees are exhaustively verified in unit testing.

- #### Manual e2e test
Attach `NullContextCompactor` to a standard agent loop, send two sequential prompts, and verify that the agent possesses no recollection of prompt 1 when responding to prompt 2.
