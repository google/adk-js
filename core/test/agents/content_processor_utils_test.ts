/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getContents } from '../../src/agents/content_processor_utils.js';
import { createEvent } from '../../src/events/event.js';

describe('getContents', () => {
  it('should handle object responses in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [{
          functionResponse: {
            name: 'transfer_to_agent',
            response: {
              result: 'success',
              details: {
                foo: 'bar'
              }
            }
          }
        }]
      }
    });

    const contents = getContents([event], 'current_agent');

    // We expect the content to contain a string representation of the object, not [object Object]
    const textPart = contents[0].parts?.find(p => p.text?.includes('transfer_to_agent'));
    expect(textPart).toBeDefined();
    expect(textPart?.text).not.toContain('[object Object]');
    expect(textPart?.text).toContain('{"result":"success"');
  });

  it('should handle object parameters in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [{
          functionCall: {
            name: 'transfer_to_agent',
            args: {
              target_agent: 'foo',
              reason: 'bar'
            }
          }
        }]
      }
    });

    const contents = getContents([event], 'current_agent');

    const textPart = contents[0].parts?.find(p => p.text?.includes('transfer_to_agent'));
    expect(textPart).toBeDefined();
    expect(textPart?.text).not.toContain('[object Object]');
    expect(textPart?.text).toContain('{"target_agent":"foo"');
  });
});
