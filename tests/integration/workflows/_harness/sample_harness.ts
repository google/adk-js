/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives a real workflow sample (`samples/workflows/<name>/agent.ts`) through a
 * real `InMemoryRunner`, mocking only the model via {@link installRecordReplay}.
 *
 * Default mode replays `<name>.model_responses.json`. With
 * `RECORD_MODEL_RESPONSES=1` (and a key in `samples/.env` or the environment) it
 * calls the live model and writes that fixture.
 */

import {App, Event, InMemoryRunner, RunConfig, RunnableRoot} from '@google/adk';
import {Content} from '@google/genai';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  drainRecordedCalls,
  installRecordReplay,
  RecordedCall,
  restoreRecordReplay,
} from './record_replay_model.js';

// This harness lives in tests/integration/workflows/_harness/; each sample's
// test + fixture live in the sibling tests/integration/workflows/<name>/ dir.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_ENV = path.join(HERE, '../../../../samples/.env');

/** True when the suite is (re)recording responses from the live model. */
export function isRecording(): boolean {
  return process.env['RECORD_MODEL_RESPONSES'] === '1';
}

function fixturePath(name: string): string {
  return path.join(HERE, '..', name, 'model_responses.json');
}

/** Whether a recorded fixture exists for the sample (replay prerequisite). */
export function fixtureExists(name: string): boolean {
  return existsSync(fixturePath(name));
}

/**
 * Best-effort load of `samples/.env` into `process.env` for record runs, so the
 * live Gemini backend finds `GEMINI_API_KEY` the same way the sample CLI does.
 * Never overwrites a value already present in the environment.
 */
function loadSamplesEnv(): void {
  if (!existsSync(SAMPLES_ENV)) return;
  for (const line of readFileSync(SAMPLES_ENV, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^['"]|['"]$/g, '').trim();
    if (value && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

/**
 * A single user turn: plain text, a full `Content` (e.g. a function response),
 * or a function that builds one from the turns already run — which is how a
 * HITL sample answers an interrupt whose id the framework generated.
 */
export type SampleTurn =
  | string
  | Content
  | ((previousTurns: Event[][]) => string | Content);

/** Specification of a sample run. */
export interface SampleSpec {
  /** Fixture base name (also the sample directory name by convention). */
  name: string;
  /** The real `rootAgent` imported from the sample module. */
  rootAgent: RunnableRoot;
  /**
   * The sample's `App`, for samples that ship one (e.g. because they need
   * `ResumabilityConfig`). When set it is what the runner is built from, so the
   * sample is exercised exactly as its module declares it.
   */
  app?: App;
  /** User turns to send, in order (one session, so later turns resume). */
  turns: SampleTurn[];
  /** Optional run config (e.g. `plainTextToolConfirmation` for HITL samples). */
  runConfig?: RunConfig;
  /**
   * Set for samples that make no model calls (pure function/node workflows), so
   * no fixture is required or written. A model call under an offline sample
   * still throws (surfacing an unexpected dependency on the model).
   */
  offline?: boolean;
}

function toContent(turn: SampleTurn, previousTurns: Event[][]): Content {
  const resolved = typeof turn === 'function' ? turn(previousTurns) : turn;
  return typeof resolved === 'string'
    ? {role: 'user', parts: [{text: resolved}]}
    : resolved;
}

/**
 * Runs a sample end-to-end and returns the events emitted per turn. In record
 * mode it also writes the fixture. Throws in replay mode if no fixture exists.
 */
export async function runSample(spec: SampleSpec): Promise<Event[][]> {
  // Offline samples call no model: always replay with an empty response set
  // (a stray model call then throws), and never require or write a fixture.
  const recording = spec.offline ? false : isRecording();
  const file = fixturePath(spec.name);

  if (recording) {
    loadSamplesEnv();
  }

  let recordedCalls: RecordedCall[] = [];
  if (!recording && !spec.offline) {
    if (!existsSync(file)) {
      throw new Error(
        `Missing fixture ${path.basename(file)}. Record it with: ` +
          `npm run record:samples -- ${spec.name}`,
      );
    }
    recordedCalls = JSON.parse(readFileSync(file, 'utf8')) as RecordedCall[];
  }

  installRecordReplay({
    mode: recording ? 'record' : 'replay',
    recordedCalls,
  });

  try {
    const appName = spec.app?.name ?? spec.rootAgent.name;
    const runner = spec.app
      ? new InMemoryRunner({app: spec.app})
      : new InMemoryRunner({agent: spec.rootAgent, appName});
    const session = await runner.sessionService.createSession({
      appName,
      userId: 'u1',
    });

    const perTurn: Event[][] = [];
    for (const turn of spec.turns) {
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: toContent(turn, perTurn),
        runConfig: spec.runConfig,
      })) {
        events.push(event);
      }
      perTurn.push(events);
    }

    if (recording) {
      appendFixture(file, drainRecordedCalls());
    }
    return perTurn;
  } finally {
    restoreRecordReplay();
  }
}

/**
 * Fixtures this process has already truncated. A sample with several scenarios
 * calls `runSample` once per `it()` against one fixture file, so only the first
 * write of a record run replaces it; the rest append. Without this the last
 * scenario's calls would be the only ones recorded and every other scenario
 * would miss on replay.
 */
const truncatedFixtures = new Set<string>();

function appendFixture(file: string, calls: RecordedCall[]): void {
  let existing: RecordedCall[] = [];
  if (truncatedFixtures.has(file) && existsSync(file)) {
    existing = JSON.parse(readFileSync(file, 'utf8')) as RecordedCall[];
  }
  truncatedFixtures.add(file);
  const merged = [...existing, ...calls];
  writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
}

/** Flattens per-turn events into one list. */
export function allEvents(perTurn: Event[][]): Event[] {
  return perTurn.flat();
}

/** The last non-undefined `output` across events (the workflow's final output). */
export function finalOutput(events: Event[]): unknown {
  let output: unknown;
  for (const event of events) {
    if (event.output !== undefined) {
      output = event.output;
    }
  }
  return output;
}

/** Distinct event authors (node/agent names) that produced events. */
export function authors(events: Event[]): Set<string> {
  return new Set(events.map((e) => e.author).filter((a): a is string => !!a));
}
