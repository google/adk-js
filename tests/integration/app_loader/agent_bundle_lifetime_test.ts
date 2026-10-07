/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event, InMemorySessionService} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {AdkApiServer} from '../../../dev/src/server/adk_api_server.js';
import {
  AgentLoader,
  FileModuleType,
} from '../../../dev/src/utils/agent_loader.js';

describe.each([FileModuleType.CJS, FileModuleType.ESM])(
  'Shared agent bundle (%s)',
  (moduleType) => {
    it.each([
      'build_graph',
      'build_graph_image',
      'event_graph',
      'run',
      'run_sse',
    ])(
      'keeps lazy imports working after a %s request until loader disposal',
      async (endpoint) => {
        const packages = ['first', 'second', 'third'].map(
          (name) => `lazy-${moduleType}-${endpoint}-${name}`,
        );
        const project = await fs.mkdtemp(
          path.join(os.tmpdir(), 'adk-bundle-lifetime-'),
        );
        const loader = new AgentLoader(project, {
          compile: true,
          bundle: true,
          moduleType,
        });
        const sessionService = new InMemorySessionService();
        const server = new AdkApiServer({agentLoader: loader, sessionService});

        try {
          await fs.writeFile(
            path.join(project, 'package.json'),
            JSON.stringify({type: 'module'}),
          );
          await fs.mkdir(path.join(project, 'node_modules', '@google'), {
            recursive: true,
          });
          await fs.symlink(
            // The package exports resolve to dist, so build core before running.
            fileURLToPath(new URL('../../../core/', import.meta.url)),
            path.join(project, 'node_modules', '@google', 'adk'),
            process.platform === 'win32' ? 'junction' : 'dir',
          );
          // Separate packages ensure a later request cannot succeed merely
          // because Node cached the import made by an earlier request.
          for (const name of packages) {
            const packageDir = path.join(project, 'node_modules', name);
            await fs.mkdir(packageDir);
            await fs.writeFile(
              path.join(packageDir, 'package.json'),
              JSON.stringify({name, type: 'module', exports: './index.js'}),
            );
            await fs.writeFile(
              path.join(packageDir, 'index.js'),
              `export default ${JSON.stringify(name)};`,
            );
          }
          await fs.writeFile(
            path.join(project, 'agent.ts'),
            `import {BaseAgent, createEvent} from '@google/adk';
class LazyAgent_${moduleType}_${endpoint} extends BaseAgent {
  async *runAsyncImpl(context) {
    const name = context.userContent.parts[0].text;
    const loaded = await import(name);
    yield createEvent({
      author: this.name,
      invocationId: context.invocationId,
      content: {role: 'model', parts: [{text: loaded.default}]},
    });
  }
}
export const rootAgent = new LazyAgent_${moduleType}_${endpoint}({name: 'lazy_agent'});`,
          );

          const agentFile = await loader.getAgentFile('agent');
          const compiledPath = agentFile.getFilePath();
          const session = await sessionService.createSession({
            appName: 'agent',
            userId: 'user',
            sessionId: 'session',
          });
          await sessionService.appendEvent({
            session,
            event: createEvent({
              id: 'event',
              author: 'lazy_agent',
              invocationId: 'previous',
              content: {role: 'model', parts: [{text: 'Previous response'}]},
            }),
          });
          await server.start();

          const run = (route: string, packageName: string) =>
            fetch(`${server.url}/${route}`, {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({
                appName: 'agent',
                userId: 'user',
                sessionId: 'session',
                newMessage: {role: 'user', parts: [{text: packageName}]},
              }),
            });
          const firstResponse = endpoint.startsWith('run')
            ? await run(endpoint, packages[0])
            : await fetch(
                `${server.url}${
                  endpoint === 'event_graph'
                    ? '/apps/agent/users/user/sessions/session/events/event/graph'
                    : `/dev/apps/agent/${endpoint}`
                }`,
              );
          expect(firstResponse.status).toBe(200);
          // Drain streaming responses so their request scope has finished.
          await firstResponse.text();

          for (const name of packages.slice(1)) {
            const response = await run('run', name);
            const events = (await response.json()) as Event[];
            expect(response.status).toBe(200);
            expect(
              events.some((e) => e.content?.parts?.[0].text === name),
            ).toBe(true);
          }
          await expect(fs.access(compiledPath)).resolves.toBeUndefined();
          await server.stop();
          await loader.disposeAll();
          await expect(
            fs.stat(path.dirname(compiledPath)),
          ).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
          await server.stop();
          await loader.disposeAll();
          await fs.rm(project, {recursive: true, force: true});
        }
      },
    );
  },
);
