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
const repeats = Number(arg('repeats') ?? 3);
const retries = Number(arg('retries') ?? 1);

const runnable = CASES.filter((c) => !c.skip && c.tsAgent).length;
console.log(
  `Running ${filter ? `cases matching "${filter}"` : `${runnable} cases`} ` +
    `with ${jobs} at a time, ${repeats}\u00d7 each.\n`,
);
if (repeats === 1) {
  console.log(
    'Note: --repeats 1 produces leads, not findings. An LLM-backed case is\n' +
      'not reproducible; use 3 or more before acting on a result.\n',
  );
}

const outcome = await runSuite({
  cases: CASES,
  filter,
  concurrency: jobs,
  repeats,
  retries,
  onProgress: (done, total, result) => {
    const has = (severity: string) =>
      result.differences.some((d) => d.severity === severity);
    const icon = has('blocked')
      ? '🚫'
      : has('structural')
        ? '❌'
        : has('infrastructure')
          ? '🛠️'
          : result.differences.length
            ? '⚠️'
            : '✅';
    const summary = result.differences.length
      ? result.differences.map((d) => d.dimension).join(', ')
      : 'identical';
    // The unstable dimensions are the ones a single run would have reported
    // as findings, so it is worth seeing them go by.
    const noise = result.unstableDimensions?.length
      ? `  (dropped as noise: ${result.unstableDimensions.join(', ')})`
      : '';
    console.log(
      `${icon} [${String(done).padStart(3)}/${total}] ${result.case.id.padEnd(42)} ${summary}${noise}`,
    );
  },
});

const diverged = outcome.results.filter((r) => !r.match).length;
const flaky = outcome.results.filter((r) => (r.flipRate ?? 0) > 0).length;
const retried = outcome.results.reduce((sum, r) => sum + (r.retries ?? 0), 0);
console.log(
  `\n${outcome.results.length} run · ${outcome.results.length - diverged} matched · ` +
    `${diverged} diverged · ${outcome.skipped.length} not run`,
);
console.log(
  `${flaky} case(s) disagreed with themselves across repeats · ` +
    `${retried} repeat(s) retried after a transient failure`,
);
console.log(`Report: ${outcome.reportPath}`);
