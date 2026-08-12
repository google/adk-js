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
 * them, which left the interesting failure uncovered: a `WorkflowAgent`
 * validates its graph in its constructor, so a rename or a semantics change in
 * the `@experimental` workflow API can turn a sample into a load-time error
 * that still type-checks.
 *
 * Every sample is constructed. The ones that call no model are also run through
 * a real `InMemoryRunner`, with the record/replay model installed on an empty
 * response set — so an accidental model call in an "offline" sample throws
 * rather than silently reaching the network.
 *
 * The three `dynamic/` samples that call a model are also run, against a
 * recorded fixture, because what they demonstrate is orchestration the offline
 * set cannot cover: a value handed from an agent node to a function node, a
 * sequence of `ctx.runNode()` calls, and a `while` loop that keeps calling an
 * agent until a checker is satisfied. Each assertion checks that behaviour, not
 * the wording the model happened to produce.
 *
 * The remaining model-backed samples are constructed only. Driving them would
 * mean a fixture per sample for behaviour the sibling
 * `tests/integration/workflows/` set already covers.
 *
 * Re-record after changing one of them:
 *   npm run record:docs-samples
 */

import {Event} from '@google/adk';
import {readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  allEvents,
  authors,
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
  'routes/fan_out_join': {turns: ['hello world']},
  'routes/function_node': {turns: ['hello world']},
  'routes/loop_escalation': {turns: ['graph workflows']},
  'routes/nested_workflow': {turns: ['hello world']},
  'routes/sequence': {turns: ['hello world']},
};

/** The samples that call a live model, so they are constructed but not run. */
const MODEL_BACKED = [
  'data_handling/schemas',
  'data_handling/structured_access',
  'graphs/get_started',
  'graphs/process_pipeline',
  'routes/branches',
];

/** A model-backed sample driven end-to-end against a recorded fixture. */
interface RecordedSample {
  turns: string[];
  /** Asserts the orchestration the sample exists to demonstrate. */
  check(events: Event[]): void;
}

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);

const RECORDED: Record<string, RecordedSample> = {
  // An agent node's output reaches a function node with no session-state hop:
  // every line of the answer comes back prefixed by the formatter.
  'dynamic/data_handling': {
    turns: ['a short paragraph about why graphs beat long prompts'],
    check(events) {
      const draft = outputOf(events, 'draft_agent');
      expect(typeof draft).toBe('string');

      const formatted = String(finalOutput(events));
      const lines = formatted.split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((line) => line.startsWith('| '))).toBe(true);
      // The formatter ran on the draft, rather than on something else.
      expect(formatted).toContain(String(draft).split('\n')[0].trim());
    },
  },

  // Three sequential ctx.runNode() calls: the city the first node invents has
  // to survive the lookup and reach the report.
  'dynamic/sequence_route': {
    turns: ['go'],
    check(events) {
      const cityTime = outputOf(events, 'city_time_function') as {
        city?: string;
        timeInfo?: string;
      };
      expect(cityTime?.city).toBeTruthy();
      expect(cityTime?.timeInfo).toBe('10:10 AM');

      // Same city end to end, and the ordering that makes it sequential.
      const report = String(finalOutput(events));
      expect(report).toContain(cityTime.city!);
      expect(indexOfAuthor(events, 'city_generator_agent')).toBeLessThan(
        indexOfAuthor(events, 'city_time_function'),
      );
      expect(indexOfAuthor(events, 'city_time_function')).toBeLessThan(
        indexOfAuthor(events, 'city_report_agent'),
      );
    },
  },

  // The refine loop: the lint checker rejects the first draft, the fixer runs,
  // and the loop exits on a clean check rather than on the round cap.
  'dynamic/loop_route': {
    turns: [
      'a one-line function that adds two numbers, no comments, no type annotations',
    ],
    check(events) {
      const lintResults = events
        .filter((e) => e.author === 'lint_reviewer' && e.output !== undefined)
        .map((e) => (e.output as {findings: string}).findings);

      // At least one round: a first draft the checker rejected.
      expect(lintResults.length).toBeGreaterThan(1);
      expect(lintResults[0]).not.toBe('');
      expect(authors(events).has('fixer_agent')).toBe(true);

      // It exited because the code came back clean, not because it ran out of
      // rounds (MAX_FIX_ROUNDS is 3, so at most 4 checks).
      expect(lintResults[lintResults.length - 1]).toBe('');
      expect(lintResults.length).toBeLessThanOrEqual(4);
      expect(String(finalOutput(events))).toBeTruthy();
    },
  },
};

/** The output of the last event authored by `author`. */
function outputOf(events: Event[], author: string): unknown {
  return finalOutput(events.filter((e) => e.author === author));
}

/** Index of the first event authored by `author` (-1 when absent). */
function indexOfAuthor(events: Event[], author: string): number {
  return events.findIndex((e) => e.author === author);
}

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
    const registered = [
      ...Object.keys(OFFLINE),
      ...Object.keys(RECORDED),
      ...MODEL_BACKED,
    ].sort();
    expect(registered).toEqual(discoverSamples());
  });

  describe.each(MODEL_BACKED)('%s (model-backed)', (sample) => {
    it('builds a valid graph', async () => {
      // A WorkflowAgent validates its edges in its constructor, so importing
      // the module is the assertion.
      expect(await loadRootAgent(sample)).toBeDefined();
    });
  });

  describe.each(Object.entries(RECORDED))('%s (recorded)', (sample, spec) => {
    it('runs against its recorded model responses', async () => {
      const rootAgent = await loadRootAgent(sample);
      expect(rootAgent).toBeDefined();

      const perTurn = await runSample({
        name: sample,
        rootAgent: rootAgent as Parameters<typeof runSample>[0]['rootAgent'],
        turns: spec.turns,
        fixtureDir: FIXTURE_DIR,
      });

      spec.check(allEvents(perTurn));
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
      expect(
        finalOutput(allEvents([perTurn[perTurn.length - 1]])),
      ).toBeDefined();
    });
  });
});
