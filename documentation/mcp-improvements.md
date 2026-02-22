# RFC: MCP Connection Layer Improvements

## TL;DR (for managers)

**What**: MCP (Model Context Protocol) integration in ADK-JS is now production-ready.

**Validation**: 59 tests (5 explicit improvement tests) — all passing.

### Before / After

| Operation | Before | After |
|-----------|--------|-------|
| `new Client()` + `connect()` | N per run | 1 |
| `tools/list` RPC | N per run | 1 |
| `MCPTool` allocations | N × M | M |
| Server instructions in system prompt | never | every step (XML-tagged) |
| Recovery from transport failure | none | automatic (retry-once) |
| Tool filtering | never | every `getTools()` with context |
| Schema fidelity (enum, format, pattern) | lost | preserved |

| Area | Before | After |
|------|--------|-------|
| Session | New `Client` + `connect()` every call | Cached client, promise coalescing |
| Tools | `listTools()` every `getTools()` | Cached after first call |
| Instructions | Discarded | Cached at connect, XML-tagged per step |
| Declaration | `parameters: toGeminiSchema(inputSchema)` | `parametersJsonSchema: inputSchema` |
| Tool execution | No retry on failure | Retry-once after `close()` |

---

## Overview

We upgraded the MCP integration so agents can talk to external tools reliably and efficiently.

**Before**: Every step in an agent run opened a new connection, re-discovered tools, and ignored server instructions. If the connection dropped, the run failed. Tool schemas were simplified and some details were lost.

**After**: One connection per run. Tools are discovered once and reused. Server instructions reach the LLM so it knows how to use each tool. If the connection drops, we retry once automatically. Tool schemas are passed through unchanged. Filtering (by name or predicate) works as intended.

**In short**: Faster, more reliable, and better aligned with how MCP servers expect to be used.

---

| Field | Value |
|-------|-------|
| **Status** | Implemented |
| **Authors** | ADK-JS contributors |
| **Created** | 2026-02-22 |
| **Scope** | `core/src/tools/mcp/*`, `core/src/agents/llm_agent.ts` |
| **Tests** | 59 tests across 4 files (was: 5 tests, 1 file) |

---

## Abstract

The MCP (Model Context Protocol) integration in ADK-JS provided basic connectivity
but lacked session management, caching, resilience, and LLM-aware features. This
RFC describes changes that bring the integration to production quality and MCP
spec alignment.

**Categories**: performance (session + tool caching), resilience (concurrency
guard, transport health, retry), LLM integration (XML-tagged instructions, tool
filtering), LLM portability (raw JSON Schema pass-through).

---

## References

| Reference | URL |
|-----------|-----|
| MCP Specification | https://spec.modelcontextprotocol.io |
| MCP TypeScript SDK | https://github.com/modelcontextprotocol/typescript-sdk |
| Python ADK MCP | https://github.com/google/adk-python (src/google/adk/tools/mcp_tool/) |
| Gemini FunctionDeclaration | `@google/genai` — `parametersJsonSchema`, `responseJsonSchema` |

---

## Before / After

### Behavior (N steps, M tools)

| Operation | Before | After |
|-----------|--------|-------|
| `new Client()` + `connect()` | N | 1 |
| `tools/list` RPC | N | 1 |
| `MCPTool` allocations | N × M | M |
| Server instructions in system prompt | never | every step (XML-tagged) |
| Recovery from transport failure | none | automatic (retry-once) |
| Tool filtering | never | every `getTools()` with context |
| Schema fidelity (enum, format, pattern) | lost | preserved |

### Code (representative)

| Area | Before | After |
|------|--------|-------|
| Session | New `Client` + `connect()` every call | Cached client, promise coalescing |
| Tools | `listTools()` every `getTools()` | Cached after first call |
| Instructions | Discarded | Cached at connect, XML-tagged per step |
| Declaration | `parameters: toGeminiSchema(inputSchema)` | `parametersJsonSchema: inputSchema` |
| Tool execution | No retry on failure | Retry-once after `close()` |

---

## Motivation

An LLM agent runs in a loop. Each step calls `getTools()` to discover tools and
`callTool()` when the LLM uses one. The original implementation treated each
step as isolated: new connection, new `listTools()` RPC, no recovery, no
instructions, no filtering. For 10 steps this meant 10 connections and 10
identical tool discoveries.

```
┌─────────────── LlmAgent.runAsyncImpl ──────────────┐
│  while (true) {                                    │
│    ┌─────── runOneStepAsync ───────┐               │
│    │  1. Build fresh llmRequest     │ stateless     │
│    │  2. processLlmRequest()       │ per toolset   │
│    │  3. getTools() → declarations │ per toolset   │
│    │  4. Call LLM                 │               │
│    │  5. Process response         │               │
│    │  6. callTool() if needed     │ per tool      │
│    └──────────────────────────────┘               │
│    if (final response) break;                     │
│  }                                                 │
└────────────────────────────────────────────────────┘
```

