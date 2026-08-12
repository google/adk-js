/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared plumbing for the docs-page ports in `samples/workflows/`.
 *
 * One test directory per sample, mirroring `tests/integration/workflows/`, so a
 * sample's turns, assertions and recorded responses sit together and a failure
 * names the sample. `coverage_test.ts` fails when a sample on disk has no test
 * directory here.
 */

import {BaseAgent, Event} from '@google/adk';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect} from 'vitest';
import {
  allEvents,
  finalOutput,
  runSample,
} from '../workflows/_harness/sample_harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `samples/workflows/`, where the docs ports live. */
export const SAMPLES_ROOT = path.resolve(HERE, '../../../samples/workflows');

/** Maps `routes/sequence` to this suite's `routes_sequence` directory name. */
export function testDirName(sample: string): string {
  return sample.replace('/', '_');
}

/**
 * Imports a sample's `rootAgent`. A `WorkflowAgent` validates its edges in its
 * constructor, so the import is itself an assertion that the graph is legal.
 */
export async function loadRootAgent(sample: string): Promise<BaseAgent> {
  const module = (await import(
    path.join(SAMPLES_ROOT, sample, 'agent.ts')
  )) as {
    rootAgent?: BaseAgent;
  };
  expect(module.rootAgent, `${sample} exports no rootAgent`).toBeDefined();
  return module.rootAgent!;
}

/** Whether any event in the turn raised a human-input interrupt. */
export function isPaused(events: Event[]): boolean {
  return events.some((e) => (e.longRunningToolIds?.length ?? 0) > 0);
}

/** Options for {@link runOffline}. */
export interface OfflineOptions {
  /** Set for a sample that pauses for a human on its first turn. */
  pausesOnFirstTurn?: boolean;
}

/**
 * Runs a sample that calls no model, with the record/replay model installed on
 * an empty response set — so a stray model call throws rather than silently
 * reaching the network. Returns the events of every turn, flattened.
 */
export async function runOffline(
  sample: string,
  turns: string[],
  options: OfflineOptions = {},
): Promise<Event[]> {
  const perTurn = await runSample({
    name: sample,
    rootAgent: await loadRootAgent(sample),
    turns,
    offline: true,
  });

  expect(perTurn[0].length).toBeGreaterThan(0);
  if (options.pausesOnFirstTurn) {
    expect(isPaused(perTurn[0]), 'first turn should pause').toBe(true);
    expect(isPaused(perTurn[perTurn.length - 1]), 'last turn should not').toBe(
      false,
    );
  }
  // The last turn carries the workflow's answer.
  expect(finalOutput(allEvents([perTurn[perTurn.length - 1]]))).toBeDefined();

  return allEvents(perTurn);
}

/**
 * Runs a model-backed sample against the `model_responses.json` recorded beside
 * its test. Re-record with:
 *
 *   RECORD_MODEL_RESPONSES=1 npx vitest run --project integration \
 *     tests/integration/docs_samples/<dir>
 */
export async function runRecorded(
  sample: string,
  turns: string[],
  testFileUrl: string,
): Promise<Event[]> {
  const perTurn = await runSample({
    name: sample,
    rootAgent: await loadRootAgent(sample),
    turns,
    fixtureDir: path.dirname(fileURLToPath(testFileUrl)),
  });
  return allEvents(perTurn);
}

/** The output of the last event authored by `author`. */
export function outputOf(events: Event[], author: string): unknown {
  return finalOutput(events.filter((e) => e.author === author));
}

/** Index of the first event authored by `author` (-1 when absent). */
export function indexOfAuthor(events: Event[], author: string): number {
  return events.findIndex((e) => e.author === author);
}

export {authors} from '../workflows/_harness/sample_harness.js';
export {allEvents, finalOutput};
