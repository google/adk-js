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

export interface LlmSummarizerOptions {
  llm: BaseLlm;
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

  constructor(options: LlmSummarizerOptions) {
    this.llm = options.llm;
    this.prompt = options.prompt || DEFAULT_PROMPT;
  }

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

    const responseGen = this.llm.generateContentAsync(request, false);
    let compactedContent = '';

    const firstResponse = await responseGen.next();
    if (firstResponse.done || !firstResponse.value.content?.parts?.[0]?.text) {
      throw new Error('LLM failed to return a valid summary.');
    }
    compactedContent += firstResponse.value.content.parts[0].text;

    // consume the rest of the stream
    for await (const chunk of responseGen) {
      if (chunk.content?.parts?.[0]?.text) {
        compactedContent += chunk.content.parts[0].text;
      }
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
