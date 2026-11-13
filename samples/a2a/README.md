# A2A Sample (`getA2AAgentCard`, `A2AAgentExecutor`, and `RemoteA2AAgent`)

This sample shows how an ADK agent is described with an A2A `AgentCard`, executed through `A2AAgentExecutor` to produce A2A task, artifact, and status update events, and consumed through `RemoteA2AAgent` to reconstruct ADK `Event` objects. It runs offline in memory and requires no API key or network socket.

## Overview

`A2AShowcaseAgent` (exported as `rootAgent`) is a deterministic `BaseAgent` subclass. On each turn it runs an in-memory pipeline and replies with one message reporting:

- `AGENT_CARD_PATH` and the `AgentCard` built by `getA2AAgentCard` for `OrderStatusWorkerAgent`.
- The sequence of A2A events (`task`, `status-update`, and `artifact-update`) published by `A2AAgentExecutor` when `OrderStatusWorkerAgent` emits a `functionCall`, a `functionResponse`, and a final text reply.
- The ADK `Event` objects reconstructed by `RemoteA2AAgent` from that A2A stream, including recovered tool calls (`getFunctionCalls`), tool responses (`getFunctionResponses`), and final text (`stringifyContent`).

## Sample Inputs

- `Run the A2A showcase.`

  _Any message works. The agent runs the same deterministic in-memory A2A round-trip and reports the result._

## Running the Sample

Build the workspace once, then run the exported `rootAgent` through the ADK CLI:

```bash
npm run build
npm run sample -- samples/a2a/agent.ts
```

`samples/` is type-checked separately against the built package declarations:

```bash
npm run ts:check:samples
```

## Related Guides

- [A2A](../../docs/guides/a2a/index.md) - Exposing ADK agents as A2A servers, calling remote A2A agents, event/part conversion metadata, and security defaults.