Steps 2, 3, 6 interact with MCP. The improved design treats the MCP server as a
persistent resource and caches accordingly.

---

## Design decisions

### D1: Session caching with promise coalescing

**Problem**: Every `createSession()` opened a new connection; concurrent calls
could create duplicate clients.

**Solution**: Promise coalescing — store in-flight `Promise<Client>` so concurrent
callers await the same result. See [`mcp_session_manager.ts`](../core/src/tools/mcp/mcp_session_manager.ts) L94–104.

**Tests**: `returns cached client on subsequent createSession calls`,
`coalesces concurrent createSession() calls into one Client`,
`retries after concurrent connection failure`.

### D2: Reactive transport health via `onclose`

**Problem**: A cached client with a dead transport was indistinguishable from a
healthy one.

**Solution**: Use MCP SDK `client.onclose` to clear cached state. Identity guard
(`cachedClient === client`) prevents stale callbacks from clearing a newer
client. See [`mcp_session_manager.ts`](../core/src/tools/mcp/mcp_session_manager.ts) L168–174.

**Tests**: `clears cached state when transport disconnects (onclose)`,
`creates fresh client after transport disconnect`,
`onclose does not clear state if a newer client replaced it`.

### D3: Tool list caching with copy-on-read

**Problem**: `getTools()` called `session.listTools()` every invocation.

**Solution**: Cache `BaseTool[]` after first `listTools()`. Return shallow copy
`[...this.cachedTools]` for mutation safety. Invalidate only via `close()`.
See [`mcp_toolset.ts`](../core/src/tools/mcp/mcp_toolset.ts) L61–82.

**Tests**: `caches tools after the first getTools() call`,
`returns a copy when no context is provided (mutation-safe)`,
`re-fetches tools after close()`, `wraps each MCP tool in an MCPTool instance`.

### D4: Server instructions in XML-tagged system prompt

**Problem**: MCP `instructions` in `initialize` were discarded.

**Solution**: Read `client.getInstructions()` at connect, cache in
`MCPSessionManager`. Per step, `MCPToolset.processLlmRequest()` wraps in
`<mcp_instructions>` tags and appends to `systemInstruction`. See
[`mcp_toolset.ts`](../core/src/tools/mcp/mcp_toolset.ts) L99–109.

**Why XML**: System prompt is assembled from many sources. XML tags delimit
sections so the LLM can parse them. Matches the pattern used by Claude/Cursor.

**Integration**: [`llm_agent.ts`](../core/src/agents/llm_agent.ts) L1688–1689 calls
`processLlmRequest()` on toolsets (`!isBaseTool(toolUnion)`). Previously only
individual tools had this invoked.

**Tests**: `appends MCP server instructions to llmRequest wrapped in XML tags`,
`does not modify llmRequest when no instructions exist`,
`appends tagged instructions to existing systemInstruction`,
`full pipeline: discover → filter → inject instructions → ready`,
`multiple toolsets each append their own instructions`.

### D5: Tool filtering

**Problem**: `toolFilter` was never applied.

**Solution**: Filter after cache lookup. Supports name array `['tool_a']` and
predicate `(tool, ctx) => boolean`. Edge case: empty `[]` is truthy in JS;
explicit length check prevents filtering out all tools. See
[`mcp_toolset.ts`](../core/src/tools/mcp/mcp_toolset.ts) L76–81.

**Tests**: `filters tools by name array`, `filters tools by predicate`,
`returns all tools when filter is empty array`, `returns empty array when filter matches nothing`,
`predicate receives the context argument`, `returns filtered copy (mutation-safe) with context`.

### D6: Retry-once on `callTool` failure

**Problem**: A single `callTool()` failure was permanent.

**Solution**: try/catch; on failure call `close()`, reconnect, retry once. See
[`mcp_tool.ts`](../core/src/tools/mcp/mcp_tool.ts) L51–62.

**Tests**: `retries once on session failure`, `throws if retry also fails`,
`retries when createSession itself fails on first attempt`,
`propagates close() error when it throws during retry`.

### D7: Raw JSON Schema pass-through (LLM portability)

**Problem**: `toGeminiSchema()` was lossy and Gemini-specific (dropped enum,
format, pattern, etc.).

**Solution**: Use `parametersJsonSchema` and `responseJsonSchema` on
`FunctionDeclaration` — pass MCP raw JSON Schema directly. See
[`mcp_tool.ts`](../core/src/tools/mcp/mcp_tool.ts) L42–49.

**Tests**: `passes MCP JSON Schema directly via parametersJsonSchema`,
`preserves full schema fidelity (enum, format, pattern)`,
`handles tool with no inputSchema properties`,
`passes nested object schema through without conversion`,
`returns undefined responseJsonSchema when outputSchema is missing`,
`passes outputSchema through as responseJsonSchema`.

