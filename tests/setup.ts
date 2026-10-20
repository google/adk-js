/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import {vi} from 'vitest';
// Imported by path rather than through the `@google/adk` barrel on purpose:
// the barrel pulls most of core into the module graph before any test file is
// evaluated, which leaves those modules cached with real bindings and silently
// defeats `vi.mock` in the tests that mock them.
import {LogLevel, setLogLevel} from '../core/src/utils/logger.js';

const ISOLATED_TEST_CONTENT_PATTERN =
  /\bvi\.(mock|doMock|resetModules)\b|setGlobalTracerProvider|resetLogger|logger_node_wiring|is experimental|(?:globalThis|global)\.fetch\s*=|process\.listeners/;

interface EvaluatedModuleNode {
  promise?: unknown;
  exports?: unknown;
  evaluated?: boolean;
  mockedExports?: unknown;
  importers: Set<unknown>;
}

interface WorkerModuleState {
  filepath?: string;
  evaluatedModules?: {
    idToModuleMap: Map<string, EvaluatedModuleNode>;
    fileToModulesMap: Map<string, Set<unknown>>;
    invalidateModule: (mod: unknown) => void;
  };
}

const PROCESS_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGUSR1', 'SIGUSR2'] as const;
type ProcessSignal = (typeof PROCESS_SIGNALS)[number];

type ListenerFn = (...args: unknown[]) => void;

interface GlobalWithSetupState {
  __vitest_worker__?: WorkerModuleState;
  __vitest_mocker__?: {reset: () => void};
  __adk_prev_isolated__?: boolean;
  __adk_original_fetch__?: typeof globalThis.fetch;
  __adk_initial_env__?: typeof process.env;
  __adk_initial_listeners__?: Map<ProcessSignal, Set<ListenerFn>>;
  __adk_isolated_cache__?: Map<string, boolean>;
}

const g = globalThis as unknown as GlobalWithSetupState;
g.__adk_original_fetch__ ??= globalThis.fetch;
g.__adk_initial_env__ ??= {...process.env};
if (!g.__adk_initial_listeners__) {
  g.__adk_initial_listeners__ = new Map();
  for (const signal of PROCESS_SIGNALS) {
    g.__adk_initial_listeners__.set(
      signal,
      new Set(process.listeners(signal) as ListenerFn[]),
    );
  }
}
g.__adk_isolated_cache__ ??= new Map<string, boolean>();

function isIsolatedFile(filepath: string | undefined): boolean {
  if (!filepath) return false;
  const cached = g.__adk_isolated_cache__!.get(filepath);
  if (cached !== undefined) return cached;
  let result = filepath.includes('logger_node_wiring');
  if (!result) {
    try {
      result = ISOLATED_TEST_CONTENT_PATTERN.test(
        fs.readFileSync(filepath, 'utf8'),
      );
    } catch {
      result = false;
    }
  }
  g.__adk_isolated_cache__!.set(filepath, result);
  return result;
}

// Restore any direct `process.env` or `globalThis.fetch` mutations from the
// previous test file in this worker when `isolate: false`.
vi.unstubAllEnvs();
vi.unstubAllGlobals();
for (const key of Object.keys(process.env)) {
  if (!(key in g.__adk_initial_env__!)) {
    delete process.env[key];
  }
}
Object.assign(process.env, g.__adk_initial_env__);
globalThis.fetch = g.__adk_original_fetch__!;

const workerState = g.__vitest_worker__;
const currentIsolated = isIsolatedFile(workerState?.filepath);

if (currentIsolated || g.__adk_prev_isolated__) {
  for (const signal of PROCESS_SIGNALS) {
    const initial = g.__adk_initial_listeners__!.get(signal)!;
    for (const listener of process.listeners(signal) as ListenerFn[]) {
      if (!initial.has(listener)) {
        process.removeListener(signal, listener);
      }
    }
  }
  g.__vitest_mocker__?.reset();
  vi.resetModules();
  // `vi.resetModules()` skips `mock:` entries in `idToModuleMap`; clear them
  // too so mocked modules do not carry over across files.
  workerState?.evaluatedModules?.idToModuleMap.forEach((node, id) => {
    if (id.startsWith('mock:')) {
      workerState.evaluatedModules?.invalidateModule(node);
      node.mockedExports = undefined;
    }
  });
}
g.__adk_prev_isolated__ = currentIsolated;

// Re-evaluate this setup file before the next test file when running with
// `isolate: false`.
queueMicrotask(() => {
  workerState?.evaluatedModules?.idToModuleMap.forEach((node, id) => {
    if (id.endsWith('/tests/setup.ts')) {
      workerState.evaluatedModules?.invalidateModule(node);
    }
  });
});

// Runs inside every test worker. A `globalSetup` file cannot do this: it is
// evaluated only in Vitest's main process, so the level it sets never reaches
// the forked workers that run the tests, and every WARN/INFO the ADK logger
// emits ends up echoed into the CI log.
setLogLevel(LogLevel.ERROR);
