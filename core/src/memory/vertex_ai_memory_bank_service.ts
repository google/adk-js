/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai/build/src/genai/client.js';
import {Memories} from '@google-cloud/vertexai/build/src/genai/memories.js';
import {
  AgentEngineMemoryConfig,
  CreateAgentEngineMemoryRequestParameters,
  GenerateAgentEngineMemoriesConfig,
  GenerateAgentEngineMemoriesRequestParameters,
  GenerateMemoriesRequestDirectContentsSourceEvent,
  MemoryMetadataValue,
  RetrieveAgentEngineMemoriesRequestParameters,
} from '@google-cloud/vertexai/build/src/genai/types.js';
import {Content, Part} from '@google/genai';
import {Event} from '../events/event.js';
import {Session} from '../sessions/session.js';
import {logger} from '../utils/logger.js';
import {getExpressModeApiKey} from '../utils/vertex_ai_utils.js';
import {
  BaseMemoryService,
  SearchMemoryRequest,
  SearchMemoryResponse,
} from './base_memory_service.js';
import {MemoryEntry} from './memory_entry.js';

const ENABLE_CONSOLIDATION_KEY = 'enable_consolidation';
const MAX_DIRECT_MEMORIES_PER_GENERATE_CALL = 5;

export interface VertexAiMemoryBankServiceOptions {
  projectId?: string;
  location?: string;
  agentEngineId: string;
  expressModeApiKey?: string;
  client?: Client;
}

/**
 * Implementation of the BaseMemoryService using Vertex AI Memory Bank.
 */
export class VertexAiMemoryBankService implements BaseMemoryService {
  private readonly projectId?: string;
  private readonly location?: string;
  private readonly agentEngineId: string;
  private readonly expressModeApiKey?: string;
  private readonly memories: Memories;

  constructor(options: VertexAiMemoryBankServiceOptions) {
    if (!options.agentEngineId) {
      throw new Error(
        'agentEngineId is required for VertexAiMemoryBankService.',
      );
    }

    this.projectId = options.projectId;
    this.location = options.location;
    this.agentEngineId = options.agentEngineId;
    this.expressModeApiKey = getExpressModeApiKey(
      options.projectId,
      options.location,
      options.expressModeApiKey,
    );

    if (options.agentEngineId.includes('/')) {
      logger.warn(
        `agentEngineId appears to be a full resource path: '${options.agentEngineId}'. ` +
          `Expected just the ID (e.g., '456'). ` +
          `Extract the ID using: agentEngine.apiResource.name.split('/').pop()`,
      );
    }

    if (options.client) {
      this.memories = options.client.agentEnginesInternal.memories;
    } else {
      const client = new Client({
        project: this.projectId,
        location: this.location,
      });
      this.memories = client.agentEnginesInternal.memories;
    }
  }

  async addSessionToMemory(session: Session): Promise<void> {
    await this._addEventsToMemoryFromEvents({
      appName: session.appName,
      userId: session.userId,
      eventsToProcess: session.events,
    });
  }

  /**
   * Adds events to Vertex AI Memory Bank via memories.generate.
   */
  async addEventsToMemory(request: {
    appName: string;
    userId: string;
    events: Event[];
    sessionId?: string;
    customMetadata?: Record<string, unknown>;
  }): Promise<void> {
    await this._addEventsToMemoryFromEvents({
      appName: request.appName,
      userId: request.userId,
      eventsToProcess: request.events,
      customMetadata: request.customMetadata,
    });
  }

  /**
   * Adds explicit memory items using Vertex Memory Bank.
   */
  async addMemory(request: {
    appName: string;
    userId: string;
    memories: MemoryEntry[];
    customMetadata?: Record<string, unknown>;
  }): Promise<void> {
    if (this._isConsolidationEnabled(request.customMetadata)) {
      await this._addMemoriesViaGenerateDirectMemoriesSource(request);
      return;
    }

    await this._addMemoriesViaCreate(request);
  }

