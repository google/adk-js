/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {validateInvocationLengths} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('evaluation/evaluator', () => {
  describe('validateInvocationLengths', () => {
    const invocation = {userContent: {role: 'user', parts: [{text: 'hi'}]}};

    it('accepts lists of the same length or no expected list', () => {
      expect(() =>
        validateInvocationLengths([invocation], [invocation]),
      ).not.toThrow();
      expect(() => validateInvocationLengths([invocation])).not.toThrow();
    });

    it('rejects lists of different lengths', () => {
      expect(() => validateInvocationLengths([invocation], [])).toThrow(
        'actualInvocations and expectedInvocations must have the same length; got 1 and 0.',
      );
    });
  });
});
