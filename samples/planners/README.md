# Planners Sample (`BuiltInPlanner` and `PlanReActPlanner`)

This sample demonstrates how the `planner` option on `LlmAgent` makes an agent plan before it acts, with `BuiltInPlanner` for a model that has built-in thinking and `PlanReActPlanner` for a model that does not.

## Overview

`data_processing_agent` is an `LlmAgent` that rolls dice with the `roll_die` tool and checks the results with the `check_prime` tool. By default it uses `BuiltInPlanner` with `thinkingConfig: {includeThoughts: true}`, so the model returns its own thoughts as parts with `thought: true`. Set `ADK_SAMPLE_PLANNER=plan_react` to use `PlanReActPlanner` instead: it adds a planning instruction to each request and marks the tagged planning and reasoning text in each response as thoughts. Any other value of `ADK_SAMPLE_PLANNER` stops the sample with an error. The tools and the instruction are ported from the adk-python dice agent.

## Sample Inputs

- `Roll a 20-sided die and check if the result is prime.`

  _Calls `roll_die` with `sides: 20`, then `check_prime` with the result, and answers with the roll and whether it is prime. The thought parts show the plan._

- `Roll two 6-sided dice and check which results are prime.`

  _Makes two `roll_die` calls, then one `check_prime` call with both results. With `PlanReActPlanner`, the `/*PLANNING*/` and `/*REASONING*/` sections come back as thought parts and the text after `/*FINAL_ANSWER*/` is the answer._

## Running the Sample

The sample calls a live model, so set `GEMINI_API_KEY` first.

Run the self-contained `InMemoryRunner` script directly to print thought parts, function calls, and the answer on separate lines:

```bash
npx tsx samples/planners/agent.ts
```

Or run the exported `rootAgent` interactively through the ADK CLI after building the workspace. The CLI prints the text of every part together, so thoughts and the answer appear in one line:

```bash
npm run build
npm run sample -- samples/planners/agent.ts
```

Select the planner with `ADK_SAMPLE_PLANNER`. `built_in` is the default:

```bash
ADK_SAMPLE_PLANNER=plan_react npx tsx samples/planners/agent.ts
ADK_SAMPLE_PLANNER=plan_react npm run sample -- samples/planners/agent.ts
```

`samples/` is not an npm workspace, so it is type-checked separately:

```bash
npm run ts:check:samples
```

## Related Guides

- [Planners](../../docs/guides/planners/index.md) - The `LlmAgent` `planner` option, `BasePlanner`, `BuiltInPlanner`, `PlanReActPlanner`, `isBasePlanner`, and `isBuiltInPlanner`.