---

## Spec compliance

| Spec area | Requirement | Status | Notes |
|-----------|------------|--------|-------|
| Lifecycle | Client connects once, operates, shuts down | Done | Session caching |
| Transports | MAY reuse sessions | Done | Cached client |
| Tools | Discover via `tools/list` | Done | Cached after first call |
| Tools | Refresh on `notifications/tools/list_changed` | **Open** | Cache invalidated only via `close()` |
| Initialize | `instructions` MAY be added to system prompt | Done | XML-tagged via `processLlmRequest()` |
| Shutdown | Close transport gracefully | Done | `close()` with error swallowing |

### Open: `notifications/tools/list_changed`

Future work: after `doConnect()`, check `serverCapabilities?.tools?.listChanged`;
if true, register handler for `tools/list_changed` to invalidate
`cachedTools`. Requires back-channel from `MCPSessionManager` to `MCPToolset`.

---

## Comparison with Python ADK

| Capability | Python ADK | JS ADK (this RFC) |
|-----------|------------|-------------------|
| Session caching | Yes (pooled by auth) | Yes (single per manager) |
| Tool list caching | No | Yes |
| Server instructions | No | Yes (XML-tagged) |
| Tool filtering | Yes | Yes |
| Retry on `call_tool` | Yes | Yes |
| Concurrency guard | Partial | Yes (promise coalescing) |
| Transport health | `_is_session_disconnected()` | `onclose` callback |
| JSON Schema pass-through | Yes (feature flag) | Yes (default) |
| Session pooling by auth | Yes | No |

---

## Caching summary

| What | Fetched once | Per step |
|------|--------------|----------|
| Session | `createSession()` → connect | Reuse cached client |
| Tool list | `listTools()` RPC | `getTools()` returns cached `BaseTool[]` |
| Instructions | `getInstructions()` at connect | Cached string appended to `systemInstruction` |
| Tool declarations | — | Pushed to `llmRequest.config.tools` (required; API is stateless) |

---

## Files changed

| File | Change |
|------|--------|
| `core/src/tools/mcp/mcp_session_manager.ts` | Session caching, concurrency guard, `onclose`, `close()`, instructions cache |
| `core/src/tools/mcp/mcp_toolset.ts` | Tool caching, filtering, `processLlmRequest()` with XML tags, `close()` |
| `core/src/tools/mcp/mcp_tool.ts` | Retry-once, `parametersJsonSchema` / `responseJsonSchema` pass-through |
| `core/src/agents/llm_agent.ts` | Call `processLlmRequest()` on toolsets (L1688–1689) |

---

## Test matrix (validates design decisions)

| Test file | Count | Validates |
|-----------|-------|-----------|
| [`mcp_session_manager_test.ts`](../core/test/tools/mcp/mcp_session_manager_test.ts) | 19 | D1 (caching, coalescing, N→1), D2 (onclose), instructions cache, close lifecycle |
| [`mcp_toolset_test.ts`](../core/test/tools/mcp/mcp_toolset_test.ts) | 18 | D3 (tool caching, N→1), D4 (XML-tagged instructions), D5 (filtering) |
| [`mcp_tool_test.ts`](../core/test/tools/mcp/mcp_tool_test.ts) | 16 | D6 (retry-once), D7 (parametersJsonSchema, schema fidelity) |
| [`mcp_toolset_integration_test.ts`](../core/test/tools/mcp/mcp_toolset_integration_test.ts) | 6 | Full pipeline, `isBaseTool` dispatch, multiple toolsets, lifecycle, **N steps = 1 RPC** |
| **Total** | **59** | |

### Improvement tests (explicit before/after validation)

| Test | Improvement shown |
|------|-------------------|
| `improvement: N sequential createSession calls reuse one Client` | Session: N→1 |
| `improvement: N getTools() calls trigger 1 listTools RPC` | Tool list: N→1 |
| `improvement: N simulated steps use cached session and tools (no repeated RPCs)` | Full loop: N→1 |
| `improvement: preserves full schema fidelity (enum, format, pattern)` | Schema: no loss |
| `improvement: retries once on session failure` | Recovery: automatic |

---

## Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Stale tool cache if server changes tools silently | Medium | Future: `notifications/tools/list_changed` handling |
| `close()` racing with in-flight `doConnect()` | Low | `onclose` cleans up; race unlikely |
| `parametersJsonSchema` unsupported by very old Gemini | Low | Current models support it; Python ADK uses it |
| XML tags for LLMs that don't parse XML | Very Low | Content still visible; tags degrade gracefully |

---

## Future improvements

1. **`notifications/tools/list_changed`** — invalidate tool cache on notification
2. **Session pooling by auth** — parity with Python ADK for multi-tenant
3. **Explicit `isError` passthrough** — surface tool execution errors to LLM
