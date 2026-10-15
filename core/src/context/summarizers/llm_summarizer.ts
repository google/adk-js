/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompactedEvent,
  createCompactedEvent,
} from '../../events/compacted_event.js';
import {Event, stringifyContent} from '../../events/event.js';
import {BaseLlm} from '../../models/base_llm.js';
import {LlmRequest} from '../../models/llm_request.js';
import {BaseSummarizer} from './base_summarizer.js';

/** Options for constructing an {@link LlmSummarizer}. */
export interface LlmSummarizerOptions {
  /** The LLM instance used to generate the summary. */
  llm: BaseLlm;
  /**
   * Optional system prompt prepended to the formatted events. Defaults to a
   * built-in summarization prompt when omitted.
   */
  prompt?: string;
}

const DEFAULT_PROMPT =
  'The following is a conversation history between a user and an AI' +
  ' agent. Please summarize the conversation, focusing on key' +
  ' information and decisions made, as well as any unresolved' +
  ' questions or tasks. The summary should be concise and capture the' +
  ' essence of the interaction.';
/**
 * A summarizer that uses an LLM to generate a compacted representation
 * of existing events.
 */
export class LlmSummarizer implements BaseSummarizer {
  private readonly llm: BaseLlm;
  private readonly prompt: string;

  /**
   * @param options - Configuration specifying the LLM and optional prompt.
   */
  constructor(options: LlmSummarizerOptions) {
    this.llm = options.llm;
    this.prompt = options.prompt || DEFAULT_PROMPT;
  }

  /**
   * Summarizes a list of events into a single {@link CompactedEvent} using the
   * configured LLM.
   *
   * @param events - The events to summarize. Must be non-empty.
   * @returns A promise resolving to the compacted representation.
   * @throws {Error} If `events` is empty or the LLM returns no content.
   */
  async summarize(events: Event[]): Promise<CompactedEvent> {
    if (events.length === 0) {
      throw new Error('Cannot summarize an empty list of events.');
    }

    const startTime = events[0].timestamp;
    const endTime = events[events.length - 1].timestamp;

    // Format the events to be digestible by an LLM
    let formattedEvents = '';
    for (let i = 0; i < events.length; i++) {
      formattedEvents += `[Event ${i + 1} - Author: ${events[i].author}]\n`;
      formattedEvents += `${stringifyContent(events[i])}\n\n`;
    }

    const fullPrompt = `${this.prompt}\n\n${formattedEvents}`;

    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: fullPrompt}]}],
      toolsDict: {},
      liveConnectConfig: {},
    };

    // A response can hold several text parts, e.g. one per request of a
    // generation that @google/genai resumed after continuation pauses.
    let compactedContent = '';
    for await (const response of this.llm.generateContentAsync(
      request,
      false,
    )) {
      for (const part of response.content?.parts ?? []) {
        if (part.text && !part.thought) {
          compactedContent += part.text;
        }
      }
    }
    if (!compactedContent) {
      throw new Error('LLM failed to return a valid summary.');
    }

    return createCompactedEvent({
      author: 'system',
      content: {
        role: 'model',
        parts: [{text: compactedContent}],
      },
      startTime,
      endTime,
      compactedContent,
    });
  }
}
