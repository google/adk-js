/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Loop route
 * https://adk.dev/graphs/dynamic/#loop-route
 *
 * This is where dynamic workflows earn their keep: the iteration is an ordinary
 * `while` loop, not a back-edge you have to reason about. Values live in local
 * variables; state is written only where an agent's instruction template needs
 * to read it back (`{code}`, `{findings}`).
 *
 * Unlike a graph cycle, the loop is trivially bounded — `MAX_FIX_ROUNDS` here —
 * so a stubborn model cannot spin forever burning live model calls.
 *
 * REQUIRES an API key (two agents call a live model). Set GEMINI_API_KEY:
 *   npm run sample -- samples/workflows/dynamic/loop_route/agent.ts
 * Try "a one-line function that adds two numbers, no comments, no type
 * annotations" — asking for code the linter will reject is what makes the loop
 * run. A plainly-worded request ("a function that returns the nth fibonacci
 * number") comes back documented and annotated on the first try, `findings` is
 * empty, and the loop exits before the fixer ever runs.
 */

import {LlmAgent, node, NodeContext, WorkflowAgent} from '@google/adk';

/** Safety bound on the refine loop. */
const MAX_FIX_ROUNDS = 3;

const coderAgent = new LlmAgent({
  name: 'generator_agent',
  model: 'gemini-flash-latest',
  instruction: 'Write TypeScript code for the user request. Output code only.',
});

/** Simulates a compile / lint pass. Empty findings means "clean". */
const compileLintCheck = node(
  (_ctx: NodeContext, code: string) => {
    const findings: string[] = [];
    if (!/\/\*\*/.test(code)) {
      findings.push('every function needs a JSDoc comment');
    }
    if (!/\)\s*:\s*\w/.test(code)) {
      findings.push('add return type annotations');
    }
    return {findings: findings.join('; ')};
  },
  {name: 'lint_reviewer'},
);

const fixerAgent = new LlmAgent({
  name: 'fixer_agent',
  model: 'gemini-flash-latest',
  instruction: `Refactor current code {code}.
      Based on compile & lint review: {findings}
      Output code only.`,
});

const codeWorkflow = node(
  async (ctx: NodeContext, userRequest: string) => {
    let code = (await ctx.runNode(coderAgent, userRequest)).output as string;
    let checkResp = (await ctx.runNode(compileLintCheck, code)).output as {
      findings: string;
    };

    for (let round = 0; checkResp.findings && round < MAX_FIX_ROUNDS; round++) {
      // The fixer agent reads `{code}` / `{findings}` from session state.
      ctx.state.set('code', code);
      ctx.state.set('findings', checkResp.findings);

      code = (
        await ctx.runNode(fixerAgent, {code, findings: checkResp.findings})
      ).output as string;
      checkResp = (await ctx.runNode(compileLintCheck, code)).output as {
        findings: string;
      };
    }

    return code;
  },
  {name: 'code_workflow', rerunOnResume: true},
);

export const rootAgent = new WorkflowAgent({
  name: 'root_agent',
  edges: [['START', codeWorkflow]],
});
