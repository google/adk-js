/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';
import {Session} from '../sessions/session.js';

import {
  BaseMemoryService,
  SearchMemoryRequest,
  SearchMemoryResponse,
} from './base_memory_service.js';
import {MemoryEntry} from './memory_entry.js';

/**
 * An in-memory memory service for prototyping purpose only.
 *
 * Uses keyword matching instead of semantic search.
 */
export class InMemoryMemoryService implements BaseMemoryService {
  private readonly memories: MemoryEntry[] = [];
  /**
   * A map from user key to a map from session ID to events.
   *
   * The inner map is keyed by `session.id`, which arrives off the request path
   * and contains no `/`, so it can be exactly `__proto__`. On a plain object
   * literal that key would reach the inherited `__proto__` setter and
   * re-parent the map instead of creating an own property, silently dropping
   * the session from the `Object.values` scan in `searchMemory`. The outer key
   * always contains a `/` (see `getUserKey`) and cannot collide, but is
   * created the same way for consistency.
   */
  private readonly sessionEvents: {
    [userKey: string]: {[sessionId: string]: Event[]};
  } = Object.create(null);

  async addSessionToMemory(session: Session): Promise<void> {
    const userKey = getUserKey(session.appName, session.userId);
    if (!this.sessionEvents[userKey]) {
      this.sessionEvents[userKey] = Object.create(null);
    }
    this.sessionEvents[userKey][session.id] = session.events.filter(
      (event) => (event.content?.parts?.length ?? 0) > 0,
    );
  }

  async searchMemory(req: SearchMemoryRequest): Promise<SearchMemoryResponse> {
    const userKey = getUserKey(req.appName, req.userId);
    if (!this.sessionEvents[userKey]) {
      return Promise.resolve({memories: []});
    }

    const wordsInQuery = req.query.toLowerCase().split(/\s+/);
    const response: SearchMemoryResponse = {memories: []};

    for (const sessionEvents of Object.values(this.sessionEvents[userKey])) {
      for (const event of sessionEvents) {
        if (!event.content?.parts?.length) {
          continue;
        }

        const joinedText = event.content.parts
          .map((part) => part.text)
          .filter((text) => !!text)
          .join(' ');
        const wordsInEvent = extractWordsLower(joinedText);
        if (!wordsInEvent.size) {
          continue;
        }

        const matchQuery = wordsInQuery.some((queryWord) =>
          wordsInEvent.has(queryWord),
        );
        if (matchQuery) {
          response.memories.push({
            content: event.content,
            author: event.author,
            timestamp: formatTimestamp(event.timestamp),
          });
        }
      }
    }

    return response;
  }
}

/**
 * Constructs the user key from the app name and user ID.
 *
 * @param appName The app name.
 * @param userId The user ID.
 * @return The user key.
 */
function getUserKey(appName: string, userId: string): string {
  return `${appName}/${userId}`;
}

/**
 * Extracts the words from the text.
 *
 * @param text The text to extract the words from.
 * @return A set of words.
 */
function extractWordsLower(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/[A-Za-z]+/g)].map((match) => match[0].toLowerCase()),
  );
}

/**
 * Formats the timestamp to a string in ISO format.
 *
 * @param timestamp The timestamp to format.
 * @return A string representing the timestamp in ISO format.
 */
function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
