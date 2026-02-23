# Design Document: ADK TS Improvements and Alignment

## 1. Introduction

This document defines the architectural improvements for ADK TS to support
advanced CLI and IDE-based agent scenarios, aligning with ADK Python patterns.
The primary goals are functional parity with the Python implementation, robust
streaming support, and a native human-in-the-loop (HITL) mechanism for tool
execution.

The goal is to transition from a request-response pattern to an
interface-driven, event-streamed architecture. This enables client
applications to provide real-time feedback, including reasoning traces and
partial content deltas.

## 2. Strategic Alignment with ADK Python

To maintain cross-language consistency, ADK TS will adopt the established
patterns of ADK Python. Key areas of alignment include the runner abstraction
and event-driven execution loops.

- **The Runner Abstraction:** Decouples the orchestration of models, tools,
  and session state from the agent definition.
- **Event-Driven Execution:** Uses asynchronous generators to yield
  fine-grained execution events instead of returning final result promises.

## 3. Core Enhancements

### 3.1. First-Class Streaming Support

Interactive CLIs rely on real-time feedback. Users expect to see the agent
thinking, calling tools, and streaming partial content tokens.

**The runAsync API:**

To maintain parity with ADK Python, the Runner interface exposes a `runAsync`
method returning an `AsyncGenerator` of raw ADK `Event` objects. This ensures
that the core API remains non-lossy and consistent across languages.

For client applications that require a simplified, structured view of the
execution, the ADK provides an optional `toStructuredEvents` utility. This
utility converts raw events into a list of `StructuredEvent` objects,
categorizing them into:

- **Reasoning Traces (`ThoughtEvent`):** Internal reasoning or thinking
  tokens.
- **Content Deltas (`ContentEvent`):** Partial content intended for the user.
- **Tool Lifecycle Events (`ToolCallEvent`, `ToolResultEvent`):** Explicit
  tool call and tool result events.
- **Code Execution Events (`CallCodeEvent`, `CodeResultEvent`):** Explicit
  code execution call and result events.
- **Lifecycle Events (`ErrorEvent`, `ActivityEvent`, `FinishedEvent`):** Error
  states, activities, and final completion.

### 3.2. Human-in-the-Loop and Tool Approval

Safety requires a client-side tool execution model where sensitive operations
require explicit user approval.

**Mechanism:**

1. **Confirmation Callback:** The Runner will support a confirmation callback.
1. **Execution Suspension:** When a tool requires confirmation, the Runner
   invokes the callback and yields a tool confirmation request event.
   **CRITICAL:** The agent loop MUST explicitly suspend/exit after yielding
   this event to return control to the host.
1. **Resumability:** The agent state remains suspended until the host
   application resumes execution with the approval result.

### 3.3. Dynamic Instructions

CLI agents require context-aware system prompts that reflect the current state
of the environment, such as the working directory.

**Instruction Providers:**

The instruction field will support a dynamic resolver: (context:
ReadonlyContext) => Promise<string>. This allows the agent to resolve its
behavior and constraints at the moment of execution using session state and
runtime facts.

### 3.4. Session Isolation

To prevent history leakage between runs, the Runner will implement strict
session isolation.

- **Ephemeral Execution:** A `runEphemeral` helper will handle temporary
  session creation, ensuring a clean slate for each run while supporting
  initial `stateDelta`.
- **Resumable Invocations:** Support for hydrating agent state from persisted
  sessions to allow multi-turn conversations across separate CLI invocations.

## 4. Developer Experience and API Surface

Key interfaces will be consolidated and exported from the package root to
improve discoverability and reduce integration friction.

**Consolidated Exports:**

The index file will export the following core extensibility interfaces:
BaseAgent, LlmAgent, Runner, BaseLlm, BaseTool, ToolConfirmation,
InstructionProvider, EventType, StructuredEvent, and toStructuredEvents.

## 5. Implementation Roadmap

1. **Phase 1: API Surface Refactoring:** Update exports, standardize on native
   events, and implement the optional parsing utility.
1. **Phase 2: Streaming Implementation:** Refactor the LLM agent loop to
   support the `runAsync` generator.
1. **Phase 3: HITL and Resumption:** Implement tool approval pauses (Explicit
   Suspension) and the resume capability in the Runner.
1. **Phase 4: Adapter Validation:** Implement the ADK adapters within a
   reference CLI implementation.

## 6. Recommendations from Integration Feedback

The following friction points were identified during end-to-end integration.
Addressing these will significantly improve robustness and developer
experience:

1. **Error Handling:** The Model Adapter should support native `Error` objects
   in responses, eliminating the need for strict JSON-stringified error
   messages.
1. **Type Compatibility:** Adopt structural typing for `@google/genai` types
   (e.g., `Content`, `Part`) to prevent version-mismatch errors in monorepos
   where multiple versions of the SDK might coexist.
1. **Strict Naming:** Relax `BaseAgent` naming validation to allow hyphens
   (kebab-case), aligning with common CLI command naming conventions.
1. **Execution Control (Client-Side Tools):** Support a native configuration
   (e.g., `pauseOnToolCalls`) to suspend execution on _any_ tool call. This
   simplifies implementing "Client-Side Tool Execution" patterns without
   requiring a custom security plugin for every tool.
1. **Session Ergonomics:** Add a `getOrCreateSession` helper to
   `SessionService` to reduce boilerplate when initializing agent loops.
