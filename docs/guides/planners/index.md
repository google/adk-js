# Planners (`BasePlanner`, `BuiltInPlanner`, and `PlanReActPlanner`)

A planner makes an `LlmAgent` in the Agent Development Kit (ADK) plan before it acts. You set it with the `planner` option, and the agent applies it to every model request and response.

All planners extend `BasePlanner`, and the package exports two implementations and two type guards:

- `BasePlanner` - The abstract base. It builds an optional planning instruction for each request and optionally rewrites the parts of each response.
- `BuiltInPlanner` - Uses the model's built-in thinking. It sets `thinkingConfig` on the request and changes nothing else.
- `PlanReActPlanner` - Adds a Plan-ReAct instruction to the request, and marks the tagged planning and reasoning text in the response as thoughts. It does not need a model with built-in thinking.
- `isBasePlanner` and `isBuiltInPlanner` - Type guards that identify planners without `instanceof`.

## Introduction

Without a planner, an agent sends the request and uses the response as it is. A planner changes both sides. Before the request goes to the model, it can add an instruction or change the request config. After the response comes back, it can rewrite the response parts, for example to mark planning text as a thought so that it is kept apart from the answer.

Choose the planner from what the model can do:

- **`BuiltInPlanner`** for a model with built-in thinking, such as a Gemini thinking model. The model plans on its own, and returns its thoughts as parts with `thought: true` when you set `includeThoughts: true`. The planner only sets `thinkingConfig`.
- **`PlanReActPlanner`** for a model without built-in thinking. The planner tells the model, in an instruction, to write its plan, reasoning, actions, and final answer under fixed tags, and then marks the planning and reasoning text as thoughts.
- **A `BasePlanner` subclass** when you need your own instruction or your own response rewrite.

## Get started

Give an `LlmAgent` a `BuiltInPlanner` and a tool, run it with `InMemoryRunner`, and print the thought parts apart from the answer. `stringifyContent` already leaves out thought parts.

```ts
import {
  BuiltInPlanner,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  stringifyContent,
} from '@google/adk';
import {z} from 'zod';

const rollDie = new FunctionTool({
  name: 'roll_die',
  description: 'Roll a die and return the rolled result.',
  parameters: z.object({
    sides: z.number().int().describe('The number of sides the die has.'),
  }),
  execute: ({sides}) => Math.floor(Math.random() * sides) + 1,
});

const agent = new LlmAgent({
  name: 'dice_agent',
  model: 'gemini-flash-latest',
  instruction: 'Roll dice with the roll_die tool when the user asks.',
  tools: [rollDie],
  planner: new BuiltInPlanner({thinkingConfig: {includeThoughts: true}}),
});

const runner = new InMemoryRunner({agent, appName: 'planner_app'});
const session = await runner.sessionService.createSession({
  appName: 'planner_app',
  userId: 'user-1',
});

for await (const event of runner.runAsync({
  userId: 'user-1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Roll a 20-sided die.'}]},
})) {
  for (const part of event.content?.parts ?? []) {
    if (part.thought && part.text) {
      console.log('Thought:', part.text);
    }
  }
  const answer = stringifyContent(event);
  if (answer) {
    console.log('Answer:', answer);
  }
}
```

For a model without built-in thinking, use `PlanReActPlanner` instead. Its constructor takes no arguments, and the loop above prints its planning and reasoning sections as thoughts:

```ts
import {LlmAgent, PlanReActPlanner} from '@google/adk';

const planReActAgent = new LlmAgent({
  name: 'dice_agent',
  model: 'gemini-flash-latest',
  instruction: 'Roll dice with the roll_die tool when the user asks.',
  tools: [rollDie],
  planner: new PlanReActPlanner(),
});
```

## How it works

1. **The request processor (`NL_PLANNING_REQUEST_PROCESSOR`)**: In the default request processor chain, the planning processor runs after `CONTENT_REQUEST_PROCESSOR` has built `llmRequest.contents`, and before the interactions, code-execution, and tool-filter processors. It does nothing when the agent has no planner, or when `planner` fails `isBasePlanner`. Otherwise it does three things, in this order:
   - If the planner is a `BuiltInPlanner`, it calls `applyThinkingConfig(llmRequest)`, which sets `llmRequest.config.thinkingConfig`.
   - It calls `buildPlanningInstruction(readonlyContext, llmRequest)`. If the result is a non-empty string, it appends that string to the system instruction with `appendInstructions`.
   - It copies every part of `llmRequest.contents` without its `thought` flag. Planning output from earlier turns, such as reasoning that `PlanReActPlanner` marked as a thought, therefore goes back to the model as plain text. The processor copies the parts, so the events stored in the session keep their `thought` flags.
