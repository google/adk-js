/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {expect} from 'chai';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {getSessionServiceFromUri} from '../../src/sessions/registry.js';

describe('Registry', () => {
  describe('getSessionServiceFromUri', () => {
    it('should return InMemorySessionService for "memory://" uri', () => {
      const service = getSessionServiceFromUri('memory://');
      expect(service).to.be.instanceOf(InMemorySessionService);
    });

    it('should throw error for unsupported uri', () => {
      expect(() =>
        getSessionServiceFromUri('unsupported://localhost:5432/mydb'),
      ).to.throw(
        'Unsupported session service URI: unsupported://localhost:5432/mydb',
      );
    });
  });
});
