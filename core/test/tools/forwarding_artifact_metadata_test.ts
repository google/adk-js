/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {InMemoryArtifactService} from '../../src/artifacts/in_memory_artifact_service.js';
import {ScopedArtifactService} from '../../src/artifacts/scoped_artifact_service.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {ForwardingArtifactService} from '../../src/tools/forwarding_artifact_service.js';

describe('ForwardingArtifactService metadata', () => {
  it('retains per-version custom metadata while tracking parent artifact deltas', async () => {
    const session = createSession({
      appName: 'app',
      userId: 'user',
      id: 'session',
    });
    const storage = new ScopedArtifactService(
      new InMemoryArtifactService(),
      session.appName,
      session.userId,
      session.id,
    );
    const context = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'invocation',
        session,
        artifactService: storage,
        pluginManager: new PluginManager([]),
      }),
    });
    const service = new ForwardingArtifactService(context);

    for (const [version, producer] of [
      'first-agent',
      'second-agent',
    ].entries()) {
      const customMetadata = {producer, page: version + 1};
      expect(
        await service.saveArtifact({
          filename: 'report.txt',
          artifact: {text: producer},
          customMetadata,
        }),
      ).toBe(version);
      expect(context.eventActions.artifactDelta).toEqual({
        'report.txt': version,
      });
      expect(
        await storage.getArtifactVersion({filename: 'report.txt', version}),
      ).toMatchObject({version, customMetadata});
    }
    expect(await service.loadArtifact({filename: 'report.txt'})).toEqual({
      text: 'second-agent',
    });
  });
});