2. **`thinkingConfig` precedence (`BuiltInPlanner`)**: `applyThinkingConfig` replaces `llmRequest.config.thinkingConfig` with the planner's `thinkingConfig`. It does not merge the two, so a `generateContentConfig.thinkingConfig` on the agent has no effect when the planner is a `BuiltInPlanner`. When you set both, the `LlmAgent` constructor logs this warning. Nothing is logged when a request is sent:

   ```text
   Agent <name>: both generateContentConfig.thinkingConfig and planner.thinkingConfig are set. The planner's thinkingConfig takes precedence.
   ```

3. **The response processor (`NL_PLANNING_RESPONSE_PROCESSOR`)**: This is the only default response processor. It runs on every response from the model, before the agent builds the event from it. When the agent has a planner and the response has parts, it calls `processPlanningResponse(callbackContext, parts)`. If the result is not `undefined`, it replaces `llmResponse.content.parts` with the result. `BuiltInPlanner` returns `undefined`, so its responses are unchanged: the model sets `thought: true` itself.
4. **`PlanReActPlanner` response processing**: The instruction asks the model to write its plan under `/*PLANNING*/`, a revised plan under `/*REPLANNING*/`, tool code under `/*ACTION*/`, reasoning under `/*REASONING*/`, and the answer under `/*FINAL_ANSWER*/`. The planner then processes the response parts as follows, and copies each part it changes instead of changing it in place:
   - **Function-call boundary**: It keeps the parts up to and including the first function call with a non-empty name, and drops the rest. It skips a function call with an empty name that comes before that first call. When the first call is not the first part, it also keeps the function calls that follow it with no other part between them. When the first call is the first part, it keeps only that one call.
   - **Final answer**: It splits a text part that contains `/*FINAL_ANSWER*/` at the last occurrence of the tag. The text up to and including the tag becomes a part with `thought: true`, and the text after it becomes a plain part. An empty side is dropped.
   - **Reasoning**: It marks a text part with `thought: true` when the text starts with `/*PLANNING*/`, `/*REASONING*/`, `/*ACTION*/`, or `/*REPLANNING*/`. A part where the tag is not at the start stays a plain part.
5. **Where thoughts go**: `stringifyContent(event)` leaves out thought parts, and `hasThoughts(event)` and `pruneThoughts(event)` find and remove them. When an agent builds its context from events that another agent wrote, it drops that agent's thought text. The `npm run sample` CLI prints the text of every part together, thoughts included.

## Configuration options

### `LlmAgent` planner option

| Property                               | Type                         | Default       | Description                                                                                                           |
| :------------------------------------- | :--------------------------- | :------------ | :-------------------------------------------------------------------------------------------------------------------- |
| `planner`                              | `BasePlanner`                | `undefined`   | The planner the agent applies to each model request and response. Without it, the planning processors change nothing. |
| `generateContentConfig.thinkingConfig` | `ThinkingConfig`             | `undefined`   | Sent to the model as given, unless `planner` is a `BuiltInPlanner`. The planner's `thinkingConfig` then replaces it.  |
| `requestProcessors`                    | `BaseLlmRequestProcessor[]`  | Default chain | Replaces the default request processors, including the planning request processor. See Limitations.                   |
| `responseProcessors`                   | `BaseLlmResponseProcessor[]` | Default chain | Replaces the default response processors, including the planning response processor. See Limitations.                 |

### `BuiltInPlanner` constructor options

| Property         | Type             | Default  | Description                                                                                                                                                  |
| :--------------- | :--------------- | :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thinkingConfig` | `ThinkingConfig` | Required | The `@google/genai` thinking config set on every request, for example `{includeThoughts: true}`. The model returns an error if it does not support thinking. |

### `PlanReActPlanner` constructor

`new PlanReActPlanner()` takes no arguments. The instruction and the tags are fixed.

### `BasePlanner` abstract methods

| Method                     | Parameters                                                   | Return type           | Description                                                                                                                               |
| :------------------------- | :----------------------------------------------------------- | :-------------------- | :---------------------------------------------------------------------------------------------------------------------------------------- |
| `buildPlanningInstruction` | `readonlyContext: ReadonlyContext`, `llmRequest: LlmRequest` | `string \| undefined` | The instruction to append to the system instruction. Return `undefined` or an empty string to append nothing. Do not change `llmRequest`. |
| `processPlanningResponse`  | `callbackContext: Context`, `responseParts: Part[]`          | `Part[] \| undefined` | The parts that replace the response parts. Return `undefined` to keep the response as it is. Do not change `responseParts` in place.      |

## Advanced applications

### Writing a custom `BasePlanner`

Extend `BasePlanner` and implement both methods. This planner asks the model to write a one-line plan before it calls a tool, and marks that line as a thought:

```ts
import {
  BasePlanner,
  Context,
  ReadonlyContext,
  type LlmRequest,
} from '@google/adk';
import {Part} from '@google/genai';

const PLAN_MARKER = 'PLAN:';

export class OneLinePlanner extends BasePlanner {
  buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string {
    return `Before you call a tool, write one line that starts with "${PLAN_MARKER}" and lists the steps you will take.`;
  }

