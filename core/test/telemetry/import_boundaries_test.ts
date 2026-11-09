/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ESLint} from 'eslint';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, '../../..');

const eslint = new ESLint({cwd: REPO_ROOT});

async function lintSnippet(
  code: string,
  relativeFilePath: string,
): Promise<string[]> {
  const results = await eslint.lintText(code, {
    filePath: path.join(REPO_ROOT, relativeFilePath),
  });
  return results.flatMap((result) =>
    result.messages
      .filter((msg) => msg.ruleId === 'no-restricted-imports')
      .map((msg) => msg.message),
  );
}

describe('telemetry import boundaries (no-restricted-imports)', () => {
  it('forbids @opentelemetry/* imports in core/src outside core/src/telemetry', async () => {
    const violations = await lintSnippet(
      `import {trace} from '@opentelemetry/api';\nexport const x = trace;\n`,
      'core/src/agents/some_agent.ts',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('core/src/telemetry/');
  });

  it('forbids internal telemetry imports outside core/src/telemetry', async () => {
    const violations = await lintSnippet(
      `import {getTracer} from '../telemetry/api/internal/trace/tracer.js';\nexport const x = getTracer;\n`,
      'core/src/agents/some_agent.ts',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      'core/src/telemetry/api/instrumentation.js',
    );
  });

  it('forbids telemetry/export imports in core/src runtime files outside index.ts', async () => {
    const violations = await lintSnippet(
      `import {maybeSetOtelProviders} from '../telemetry/export/setup.js';\nexport const x = maybeSetOtelProviders;\n`,
      'core/src/runner/runner.ts',
    );
    expect(violations).toHaveLength(1);
  });

  it('allows core/src/telemetry/api/instrumentation.js imports in core/src runtime files', async () => {
    const violations = await lintSnippet(
      `import {recordInvocation} from '../telemetry/api/instrumentation.js';\nexport const x = recordInvocation;\n`,
      'core/src/runner/runner.ts',
    );
    expect(violations).toEqual([]);
  });

  it('allows core/src/index.ts to re-export from ./telemetry/export/', async () => {
    const violations = await lintSnippet(
      `export * from './telemetry/export/setup.js';\nexport * from './telemetry/export/google_cloud.js';\n`,
      'core/src/index.ts',
    );
    expect(violations).toEqual([]);
  });

  it('forbids core/src/telemetry/api from importing core/src/telemetry/export', async () => {
    const violations = await lintSnippet(
      `import {maybeSetOtelProviders} from '../export/setup.js';\nexport const x = maybeSetOtelProviders;\n`,
      'core/src/telemetry/api/instrumentation.ts',
    );
    expect(violations).toHaveLength(1);
  });

  it('forbids core/src/telemetry/export from importing core/src/telemetry/api', async () => {
    const violations = await lintSnippet(
      `import {recordInvocation} from '../api/instrumentation.js';\nexport const x = recordInvocation;\n`,
      'core/src/telemetry/export/setup.ts',
    );
    expect(violations).toHaveLength(1);
  });

  it('forbids OpenTelemetry SDK imports in core/src/telemetry/api', async () => {
    const violations = await lintSnippet(
      `import {BasicTracerProvider} from '@opentelemetry/sdk-trace-base';\nexport const x = BasicTracerProvider;\n`,
      'core/src/telemetry/api/internal/trace/tracer.ts',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('@opentelemetry/api-logs');
  });

  it('allows @opentelemetry/api and @opentelemetry/api-logs imports in core/src/telemetry/api', async () => {
    const violations = await lintSnippet(
      `import {trace} from '@opentelemetry/api';\nimport {logs} from '@opentelemetry/api-logs';\nexport const x = [trace, logs];\n`,
      'core/src/telemetry/api/internal/trace/tracer.ts',
    );
    expect(violations).toEqual([]);
  });

  it('allows @opentelemetry/api imports inside core/src/telemetry/export', async () => {
    const violations = await lintSnippet(
      `import {metrics} from '@opentelemetry/api';\nexport const x = metrics;\n`,
      'core/src/telemetry/export/setup.ts',
    );
    expect(violations).toEqual([]);
  });
});
