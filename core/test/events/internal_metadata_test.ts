/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, createSession} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  INTERNAL_METADATA_PREFIX,
  internalMetadata,
  markRestored,
  publicEvent,
  publicMetadata,
  publicSession,
  RESTORED_EVENT_KEY,
  withoutInternalMetadata,
} from '../../src/events/internal_metadata.js';
import {logger} from '../../src/utils/logger.js';

const INTERNAL_KEY = `${INTERNAL_METADATA_PREFIX}anything`;

describe('internal_metadata', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('withoutInternalMetadata', () => {
    it('keeps other keys and does not modify the input', () => {
      const metadata = {
        keep: 1,
        [INTERNAL_KEY]: 'x',
        [RESTORED_EVENT_KEY]: true,
      };

      expect(withoutInternalMetadata(metadata)).toEqual({keep: 1});
      expect(metadata).toHaveProperty(INTERNAL_KEY);
    });

    it('logs the dropped keys only', () => {
      const debug = vi.spyOn(logger, 'debug');

      withoutInternalMetadata({keep: 1, [INTERNAL_KEY]: 'x'});

      expect(debug).toHaveBeenCalledOnce();
      expect(String(debug.mock.calls[0])).toContain(INTERNAL_KEY);
      expect(String(debug.mock.calls[0])).not.toContain('keep');
    });

    it('passes undefined through', () => {
      expect(withoutInternalMetadata(undefined)).toBeUndefined();
    });
  });

  describe('publicMetadata', () => {
    it.each([
      [{keep: 1, [INTERNAL_KEY]: 'x'}, {keep: 1}],
      [{[RESTORED_EVENT_KEY]: true}, undefined],
      [{}, undefined],
      [undefined, undefined],
    ])('maps %o to %o', (metadata, expected) => {
      expect(publicMetadata(metadata)).toEqual(expected);
    });

    it('does not log', () => {
      const debug = vi.spyOn(logger, 'debug');

      publicMetadata({keep: 1, [INTERNAL_KEY]: 'x'});
      publicEvent(createEvent({customMetadata: {[INTERNAL_KEY]: 'x'}}));

      expect(debug).not.toHaveBeenCalled();
    });
  });

  describe('internalMetadata', () => {
    it.each([
      [undefined, {}],
      [{keep: 1}, {}],
      [{keep: 1, [INTERNAL_KEY]: 'x'}, {[INTERNAL_KEY]: 'x'}],
    ])('maps %o to %o', (metadata, expected) => {
      expect(internalMetadata(metadata)).toEqual(expected);
    });
  });

  describe('markRestored', () => {
    it.each([
      undefined,
      {keep: 1},
      {keep: 1, [INTERNAL_KEY]: 'planted', [RESTORED_EVENT_KEY]: false},
    ])('strips internal keys and sets the marker (%o)', (customMetadata) => {
      const event = createEvent({customMetadata});

      expect(markRestored(event)).toBe(event);

      const expected = customMetadata ? {keep: 1} : {};
      expect(event.customMetadata).toEqual({
        ...expected,
        [RESTORED_EVENT_KEY]: true,
      });
    });
  });

  describe('publicEvent', () => {
    it.each([undefined, {}, {keep: 1}])(
      'returns an event without internal keys unchanged (%o)',
      (customMetadata) => {
        const event = createEvent({customMetadata});

        expect(publicEvent(event)).toBe(event);
      },
    );

    it.each([
      [{keep: 1, [INTERNAL_KEY]: 'x'}, {keep: 1}],
      [{[RESTORED_EVENT_KEY]: true}, undefined],
    ])('strips internal keys from a copy (%o)', (customMetadata, expected) => {
      const event = createEvent({customMetadata});

      const result = publicEvent(event);

      expect(result).not.toBe(event);
      expect(result.customMetadata).toEqual(expected);
      expect(result.id).toBe(event.id);
      expect(event.customMetadata).toEqual(customMetadata);
    });
  });

  describe('publicSession', () => {
    it('strips every event and keeps the original', () => {
      const session = createSession({id: 's', appName: 'app', userId: 'u'});
      session.events = [
        createEvent({customMetadata: {[RESTORED_EVENT_KEY]: true}}),
        createEvent({customMetadata: {keep: 1}}),
      ];

      const result = publicSession(session);

      expect(result.events.map((e) => e.customMetadata)).toEqual([
        undefined,
        {keep: 1},
      ]);
      expect(result.events[1]).toBe(session.events[1]);
      expect(session.events[0].customMetadata).toEqual({
        [RESTORED_EVENT_KEY]: true,
      });
    });

    it('returns a session without internal keys unchanged', () => {
      const session = createSession({id: 's', appName: 'app', userId: 'u'});
      session.events = [createEvent({customMetadata: {keep: 1}})];

      expect(publicSession(session)).toBe(session);
    });
  });
});
