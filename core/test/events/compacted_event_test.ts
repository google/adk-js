/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  createCompactedEvent,
  isCompactedEvent,
} from '../../src/events/compacted_event.js';

describe('isCompactedEvent', () => {
  it('returns true for a valid CompactedEvent', () => {
    const event = createCompactedEvent({
      author: 'system',
      startTime: 1000,
      endTime: 2000,
      compactedContent: 'summary',
    });
    expect(isCompactedEvent(event)).toBe(true);
  });

  it('returns false for a plain Event', () => {
    const event = createEvent({author: 'user'});
    expect(isCompactedEvent(event)).toBe(false);
  });

  it('returns false when isCompacted field is missing', () => {
    const event = createEvent({author: 'agent'}) as object;
    expect(isCompactedEvent(event as ReturnType<typeof createEvent>)).toBe(
      false,
    );
  });

  it('returns false when isCompacted is false', () => {
    const event = {
      ...createEvent({author: 'agent'}),
      isCompacted: false,
    } as ReturnType<typeof createEvent>;
    expect(isCompactedEvent(event)).toBe(false);
  });
});

describe('createCompactedEvent', () => {
  it('creates a CompactedEvent with isCompacted set to true', () => {
    const event = createCompactedEvent({
      startTime: 100,
      endTime: 200,
      compactedContent: 'summary text',
    });
    expect(event.isCompacted).toBe(true);
  });

  it('carries startTime, endTime, and compactedContent', () => {
    const event = createCompactedEvent({
      startTime: 500,
      endTime: 1500,
      compactedContent: 'key decisions were made',
    });
    expect(event.startTime).toBe(500);
    expect(event.endTime).toBe(1500);
    expect(event.compactedContent).toBe('key decisions were made');
  });

  it('merges base event defaults (id, invocationId, actions)', () => {
    const event = createCompactedEvent({
      startTime: 0,
      endTime: 0,
      compactedContent: '',
    });
    expect(event.id).toBeDefined();
    expect(event.id.length).toBeGreaterThan(0);
    expect(event.invocationId).toBe('');
    expect(event.actions).toBeDefined();
  });

  it('accepts author and content from params', () => {
    const event = createCompactedEvent({
      author: 'system',
      content: {role: 'model', parts: [{text: 'summary'}]},
      startTime: 0,
      endTime: 10,
      compactedContent: 'summary',
    });
    expect(event.author).toBe('system');
    expect(event.content?.parts?.[0]?.text).toBe('summary');
  });

  it('satisfies the isCompactedEvent type guard after creation', () => {
    const event = createCompactedEvent({
      startTime: 0,
      endTime: 0,
      compactedContent: '',
    });
    expect(isCompactedEvent(event)).toBe(true);
  });
});
