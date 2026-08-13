/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {node} from '../../src/workflow/node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveWorkflow, replyAgent, transferringAgent} from './test_helpers.js';

describe('multi-agent hand-off (transfer_to_agent)', () => {
  it('follows a transfer to a peer agent and uses its output', async () => {
    const specialist = replyAgent('specialist', 'specialist-answer');
    const coordinator = transferringAgent('coordinator', 'specialist', [
      specialist,
    ]);

    const wf = new Workflow({
      name: 'transfer_wf',
      edges: [['START', coordinator]],
    });
    const {output, events} = await driveWorkflow(wf, 'question');

    expect(output).toBe('specialist-answer');
    expect(
      events.some((e) => e.actions?.transferToAgent === 'specialist'),
    ).toBe(true);
    expect(events.some((e) => e.author === 'specialist')).toBe(true);
  });

  it('follows a chain of transfers', async () => {
    const c = replyAgent('c_agent', 'final');
    const b = transferringAgent('b_agent', 'c_agent', [c]);
    const a = transferringAgent('a_agent', 'b_agent', [b]);

    const wf = new Workflow({name: 'chain_wf', edges: [['START', a]]});
    expect((await driveWorkflow(wf, 'x')).output).toBe('final');
  });
});

describe('multi-agent orchestration via ctx.runNode', () => {
  it('coordinates specialist agents imperatively (node-as-tool)', async () => {
    const researcher = replyAgent('researcher', 'facts');
    const writer = replyAgent('writer', 'report');

    // Idiomatic TS multi-agent: a coordinator drives sub-agents via runNode.
    const wf = new Workflow({
      name: 'coordinator_wf',
      dynamicEntry: async (ctx, input) => {
        const research = await ctx.runNode(node(researcher), input);
        const draft = await ctx.runNode(node(writer), research.output);
        return {research: research.output, draft: draft.output};
      },
    });

    expect(await driveWorkflow(wf, 'topic').then((r) => r.output)).toEqual({
      research: 'facts',
      draft: 'report',
    });
  });
});
