/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getAllToolCalls} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('evaluation/eval_case', () => {
  describe('getAllToolCalls', () => {
    it('returns the tool uses of intermediate data', () => {
      expect(
        getAllToolCalls({
          toolUses: [{name: 'a'}, {name: 'b'}],
          toolResponses: [],
          intermediateResponses: [],
        }),
      ).toEqual([{name: 'a'}, {name: 'b'}]);
    });

    it('returns the function calls found in invocation events', () => {
      expect(
        getAllToolCalls({
          invocationEvents: [
            {
              author: 'agent',
              content: {
                role: 'model',
                parts: [{text: 'thinking'}, {functionCall: {name: 'a'}}],
              },
            },
            {author: 'agent'},
            {
              author: 'agent',
              content: {
                role: 'user',
                parts: [{functionResponse: {name: 'a', response: {}}}],
              },
            },
            {
              author: 'agent',
              content: {role: 'model', parts: [{functionCall: {name: 'b'}}]},
            },
          ],
        }),
      ).toEqual([{name: 'a'}, {name: 'b'}]);
    });

    it('returns no tool calls without intermediate data', () => {
      expect(getAllToolCalls(undefined)).toEqual([]);
    });
  });
});
