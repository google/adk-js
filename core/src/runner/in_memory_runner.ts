/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent} from '../agents/base_agent.js';
import {InMemoryArtifactService} from '../artifacts/in_memory_artifact_service.js';
import {InMemoryMemoryService} from '../memory/in_memory_memory_service.js';
import {BasePlugin} from '../plugins/base_plugin.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';

import {Runner} from './runner.js';

/**
 * A {@link Runner} pre-configured with in-memory services.
 *
 * Suitable for local development, testing, and prototyping. All session,
 * artifact, and memory data is stored in-process and is not persisted between
 * runs.
 *
 * Example:
 * ```typescript
 * const runner = new InMemoryRunner({agent: myAgent});
 *
 * for await (const event of runner.runEphemeral({
 *   userId: 'user1',
 *   newMessage: {parts: [{text: 'Hello'}]},
 * })) {
 *   console.log(event);
 * }
 * ```
 */
export class InMemoryRunner extends Runner {
  /**
   * Creates a new InMemoryRunner instance.
   *
   * @param params The configuration for the runner.
   * @param params.agent The root agent to run.
   * @param params.appName The application name. Defaults to `'InMemoryRunner'`.
   * @param params.plugins An optional list of plugins.
   */
  constructor(params: {
    agent: BaseAgent;
    appName?: string;
    plugins?: BasePlugin[];
  }) {
    const {agent, appName = 'InMemoryRunner', plugins = []} = params;
    super({
      appName,
      agent,
      plugins,
      artifactService: new InMemoryArtifactService(),
      sessionService: new InMemorySessionService(),
      memoryService: new InMemoryMemoryService(),
    });
  }
}
