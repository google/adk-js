/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CompactedEvent, createEvent} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  getContents,
  getCurrentTurnContents,
  mergeFunctionResponseEvents,
  removeClientFunctionCallId,
} from '../../../src/agents/processors/content_processor_utils.js';

describe('getContents', () => {
  it('should handle object responses in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionResponse: {
              name: 'transfer_to_agent',
              response: {
                result: 'success',
                details: {
                  foo: 'bar',
                },
              },
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');

    // We expect the content to contain a string representation of the object, not [object Object]
    const textPart = contents[0].parts?.find((p) =>
      p.text?.includes('transfer_to_agent'),
    );
    expect(textPart).toBeDefined();
    expect(textPart?.text).not.toContain('[object Object]');
    expect(textPart?.text).toContain('{"result":"success"');
  });

  it('should handle object parameters in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'transfer_to_agent',
              args: {
                target_agent: 'foo',
                reason: 'bar',
              },
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');

    const textPart = contents[0].parts?.find((p) =>
      p.text?.includes('transfer_to_agent'),
    );
    expect(textPart).toBeDefined();
    expect(textPart?.text).not.toContain('[object Object]');
    expect(textPart?.text).toContain('{"target_agent":"foo"');
  });

  it('should handle circular objects in convertForeignEvent', () => {
    const circular: Record<string, unknown> = {a: 1};
    circular.self = circular;

    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'circular_tool',
              args: circular,
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');

    const textPart = contents[0].parts?.find((p) =>
      p.text?.includes('circular_tool'),
    );
    expect(textPart).toBeDefined();
    // It should fall back to String(obj) which is usually [object Object] for plain objects.
    expect(textPart?.text).toContain('[object Object]');
  });

  it('should rearrange basic function call and response events correctly', () => {
    const e0 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const e1 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'intermediate user message'}],
      },
    });
    const e3 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'success'},
            },
          },
        ],
      },
    });

    const contents = getContents([e0, e1, e2, e3], 'my_agent');

    // Expected output order: e0 (user input), e1 (function call), merged response (e3 response part)
    // Note that intermediate user input (e2) between call and response is discarded.
    expect(contents).toHaveLength(3);
    expect(contents[0].parts?.[0].text).toBe('hello');
    expect(contents[1].parts?.[0].functionCall?.id).toBe('id1');
    expect(contents[2].parts?.[0].functionResponse?.id).toBe('id1');
  });

  it('should avoid multiple mutations/overwrites and process multiple function calls safely', () => {
    const e0 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const e1 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
          {
            functionCall: {
              name: 'tool2',
              id: 'id2',
              args: {},
            },
          },
        ],
      },
    });
    const e3 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'success'},
            },
          },
        ],
      },
    });

    // We expect it to match the latest event e2 (which has id1 and id2) for the response id2,
    // and terminate the loop immediately. If it didn't terminate, it would continue back to e1,
    // matching id1 (due to mutated state), causing a subset error or wrong rearrangement index.
    const contents = getContents([e0, e1, e2, e3], 'my_agent');
    expect(contents).toHaveLength(4);
    expect(contents[0].parts?.[0].text).toBe('hello');
    expect(contents[1].parts?.[0].functionCall?.id).toBe('id1');
    // e2 has two function calls:
    expect(contents[2].parts?.[0].functionCall?.id).toBe('id1');
    expect(contents[2].parts?.[1].functionCall?.id).toBe('id2');
    // e3 is merged/rearranged after e2:
    expect(contents[3].parts?.[0].functionResponse?.id).toBe('id2');
  });

  it('should throw an error when last responses do not match the expected subset criteria of function calls', () => {
    const e0 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const e1 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            // response with id2, but the call event e1 only has id1
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'success'},
            },
          },
        ],
      },
    });

    expect(() => getContents([e0, e1, e2], 'my_agent')).toThrowError(
      'No function call event found for function responses ids: id2',
    );
  });

  it('should throw subset error when response is for an id from a call event, but contains other unexpected ids', () => {
    // Actually, the subset error occurs when functionResponsesIds is NOT a subset of functionCallIds.
    // e.g. the last event has responses for id1 and id2, but the matched call event only has id1.
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
        ],
      },
    });
    const e0_5 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const e1 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'success'},
            },
          },
          {
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'success'},
            },
          },
        ],
      },
    });

    expect(() => getContents([e0, e0_5, e1], 'my_agent')).toThrowError(
      'Last response event should only contain the responses for the function calls in the same function call event.',
    );
  });

  it('should handle empty events list gracefully', () => {
    const contents = getContents([], 'my_agent');
    expect(contents).toEqual([]);
  });

  it('should collect and merge intermediate response events for parallel function calls', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
          {
            functionCall: {
              name: 'tool2',
              id: 'id2',
              args: {},
            },
          },
        ],
      },
    });
    const e1 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'success1'},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'success2'},
            },
          },
        ],
      },
    });

    const contents = getContents([e0, e1, e2], 'my_agent');
    expect(contents).toHaveLength(2);
    expect(contents[0].parts?.[0].functionCall?.id).toBe('id1');
    expect(contents[0].parts?.[1].functionCall?.id).toBe('id2');

    // e1 and e2 should be merged:
    expect(contents[1].parts?.[0].functionResponse?.id).toBe('id1');
    expect(contents[1].parts?.[0].functionResponse?.response).toEqual({
      result: 'success1',
    });
    expect(contents[1].parts?.[1].functionResponse?.id).toBe('id2');
    expect(contents[1].parts?.[1].functionResponse?.response).toEqual({
      result: 'success2',
    });
  });

  it('should not mutate input events content', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
          {
            functionCall: {
              name: 'tool2',
              id: 'id2',
              args: {},
            },
          },
        ],
      },
    });
    const e1 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'success1'},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'success2'},
            },
          },
        ],
      },
    });

    const originalE1PartsLength = e1.content?.parts?.length;

    getContents([e0, e1, e2], 'my_agent');

    expect(e1.content?.parts?.length).toBe(originalE1PartsLength);
  });

  it('should convert CompactedEvent correctly', () => {
    const compactedEvent = {
      isCompacted: true,
      author: 'user',
      compactedContent: 'synthesized summary',
      timestamp: 12345,
      invocationId: 'inv1',
      branch: 'main',
    } as unknown as CompactedEvent;

    const contents = getContents([compactedEvent], 'my_agent');
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts?.[0].text).toContain(
      '[Previous Context Summary]:\nsynthesized summary',
    );
  });

  it('should skip rearranging when the second latest event contains the corresponding function calls', () => {
    const e0 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const e1 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'success'},
            },
          },
        ],
      },
    });

    const contents = getContents([e0, e1, e2], 'my_agent');
    expect(contents).toHaveLength(3);
    expect(contents[0].parts?.[0].text).toBe('hello');
    expect(contents[1].parts?.[0].functionCall?.id).toBe('id1');
    expect(contents[2].parts?.[0].functionResponse?.id).toBe('id1');
  });

  it('should handle string arguments in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'transfer_to_agent',
              args: 'plain_string_args' as unknown as Record<string, unknown>,
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');
    const textPart = contents[0].parts?.find((p) =>
      p.text?.includes('transfer_to_agent'),
    );
    expect(textPart).toBeDefined();
    expect(textPart?.text).toContain('plain_string_args');
  });

  it('should handle plain text parts in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            text: 'hello from other agent',
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');
    expect(contents).toHaveLength(1);
    expect(contents[0].parts).toHaveLength(2);
    expect(contents[0].parts?.[1].text).toBe(
      '[other_agent] said: hello from other agent',
    );
  });

  it('should replace function responses with the same id and append non-function-response parts during merge', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'tool1', id: 'id1', args: {}}},
          {functionCall: {name: 'tool2', id: 'id2', args: {}}},
        ],
      },
    });
    const e1 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'initial'},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'updated'},
            },
          },
          {
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'success2'},
            },
          },
          {text: 'some extra message'},
        ],
      },
    });

    const contents = getContents([e0, e1, e2], 'my_agent');
    expect(contents).toHaveLength(2);
    const mergedResponseParts = contents[1].parts;
    expect(mergedResponseParts).toHaveLength(3);
    expect(mergedResponseParts?.[0].functionResponse?.response).toEqual({
      result: 'updated',
    });
    expect(mergedResponseParts?.[1].functionResponse?.response).toEqual({
      result: 'success2',
    });
    expect(mergedResponseParts?.[2].text).toBe('some extra message');
  });

  it('should merge multiple function responses in history when size > 1', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'tool1', id: 'id1', args: {}}},
          {functionCall: {name: 'tool2', id: 'id2', args: {}}},
        ],
      },
    });
    const e1 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'res1'},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'res2'},
            },
          },
        ],
      },
    });
    const e3 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });

    const contents = getContents([e0, e1, e2, e3], 'my_agent');
    expect(contents).toHaveLength(3);
    expect(contents[0].parts?.[0].functionCall?.id).toBe('id1');
    expect(contents[1].parts).toHaveLength(2);
    expect(contents[1].parts?.[0].functionResponse?.id).toBe('id1');
    expect(contents[1].parts?.[1].functionResponse?.id).toBe('id2');
    expect(contents[2].parts?.[0].text).toBe('hello');
  });

  it('should skip mapping function response event when response id is missing', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'tool1', id: 'id1', args: {}}}],
      },
    });
    const e1 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              response: {result: 'res1'},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });

    const contents = getContents([e0, e1, e2], 'my_agent');
    expect(contents).toHaveLength(2);
    expect(contents[0].parts?.[0].functionCall?.id).toBe('id1');
    expect(contents[1].parts?.[0].text).toBe('hello');
  });

  it('should handle empty agentName in getContents', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [{text: 'hello'}],
      },
    });
    const contents = getContents([event], '');
    expect(contents).toHaveLength(1);
    expect(contents[0].parts?.[0].text).toBe('hello');
  });

  describe('getCurrentTurnContents', () => {
    it('should return empty list when no events are provided', () => {
      const contents = getCurrentTurnContents([], 'my_agent');
      expect(contents).toEqual([]);
    });

    it('should slice events from the last user or foreign agent event', () => {
      const e0 = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      });
      const e1 = createEvent({
        author: 'my_agent',
        content: {role: 'model', parts: [{text: 'hi'}]},
      });
      const e2 = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'how are you?'}]},
      });
      const e3 = createEvent({
        author: 'my_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool1', id: 'id1', args: {}}}],
        },
      });

      const contents = getCurrentTurnContents([e0, e1, e2, e3], 'my_agent');
      expect(contents).toHaveLength(2);
      expect(contents[0].parts?.[0].text).toBe('how are you?');
      expect(contents[1].parts?.[0].functionCall?.id).toBe('id1');
    });

    it('should return empty list if no user or foreign agent starts a turn', () => {
      const e0 = createEvent({
        author: 'my_agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });
      const contents = getCurrentTurnContents([e0], 'my_agent');
      expect(contents).toEqual([]);
    });

    it('should handle empty agentName in getCurrentTurnContents', () => {
      const e0 = createEvent({
        author: 'other_agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });
      const contents = getCurrentTurnContents([e0], '');
      expect(contents).toEqual([]);
    });
  });

  it('should handle media parts in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'base64data',
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');
    expect(contents).toHaveLength(1);
    expect(contents[0].parts).toHaveLength(2); // 'For context:' part and the inlineData part
    expect(contents[0].parts?.[1]).toEqual({
      inlineData: {
        mimeType: 'image/png',
        data: 'base64data',
      },
    });
  });

  it('should not mutate original event media parts in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'base64data',
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');

    // Mutate the returned content
    if (contents[0].parts?.[1]?.inlineData) {
      contents[0].parts[1].inlineData.data = 'mutated';
    }

    // Check if original event was mutated
    expect(event.content?.parts?.[0]?.inlineData?.data).toBe('base64data');
  });

  describe('mergeFunctionResponseEvents', () => {
    it('should throw an error when merging empty list of events', () => {
      expect(() => mergeFunctionResponseEvents([])).toThrowError(
        'Cannot merge an empty list of events.',
      );
    });

    it('should throw an error when first event has no parts', () => {
      const e0 = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [],
        },
      });
      expect(() => mergeFunctionResponseEvents([e0])).toThrowError(
        'There should be at least one function_response part.',
      );
    });

    it('should throw an error when first event has no content', () => {
      const e0 = createEvent({
        author: 'user',
      });
      expect(() => mergeFunctionResponseEvents([e0])).toThrowError(
        'There should be at least one function_response part.',
      );
    });

    it('should throw an error when subsequent event has no content or parts', () => {
      const e0 = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'tool1',
                id: 'id1',
                response: {result: 'success'},
              },
            },
          ],
        },
      });
      const e1 = createEvent({
        author: 'user',
      });
      expect(() => mergeFunctionResponseEvents([e0, e1])).toThrowError(
        'There should be at least one function_response part.',
      );
    });

    it('should not mutate subsequent events when merging', () => {
      const e0 = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'tool1',
                id: 'id1',
                response: {result: 'initial'},
              },
            },
          ],
        },
      });
      const e1 = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'tool2',
                id: 'id2',
                response: {result: 'success2'},
              },
            },
          ],
        },
      });

      const merged = mergeFunctionResponseEvents([e0, e1]);

      // Mutate the merged event parts
      if (merged.content?.parts?.[0]?.functionResponse) {
        merged.content.parts[0].functionResponse.response = {
          result: 'mutated0',
        };
      }
      if (merged.content?.parts?.[1]?.functionResponse) {
        merged.content.parts[1].functionResponse.response = {
          result: 'mutated1',
        };
      }

      // Check if e0 was mutated
      expect(e0.content?.parts?.[0]?.functionResponse?.response).toEqual({
        result: 'initial',
      });

      // Check if e1 was mutated
      expect(e1.content?.parts?.[0]?.functionResponse?.response).toEqual({
        result: 'success2',
      });
    });
  });

  it('should skip tool confirmation events in getContents', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'adk_request_confirmation',
              args: {},
            },
          },
        ],
      },
    });
    const contents = getContents([e0], 'my_agent');
    expect(contents).toEqual([]);
  });

  it('should skip auth events in getContents', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'adk_request_credential',
              args: {},
            },
          },
        ],
      },
    });
    const contents = getContents([e0], 'my_agent');
    expect(contents).toEqual([]);
  });

  it('should handle events with no parts in isAuthEvent and isToolConfirmationEvent', () => {
    const event = createEvent({
      author: 'my_agent',
      content: {
        role: 'user',
      },
    });
    const contents = getContents([event], 'my_agent');
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
  });

  it('should return input event in convertForeignEvent if content or parts length is 0', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [],
      },
    });
    const contents = getContents([event], 'current_agent');
    expect(contents).toHaveLength(1);
  });

  it('should handle event without parts in isToolConfirmationEvent', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
      },
    });
    const contents = getContents([e0], 'my_agent');
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('model');
    expect(contents[0].parts).toBeUndefined();
  });

  it('should skip events with no role in getContents', () => {
    const e0 = createEvent({
      author: 'user',
      content: {
        parts: [{text: 'hello'}],
      } as unknown as Content,
    });
    const contents = getContents([e0], 'my_agent');
    expect(contents).toEqual([]);
  });

  it('should skip events with empty first part text in getContents', () => {
    const e0 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: ''}],
      },
    });
    const contents = getContents([e0], 'my_agent');
    expect(contents).toEqual([]);
  });

  it('should skip events from non-matching branch in getContents', () => {
    const e0 = createEvent({
      author: 'user',
      branch: 'main.agentB',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const contents = getContents([e0], 'my_agent', 'main.agentA');
    expect(contents).toEqual([]);
  });

  it('should not skip events from matching branch in getContents', () => {
    const e0 = createEvent({
      author: 'user',
      branch: 'main.agentA',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const contents = getContents([e0], 'my_agent', 'main.agentA.subAgent');
    expect(contents).toHaveLength(1);
    expect(contents[0].parts?.[0].text).toBe('hello');
  });
});

describe('removeClientFunctionCallId', () => {
  it('should remove client generated ID from functionCall', () => {
    const content: Content = {
      role: 'model',
      parts: [{functionCall: {name: 'testTool', args: {}, id: 'adk-test-id'}}],
    };
    removeClientFunctionCallId(content);
    expect(content.parts![0].functionCall!.id).toBeUndefined();
  });

  it('should remove client generated ID from functionResponse', () => {
    const content: Content = {
      role: 'user',
      parts: [
        {functionResponse: {name: 'testTool', response: {}, id: 'adk-test-id'}},
      ],
    };
    removeClientFunctionCallId(content);
    expect(content.parts![0].functionResponse!.id).toBeUndefined();
  });

  it('should not remove non-client generated ID', () => {
    const content: Content = {
      role: 'model',
      parts: [{functionCall: {name: 'testTool', args: {}, id: 'server-id'}}],
    };
    removeClientFunctionCallId(content);
    expect(content.parts![0].functionCall!.id).toBe('server-id');
  });

  it('should safely handle null, undefined, or empty content objects without throwing', () => {
    expect(() =>
      removeClientFunctionCallId(undefined as unknown as Content),
    ).not.toThrow();
    expect(() =>
      removeClientFunctionCallId(null as unknown as Content),
    ).not.toThrow();
    const emptyContent: Content = {};
    expect(() => removeClientFunctionCallId(emptyContent)).not.toThrow();
    const noParts: Content = {role: 'user', parts: []};
    expect(() => removeClientFunctionCallId(noParts)).not.toThrow();
  });
});
