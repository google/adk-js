/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vitest entry for the Python parity harness.
 *
 * Two tiers, because the full comparison costs ~120 live model calls and
 * several minutes:
 *
 *  - Always: validate the catalogue and load every ported agent through both
 *    runtimes' real loaders. No model calls, so it is safe in CI and it still
 *    catches the common breakages (a renamed export, a bad shim, a case
 *    pointing at an agent that no longer exists).
 *  - With `ADK_PARITY_LIVE=1`: run the actual side-by-side comparison and fail
 *    on structural divergence.
 *
 * `npm run test:parity` runs the live suite directly, outside vitest.
 */

import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

import {CASES} from './cases.ts';
import {runSuite} from './harness/run_suite.ts';
import {
  PY_AGENTS,
  ROOT,
  TS_AGENTS,
  harnessIsProvisioned,
} from './harness/runtimes.ts';

const LIVE = process.env['ADK_PARITY_LIVE'] === '1';
const provisioned = harnessIsProvisioned();

describe('python parity catalogue', () => {
  it('has unique case ids', () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names a real adk-python sample for every case', () => {
    // Only meaningful once setup.sh has cloned the checkout.
    if (!fs.existsSync(path.join(ROOT, 'adk-python'))) return;
    const missing = CASES.filter(
      (c) =>
        !fs.existsSync(
          path.join(ROOT, 'adk-python/contributing/samples', c.pySample),
        ),
    ).map((c) => `${c.id} → ${c.pySample}`);
    expect(missing).toEqual([]);
  });

  it('has a TS agent file and a Python shim for every runnable case', () => {
    const broken: string[] = [];
    for (const c of CASES) {
      if (c.skip || !c.tsAgent) continue;
      if (!fs.existsSync(path.join(TS_AGENTS, `${c.tsAgent}.ts`))) {
        broken.push(`${c.id}: missing agents/ts/${c.tsAgent}.ts`);
      }
      if (!fs.existsSync(path.join(PY_AGENTS, c.id, 'agent.py'))) {
        broken.push(`${c.id}: missing agents/py/${c.id}/agent.py`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('explains every case it does not run', () => {
    const unexplained = CASES.filter((c) => !c.tsAgent && !c.skip).map(
      (c) => c.id,
    );
    expect(unexplained).toEqual([]);
  });
});

describe.skipIf(!provisioned.ok)('python parity agents load', () => {
  it('loads every ported agent in both runtimes', () => {
    // Runs in a subprocess: it imports agent modules, and a bad one should
    // not take the test runner's process with it.
    const output = execFileSync(
      process.execPath,
      ['--experimental-strip-types', path.join(ROOT, 'harness/load_check.ts')],
      {encoding: 'utf8', cwd: ROOT},
    );
    expect(output).toContain('0 failed');
  }, 600_000);
});

describe.skipIf(!provisioned.ok || !LIVE)('python parity behaviour', () => {
  it('behaves the same in both runtimes', async () => {
    const outcome = await runSuite({cases: CASES, concurrency: 4});
    const diverged = outcome.results
      .filter((r) => !r.match)
      .map(
        (r) =>
          `${r.case.id}: ` +
          r.differences
            .filter((d) => d.severity !== 'cosmetic')
            .map((d) => `${d.dimension} (py=${d.python} ts=${d.ts})`)
            .join('; '),
      );
    expect(diverged).toEqual([]);
  }, 3_600_000);
});