  async searchMemory(
    request: SearchMemoryRequest,
  ): Promise<SearchMemoryResponse> {
    const params: RetrieveAgentEngineMemoriesRequestParameters = {
      name: `reasoningEngines/${this.agentEngineId}`,
      scope: {
        app_name: request.appName,
        user_id: request.userId,
      },
      similaritySearchParams: {
        searchQuery: request.query,
      },
    };
    const retrievedMemoriesResponse =
      await this.memories.retrieveInternal(params);

    logger.info('Search memory response received.');

    const memoryEvents: MemoryEntry[] = [];
    const retrievedMemories = retrievedMemoriesResponse.retrievedMemories || [];

    for (const retrievedMemory of retrievedMemories) {
      logger.debug(`Retrieved memory: ${JSON.stringify(retrievedMemory)}`);
      if (retrievedMemory.memory && retrievedMemory.memory.fact) {
        const part: Part = {text: retrievedMemory.memory.fact};
        const content: Content = {
          parts: [part],
          role: 'user',
        };
        memoryEvents.push({
          author: 'user',
          content: content,
          timestamp: retrievedMemory.memory.updateTime,
        });
      }
    }

    return {memories: memoryEvents};
  }

  private async _addEventsToMemoryFromEvents(request: {
    appName: string;
    userId: string;
    eventsToProcess: Event[];
    customMetadata?: Record<string, unknown>;
  }): Promise<void> {
    const directEvents: GenerateMemoriesRequestDirectContentsSourceEvent[] = [];
    for (const event of request.eventsToProcess) {
      if (this._shouldFilterOutEvent(event.content)) {
        continue;
      }
      if (event.content) {
        // Content might need to be serialized or dumped as in Python
        directEvents.push({
          content: JSON.parse(JSON.stringify(event.content)),
        });
      }
    }

    if (directEvents.length > 0) {
      const config = this._buildGenerateMemoriesConfig(request.customMetadata);
      const params: GenerateAgentEngineMemoriesRequestParameters = {
        name: `reasoningEngines/${this.agentEngineId}`,
        directContentsSource: {events: directEvents},
        scope: {
          app_name: request.appName,
          user_id: request.userId,
        },
        config: config,
      };
      const operation = await this.memories.generateInternal(params);
      logger.info('Generate memory response received.');
      logger.debug(`Generate memory response: ${JSON.stringify(operation)}`);
    } else {
      logger.info('No events to add to memory.');
    }
  }

  private async _addMemoriesViaCreate(request: {
    appName: string;
    userId: string;
    memories: MemoryEntry[];
    customMetadata?: Record<string, unknown>;
  }): Promise<void> {
    const validatedMemories = this._normalizeMemoriesForCreate(
      request.memories,
    );

    for (let index = 0; index < validatedMemories.length; index++) {
      const memory = validatedMemories[index];
      const memoryFact = this._memoryEntryToFact(memory, index);

      // We don't have customMetadata on MemoryEntry in JS yet, so we pass undefined or handle it if we extend it.
      // For now, we assume it's not there as per the current interface.
      const memoryMetadata = this._mergeCustomMetadataForMemory({
        customMetadata: request.customMetadata,
        memory: memory,
      });

      const memoryRevisionLabels = this._revisionLabelsForMemory(memory);
      const config = this._buildCreateMemoryConfig({
        customMetadata: memoryMetadata,
        memoryRevisionLabels,
      });

      const params: CreateAgentEngineMemoryRequestParameters = {
        name: `reasoningEngines/${this.agentEngineId}`,
        fact: memoryFact,
        scope: {
          app_name: request.appName,
          user_id: request.userId,
        },
        config: config,
      };
      const operation = await this.memories.createInternal(params);
      logger.info('Create memory response received.');
      logger.debug(`Create memory response: ${JSON.stringify(operation)}`);
    }
  }

