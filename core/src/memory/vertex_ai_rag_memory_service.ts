/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Session} from '../sessions/session.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {
  RagApiClient,
  RagContext,
  VertexRagApiClient,
} from '../utils/vertex_rag_api.js';
import {
  BaseMemoryService,
  SearchMemoryRequest,
  SearchMemoryResponse,
} from './base_memory_service.js';
import {MemoryEntry} from './memory_entry.js';
import {
  buildSourceDisplayName,
  mergeOverlappingEventLists,
  parseSourceDisplayName,
  parseTranscriptEvents,
  serializeSessionTranscript,
  SourceIdentity,
  TranscriptEvent,
} from './rag_memory_transcript.js';

/** Files requested per corpus listing page. The API caps this at 100. */
const RAG_FILE_PAGE_SIZE = 100;

/**
 * Listing pages a search may walk. The cap keeps the cost of a search
 * independent of how large a shared corpus grows.
 */
const MAX_RAG_FILE_PAGES = 10;

/** Vector distance above which a context is dropped. */
const DEFAULT_VECTOR_DISTANCE_THRESHOLD = 10;

/** Options for {@link VertexAiRagMemoryService}. */
export interface VertexAiRagMemoryServiceOptions {
  /**
   * `projects/{project}/locations/{location}/ragCorpora/{ragCorpusId}`, or a
   * bare `{ragCorpusId}` when the project and the location are resolvable.
   */
  ragCorpus: string;
  /** Number of contexts to retrieve. Sent as `ragRetrievalConfig.topK`. */
  similarityTopK?: number;
  /** Only return contexts below this vector distance. Defaults to 10. */
  vectorDistanceThreshold?: number;
  /** Defaults to `process.env.GOOGLE_CLOUD_PROJECT`. */
  projectId?: string;
  /** Defaults to `process.env.GOOGLE_CLOUD_LOCATION`. */
  location?: string;
  /** Defaults to a {@link VertexRagApiClient} for the resolved location. */
  ragApiClient?: RagApiClient;
}

interface ResolvedRagCorpus {
  ragCorpus: string;
  projectId: string;
  location: string;
}

function resolveRagCorpus(
  options: VertexAiRagMemoryServiceOptions,
): ResolvedRagCorpus {
  const ragCorpus = options.ragCorpus.trim();
  const isResourceName = ragCorpus.startsWith('projects/');
  const segments = ragCorpus.split('/');
  const projectId =
    options.projectId ??
    (isResourceName ? segments[1] : process.env['GOOGLE_CLOUD_PROJECT']);
  const location =
    options.location ??
    (isResourceName ? segments[3] : process.env['GOOGLE_CLOUD_LOCATION']);

  if (!projectId) {
    throw new Error(
      'projectId is required for VertexAiRagMemoryService: pass projectId, ' +
        'set GOOGLE_CLOUD_PROJECT, or give ragCorpus as a full resource name.',
    );
  }
  if (!location) {
    throw new Error(
      'location is required for VertexAiRagMemoryService: pass location, ' +
        'set GOOGLE_CLOUD_LOCATION, or give ragCorpus as a full resource name.',
    );
  }

  return {
    projectId,
    location,
    ragCorpus: isResourceName
      ? ragCorpus
      : `projects/${projectId}/locations/${location}/ragCorpora/${ragCorpus}`,
  };
}

/**
 * Returns the identifiers behind a display name when it belongs to the
 * requesting app and user, and `undefined` otherwise.
 *
 * This is the tenant boundary: it runs on every retrieved context, including
 * the contexts of a retrieval that could not be narrowed beforehand.
 */
function tenantSource(
  displayName: string | undefined,
  appName: string,
  userId: string,
): SourceIdentity | undefined {
  if (!displayName) {
    return undefined;
  }
  const source = parseSourceDisplayName(displayName);
  if (!source || source.appName !== appName || source.userId !== userId) {
    return undefined;
  }
  return source;
}

