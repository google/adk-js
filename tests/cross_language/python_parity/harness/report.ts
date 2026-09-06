/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Renders the parity run as a Markdown report. */

import type {CaseResult, Difference, ParityCase} from './types.ts';

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function truncate(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean || '(empty)';
}

function severityIcon(differences: Difference[]): string {
  if (differences.some((d) => d.severity === 'blocked')) return '🚫';
  if (differences.some((d) => d.severity === 'structural')) return '❌';
  if (differences.some((d) => d.severity === 'infrastructure')) return '🛠️';
  if (differences.some((d) => d.severity === 'cosmetic')) return '⚠️';
  return '✅';
}

export interface ReportInput {
  results: CaseResult[];
  skipped: ParityCase[];
  pythonVersion: string;
  tsVersion: string;
  model: string;
  startedAt: Date;
  durationMs: number;
}

export function renderReport(input: ReportInput): string {
  const {results, skipped} = input;
  const ran = results.filter((r) => r.python && r.ts);
  const blocked = ran.filter((r) =>
    r.differences.some((d) => d.severity === 'blocked'),
  );
  const structural = ran.filter(
    (r) =>
      !blocked.includes(r) &&
      r.differences.some((d) => d.severity === 'structural'),
  );
  const infrastructure = ran.filter(
    (r) =>
      !blocked.includes(r) &&
      !structural.includes(r) &&
      r.differences.some((d) => d.severity === 'infrastructure'),
  );
  const cosmetic = ran.filter(
    (r) =>
      !blocked.includes(r) &&
      !structural.includes(r) &&
      !infrastructure.includes(r) &&
      r.differences.length > 0,
  );
  const clean = ran.filter((r) => r.differences.length === 0);

  const unstable = ran.filter((r) => (r.flipRate ?? 0) > 0);
  const withUnstableDims = ran.filter(
    (r) => (r.unstableDimensions?.length ?? 0) > 0,
  );
  const repeats = ran[0]?.repeats ?? 1;
  const totalRetries = ran.reduce((sum, r) => sum + (r.retries ?? 0), 0);

  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push('# ADK TypeScript ↔ Python parity report');
  push();
  push(
    `Generated ${input.startedAt.toISOString()} · ${(input.durationMs / 1000).toFixed(0)}s`,
  );
  push();
  push('| | |');
  push('|---|---|');
  push(`| adk-python | \`${input.pythonVersion}\` |`);
  push(`| adk-js | \`${input.tsVersion}\` |`);
  push(`| Model (pinned both sides) | \`${input.model}\` |`);
  push(`| Cases run | ${ran.length} |`);
  push(`| Repeats per case | ${repeats} |`);
  push(`| Cases catalogued but not run | ${skipped.length} |`);
  push();

  if (repeats === 1) {
    push(
      '> **Single run — these are leads, not findings.** An LLM-backed case is' +
        ' not reproducible: across two full runs of this suite, 18% of cases' +
        ' changed verdict without either framework changing. Re-run with' +
        ' `--repeats 3` before acting on anything here.',
    );
    push();
  }

  push('## Summary');
  push();
  push('| Outcome | Count | Meaning |');
  push('|---|---:|---|');
  push(
    `| ✅ Identical behaviour | ${clean.length} | No differences on any compared dimension. |`,
  );
  push(
    `| ⚠️ Cosmetic only | ${cosmetic.length} | Same tools, agents and state; differs in event packaging. |`,
  );
  push(
    `| 🛠️ Infrastructure | ${infrastructure.length} | A model/API failure voided the comparison. Not a parity result. |`,
  );
  push(
    `| ❌ Structural divergence | ${structural.length} | The runtimes did materially different things. |`,
  );
  push(
    `| 🚫 Blocked | ${blocked.length} | One side failed to run the case at all. |`,
  );
  push();

  if (blocked.length) {
    push('## 🚫 Blocked');
    push();
    push(
      'One runtime could not run the case. These are the highest-signal findings.',
    );
    push();
    push('| Case | Python | TypeScript |');
    push('|---|---|---|');
    for (const r of blocked) {
      const d = r.differences.find((x) => x.severity === 'blocked')!;
      push(
        `| \`${r.case.id}\` | ${truncate(d.python, 90)} | ${truncate(d.ts, 90)} |`,
      );
    }
    push();
  }

  if (structural.length) {
    push('## ❌ Structural divergence');
    push();
    for (const r of structural) {
      push(`### \`${r.case.id}\``);
      push();
      push(`Sample: \`contributing/samples/${r.case.pySample}\``);
      push();
      push('| Dimension | Python | TypeScript |');
      push('|---|---|---|');
      for (const d of r.differences.filter(
        (x) => x.severity === 'structural',
      )) {
        push(
          `| ${d.dimension} | ${truncate(d.python, 110)} | ${truncate(d.ts, 110)} |`,
        );
      }
      push();
      // Only a structural difference's own detail: a cosmetic entry's note
      // ("differs when one side splits text across events") would otherwise be
      // printed under an unrelated structural table.
      const detail = r.differences.find(
        (d) => d.severity === 'structural' && d.detail,
      )?.detail;
      if (detail) {
        push(`> ${detail}`);
        push();
      }
    }
  }

  if (cosmetic.length) {
    push('## ⚠️ Cosmetic differences');
    push();
    push('| Case | Dimension | Python | TypeScript |');
    push('|---|---|---|---|');
    for (const r of cosmetic) {
      for (const d of r.differences) {
        push(
          `| \`${r.case.id}\` | ${d.dimension} | ${truncate(d.python, 60)} | ${truncate(d.ts, 60)} |`,
        );
      }
    }
    push();
  }

  if (repeats > 1 && (unstable.length || withUnstableDims.length)) {
    push('## ⚡ Reproducibility');
    push();
    push(
      `Each case was compared ${repeats} times and only differences seen in a ` +
        'majority are reported above. What follows was seen but did not carry ' +
        '— it is model nondeterminism, not a runtime difference, and it is ' +
        'listed so the noise stays visible.',
    );
    push();
    if (totalRetries) {
      push(
        `${totalRetries} repeat(s) hit a transient API failure and were re-run.`,
      );
      push();
    }
    push('| Case | Verdict held | Dimensions that did not carry |');
    push('|---|---|---|');
    for (const r of ran) {
      const flip = r.flipRate ?? 0;
      const dims = r.unstableDimensions ?? [];
      if (!flip && !dims.length) continue;
      const held = `${Math.round((1 - flip) * (r.repeats ?? 1))}/${r.repeats ?? 1}`;
      push(`| \`${r.case.id}\` | ${held} | ${dims.join(', ') || '–'} |`);
    }
    push();
  }

  if (infrastructure.length) {
    push('## 🛠️ Infrastructure failures');
    push();
    push(
      'The model or the API failed in a way that says nothing about either ' +
        'framework (429, 503, empty completion, timeout). These are excluded ' +
        'from the parity verdict. A deterministic 400 that only one runtime ' +
        'provokes is *not* here — that stays a structural finding.',
    );
    push();
    push('| Case | Python | TypeScript |');
    push('|---|---|---|');
    for (const r of infrastructure) {
      for (const d of r.differences.filter(
        (x) => x.severity === 'infrastructure',
      )) {
        push(
          `| \`${r.case.id}\` | ${truncate(d.python, 70)} | ${truncate(d.ts, 70)} |`,
        );
      }
    }
    push();
  }

  push('## All cases');
  push();
  push(
    '| | Case | Family | Tools (py → ts) | Text overlap | Stable | py ms | ts ms |',
  );
  push('|---|---|---|---|---:|---|---:|---:|');
  for (const r of results) {
    const py = r.python;
    const ts = r.ts;
    const flip = r.flipRate ?? 0;
    const stable =
      r.repeats && r.repeats > 1
        ? flip === 0
          ? `${r.repeats}/${r.repeats}`
          : `⚡ ${Math.round((1 - flip) * r.repeats)}/${r.repeats}`
        : '–';
    push(
      `| ${severityIcon(r.differences)} | \`${r.case.id}\` | ${r.case.family} | ` +
        `${py?.toolSequence.join(',') || '–'} → ${ts?.toolSequence.join(',') || '–'} | ` +
        `${r.textSimilarity !== undefined ? pct(r.textSimilarity) : '–'} | ` +
        `${stable} | ` +
        `${py?.durationMs ?? '–'} | ${ts?.durationMs ?? '–'} |`,
    );
  }
  push();

  push('## Side-by-side answers');
  push();
  push(
    'Wording is never a failure — the model is free to phrase differently. This is here so a human can spot answers that differ in substance.',
  );
  push();
  for (const r of ran) {
    push(
      `<details><summary><code>${r.case.id}</code> — overlap ${pct(r.textSimilarity ?? 0)}</summary>`,
    );
    push();
    push(`**Query:** ${r.case.queries.join(' / ')}`);
    push();
    push(`**Python:** ${truncate(r.python!.allText, 700)}`);
    push();
    push(`**TypeScript:** ${truncate(r.ts!.allText, 700)}`);
    push();
    push('</details>');
    push();
  }

  if (skipped.length) {
    push('## Catalogued but not run');
    push();
    push('| Case | Sample | Reason | Note |');
    push('|---|---|---|---|');
    for (const c of skipped) {
      push(
        `| \`${c.id}\` | \`${c.pySample}\` | ${c.skip ?? '?'} | ${c.note ?? ''} |`,
      );
    }
    push();
  }

  return lines.join('\n');
}