  private async _addMemoriesViaGenerateDirectMemoriesSource(request: {
    appName: string;
    userId: string;
    memories: MemoryEntry[];
    customMetadata?: Record<string, unknown>;
  }): Promise<void> {
    const validatedMemories = this._normalizeMemoriesForCreate(
      request.memories,
    );
    const memoryTexts = validatedMemories.map((m, i) =>
      this._memoryEntryToFact(m, i),
    );

    const config = this._buildGenerateMemoriesConfig(request.customMetadata);
    const memoryBatches = this._iterMemoryBatches(memoryTexts);

    for (const memoryBatch of memoryBatches) {
      const params: GenerateAgentEngineMemoriesRequestParameters = {
        name: `reasoningEngines/${this.agentEngineId}`,
        directMemoriesSource: {
          directMemories: memoryBatch.map((fact) => ({fact})),
        },
        scope: {
          app_name: request.appName,
          user_id: request.userId,
        },
        config: config,
      };
      const operation = await this.memories.generateInternal(params);
      logger.info('Generate direct memory response received.');
      logger.debug(
        `Generate direct memory response: ${JSON.stringify(operation)}`,
      );
    }
  }

  private _shouldFilterOutEvent(content?: Content): boolean {
    if (!content || !content.parts) {
      return true;
    }
    for (const part of content.parts) {
      const explicitPart: Part = part;
      if (
        explicitPart.text ||
        explicitPart.inlineData ||
        explicitPart.fileData
      ) {
        return false;
      }
    }
    return true;
  }

  private _buildGenerateMemoriesConfig(
    customMetadata?: Record<string, unknown>,
  ): GenerateAgentEngineMemoriesConfig {
    const config: Record<string, unknown> = {waitForCompletion: false};
    if (!customMetadata) {
      return config;
    }

    logger.debug(
      `Memory generation metadata: ${JSON.stringify(customMetadata)}`,
    );

    const metadataByKey: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(customMetadata)) {
      if (key === ENABLE_CONSOLIDATION_KEY) {
        continue;
      }
      if (key === 'ttl') {
        if (value === null || value === undefined) continue;
        if (customMetadata['revisionTtl'] === undefined) {
          config['revisionTtl'] = value as string;
        }
        continue;
      }
      if (key === 'metadata') {
        if (value === null || value === undefined) continue;
        if (typeof value === 'object' && !Array.isArray(value)) {
          config['metadata'] = this._buildVertexMetadata(
            value as Record<string, unknown>,
          );
        } else {
          logger.warn(
            'Ignoring metadata because customMetadata["metadata"] is not an object.',
          );
        }
        continue;
      }

      // In JS we assume the fields are supported if they are in the type.
      // We just map them if they are known fields.
      const knownFields = [
        'disableConsolidation',
        'waitForCompletion',
        'revisionLabels',
        'revisionExpireTime',
        'revisionTtl',
        'disableMemoryRevisions',
        'metadataMergeStrategy',
        'allowedTopics',
      ];

      if (knownFields.includes(key)) {
        if (value !== null && value !== undefined) {
          config[key] = value;
        }
      } else {
        metadataByKey[key] = value;
      }
    }

    if (Object.keys(metadataByKey).length > 0) {
      const existingMetadata = config['metadata'];
      if (!existingMetadata) {
        config['metadata'] = this._buildVertexMetadata(metadataByKey);
      } else {
        config['metadata'] = {
          ...existingMetadata,
          ...this._buildVertexMetadata(metadataByKey),
        };
      }
    }

