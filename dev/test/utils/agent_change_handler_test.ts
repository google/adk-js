/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentChangeEventHandler,
  type AgentChangeEventHandlerOptions,
  type AgentFileHandle,
  BaseAgentLoader,
  type CachingAgentLoader,
} from '@google/adk-devtools';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

class RecordingCachingLoader
  extends BaseAgentLoader
  implements CachingAgentLoader
{
  readonly evictedNames: string[] = [];

  removeAgentFromCache(agentName: string): void {
    this.evictedNames.push(agentName);
  }

  override async listAgents(): Promise<string[]> {
    return [];
  }

  override async getAgentFile(agentName: string): Promise<AgentFileHandle> {
    throw new Error(`Agent '${agentName}' not found.`);
  }
}

class CachelessLoader extends BaseAgentLoader {
  override async listAgents(): Promise<string[]> {
    return [];
  }

  override async getAgentFile(agentName: string): Promise<AgentFileHandle> {
    throw new Error(`Agent '${agentName}' not found.`);
  }
}

describe('AgentChangeEventHandler', () => {
  let rootDir: string;
  let agentsDir: string;
  let loader: RecordingCachingLoader;
  let runnersToClean: Set<string>;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'adk-agent-change-handler-'),
    );
    agentsDir = path.join(rootDir, 'agents');
    fs.mkdirSync(agentsDir, {recursive: true});
    loader = new RecordingCachingLoader();
    runnersToClean = new Set<string>();
  });

  afterEach(() => {
    fs.rmSync(rootDir, {recursive: true, force: true});
  });

  it('rejects an empty or whitespace-only agentsDir in the constructor', () => {
    const emptyOptions: AgentChangeEventHandlerOptions = {
      agentLoader: loader,
      runnersToClean,
      agentsDir: '',
    };
    expect(() => new AgentChangeEventHandler(emptyOptions)).toThrow(
      'agentsDir must be a non-empty string.',
    );
    expect(
      () =>
        new AgentChangeEventHandler({
          agentLoader: loader,
          runnersToClean,
          agentsDir: '   ',
        }),
    ).toThrow('agentsDir must be a non-empty string.');
  });

  it.each([
    {
      label: 'TypeScript agent entry file',
      relPath: 'sampleAgent/agent.ts',
      expectedAgent: 'sampleAgent',
    },
    {
      label: 'JavaScript agent entry file',
      relPath: 'jsAgent/agent.js',
      expectedAgent: 'jsAgent',
    },
    {
      label: 'ESM app entry file',
      relPath: 'esmApp/app.mjs',
      expectedAgent: 'esmApp',
    },
    {
      label: 'CommonJS agent entry file',
      relPath: 'cjsAgent/agent.cjs',
      expectedAgent: 'cjsAgent',
    },
    {
      label: 'MTS agent entry file',
      relPath: 'mtsAgent/agent.mts',
      expectedAgent: 'mtsAgent',
    },
    {
      label: 'CTS agent entry file',
      relPath: 'ctsAgent/agent.cts',
      expectedAgent: 'ctsAgent',
    },
    {
      label: 'YAML config inside an agent directory',
      relPath: 'sampleAgent/config.yaml',
      expectedAgent: 'sampleAgent',
    },
    {
      label: 'YML config inside an agent directory',
      relPath: 'sampleAgent/config.yml',
      expectedAgent: 'sampleAgent',
    },
    {
      label: 'nested agent directory',
      relPath: 'team/support/agent.ts',
      expectedAgent: 'team.support',
    },
    {
      label: 'deeply nested root_agent.yaml directory',
      relPath: 'subDir/subSubDir/agentThree/root_agent.yaml',
      expectedAgent: 'subDir.subSubDir.agentThree',
    },
    {
      label: 'root_agent.yml directory',
      relPath: 'yamlAgent/root_agent.yml',
      expectedAgent: 'yamlAgent',
    },
    {
      label: 'standalone top-level agent file',
      relPath: 'standaloneAgent.ts',
      expectedAgent: 'standaloneAgent',
    },
  ])(
    'triggers cache eviction and runner cleanup for $label',
    ({relPath, expectedAgent}) => {
      fs.mkdirSync(path.join(agentsDir, 'sampleAgent'), {recursive: true});
      fs.writeFileSync(path.join(agentsDir, 'sampleAgent', 'agent.ts'), '');

      const fullPath = path.join(agentsDir, ...relPath.split('/'));
      fs.mkdirSync(path.dirname(fullPath), {recursive: true});
      fs.writeFileSync(fullPath, '');

      const handler = new AgentChangeEventHandler({
        agentLoader: loader,
        runnersToClean,
        agentsDir,
      });

      handler.onModified(fullPath);

      expect(loader.evictedNames).toContain(expectedAgent);
      expect(runnersToClean.has(expectedAgent)).toBe(true);
    },
  );

  it.each([
    {label: 'JSON file', filename: 'data.json'},
    {label: 'text file', filename: 'notes.txt'},
    {label: 'Markdown file', filename: 'README.md'},
    {label: 'TOML file', filename: 'config.toml'},
    {label: 'dotfile', filename: '.gitignore'},
    {label: 'extensionless file', filename: 'LICENSE'},
  ])('ignores unsupported $label', ({filename}) => {
    const agentDir = path.join(agentsDir, 'sampleAgent');
    fs.mkdirSync(agentDir, {recursive: true});
    fs.writeFileSync(path.join(agentDir, 'agent.ts'), '');
    const ignoredFile = path.join(agentDir, filename);
    fs.writeFileSync(ignoredFile, '');

    const handler = new AgentChangeEventHandler({
      agentLoader: loader,
      runnersToClean,
      agentsDir,
    });

    handler.onModified(ignoredFile);
    handler.onModified(null);
    handler.onModified(undefined);
    handler.onModified('');

    expect(loader.evictedNames).toEqual([]);
    expect([...runnersToClean]).toEqual([]);
  });

  it('derives enclosing and top-level agent names when a nested subfolder file changes', () => {
    const supportDir = path.join(agentsDir, 'team', 'support');
    const toolsDir = path.join(supportDir, 'tools');
    fs.mkdirSync(toolsDir, {recursive: true});
    fs.writeFileSync(path.join(supportDir, 'agent.ts'), '');
    const customTool = path.join(toolsDir, 'customTool.ts');
    fs.writeFileSync(customTool, '');

    const handler = new AgentChangeEventHandler({
      agentLoader: loader,
      runnersToClean,
      agentsDir,
    });

    handler.onModified(customTool);

    expect(loader.evictedNames).toEqual(['team.support', 'team']);
    expect([...runnersToClean]).toEqual(['team.support', 'team']);
  });

  it('evicts both a nested sub-agent and its enclosing parent agent in order', () => {
    const parentDir = path.join(agentsDir, 'parentAgent');
    const greeterDir = path.join(parentDir, 'subAgents', 'greeter');
    fs.mkdirSync(greeterDir, {recursive: true});
    fs.writeFileSync(path.join(parentDir, 'agent.ts'), '');
    const greeterFile = path.join(greeterDir, 'agent.ts');
    fs.writeFileSync(greeterFile, '');

    const handler = new AgentChangeEventHandler({
      agentLoader: loader,
      runnersToClean,
      agentsDir,
    });

    handler.onModified(greeterFile);

    expect(loader.evictedNames).toEqual([
      'parentAgent.subAgents.greeter',
      'parentAgent',
    ]);
    expect([...runnersToClean]).toEqual([
      'parentAgent.subAgents.greeter',
      'parentAgent',
    ]);
  });

  it('ignores changes in non-agent helper directories and outside agentsDir', () => {
    const helpersDir = path.join(agentsDir, 'helpers');
    fs.mkdirSync(helpersDir, {recursive: true});
    const helperFile = path.join(helpersDir, 'helper.ts');
    fs.writeFileSync(helperFile, '');
    const outsideFile = path.join(rootDir, 'outside.ts');
    fs.writeFileSync(outsideFile, '');

    const handler = new AgentChangeEventHandler({
      agentLoader: loader,
      runnersToClean,
      agentsDir,
    });

    handler.onModified(helperFile);
    handler.onModified(outsideFile);
    handler.onModified('../outside.ts');

    expect(loader.evictedNames).toEqual([]);
    expect([...runnersToClean]).toEqual([]);
  });

  it.each([
    {
      label: 'top-level node_modules package containing agent.js',
      relPath: 'node_modules/somePackage/agent.js',
    },
    {
      label: 'nested node_modules package inside an agent directory',
      relPath: 'sampleAgent/node_modules/somePackage/app.js',
    },
    {
      label: 'top-level dot-prefixed directory containing agent.ts',
      relPath: '.hidden/agent.ts',
    },
    {
      label: 'nested dot-prefixed directory inside an agent directory',
      relPath: 'sampleAgent/.adk/cache.yaml',
    },
  ])('ignores paths traversing $label', ({relPath}) => {
    const sampleDir = path.join(agentsDir, 'sampleAgent');
    fs.mkdirSync(sampleDir, {recursive: true});
    fs.writeFileSync(path.join(sampleDir, 'agent.ts'), '');

    const ignoredPath = path.join(agentsDir, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(ignoredPath), {recursive: true});
    fs.writeFileSync(ignoredPath, '');

    const handler = new AgentChangeEventHandler({
      agentLoader: loader,
      runnersToClean,
      agentsDir,
    });

    handler.onModified(ignoredPath);
    handler.createWatchListener()('change', path.join(...relPath.split('/')));

    expect(loader.evictedNames).toEqual([]);
    expect([...runnersToClean]).toEqual([]);
  });

  it('evicts package-style agents with an index entry file via createWatchListener', () => {
    const pkgDir = path.join(agentsDir, 'pkgAgent');
    const subDir = path.join(pkgDir, 'helpers');
    fs.mkdirSync(subDir, {recursive: true});
    fs.writeFileSync(path.join(pkgDir, 'index.ts'), '');
    fs.writeFileSync(path.join(subDir, 'formatter.ts'), '');

    const handler = new AgentChangeEventHandler({
      agentLoader: loader,
      runnersToClean,
      agentsDir,
    });
    const listener = handler.createWatchListener();

    listener('change', path.join('pkgAgent', 'helpers', 'formatter.ts'));

    expect(loader.evictedNames).toEqual(['pkgAgent']);
    expect([...runnersToClean]).toEqual(['pkgAgent']);
  });

  it('handles single-file agentsDir targets and ignores sibling files', () => {
    const singleFile = path.join(rootDir, 'singleAgent.ts');
    const siblingFile = path.join(rootDir, 'otherAgent.ts');
    fs.writeFileSync(singleFile, '');
    fs.writeFileSync(siblingFile, '');

    const handler = new AgentChangeEventHandler({
      agentLoader: loader,
      runnersToClean,
      agentsDir: singleFile,
    });
    const listener = handler.createWatchListener();

    listener('change', siblingFile);
    listener('change', 'otherAgent.ts');
    expect(loader.evictedNames).toEqual([]);

    listener('change', 'singleAgent.ts');
    expect(loader.evictedNames).toEqual(['singleAgent']);
    expect([...runnersToClean]).toEqual(['singleAgent']);

    // Even if an atomic save unlinks the file before renaming its replacement,
    // the single-file target status captured at construction still holds.
    fs.unlinkSync(singleFile);
    runnersToClean.clear();
    listener('rename', 'otherAgent.ts');
    expect(loader.evictedNames).toEqual(['singleAgent']);
    expect([...runnersToClean]).toEqual([]);

    listener('rename', 'singleAgent.ts');
    expect(loader.evictedNames).toEqual(['singleAgent', 'singleAgent']);
    expect([...runnersToClean]).toEqual(['singleAgent']);
  });

  it('marks runners for cleanup without throwing when the loader has no cache', () => {
    const agentDir = path.join(agentsDir, 'statelessAgent');
    fs.mkdirSync(agentDir, {recursive: true});
    const agentFile = path.join(agentDir, 'agent.ts');
    fs.writeFileSync(agentFile, '');

    const handler = new AgentChangeEventHandler({
      agentLoader: new CachelessLoader(),
      runnersToClean,
      agentsDir,
    });

    handler.onModified(agentFile);

    expect([...runnersToClean]).toEqual(['statelessAgent']);
  });
});
