/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Executes the docs-page ports in `samples/workflows/`.
 *
 * Lint, Prettier, the license check and `ts:check:samples` all read these files
 * already, so a syntax, style, license or type error fails CI. Nothing ran
 * them, which left the interesting failure uncovered: a `Workflow`
 * validates its graph in its constructor, so a rename or a semantics change in
 * the `@experimental` workflow API can turn a sample into a load-time error
 * that still type-checks.
 *
 * Every sample is constructed. The ones that call no model are also run through
 * a real `InMemoryRunner`, with the record/replay model installed on an empty
 * response set — so an accidental model call in an "offline" sample throws
 * rather than silently reaching the network.
 *
 * The model-backed samples are constructed only. Driving them would mean
 * checking in a fixture per sample, and the behaviour they add over the
 * sibling `tests/integration/workflows/` set is prompt wording, not graph
 * shape.
 */

import {Event} from '@google/adk';
import {readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  allEvents,
  finalOutput,
  runSample,
} from '../workflows/_harness/sample_harness.js';

const SAMPLES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../samples/workflows',
);

/** Turns to drive an offline sample with, and what to expect back. */
interface OfflineSample {
  /** User turns, in order. A second turn resumes a sample that pauses. */
  turns: string[];
  /** Set for a sample that pauses for a human on its first turn. */
  pausesOnFirstTurn?: boolean;
  /**
   * The exact final output, for a sample whose transformation is the point and
   * so is worth pinning rather than just asserting something came back.
   */
  expectedFinalOutput?: unknown;
}

/**
 * The samples that run without an API key, and the turns that drive them.
 *
 * `hello world` is the generic turn; a sample gets something more specific only
 * where its nodes actually parse the input.
 */
const OFFLINE: Record<string, OfflineSample> = {
  'data_handling/node_output': {turns: ['hello world']},
  'data_handling/routing_output': {turns: ['this is a bug report']},
  'data_handling/session_state': {turns: ['hello world']},
  'data_handling/structured_output': {turns: ['hello world']},
  'data_handling/user_message': {turns: ['hello world']},
  'dynamic/custom_run_ids': {turns: ['hello world']},
  'dynamic/get_started': {turns: ['hello world']},
  'dynamic/human_input': {
    turns: ['please approve', 'yes'],
    pausesOnFirstTurn: true,
  },
  'dynamic/nodes': {turns: ['hello world']},
  'dynamic/parallel_route': {turns: ['alpha, beta, gamma']},
  'human_input/get_started': {turns: ['start', '21'], pausesOnFirstTurn: true},
  'human_input/initial_prompt': {
    turns: ['start', 'Paris, 30, hiking'],
    pausesOnFirstTurn: true,
  },
  'human_input/payload_and_schema': {
    turns: ['Paris', 'the museum'],
    pausesOnFirstTurn: true,
  },
  'human_input/rerun_on_resume': {
    turns: ['the delivery was a week late', 'make it shorter', 'approve'],
    pausesOnFirstTurn: true,
  },
  'routes/fan_out_join': {turns: ['hello world']},
  'routes/function_node': {turns: ['hello world']},
  'routes/loop_escalation': {turns: ['graph workflows']},
  'routes/nested_workflow': {
    turns: ['ünïcödé strässe ß ǅungla 😀 test'],
    expectedFinalOutput: '[B] Ünïcödé Strässe ß Ǆungla 😀 Test',
  },
  'routes/sequence': {turns: ['hello world']},
};

/** The samples that call a live model, so they are constructed but not run. */
const MODEL_BACKED = [
  'data_handling/schemas',
  'data_handling/structured_access',
  'dynamic/data_handling',
  'dynamic/loop_route',
  'dynamic/sequence_route',
  'graphs/get_started',
  'graphs/process_pipeline',
  'routes/branches',
];

/** Every `<category>/<name>` directory holding an `agent.ts`, from disk. */
function discoverSamples(): string[] {
  const found: string[] = [];
  for (const category of readdirSync(SAMPLES_ROOT)) {
    const categoryPath = path.join(SAMPLES_ROOT, category);
    if (!statSync(categoryPath).isDirectory()) continue;
    for (const name of readdirSync(categoryPath)) {
      const agent = path.join(categoryPath, name, 'agent.ts');
      if (statSync(agent, {throwIfNoEntry: false})?.isFile()) {
        found.push(`${category}/${name}`);
      }
    }
  }
  return found.sort();
}

async function loadRootAgent(sample: string) {
  const module = (await import(
    path.join(SAMPLES_ROOT, sample, 'agent.ts')
  )) as {rootAgent?: unknown};
  return module.rootAgent;
}

function isPaused(events: Event[]): boolean {
  return events.some((e) => (e.longRunningToolIds?.length ?? 0) > 0);
}

describe('workflow docs samples', () => {
  // Guards the two lists above: a sample added to samples/workflows/ has to be
  // classified here, rather than silently gaining no coverage.
  it('covers every sample on disk', () => {
    const registered = [...Object.keys(OFFLINE), ...MODEL_BACKED].sort();
    expect(registered).toEqual(discoverSamples());
  });

  describe.each(MODEL_BACKED)('%s (model-backed)', (sample) => {
    it('builds a valid graph', async () => {
      // A Workflow validates its edges in its constructor, so importing
      // the module is the assertion.
      expect(await loadRootAgent(sample)).toBeDefined();
    });
  });

  describe.each(Object.entries(OFFLINE))('%s (offline)', (sample, spec) => {
    it('runs without a model', async () => {
      const rootAgent = await loadRootAgent(sample);
      expect(rootAgent).toBeDefined();

      const perTurn = await runSample({
        name: sample,
        rootAgent: rootAgent as Parameters<typeof runSample>[0]['rootAgent'],
        turns: spec.turns,
        offline: true,
      });

      expect(perTurn[0].length).toBeGreaterThan(0);
      if (spec.pausesOnFirstTurn) {
        expect(isPaused(perTurn[0])).toBe(true);
        expect(isPaused(perTurn[perTurn.length - 1])).toBe(false);
      }
      // The last turn produces the workflow's answer.
      const answer = finalOutput(allEvents([perTurn[perTurn.length - 1]]));
      expect(answer).toBeDefined();
      if ('expectedFinalOutput' in spec) {
        expect(answer).toEqual(spec.expectedFinalOutput);
      }
    });
  });
});
