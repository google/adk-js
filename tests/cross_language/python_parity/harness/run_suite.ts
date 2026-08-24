/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Runs the parity suite and writes the report. Shared by the CLI and vitest. */

import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {compareTraces, consensusOf, isTransient} from './compare.ts';
import {renderReport} from './report.ts';
import {
  PARITY_MODEL,
  PY_ADK,
  ROOT,
  RUNS,
  TS_CLI,
  runPython,
  runTypeScript,
  writeReplayFile,
} from './runtimes.ts';
import type {CaseResult, ParityCase, Trace} from './types.ts';

function versionOf(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {encoding: 'utf8'})
      .trim()
      .split('\n')[0];
  } catch {
    return 'unknown';
  }
}

export interface SuiteOptions {
  cases: ParityCase[];
  /** Substring filter on case id or family. */
  filter?: string;
  /** How many cases to run at once. Each case is two LLM-backed CLI runs. */
  concurrency?: number;
  /**
   * How many times to compare each case. A difference has to appear in a
   * majority of repeats to be reported, which is what makes the result
   * reproducible; 1 is fast but produces leads, not findings.
   */
  repeats?: number;
  /** Extra attempts for a repeat lost to a transient API failure. */
  retries?: number;
  onProgress?: (done: number, total: number, result: CaseResult) => void;
}

export interface SuiteOutcome {
  results: CaseResult[];
  skipped: ParityCase[];
  reportPath: string;
  report: string;
}

/** One comparison of one case: both CLIs over the same replay file. */
async function compareOnce(
  parityCase: ParityCase,
  runDir: string,
  replayFile: string,
): Promise<CaseResult> {
  // Sequential per case: the two runs write session files into sibling trees
  // and share a rate limit, and interleaving them makes a timeout ambiguous.
  const python = await runPython(parityCase, runDir, replayFile);
  const ts = await runTypeScript(parityCase, runDir, replayFile);
  return compareTraces(parityCase, python, ts);
}

async function runCase(
  parityCase: ParityCase,
  repeats: number,
  retries: number,
): Promise<CaseResult> {
  const runDir = path.join(RUNS, parityCase.id);
  fs.rmSync(runDir, {recursive: true, force: true});
  fs.mkdirSync(runDir, {recursive: true});

  const replayFile = writeReplayFile(parityCase, runDir);

  const attempts: CaseResult[] = [];
  let retried = 0;

  for (let i = 0; i < repeats; i++) {
    let result = await compareOnce(parityCase, runDir, replayFile);

    // A repeat lost to a 429/503/empty completion measures the API, not the
    // frameworks. Re-run it rather than letting it vote.
    for (
      let attempt = 0;
      attempt < retries &&
      result.python &&
      result.ts &&
      isTransient(result.python, result.ts);
      attempt++
    ) {
      retried++;
      result = await compareOnce(parityCase, runDir, replayFile);
    }
    attempts.push(result);
  }

  const result = {...consensusOf(attempts), retries: retried};
  fs.writeFileSync(
    path.join(runDir, 'diff.json'),
    JSON.stringify(toRecord(result), null, 2),
  );
  return result;
}

/** The compact per-case record persisted to `runs/<id>/diff.json`. */
interface CaseRecord {
  case: ParityCase;
  differences: CaseResult['differences'];
  match: boolean;
  textSimilarity?: number;
  repeats?: number;
  flipRate?: number;
  unstableDimensions?: string[];
  retries?: number;
  python: SideRecord;
  ts: SideRecord;
}

interface SideRecord {
  toolSequence: string[];
  authors: string[];
  transfers: string[];
  finalState: Record<string, unknown>;
  finalText: string;
  allText: string;
  durationMs: number;
  failed: boolean;
}

function toRecord(result: CaseResult): CaseRecord {
  const side = (trace: Trace): SideRecord => ({
    toolSequence: trace.toolSequence,
    authors: trace.authors,
    transfers: trace.transfers,
    finalState: trace.finalState,
    finalText: trace.finalText,
    allText: trace.allText,
    durationMs: trace.durationMs,
    failed: trace.failed,
  });
  return {
    case: result.case,
    differences: result.differences,
    match: result.match,
    textSimilarity: result.textSimilarity,
    repeats: result.repeats,
    flipRate: result.flipRate,
    unstableDimensions: result.unstableDimensions,
    retries: result.retries,
    python: side(result.python!),
    ts: side(result.ts!),
  };
}