  processPlanningResponse(
    _callbackContext: Context,
    responseParts: Part[],
  ): Part[] | undefined {
    if (!responseParts.some((part) => part.text?.startsWith(PLAN_MARKER))) {
      return undefined;
    }
    return responseParts.map((part) =>
      part.text?.startsWith(PLAN_MARKER) ? {...part, thought: true} : part,
    );
  }
}
```

Pass it as `planner: new OneLinePlanner()`. Keep these rules in mind:

- **Extend the class.** The processors accept a planner only if `isBasePlanner` is true for it. An object that has the two methods but does not extend `BasePlanner` is ignored.
- **Return `undefined` to keep the response.** An empty array replaces the parts with nothing, and the agent then emits no event for that response.
- **Copy, do not mutate.** The response parts can be shared with other code, so return new part objects, as the example does with `{...part, thought: true}`.
- **Treat the request as read-only.** `buildPlanningInstruction` receives `llmRequest` to read, not to change. The request processor sets `thinkingConfig` only for a planner where `isBuiltInPlanner` is true.

### Identifying planners with `isBasePlanner` and `isBuiltInPlanner`

Use the type guards instead of `instanceof`. When an application loads two copies of `@google/adk`, a planner built by one copy fails `instanceof` against the class from the other copy. The guards check a brand symbol (`Symbol.for('google.adk.basePlanner')` and `Symbol.for('google.adk.builtInPlanner')`), which both copies share.

```ts
import {isBasePlanner, isBuiltInPlanner, LlmAgent} from '@google/adk';

function describePlanner(agent: LlmAgent): string {
  if (isBuiltInPlanner(agent.planner)) {
    return `built-in thinking: ${JSON.stringify(agent.planner.thinkingConfig)}`;
  }
  if (isBasePlanner(agent.planner)) {
    return 'instruction-based planner';
  }
  return 'no planner';
}
```

### Streaming with `StreamingMode.SSE`

With `StreamingMode.SSE`, the runner yields partial events while the model writes, and the planner processes each of them. Check `event.partial` to tell a chunk from a complete response. Only the complete responses are saved to the session.

```ts
import {StreamingMode} from '@google/adk';

for await (const event of runner.runAsync({
  userId: 'user-1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Roll a 6-sided die.'}]},
  runConfig: {streamingMode: StreamingMode.SSE},
})) {
  const kind = event.partial ? 'chunk' : 'complete';
  for (const part of event.content?.parts ?? []) {
    if (part.text) {
      console.log(kind, part.thought ? 'thought:' : 'text:', part.text);
    }
  }
}
```

## Limitations

- **Partial streaming responses are processed one chunk at a time**: The response processor has no check for `partial`, so with `StreamingMode.SSE` each partial chunk goes through `processPlanningResponse` on its own. `PlanReActPlanner` marks a chunk as a thought only if that chunk's own text starts with a tag or contains `/*FINAL_ANSWER*/`. When a reasoning section spans several chunks, the later chunks arrive as plain text. The complete, non-partial response that follows is processed again as a whole, and only that response is saved to the session. adk-python has the same behaviour: its planning response processor has no partial check either. `BuiltInPlanner` is not affected, because the model sets `thought` itself.
- **Streaming splits text and function calls**: By default, the SSE stream aggregator emits the text before a function call and the function calls as two separate complete responses, and the planner processes each one on its own. The function-call response then starts with a call, so `PlanReActPlanner` keeps only the first call of a parallel group. Without streaming, the text and the calls arrive in one response, and the planner keeps all the calls that follow the text.
- **`thinkingConfig` is replaced, not merged**: A `BuiltInPlanner` replaces the whole `thinkingConfig` of the request. Fields that you set only in `generateContentConfig.thinkingConfig`, such as a thinking budget, are lost. Put every thinking field on the planner.
- **Thinking must be supported**: If you set `thinkingConfig` for a model that does not support thinking, the model returns an error.
- **The Plan-ReAct instruction is fixed**: The instruction text matches the adk-python wording exactly, and you cannot change it without a custom planner. Its tool-code section tells the model that the code "must be valid self-contained Python snippets", even in TypeScript. The agent still calls tools as function calls.
- **The tags depend on the model**: `PlanReActPlanner` works only as well as the model follows the tag format. A part where the tag is not at the start stays a plain part, and text with no tags stays plain text.
- **Custom processor arrays remove planning**: If you pass `requestProcessors` or `responseProcessors` to `LlmAgent`, they replace the default chains, and the planner is not applied unless those arrays contain the planning processors. The package does not export the planning processors by name.

## Related samples

- [`samples/planners/`](../../../samples/planners/README.md) - Runnable dice-and-primes agent that uses `BuiltInPlanner` by default and `PlanReActPlanner` with `ADK_SAMPLE_PLANNER=plan_react`, and prints thought parts apart from the answer.
