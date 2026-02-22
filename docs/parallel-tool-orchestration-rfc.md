# RFC: High-Impact Parallel Tool Orchestration in ADK-JS

**Status**: Implementation Complete
**Date**: 2026-02-22
**Scope**: `core/src/agents/functions.ts`, `core/src/agents/run_config.ts`
**Tests**: 63/63 passing across 6 files | `tsc --noEmit` clean

---

## 1. Problem & Solution

When an LLM returns multiple `functionCall` parts in a single response, ADK-JS executes them **sequentially** — three independent 1-second tool calls take ~3s instead of ~1s. ADK-Python already runs them in parallel via `asyncio.gather`. No existing issue or PR on `google/adk-js` addresses this.

**Solution**: Replace the sequential `for...of await` loop in `handleFunctionCallList` with `Promise.allSettled`, configurable via `RunConfig.parallelToolExecution` (default: `true`), with optional concurrency limiting via `RunConfig.maxConcurrentToolCalls`.

```
BEFORE (sequential):   Tool A ──▸ Tool B ──▸ Tool C ──▸ merge   total: ~3s
AFTER  (parallel):     Tool A ──┐
                       Tool B ──┼──▸ merge                      total: ~1s
                       Tool C ──┘
AFTER  (batched, max=2):
                       Tool A ──┐
                       Tool B ──┼──▸ Tool C ──▸ merge           total: ~2s
```

### Why `Promise.allSettled` over `Promise.all`

| | `Promise.all` | `Promise.allSettled` |
|---|---|---|
| One tool throws | All results lost | Other tools complete normally |
| Model feedback | Loses successful results | Model sees all results + errors |

This is also an **improvement over Python**: Python uses `asyncio.gather` without `return_exceptions=True` — if a tool error goes unhandled by callbacks, `asyncio.gather` fails immediately, losing results from other tools. `Promise.allSettled` always waits for all tools.

### Why configurable

| Use Case | `parallelToolExecution` | `maxConcurrentToolCalls` |
|---|---|---|
| Independent API calls (default) | `true` | — |
| Rate-limited APIs | `true` | `2`–`3` |
| Tools with state interdependencies | `false` | — |
| Debugging / deterministic ordering | `false` | — |

---

## 2. Python Reference