/**
 * Rehydrates just enough of a Trace for the report to render a stored case.
 *
 * Tolerant of records written by an older harness, which may be missing fields
 * added since: a stale `diff.json` should degrade the report, not crash the
 * run that reads it.
 */
function fromRecord(record: CaseRecord): CaseResult {
  const side = (s: Partial<SideRecord> | undefined): Trace => ({
    runtime: 'python',
    failed: s?.failed ?? false,
    exitCode: 0,
    durationMs: s?.durationMs ?? 0,
    stdout: '',
    stderr: '',
    events: [],
    toolSequence: s?.toolSequence ?? [],
    authors: s?.authors ?? [],
    transfers: s?.transfers ?? [],
    finalText: s?.finalText ?? '',
    allText: s?.allText ?? s?.finalText ?? '',
    finalState: s?.finalState ?? {},
    artifactKeys: [],
    hadError: false,
  });
  return {
    case: record.case,
    python: side(record.python),
    ts: {...side(record.ts), runtime: 'ts'},
    differences: record.differences,
    match: record.match,
    textSimilarity: record.textSimilarity,
    repeats: record.repeats,
    flipRate: record.flipRate,
    unstableDimensions: record.unstableDimensions,
    retries: record.retries,
  };
}

/**
 * Fills the gaps in a filtered run with each case's last recorded result, so
 * the report stays whole. Cases never run are simply absent.
 */
function mergeWithPreviousRuns(
  allCases: ParityCase[],
  fresh: CaseResult[],
): CaseResult[] {
  const byId = new Map(fresh.map((r) => [r.case.id, r]));
  const merged: CaseResult[] = [];

  for (const parityCase of allCases) {
    if (parityCase.skip || !parityCase.tsAgent) continue;

    const current = byId.get(parityCase.id);
    if (current) {
      merged.push(current);
      continue;
    }

    const stored = path.join(RUNS, parityCase.id, 'diff.json');
    if (!fs.existsSync(stored)) continue;
    try {
      merged.push(fromRecord(JSON.parse(fs.readFileSync(stored, 'utf8'))));
    } catch {
      // A truncated record just drops out of the report.
    }
  }

  return merged;
}

/** Runs `limit` cases at a time. */
async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    {length: Math.min(limit, items.length)},
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export async function runSuite(options: SuiteOptions): Promise<SuiteOutcome> {
  const startedAt = new Date();
  const started = Date.now();

  const selected = options.filter
    ? options.cases.filter(
        (c) =>
          c.id.includes(options.filter!) || c.family.includes(options.filter!),
      )
    : options.cases;

  const runnable = selected.filter((c) => !c.skip && c.tsAgent);
  const skipped = selected.filter((c) => c.skip || !c.tsAgent);

  fs.mkdirSync(RUNS, {recursive: true});

  const repeats = Math.max(1, options.repeats ?? 3);
  const retries = Math.max(0, options.retries ?? 1);

  let done = 0;
  const fresh = await pool(runnable, options.concurrency ?? 3, async (c) => {
    const result = await runCase(c, repeats, retries);
    options.onProgress?.(++done, runnable.length, result);
    return result;
  });

  // A filtered run still renders the whole report, by reading back the cases
  // it did not run from their last `runs/<id>/diff.json`. Otherwise re-running
  // one case to check a fix would silently shrink the report to that one case.
  const results = options.filter
    ? mergeWithPreviousRuns(options.cases, fresh)
    : fresh;
  const reportSkipped = options.filter
    ? options.cases.filter((c) => c.skip || !c.tsAgent)
    : skipped;

  const report = renderReport({
    results,
    skipped: reportSkipped,
    pythonVersion: versionOf(PY_ADK, ['--version']),
    tsVersion: versionOf(process.execPath, [TS_CLI, '--version']),
    model: PARITY_MODEL,
    startedAt,
    durationMs: Date.now() - started,
  });

  const reportPath = path.join(ROOT, 'PARITY_REPORT.md');
  fs.writeFileSync(reportPath, report);
  fs.writeFileSync(
    path.join(RUNS, 'results.json'),
    JSON.stringify(
      results.map((r) => ({
        id: r.case.id,
        match: r.match,
        differences: r.differences,
        textSimilarity: r.textSimilarity,
      })),
      null,
      2,
    ),
  );

  // `reportSkipped`, not `skipped`: the caller's summary line should describe
  // the report it just wrote, which for a filtered run covers every case.
  return {results, skipped: reportSkipped, reportPath, report};
}
