/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standalone entry point for the parity suite.
 *
 *   node --experimental-strip-types parity_cli.ts [--filter core] [--jobs 3]
 *
 * Node's type stripping is enough here — the harness is plain TS with no
 * enums or decorators — which keeps a long, LLM-backed batch run out of the
 * test runner's timeout and reporting machinery.
 */

import {CASES} from './cases.ts';
import {runSuite} from './harness/run_suite.ts';
import {harnessIsProvisioned} from './harness/runtimes.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const provisioned = harnessIsProvisioned();
if (!provisioned.ok) {
  console.error(`Harness not provisioned: ${provisioned.reason}`);
  process.exit(1);
}

const filter = arg('filter');
const jobs = Number(arg('jobs') ?? 3);

const runnable = CASES.filter((c) => !c.skip && c.tsAgent).length;
console.log(
  `Running ${filter ? `cases matching "${filter}"` : `${runnable} cases`} ` +
    `with ${jobs} at a time.\n`,
);

const outcome = await runSuite({
  cases: CASES,
  filter,
  concurrency: jobs,
  onProgress: (done, total, result) => {
    const icon = result.differences.some((d) => d.severity === 'blocked')
      ? '🚫'
      : result.differences.some((d) => d.severity === 'structural')
        ? '❌'
        : result.differences.length
          ? '⚠️'
          : '✅';
    const summary = result.differences.length
      ? result.differences.map((d) => d.dimension).join(', ')
      : 'identical';
    console.log(
      `${icon} [${String(done).padStart(3)}/${total}] ${result.case.id.padEnd(42)} ${summary}`,
    );
  },
});

const structural = outcome.results.filter((r) => !r.match).length;
console.log(
  `\n${outcome.results.length} run · ${outcome.results.length - structural} matched · ` +
    `${structural} diverged · ${outcome.skipped.length} not run`,
);
console.log(`Report: ${outcome.reportPath}`);