/** Returns the bare file id of a full RAG file resource name. */
function bareRagFileId(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

function toMemoryEntries(
  contexts: RagContext[],
  request: SearchMemoryRequest,
): MemoryEntry[] {
  const eventListsBySession = new Map<string, TranscriptEvent[][]>();
  for (const context of contexts) {
    const source = tenantSource(
      context.sourceDisplayName,
      request.appName,
      request.userId,
    );
    if (!source) {
      continue;
    }
    const events = parseTranscriptEvents(context.text ?? '');
    const eventLists = eventListsBySession.get(source.sessionId);
    if (eventLists) {
      eventLists.push(events);
    } else {
      eventListsBySession.set(source.sessionId, [events]);
    }
  }

  const memories: MemoryEntry[] = [];
  for (const eventLists of eventListsBySession.values()) {
    for (const events of mergeOverlappingEventLists(eventLists)) {
      const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
      for (const event of sorted) {
        memories.push({
          author: event.author,
          content: {parts: [{text: event.text}]},
          timestamp: new Date(event.timestamp).toISOString(),
        });
      }
    }
  }
  return memories;
}

/**
 * A {@link BaseMemoryService} backed by a Vertex AI RAG Engine corpus.
 *
 * A finished session is uploaded as one RAG file holding its transcript, and a
 * search retrieves the chunks of those transcripts that match the query. Only
 * `addSessionToMemory` and `searchMemory` are supported, matching adk-python.
 *
 * @example
 * ```ts
 * const memoryService = new VertexAiRagMemoryService({
 *   ragCorpus: 'projects/my-project/locations/us-central1/ragCorpora/12345',
 *   similarityTopK: 5,
 * });
 * await memoryService.addSessionToMemory(session);
 * ```
 */
export class VertexAiRagMemoryService implements BaseMemoryService {
  private readonly ragCorpus: string;
  private readonly projectId: string;
  private readonly location: string;
  private readonly similarityTopK?: number;
  private readonly vectorDistanceThreshold: number;
  private readonly ragApiClient: RagApiClient;

  constructor(options: VertexAiRagMemoryServiceOptions) {
    if (!options.ragCorpus || !options.ragCorpus.trim()) {
      throw new Error('ragCorpus is required for VertexAiRagMemoryService.');
    }
    const resolved = resolveRagCorpus(options);
    this.ragCorpus = resolved.ragCorpus;
    this.projectId = resolved.projectId;
    this.location = resolved.location;
    this.similarityTopK = options.similarityTopK;
    this.vectorDistanceThreshold =
      options.vectorDistanceThreshold ?? DEFAULT_VECTOR_DISTANCE_THRESHOLD;
    this.ragApiClient =
      options.ragApiClient ?? new VertexRagApiClient({location: this.location});
  }

  /** Uploads the session's transcript into the corpus as one RAG file. */
  async addSessionToMemory(session: Session): Promise<void> {
    return this.ragApiClient.uploadRagFile({
      ragCorpus: this.ragCorpus,
      displayName: buildSourceDisplayName(
        session.appName,
        session.userId,
        session.id,
      ),
      content: serializeSessionTranscript(session),
    });
  }

  async searchMemory(
    request: SearchMemoryRequest,
  ): Promise<SearchMemoryResponse> {
    const ragFileIds = await this.listTenantRagFileIds(request);
    if (ragFileIds?.length === 0) {
      return {memories: []};
    }

    const response = await this.ragApiClient.retrieveContexts({
      parent: `projects/${this.projectId}/locations/${this.location}`,
      vertexRagStore: {
        ragResources: [{ragCorpus: this.ragCorpus, ragFileIds}],
      },
      query: {
        text: request.query,
        // Top-k belongs on the query: retrieveContexts ignores
        // VertexRagStore.similarityTopK.
        ragRetrievalConfig: {
          topK: this.similarityTopK,
          filter: {vectorDistanceThreshold: this.vectorDistanceThreshold},
        },
      },
    });
    logger.debug('Search memory response received.');

    return {
      memories: toMemoryEntries(response.contexts?.contexts ?? [], request),
    };
  }

  /**
   * Returns the ids of the corpus files owned by the requesting app and user,
   * or `undefined` when the corpus could not be listed within the page budget.
   *
   * An `undefined` result retrieves over the whole corpus. Narrowing only
   * improves ranking and transfer size, and every returned context is filtered
   * by tenant anyway. Scoping to a partial listing would instead hide the
   * caller's own memories.
   */
  private async listTenantRagFileIds(
    request: SearchMemoryRequest,
  ): Promise<string[] | undefined> {
    const ragFileIds: string[] = [];
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < MAX_RAG_FILE_PAGES; page++) {
        const response = await this.ragApiClient.listRagFiles({
          ragCorpus: this.ragCorpus,
          pageSize: RAG_FILE_PAGE_SIZE,
          pageToken,
        });
        for (const ragFile of response.ragFiles ?? []) {
          const source = tenantSource(
            ragFile.displayName,
            request.appName,
            request.userId,
          );
          if (source && ragFile.name) {
            ragFileIds.push(bareRagFileId(ragFile.name));
          }
        }
        pageToken = response.nextPageToken;
        if (!pageToken) {
          return ragFileIds;
        }
      }
    } catch (e: unknown) {
      logger.warn(
        'Listing the corpus failed, so retrieval is not scoped to the ' +
          `requesting app and user: ${formatError(e)}`,
      );
      return undefined;
    }

    logger.warn(
      `Listing ${this.ragCorpus} did not finish within ${MAX_RAG_FILE_PAGES} ` +
        'pages, so retrieval is not scoped to the requesting app and user.',
    );
    return undefined;
  }
}
