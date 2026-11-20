/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Imported by package specifier: resolves through the workspace alias in
// `tsconfig.json` and `vitest.config.ts` to `dev/src/index.ts`.
import {
  AdkApiClient,
  AdkApiServer,
  AgentChangeEventHandler,
  type AgentChangeEventHandlerOptions,
  AgentFile,
  type AgentFileHandle,
  type AgentFileOptions,
  AgentLoader,
  type AgentLoadFailure,
  BaseAgentLoader,
  type CachingAgentLoader,
  FileModuleType,
  isBaseAgentLoader,
  isSharedValue,
  type ServerOptions,
  SharedValue,
  type SharedValueOptions,
  version,
} from '@google/adk-devtools';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';

const devPackageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {version: string};

describe('@google/adk-devtools entry point', () => {
  it('re-exports the version release-please writes into dev/package.json', () => {
    expect(version).toBe(devPackageJson.version);
  });

  it('exports a semver version string', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it('declares path mappings for @google/adk-devtools in root tsconfig.json', () => {
    const tsconfigText = readFileSync(
      new URL('../../tsconfig.json', import.meta.url),
      'utf8',
    );
    const parsed = ts.parseConfigFileTextToJson('tsconfig.json', tsconfigText);
    expect(parsed.error).toBeUndefined();
    const paths = (
      parsed.config as {
        compilerOptions?: {
          paths?: Record<string, string[]>;
        };
      }
    )?.compilerOptions?.paths;
    expect(paths?.['@google/adk-devtools']).toEqual(['./dev/src/index.ts']);
    expect(paths?.['@google/adk-devtools/*']).toEqual(['./dev/src/*']);
  });

  it('comments out GOOGLE_CLOUD_PROJECT in tests/e2e/.env.template', () => {
    const envTemplate = readFileSync(
      new URL('../../tests/e2e/.env.template', import.meta.url),
      'utf8',
    );
    expect(envTemplate).toContain('# GOOGLE_CLOUD_PROJECT="your-project-id"');
    expect(envTemplate).not.toMatch(/^GOOGLE_CLOUD_PROJECT=/m);
  });

  it('exports server, agent loader, change handler, and shared value symbols', () => {
    expect(AdkApiClient).toBeDefined();
    expect(AdkApiServer).toBeDefined();
    expect(BaseAgentLoader).toBeDefined();
    expect(isBaseAgentLoader).toBeTypeOf('function');
    expect(AgentLoader).toBeDefined();
    expect(AgentFile).toBeDefined();
    expect(FileModuleType.ESM).toBe('esm');
    expect(AgentChangeEventHandler).toBeDefined();
    expect(SharedValue).toBeDefined();
    expect(isSharedValue).toBeTypeOf('function');

    const sharedOpts: SharedValueOptions<string> = {value: 'demo'};
    const shared = new SharedValue(sharedOpts);
    expect(isSharedValue(shared)).toBe(true);

    const fileOpts: AgentFileOptions = {
      compile: false,
      bundle: false,
      moduleType: FileModuleType.ESM,
    };
    expect(fileOpts.moduleType).toBe(FileModuleType.ESM);

    const failureSample: AgentLoadFailure | undefined = undefined;
    const handleSample: AgentFileHandle | undefined = undefined;
    const cachingSample: CachingAgentLoader | undefined = undefined;
    const handlerOptsSample: AgentChangeEventHandlerOptions | undefined =
      undefined;
    const serverOptsSample: ServerOptions = {port: 0};
    expect(failureSample).toBeUndefined();
    expect(handleSample).toBeUndefined();
    expect(cachingSample).toBeUndefined();
    expect(handlerOptsSample).toBeUndefined();
    expect(serverOptsSample.port).toBe(0);
  });
});
