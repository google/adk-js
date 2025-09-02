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

export class InMemoryRunner extends Runner {
  constructor({
    agent,
    appName = 'InMemoryRunner',
    plugins = [],
  }: {agent: BaseAgent; appName?: string; plugins?: BasePlugin[];}) {
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