    return config as GenerateAgentEngineMemoriesConfig;
  }

  private _buildCreateMemoryConfig(params: {
    customMetadata?: Record<string, unknown>;
    memoryRevisionLabels?: Record<string, string>;
  }): AgentEngineMemoryConfig {
    const config: Record<string, unknown> = {waitForCompletion: false};

    if (params.customMetadata) {
      logger.debug(
        `Memory creation metadata: ${JSON.stringify(params.customMetadata)}`,
      );
    }

    const metadataByKey: Record<string, unknown> = {};
    const customRevisionLabels: Record<string, string> = {};

    for (const [key, value] of Object.entries(params.customMetadata || {})) {
      if (key === ENABLE_CONSOLIDATION_KEY) {
        continue;
      }
      if (key === 'metadata') {
        if (value === null || value === undefined) continue;
        if (typeof value === 'object' && !Array.isArray(value)) {
          config['metadata'] = this._buildVertexMetadata(
            value as Record<string, unknown>,
          );
        } else {
          logger.warn(
            'Ignoring metadata because customMetadata["metadata"] is not an object.',
          );
        }
        continue;
      }
      if (key === 'revisionLabels') {
        if (value === null || value === undefined) continue;
        const extractedLabels = this._extractRevisionLabels(
          value,
          'customMetadata["revisionLabels"]',
        );
        if (extractedLabels) {
          Object.assign(customRevisionLabels, extractedLabels);
        }
        continue;
      }

      const knownFields = [
        'displayName',
        'description',
        'waitForCompletion',
        'ttl',
        'expireTime',
        'revisionExpireTime',
        'revisionTtl',
        'disableMemoryRevisions',
        'topics',
        'memoryId',
      ];

      if (knownFields.includes(key)) {
        if (value !== null && value !== undefined) {
          config[key] = value;
        }
      } else {
        metadataByKey[key] = value;
      }
    }

    if (Object.keys(metadataByKey).length > 0) {
      const existingMetadata = config['metadata'];
      if (!existingMetadata) {
        config['metadata'] = this._buildVertexMetadata(metadataByKey);
      } else {
        config['metadata'] = {
          ...existingMetadata,
          ...this._buildVertexMetadata(metadataByKey),
        };
      }
    }

    const revisionLabels = {
      ...customRevisionLabels,
      ...params.memoryRevisionLabels,
    };
    if (Object.keys(revisionLabels).length > 0) {
      config['revisionLabels'] = revisionLabels;
    }

    return config as AgentEngineMemoryConfig;
  }

  private _normalizeMemoriesForCreate(memories: MemoryEntry[]): MemoryEntry[] {
    if (!Array.isArray(memories)) {
      throw new TypeError('memories must be a sequence of memory items.');
    }
    if (memories.length === 0) {
      throw new Error('memories must contain at least one entry.');
    }
    return memories;
  }

  private _memoryEntryToFact(memory: MemoryEntry, index: number): string {
    if (this._shouldFilterOutEvent(memory.content)) {
      throw new Error(`memories[${index}] must include text.`);
    }

    const textParts: string[] = [];
    if (memory.content && memory.content.parts) {
      for (const part of memory.content.parts) {
        const explicitPart: Part = part;
        if (explicitPart.inlineData || explicitPart.fileData) {
          throw new Error(
            `memories[${index}] must include text only; inlineData and fileData are not supported.`,
          );
        }
        if (explicitPart.text) {
          const strippedText = explicitPart.text.trim();
          if (strippedText) {
            textParts.push(strippedText);
          }
        }
      }
    }

    if (textParts.length === 0) {
      throw new Error(`memories[${index}] must include non-whitespace text.`);
    }
    return textParts.join('\n');
  }

  private _mergeCustomMetadataForMemory(params: {
    customMetadata?: Record<string, unknown>;
    memory: MemoryEntry;
  }): Record<string, unknown> | undefined {
    const mergedMetadata: Record<string, unknown> = {};

    if (params.customMetadata) {
      Object.assign(mergedMetadata, params.customMetadata);
    }

    // Check if memory has customMetadata (it might if passed by user, even if not in interface)
    interface MemoryEntryWithMetadata extends MemoryEntry {
      customMetadata?: Record<string, unknown>;
    }
    const memoryWithMetadata = params.memory as MemoryEntryWithMetadata;
    if (memoryWithMetadata.customMetadata) {
      Object.assign(mergedMetadata, memoryWithMetadata.customMetadata);
    }

    if (Object.keys(mergedMetadata).length === 0) {
      return undefined;
    }
    return mergedMetadata;
  }

  private _revisionLabelsForMemory(
    memory: MemoryEntry,
  ): Record<string, string> | undefined {
    const revisionLabels: Record<string, string> = {};
    if (memory.author) {
      revisionLabels['author'] = memory.author;
    }
    if (memory.timestamp) {
      revisionLabels['timestamp'] = memory.timestamp;
    }

    if (Object.keys(revisionLabels).length === 0) {
      return undefined;
    }
    return revisionLabels;
  }

  private _extractRevisionLabels(
    value: unknown,
    source: string,
  ): Record<string, string> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      logger.warn(`Ignoring ${source} because it is not an object.`);
      return undefined;
    }

    const revisionLabels: Record<string, string> = {};
    for (const [key, labelValue] of Object.entries(value)) {
      if (typeof labelValue !== 'string') {
        logger.warn(
          `Ignoring revision label ${key} from ${source} because its value is not a string.`,
        );
        continue;
      }
      revisionLabels[key] = labelValue;
    }

    if (Object.keys(revisionLabels).length === 0) {
      return undefined;
    }
    return revisionLabels;
  }

  private _isConsolidationEnabled(
    customMetadata?: Record<string, unknown>,
  ): boolean {
    if (!customMetadata) {
      return false;
    }
    const enableConsolidation = customMetadata[ENABLE_CONSOLIDATION_KEY];
    if (enableConsolidation === undefined) {
      return false;
    }
    if (typeof enableConsolidation !== 'boolean') {
      throw new TypeError(
        `customMetadata["${ENABLE_CONSOLIDATION_KEY}"] must be a bool.`,
      );
    }
    return enableConsolidation;
  }

  private _iterMemoryBatches(memories: string[]): string[][] {
    const memoryBatches: string[][] = [];
    for (
      let index = 0;
      index < memories.length;
      index += MAX_DIRECT_MEMORIES_PER_GENERATE_CALL
    ) {
      memoryBatches.push(
        memories.slice(index, index + MAX_DIRECT_MEMORIES_PER_GENERATE_CALL),
      );
    }
    return memoryBatches;
  }

  private _buildVertexMetadata(
    metadataByKey: Record<string, unknown>,
  ): Record<string, MemoryMetadataValue> {
    const vertexMetadata: Record<string, MemoryMetadataValue> = {};
    for (const [key, value] of Object.entries(metadataByKey)) {
      const convertedValue = this._toVertexMetadataValue(key, value);
      if (convertedValue !== undefined) {
        vertexMetadata[key] = convertedValue;
      }
    }
    return vertexMetadata;
  }

  private _toVertexMetadataValue(
    key: string,
    value: unknown,
  ): MemoryMetadataValue | undefined {
    if (typeof value === 'boolean') {
      return {boolValue: value};
    }
    if (typeof value === 'number') {
      return {doubleValue: value};
    }
    if (typeof value === 'string') {
      return {stringValue: value};
    }
    if (value instanceof Date) {
      return {timestampValue: value.toISOString()};
    }
    if (typeof value === 'object' && value !== null) {
      // Check if it already matches the structure
      const v = value as Partial<MemoryMetadataValue>;
      if (
        v.boolValue !== undefined ||
        v.doubleValue !== undefined ||
        v.stringValue !== undefined ||
        v.timestampValue !== undefined
      ) {
        return v as MemoryMetadataValue;
      }
      return {stringValue: JSON.stringify(value)};
    }
    if (value === null || value === undefined) {
      logger.warn(
        `Ignoring custom metadata key ${key} because its value is null or undefined.`,
      );
      return undefined;
    }
    return {stringValue: String(value)};
  }
}