**Source**: [`google/adk-python/.../functions.py`](https://github.com/google/adk-python/blob/main/src/google/adk/flows/llm_flows/functions.py)

```python
# handle_function_call_list_async — dispatch
tasks = [
    asyncio.create_task(
        _execute_single_function_call_async(
            invocation_context, function_call, tools_dict, agent,
            tool_confirmation_dict[function_call.id] if tool_confirmation_dict else None,
        )
    )
    for function_call in filtered_calls
]
function_response_events = await asyncio.gather(*tasks)
```

```python
# _execute_single_function_call_async — 6-step pipeline per call
async def _execute_single_function_call_async(...) -> Optional[Event]:
    tool_context = _create_tool_context(invocation_context, function_call, tool_confirmation)
    tool = _get_tool(function_call, tools_dict)

    async def _run_with_trace():
        # 1. plugin before_tool_callback
        # 2. canonical before callbacks
        # 3. call tool (with error callback chain — re-raises if unhandled)
        # 4. plugin after_tool_callback
        # 5. canonical after callbacks
        # 6. build response event

    with tracer.start_as_current_span(f'execute_tool {tool.name}'):
        return await _run_with_trace()
```

**Key design**: isolated `ToolContext` per call, full callback pipeline per call, own tracing span per call.

### Python ↔ JS mapping

| Python ADK | JS ADK | Notes |
|---|---|---|
| `asyncio.gather` | `Promise.allSettled` | JS is more resilient — always completes all |
| `_execute_single_function_call_async` | `executeSingleFunctionCall` | Same 6-step pipeline |
| `_create_tool_context` | `getToolAndContext` | Isolated per call |
| Unhandled errors re-raised | Rejections caught, error event built | JS improvement |
| No config (always parallel) | `RunConfig.parallelToolExecution` | JS adds escape hatch |
| No concurrency limit | `RunConfig.maxConcurrentToolCalls` | JS adds back-pressure |
| `ToolThreadPoolConfig` for live mode | N/A | JS single-threaded |
| No stateDelta conflict detection | Logger warning on overlapping keys | JS adds observability |

---

## 3. Implementation

### 3.1 `RunConfig` — new flags

```typescript
// core/src/agents/run_config.ts
export interface RunConfig {
  // ... existing fields ...

  /** true (default): concurrent via Promise.allSettled. false: sequential. */
  parallelToolExecution?: boolean;

  /**
   * Max concurrent tool calls when parallelToolExecution is true.
   * Positive int: dispatch in batches of this size.
   * Undefined/0: all at once (no limit). Ignored when sequential.
   */
  maxConcurrentToolCalls?: number;
}

export function createRunConfig(params: Partial<RunConfig> = {}) {
  return {
    // ... existing defaults ...
    parallelToolExecution: true,
    ...params,
  };
}
```

### 3.2 `executeSingleFunctionCall` — extracted from loop body

Mirrors Python's `_execute_single_function_call_async` with the same 6-step pipeline:

1. Plugin `beforeToolCallback`
2. Canonical `beforeToolCallbacks` (chain, first non-null wins)
3. `callToolAsync` with error callback chain (`onToolErrorCallback`)
4. Plugin `afterToolCallback`
5. Canonical `afterToolCallbacks` (chain, first non-null wins)
6. Build response event

Returns `Event | null` — errors are captured internally (never rejects for tool-level errors), long-running tools may return `null`.

### 3.3 `handleFunctionCallList` — configurable dispatch

```typescript
export async function handleFunctionCallList({ ... }): Promise<Event | null> {
  const filteredFunctionCalls = functionCalls.filter(fc =>
    !filters || (fc.id && filters.has(fc.id))
  );
  if (!filteredFunctionCalls.length) return null;

  const parallel = invocationContext.runConfig?.parallelToolExecution ?? true;
  const functionResponseEvents: Event[] = [];

  if (parallel) {
    const makeTask = (fc) => () => executeSingleFunctionCall({ ... });
    const maxConcurrency = invocationContext.runConfig?.maxConcurrentToolCalls;
    const useBatching = maxConcurrency && maxConcurrency > 0
      && filteredFunctionCalls.length > maxConcurrency;

    let results: PromiseSettledResult<Event | null>[];

    if (useBatching) {
      results = [];
      for (let i = 0; i < filteredFunctionCalls.length; i += maxConcurrency) {
        const batch = filteredFunctionCalls.slice(i, i + maxConcurrency);
        results.push(...await Promise.allSettled(batch.map(fc => makeTask(fc)())));
      }
    } else {
      results = await Promise.allSettled(filteredFunctionCalls.map(fc => makeTask(fc)()));
    }

    // Process settled results (fulfilled → push event, rejected → build error event)
    // Detect stateDelta key conflicts and warn
  } else {
    // Sequential execution — preserves original ordering guarantees.
  }

  return mergeParallelFunctionResponseEvents(functionResponseEvents);
}
```

### 3.4 stateDelta conflict detection

After parallel execution, overlapping `stateDelta` keys across tool results are detected and logged:

```
[ADK WARN]: Parallel tool calls wrote to the same stateDelta key(s): [counter].
Last-write-wins applies — consider sequential mode if ordering matters.
```

This provides observability without breaking execution — `mergeEventActions` applies `Object.assign` (last-write-wins) as before.

### 3.5 Unchanged components

| Component | Why |
|---|---|
| `handleFunctionCallsAsync` | Thin wrapper — delegates to `handleFunctionCallList` |
| `callToolAsync` | Self-contained with own tracing span |
| `getToolAndContext` | Creates isolated `ToolContext` per call |
| `mergeParallelFunctionResponseEvents` | Already handles N events |
| `llm_agent.ts` | Calls `handleFunctionCallsAsync` — picks up change automatically |

---

## 4. Testing

### Results

```
 ✓ test/agents/functions_test.ts              31 passed   996ms
 ✓ test/agents/agent_tool_integration_test.ts  8 passed   624ms
 ✓ Full agent suite                           63 passed   (6 files)
 ✓ tsc --noEmit                                0 errors
```

### Unit tests — `functions_test.ts` (15 new)

| # | Test | Mode | Validates |
|---|---|---|---|
| 1 | `should execute multiple tools concurrently` | parallel | 3 tools finish in ~1x delay, not ~3x |
| 2 | `should isolate errors` | parallel | 1 fail + 2 succeed = all 3 responses |
| 3 | `should preserve result order` | parallel | Slow first, fast second = input order |
| 4 | `should run callbacks concurrently` | parallel | All before/after fire for each tool |
| 5 | `single function call behaves identically` | parallel | Single-tool regression |
| 6 | `should fall back to sequential` | sequential | Trace: A-start, A-end, B-start, B-end |
| 7 | `sequential: error does not stop subsequent` | sequential | Fail A → B still executes |
| 8 | `defaults to parallel when runConfig undefined` | default | Undefined config → parallel timing |
| 9 | `tool-not-found produces error event` | parallel | Missing tool → error event, other succeeds |
| 10 | `returns null when all filtered out` | both | Empty filter → null |
| 11 | `sequential takes longer than parallel` | both | Sequential > 1.5x parallel |
| 12 | `maxConcurrentToolCalls limits batch size` | parallel | 5 tools, max=2 → peak concurrency ≤ 2 |
| 13 | `maxConcurrentToolCalls ignored in sequential` | sequential | Still strict A→B→C order |
| 14 | `warns on stateDelta key conflicts` | parallel | `console.warn` contains conflicting key name |
| 15 | `no warning when keys are disjoint` | parallel | No stateDelta warning emitted |

### Integration tests — `agent_tool_integration_test.ts` (8 new)

Full pipeline: `Runner → LlmAgent → MockLlm → handleFunctionCallList → tools → merge → back to LLM`.

| # | Test | Validates |
|---|---|---|
| 1 | `executes 3 parallel tool calls and returns all results` | LLM returns 3 function calls → all 3 tool results + model summary |
| 2 | `parallel mode is faster than sequential` | Same 3 tools: parallel timing < sequential timing × 1.5 |
| 3 | `sequential mode preserves strict execution order` | Execution trace: A-start, A-end, B-start, B-end |
| 4 | `one failing tool does not prevent others` | 1 throw + 1 success → both responses reach the model |
| 5 | `callbacks fire for each tool in multi-tool call` | `beforeToolCallback` + `afterToolCallback` fire for each |
| 6 | `agent completes the loop: tools → model summary` | Tool result flows back, model generates final text |
| 7 | `maxConcurrentToolCalls limits concurrency in full loop` | 4 tools, max=2 → peak concurrency ≤ 2 through Runner |
| 8 | `parallel execution proves concurrency via overlapping order` | Both tool starts occur before any end (no timing dependency) |

---

## 5. Risks & Edge Cases

| Concern | Severity | Behavior / Mitigation |
|---|---|---|
| `stateDelta` race (same key) | Low | Last-write-wins via `Object.assign`. **Now detected and warned.** |
| `transferToAgent` conflict | Low | Last in merge order wins. Models rarely emit competing transfers. |
| `endInvocation` shared flag | None | Checked *after* `handleFunctionCallsAsync` returns — parallel tools finish, then loop exits. |
| Callback ordering | Low | Non-deterministic in parallel. Use `parallelToolExecution: false` for order-sensitive code. |
| Plugin concurrency safety | Low | Each call gets isolated `ToolContext`. No shared mutable state by default. |
| Rate limiting (concurrent HTTP) | None | **`maxConcurrentToolCalls` provides back-pressure.** |
| Tool not found | None | `Promise.allSettled` catches rejection, builds error event. Other tools unaffected. Tested. |
| Single tool call | None | No behavioral change — same path, no merge. Tested. |
| `runConfig` undefined | None | Defaults to `true` (parallel). Tested. |
| CI timing flakiness | None | Key tests use execution-order tracking (overlapping starts) instead of wall-clock assertions. |

---

## 6. Usage

```typescript
// Default — parallel, no changes needed
const result = await runner.runAsync({ userId: 'u1', sessionId: 's1', newMessage });

// Opt-out to sequential
const result = await runner.runAsync({
  userId: 'u1', sessionId: 's1', newMessage,
  runConfig: { parallelToolExecution: false },
});

// Parallel with concurrency limit (e.g., rate-limited API)
const result = await runner.runAsync({
  userId: 'u1', sessionId: 's1', newMessage,
  runConfig: { parallelToolExecution: true, maxConcurrentToolCalls: 3 },
});
```

---

## 7. Documentation Additions (Ready to Copy)

### 7.1 RunConfig API docs

Add these options to the public `RunConfig` reference:

| Option | Type | Default | Description |
|---|---|---|---|
| `parallelToolExecution` | `boolean` | `true` | Enables concurrent execution of multiple tool calls in a single model turn. Set to `false` for strict sequential behavior. |
| `maxConcurrentToolCalls` | `number` | `undefined` | Optional concurrency cap used only when `parallelToolExecution` is `true`. Positive values execute tools in batches. |

### 7.2 Behavior note for multi-tool responses

When a model emits multiple `functionCall` parts in one response:

- ADK-JS now executes them in parallel by default.
- Results are merged and returned together.
- One tool failure does not cancel sibling tool executions.
- If tool ordering matters, disable parallel mode.

### 7.3 Recommended docs snippet

```typescript
// Default behavior (recommended): parallel tool orchestration
runConfig: {
  parallelToolExecution: true,
}

// Rate-limited environments
runConfig: {
  parallelToolExecution: true,
  maxConcurrentToolCalls: 2,
}

// Deterministic, order-sensitive tools
runConfig: {
  parallelToolExecution: false,
}
```

---

## 8. Files Changed

| File | Change |
|---|---|
| `core/src/agents/run_config.ts` | Added `parallelToolExecution?: boolean` (default `true`) and `maxConcurrentToolCalls?: number` |
| `core/src/agents/functions.ts` | Extracted `executeSingleFunctionCall`, rewrote `handleFunctionCallList` with configurable dispatch, batched concurrency, stateDelta conflict warning |
| `core/test/agents/functions_test.ts` | Added 15 unit tests for parallel/sequential/concurrency-limit/stateDelta |
| `core/test/agents/agent_tool_integration_test.ts` | **New file** — 8 integration tests: full Runner→Agent→LLM→Tools pipeline |

---

## 9. References

| Source | Link |
|---|---|
| ADK-Python `functions.py` | https://github.com/google/adk-python/blob/main/src/google/adk/flows/llm_flows/functions.py |
| ADK-Python `run_config.py` | https://github.com/google/adk-python/blob/main/src/google/adk/agents/run_config.py |
| ADK-JS `functions.ts` | https://github.com/google/adk-js/blob/main/core/src/agents/functions.ts |
| ADK-JS `event_actions.ts` | https://github.com/google/adk-js/blob/main/core/src/events/event_actions.ts |
| ADK-JS `llm_agent.ts` | https://github.com/google/adk-js/blob/main/core/src/agents/llm_agent.ts |
