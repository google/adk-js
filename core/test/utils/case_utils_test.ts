/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {renameReservedKeywords, toSnakeCaseName} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {camelCaseKeys} from '../../src/utils/case_utils.js';

describe('case_utils', () => {
  describe('camelCaseKeys', () => {
    it('should convert simple object keys', () => {
      const input = {
        'foo_bar': 'value',
        'baz': 123,
      };
      const expected = {
        fooBar: 'value',
        baz: 123,
      };
      expect(camelCaseKeys(input)).toEqual(expected);
    });

    it('should convert nested object keys', () => {
      const input = {
        'foo_bar': {
          'nested_key': 'value',
          'another_nested': {
            'deep_key': true,
          },
        },
      };
      const expected = {
        fooBar: {
          nestedKey: 'value',
          anotherNested: {
            deepKey: true,
          },
        },
      };
      expect(camelCaseKeys(input)).toEqual(expected);
    });

    it('should convert objects inside arrays', () => {
      const input = [
        {
          'foo_bar': 'val1',
        },
        {
          'baz_qux': [
            {
              'nested_array_key': 'val2',
            },
          ],
        },
      ];
      const expected = [
        {
          fooBar: 'val1',
        },
        {
          bazQux: [
            {
              nestedArrayKey: 'val2',
            },
          ],
        },
      ];
      expect(camelCaseKeys(input)).toEqual(expected);
    });

    it('should not modify non-plain objects', () => {
      const date = new Date();
      const input = {
        'date_field': date,
      };
      const expected = {
        dateField: date,
      };
      expect(camelCaseKeys(input)).toEqual(expected);
    });

    it('should handle null and undefined', () => {
      expect(camelCaseKeys(null)).toBeNull();
      expect(camelCaseKeys(undefined)).toBeUndefined();
    });

    it('should handle primitive values', () => {
      expect(camelCaseKeys(123)).toBe(123);
      expect(camelCaseKeys('hello')).toBe('hello');
      expect(camelCaseKeys(true)).toBe(true);
    });
  });

  describe('toSnakeCaseName', () => {
    it('should convert camelCase', () => {
      expect(toSnakeCaseName('camelCase')).toBe('camel_case');
    });

    it('should convert UpperCamelCase', () => {
      expect(toSnakeCaseName('UpperCamelCase')).toBe('upper_camel_case');
    });

    it('should convert space separated text', () => {
      expect(toSnakeCaseName('space separated')).toBe('space_separated');
    });

    it('should convert an acronym followed by a word', () => {
      expect(toSnakeCaseName('REST API')).toBe('rest_api');
    });

    it('should convert a dashed name', () => {
      expect(toSnakeCaseName('list-pets')).toBe('list_pets');
    });

    it('should split an embedded acronym', () => {
      expect(toSnakeCaseName('getHTTPResponse')).toBe('get_http_response');
    });

    it('should collapse repeated and trailing underscores', () => {
      expect(toSnakeCaseName('get__users__id_')).toBe('get_users_id');
    });

    it('should return an empty string unchanged', () => {
      expect(toSnakeCaseName('')).toBe('');
    });

    it('collapses every run of non-alphanumeric characters', () => {
      expect(toSnakeCaseName('a--b..c  d')).toBe('a_b_c_d');
    });

    it('leaves a string that is only separators empty', () => {
      expect(toSnakeCaseName('---')).toBe('');
      expect(toSnakeCaseName('///')).toBe('');
    });

    // The operationId fallback in `openapi_spec_parser` feeds this a raw
    // `<path>_<method>`, so path punctuation has to survive the conversion.
    it('converts a URL path with a template segment', () => {
      expect(toSnakeCaseName('/users/{id}_get')).toBe('users_id_get');
    });

    it('keeps a digit attached to its word', () => {
      expect(toSnakeCaseName('/path1_post')).toBe('path1_post');
    });

    it('splits a leading acronym from the word that follows', () => {
      expect(toSnakeCaseName('HTTPResponseCode')).toBe('http_response_code');
    });

    it('collapses mixed dashes and underscores', () => {
      expect(toSnakeCaseName('a -- b__c')).toBe('a_b_c');
    });
  });

  describe('renameReservedKeywords', () => {
    // The reference escapes PYTHON keywords (`keyword.iskeyword`). These are
    // reserved in ECMAScript and not in Python, so adk-python leaves them
    // alone and so must this. `await` is omitted: it is a keyword in both.
    it.each(['function', 'var', 'typeof', 'let', 'interface'])(
      'leaves a word reserved only in ECMAScript alone [%s]',
      (word) => {
        expect(renameReservedKeywords(word)).toBe(word);
      },
    );

    it('uses a caller-supplied prefix', () => {
      expect(renameReservedKeywords('class', 'arg_')).toBe('arg_class');
    });

    it('leaves a non-reserved word alone whatever the prefix', () => {
      expect(renameReservedKeywords('petId', 'arg_')).toBe('petId');
    });
  });
});
