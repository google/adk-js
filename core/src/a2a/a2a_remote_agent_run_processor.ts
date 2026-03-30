/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MessageSendParams} from '@a2a-js/sdk';
import {
  CitationMetadata,
  createModelContent,
  Part as GenAIPart,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
} from '@google/genai';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event as AdkEvent, createEvent} from '../events/event.js';
import {
  A2AEvent,
  getEventMetadata,
  isTask,
  isTaskArtifactUpdateEvent,
  isTaskStatusUpdateEvent,
} from './a2a_event.js';
import {A2AMetadataKeys} from './metadata_converter_utils.js';

/**
 * Aggregated state for a specific artifact.
 */
interface ArtifactAggregation {
  aggregatedText: string;
  aggregatedThoughts: string;
  parts: GenAIPart[];
  citations?: CitationMetadata;
  grounding?: GroundingMetadata;
  customMeta?: Record<string, unknown>;
  usage?: GenerateContentResponseUsageMetadata;
}

/**
 * Processes streams of A2A events and aggregates partials for emissions.
 */
export class A2ARemoteAgentRunProcessor {
  private aggregations = new Map<string, ArtifactAggregation>();
  private aggregationOrder: string[] = [];

  constructor(private readonly request?: MessageSendParams) {}

  /**
   * aggregatePartial stores contents of partial events to emit them with the terminal event.
   * It can return multiple events to emit instead of just the provided one.
   */
  aggregatePartial(
    context: InvocationContext,
    a2aEvent: A2AEvent,
    adkEvent: AdkEvent,
  ): AdkEvent[] {
    const metadata = getEventMetadata(a2aEvent);
    if (metadata[A2AMetadataKeys.PARTIAL]) {
      return [adkEvent];
    }

    if (isTaskStatusUpdateEvent(a2aEvent) && a2aEvent.final) {
      const events: AdkEvent[] = [];
      for (const aid of this.aggregationOrder) {
        const agg = this.aggregations.get(aid);
        if (agg) {
          events.push(this.buildNonPartialAggregation(context, agg));
        }
      }
      this.aggregations.clear();
      this.aggregationOrder = [];
      return [...events, adkEvent];
    }

    if (isTask(a2aEvent)) {
      this.aggregations.clear();
      this.aggregationOrder = [];
      return [adkEvent];
    }

    if (!isTaskArtifactUpdateEvent(a2aEvent)) {
      return [adkEvent];
    }

    const artifactId = a2aEvent.artifact.artifactId;

    if (!a2aEvent.append) {
      this.removeAggregation(artifactId);
      if (a2aEvent.lastChunk) {
        adkEvent.partial = false;
        return [adkEvent];
      }
    }

    let aggregation = this.aggregations.get(artifactId);
    if (!aggregation) {
      aggregation = {
        aggregatedText: '',
        aggregatedThoughts: '',
        parts: [],
      };
      this.aggregations.set(artifactId, aggregation);
      this.aggregationOrder.push(artifactId);
    } else {
      // Move to end of order as it was updated
      this.aggregationOrder = this.aggregationOrder.filter(
        (id) => id !== artifactId,
      );
      this.aggregationOrder.push(artifactId);
    }

    this.updateAggregation(aggregation, adkEvent);

    if (!a2aEvent.lastChunk) {
      return [adkEvent];
    }

    this.removeAggregation(artifactId);
    return [adkEvent, this.buildNonPartialAggregation(context, aggregation)];
  }

  private removeAggregation(artifactId: string) {
    this.aggregations.delete(artifactId);
    this.aggregationOrder = this.aggregationOrder.filter(
      (id) => id !== artifactId,
    );
  }

  private updateAggregation(agg: ArtifactAggregation, event: AdkEvent) {
    const parts = event.content?.parts || [];
    for (const part of parts) {
      if (part.text && part.text !== '') {
        if (part.thought) {
          agg.aggregatedThoughts += part.text;
        } else {
          agg.aggregatedText += part.text;
        }
      } else {
        this.promoteTextBlocksToParts(agg);
        agg.parts.push(part);
      }
    }

    if (event.citationMetadata) {
      if (!agg.citations) {
        agg.citations = {citations: []};
      }
      if (!agg.citations.citations) {
        agg.citations.citations = [];
      }
      agg.citations.citations.push(...(event.citationMetadata.citations || []));
    }

    if (event.customMetadata) {
      if (!agg.customMeta) {
        agg.customMeta = {};
      }
      Object.assign(agg.customMeta, event.customMetadata);
    }

    if (event.groundingMetadata) {
      agg.grounding = event.groundingMetadata;
    }

    if (event.usageMetadata) {
      agg.usage = event.usageMetadata;
    }
  }

  private buildNonPartialAggregation(
    context: InvocationContext,
    agg: ArtifactAggregation,
  ): AdkEvent {
    this.promoteTextBlocksToParts(agg);

    const result = createEvent({
      author: context.agent.name,
      invocationId: context.invocationId,
      content:
        agg.parts.length > 0 ? createModelContent([...agg.parts]) : undefined,
      customMetadata: agg.customMeta,
      groundingMetadata: agg.grounding,
      citationMetadata: agg.citations,
      usageMetadata: agg.usage,
      turnComplete: false,
      partial: false,
    });
    return result;
  }

  private promoteTextBlocksToParts(agg: ArtifactAggregation) {
    if (agg.aggregatedThoughts !== '') {
      agg.parts.push({thought: true, text: agg.aggregatedThoughts});
      agg.aggregatedThoughts = '';
    }
    if (agg.aggregatedText !== '') {
      agg.parts.push({text: agg.aggregatedText});
      agg.aggregatedText = '';
    }
  }

  /**
   * Adds request and response metadata to the event.
   */
  updateCustomMetadata(event: AdkEvent, response?: A2AEvent) {
    const toAdd: Record<string, unknown> = {};
    if (this.request && event.turnComplete) {
      toAdd['request'] = this.request;
    }
    if (response) {
      toAdd['response'] = response;

      if (isTask(response)) {
        if (response.id) toAdd['task_id'] = response.id;
        if (response.contextId) toAdd['context_id'] = response.contextId;
      } else if (response.taskId) {
        toAdd['task_id'] = response.taskId;
        if (response.contextId) toAdd['context_id'] = response.contextId;
      }
    }
    if (Object.keys(toAdd).length === 0) {
      return;
    }
    if (!event.customMetadata) {
      event.customMetadata = {};
    }
    for (const [k, v] of Object.entries(toAdd)) {
      if (v === undefined || v === null) continue;
      // Use prefixed keys to avoid collisions
      event.customMetadata[`a2a:${k}`] = v;
    }
  }
}
