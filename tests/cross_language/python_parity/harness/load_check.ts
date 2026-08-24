/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Loads every ported agent without calling a model.
 *
 *   node --experimental-strip-types harness/load_check.ts [caseIdSubstring]
 *
 * A port that does not even load shows up in the real run as a "blocked" case,
 * which is indistinguishable from a genuine capability gap. This separates the
 * two cheaply: it exercises the same loaders both CLIs use, and makes no LLM
 * calls, so it is the fast feedback loop while writing ports.
 */

import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {CASES} from '../cases.ts';
import {PY_ADK, PY_AGENTS, REPO_ROOT, ROOT, TS_AGENTS} from './runtimes.ts';

const AGENT_FILE_LOADER = path.join(
  REPO_ROOT,
  'dev/dist/esm/utils/agent_loader.js',
);

interface CheckResult {
  id: string;
  side: 'ts' | 'python';
  ok: boolean;
  detail: string;
}

async function checkTs(id: string, tsAgent: string): Promise<CheckResult> {
  const file = path.join(TS_AGENTS, `${tsAgent}.ts`);
  if (!fs.existsSync(file)) {
    return {
      id,
      side: 'ts',
      ok: false,
      detail: `missing ${path.relative(ROOT, file)}`,
    };
  }
  try {
    const {AgentFile} = await import(AGENT_FILE_LOADER);
    const agentFile = new AgentFile(file, {compile: true, bundle: true});
    const loaded = await agentFile.load();
    await agentFile[Symbol.asyncDispose]?.();
    const name = loaded?.name ?? loaded?.rootAgent?.name ?? '(unnamed)';
    return {id, side: 'ts', ok: true, detail: name};
  } catch (error) {
    return {
      id,
      side: 'ts',
      ok: false,
      detail: (error as Error).message.split('\n')[0],
    };
  }
}

function checkPython(id: string): CheckResult {
  const dir = path.join(PY_AGENTS, id);
  if (!fs.existsSync(path.join(dir, 'agent.py'))) {
    return {
      id,
      side: 'python',
      ok: false,
      detail: `missing agents/py/${id}/agent.py`,
    };
  }
  const python = path.join(path.dirname(PY_ADK), 'python');
  const env = {...process.env};
  delete env['GOOGLE_API_CERTIFICATE_CONFIG'];
  try {
    const out = execFileSync(
      python,
      [
        '-c',
        [
          'import sys, json',
          `sys.path.insert(0, ${JSON.stringify(PY_AGENTS)})`,
          `sys.path.insert(0, ${JSON.stringify(dir)})`,
          'import agent',
          'root = getattr(agent, "root_agent", None) or getattr(agent, "app", None)',
          'print(getattr(root, "name", type(root).__name__))',
        ].join('\n'),
      ],
      {encoding: 'utf8', env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']},
    );
    return {
      id,
      side: 'python',
      ok: true,
      detail: out.trim().split('\n').at(-1) ?? '',
    };
  } catch (error) {
    const err = error as {stderr?: string; message?: string};
    const line = (err.stderr ?? err.message ?? '')
      .trim()
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('  '))
      .at(-1);
    return {id, side: 'python', ok: false, detail: line ?? 'import failed'};
  }
}

const filter = process.argv[2];
const cases = CASES.filter(
  (c) =>
    c.tsAgent &&
    !c.skip &&
    (!filter || c.id.includes(filter) || c.family.includes(filter)),
);

const results: CheckResult[] = [];
for (const c of cases) {
  results.push(await checkTs(c.id, c.tsAgent!));
  results.push(checkPython(c.id));
}

const failures = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(
    `${r.ok ? '✅' : '❌'} ${r.side.padEnd(6)} ${r.id.padEnd(42)} ${r.detail}`,
  );
}
console.log(
  `\n${results.length} checks · ${results.length - failures.length} ok · ${failures.length} failed`,
);
process.exit(failures.length ? 1 : 0);
