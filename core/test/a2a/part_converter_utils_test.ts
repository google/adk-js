/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart} from '@a2a-js/sdk';
import {Part as GenAIPart, Language, Outcome} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createTextPart} from '../../src/a2a/a2a_event.js';
import {
  toA2ADataPart,
  toA2AFilePart,
  toA2APart,
  toA2AParts,
  toA2ATextPart,
  toGenAIPart,
  toGenAIPartData,
  toGenAIPartFile,
  toGenAIParts,
  toGenAIPartText,
} from '../../src/a2a/part_converter_utils.js';

type A2AContent = NonNullable<A2APart['content']>;
type A2ATextPart = Parameters<typeof toGenAIPartText>[0];
type A2AFilePart = Parameters<typeof toGenAIPartFile>[0];
type A2ADataPart = Parameters<typeof toGenAIPartData>[0];

const PNG_BYTES = Buffer.from('hello png');
const PNG_BASE64 = PNG_BYTES.toString('base64');
const VIDEO_BASE64 = Buffer.from('hello video').toString('base64');
// Bytes that are not valid UTF-8, to catch a lossy text round trip.
const BINARY_BYTES = new Uint8Array([0, 1, 2, 0x80, 0xfe, 0xff, 0xc3, 0x28]);
const BINARY_BASE64 = Buffer.from(BINARY_BYTES).toString('base64');

function makePart(
  content: A2AContent | undefined,
  fields: Partial<Omit<A2APart, 'content'>> = {},
): A2APart {
  return {
    content,
    metadata: undefined,
    filename: '',
    mediaType: '',
    ...fields,
  };
}

function textPart(text: string, metadata?: Record<string, unknown>): A2APart {
  return createTextPart(text, metadata);
}

function rawPart(
  base64: string,
  mediaType: string,
  metadata?: Record<string, unknown>,
): A2APart {
  return makePart(
    {$case: 'raw', value: Buffer.from(base64, 'base64')},
    {mediaType, metadata},
  );
}

function urlPart(
  url: string,
  mediaType: string,
  metadata?: Record<string, unknown>,
): A2APart {
  return makePart({$case: 'url', value: url}, {mediaType, metadata});
}

function dataPart(value: unknown, metadata?: Record<string, unknown>): A2APart {
  return makePart({$case: 'data', value}, {metadata});
}

describe('part_converter_utils', () => {
  describe('toA2ATextPart', () => {
    it('converts basic text part', () => {
      const genAiPart: GenAIPart = {text: 'hello world'};
      const expected = textPart('hello world');
      expect(toA2ATextPart(genAiPart)).toEqual(expected);
    });

    it('converts thought text part', () => {
      const genAiPart = {text: 'thinking...', thought: true};
      const expected = textPart('thinking...', {'adk_thought': true});
      expect(toA2ATextPart(genAiPart)).toEqual(expected);
    });
  });

  describe('toA2AFilePart', () => {
    it('converts fileData part', () => {
      const genAiPart: GenAIPart = {
        fileData: {mimeType: 'image/jpeg', fileUri: 'gs://bucket/image.jpg'},
      };
      const expected = urlPart('gs://bucket/image.jpg', 'image/jpeg', {});
      expect(toA2AFilePart(genAiPart)).toEqual(expected);
    });

    it('converts inlineData part to raw bytes', () => {
      const genAiPart: GenAIPart = {
        inlineData: {mimeType: 'image/png', data: PNG_BASE64},
      };
      const expected = rawPart(PNG_BASE64, 'image/png', {});
      const result = toA2AFilePart(genAiPart);
      expect(result).toEqual(expected);
      expect(result.content?.$case).toBe('raw');
      expect(
        Buffer.from((result.content as {value: Uint8Array}).value),
      ).toEqual(Buffer.from(PNG_BYTES));
    });

    it('converts fileData part with videoMetadata', () => {
      const genAiPart: GenAIPart = {
        fileData: {mimeType: 'video/mp4', fileUri: 'gs://bucket/video.mp4'},
        videoMetadata: {
          startOffset: '0s',
          endOffset: '10s',
        },
      };
      const expected = urlPart('gs://bucket/video.mp4', 'video/mp4', {
        'adk_video_metadata': {
          startOffset: '0s',
          endOffset: '10s',
        },
      });
      expect(toA2AFilePart(genAiPart)).toEqual(expected);
    });

    it('converts inlineData part with videoMetadata', () => {
      const genAiPart: GenAIPart = {
        inlineData: {mimeType: 'video/mp4', data: VIDEO_BASE64},
        videoMetadata: {
          fps: 30,
        },
      };
      const expected = rawPart(VIDEO_BASE64, 'video/mp4', {
        'adk_video_metadata': {
          fps: 30,
        },
      });
      expect(toA2AFilePart(genAiPart)).toEqual(expected);
    });

    it('throws on invalid file part', () => {
      expect(() => toA2AFilePart({text: 'not file'})).toThrow(
        'Not a file part',
      );
    });
  });

  describe('toA2ADataPart', () => {
    it('converts functionCall', () => {
      const genAiPart: GenAIPart = {
        functionCall: {
          id: 'function_call_id',
          name: 'getWeather',
          args: {location: 'London'},
        },
      };
      const expected = dataPart(
        {
          id: 'function_call_id',
          name: 'getWeather',
          args: {location: 'London'},
        },
        {'adk_type': 'function_call'},
      );
      expect(toA2ADataPart(genAiPart)).toEqual(expected);
    });

    it('adds long_running metadata to functionCall if ID matches', () => {
      const genAiPart: GenAIPart = {
        functionCall: {
          id: 'function_call_id',
          name: 'getWeather',
          args: {location: 'London'},
        },
      };
      const expected = dataPart(
        {
          id: 'function_call_id',
          name: 'getWeather',
          args: {location: 'London'},
        },
        {'adk_type': 'function_call', 'adk_is_long_running': true},
      );
      expect(toA2ADataPart(genAiPart, ['function_call_id'])).toEqual(expected);
    });

    it('does not mark functionCall as long-running when ID does not match', () => {
      const genAiPart: GenAIPart = {
        functionCall: {
          id: 'tool-456',
          name: 'getWeather',
          args: {location: 'London'},
        },
      };
      const expected = dataPart(
        {
          id: 'tool-456',
          name: 'getWeather',
          args: {location: 'London'},
        },
        {'adk_type': 'function_call'},
      );
      expect(toA2ADataPart(genAiPart, ['tool-123'])).toEqual(expected);
    });

    it('converts functionResponse', () => {
      const genAiPart: GenAIPart = {
        functionResponse: {
          id: 'function_response_id',
          name: 'getWeather',
          response: {temp: 20},
        },
      };
      const expected = dataPart(
        {
          id: 'function_response_id',
          name: 'getWeather',
          response: {temp: 20},
        },
        {'adk_type': 'function_response'},
      );
      expect(toA2ADataPart(genAiPart)).toEqual(expected);
    });

    it('adds long_running metadata to functionResponse if ID matches', () => {
      const genAiPart: GenAIPart = {
        functionResponse: {
          id: 'function_response_id',
          name: 'getWeather',
          response: {temp: 20},
        },
      };
      const expected = dataPart(
        {
          id: 'function_response_id',
          name: 'getWeather',
          response: {temp: 20},
        },
        {
          'adk_type': 'function_response',
          'adk_is_long_running': true,
        },
      );
      expect(toA2ADataPart(genAiPart, ['function_response_id'])).toEqual(
        expected,
      );
    });

    it('converts executableCode', () => {
      const genAiPart: GenAIPart = {
        executableCode: {code: 'print("hello")', language: Language.PYTHON},
      };
      const expected = dataPart(
        {
          code: 'print("hello")',
          language: Language.PYTHON,
        },
        {'adk_type': 'executable_code'},
      );
      expect(toA2ADataPart(genAiPart)).toEqual(expected);
    });

    it('converts codeExecutionResult', () => {
      const genAiPart: GenAIPart = {
        codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: 'hello'},
      };
      const expected = dataPart(
        {
          outcome: Outcome.OUTCOME_OK,
          output: 'hello',
        },
        {'adk_type': 'code_execution_result'},
      );
      expect(toA2ADataPart(genAiPart)).toEqual(expected);
    });

    it('returns empty data part on unknown data part type', () => {
      const result = toA2ADataPart({text: 'text'});
      expect(result).toEqual(dataPart({}, {}));
    });
  });

  describe('toA2APart', () => {
    it('delegates text part', () => {
      const genAiPart: GenAIPart = {text: 'hello'};
      expect(toA2APart(genAiPart)).toEqual(textPart('hello'));
    });

    it('preserves empty text part as text rather than falling through to data', () => {
      const genAiPart: GenAIPart = {text: ''};
      expect(toA2APart(genAiPart)).toEqual(textPart(''));
    });

    it('delegates fileData part', () => {
      const genAiPart: GenAIPart = {
        fileData: {mimeType: 'image/jpeg', fileUri: 'gs://foo'},
      };
      expect(toA2APart(genAiPart)).toEqual(
        urlPart('gs://foo', 'image/jpeg', {}),
      );
    });

    it('delegates inlineData part', () => {
      const genAiPart: GenAIPart = {
        inlineData: {mimeType: 'image/jpeg', data: PNG_BASE64},
      };
      expect(toA2APart(genAiPart)).toEqual(
        rawPart(PNG_BASE64, 'image/jpeg', {}),
      );
    });

    it('delegates data part', () => {
      const genAiPart: GenAIPart = {
        functionCall: {id: 'foo', name: 'getWeather', args: {}},
      };
      expect(toA2APart(genAiPart)).toEqual(
        dataPart(
          {id: 'foo', name: 'getWeather', args: {}},
          {'adk_type': 'function_call'},
        ),
      );
    });
  });

  describe('toA2AParts', () => {
    it('maps an array of parts', () => {
      const genAiParts: GenAIPart[] = [
        {text: 'hello'},
        {
          functionCall: {
            id: 'long_running_function_call_id',
            name: 'getWeather',
            args: {},
          },
        },
      ];
      const expected: A2APart[] = [
        textPart('hello'),
        dataPart(
          {
            id: 'long_running_function_call_id',
            name: 'getWeather',
            args: {},
          },
          {'adk_type': 'function_call', 'adk_is_long_running': true},
        ),
      ];
      expect(toA2AParts(genAiParts, ['long_running_function_call_id'])).toEqual(
        expected,
      );
    });
  });

  // Now the backward conversions
  describe('toGenAIPartText', () => {
    it('converts to text part', () => {
      const a2aPart = textPart('hello');
      const expected: GenAIPart = {text: 'hello', thought: false};
      expect(toGenAIPartText(a2aPart as A2ATextPart)).toEqual(expected);
    });

    it('converts empty text part', () => {
      const a2aPart = textPart('');
      const expected: GenAIPart = {text: '', thought: false};
      expect(toGenAIPart(a2aPart)).toEqual(expected);
    });

    it('converts thought text part', () => {
      const a2aPart = textPart('thinking...', {'adk_thought': true});
      const expected: GenAIPart = {text: 'thinking...', thought: true};
      expect(toGenAIPartText(a2aPart as A2ATextPart)).toEqual(expected);
    });
  });

  describe('toGenAIPartFile', () => {
    it('converts from file with raw bytes to base64 inlineData', () => {
      const a2aPart = rawPart(PNG_BASE64, 'image/png');
      const expected: GenAIPart = {
        inlineData: {mimeType: 'image/png', data: PNG_BASE64},
      };
      expect(toGenAIPartFile(a2aPart as A2AFilePart)).toEqual(expected);
    });

    it('converts from file with url', () => {
      const a2aPart = urlPart('gs://bucket/file', 'image/png');
      const expected: GenAIPart = {
        fileData: {mimeType: 'image/png', fileUri: 'gs://bucket/file'},
      };
      expect(toGenAIPartFile(a2aPart as A2AFilePart)).toEqual(expected);
    });

    it('converts from file with videoMetadata', () => {
      const a2aPart = urlPart('gs://bucket/video.mp4', 'video/mp4', {
        'adk_video_metadata': {
          startOffset: '0s',
          endOffset: '10s',
        },
      });
      const expected: GenAIPart = {
        fileData: {fileUri: 'gs://bucket/video.mp4', mimeType: 'video/mp4'},
        videoMetadata: {
          startOffset: '0s',
          endOffset: '10s',
        },
      };
      expect(toGenAIPartFile(a2aPart as A2AFilePart)).toEqual(expected);
    });

    it('converts from file with bytes and videoMetadata', () => {
      const a2aPart = rawPart(VIDEO_BASE64, 'video/mp4', {
        'adk_video_metadata': {
          fps: 30,
        },
      });
      const expected: GenAIPart = {
        inlineData: {data: VIDEO_BASE64, mimeType: 'video/mp4'},
        videoMetadata: {
          fps: 30,
        },
      };
      expect(toGenAIPartFile(a2aPart as A2AFilePart)).toEqual(expected);
    });

    it('throws if neither url nor bytes', () => {
      const a2aPart = makePart({$case: 'text', value: 'x'});
      expect(() => toGenAIPartFile(a2aPart as A2AFilePart)).toThrow(
        'Not a file part',
      );
    });
  });

  describe('toGenAIPartData', () => {
    it('converts functionCall', () => {
      const a2aPart = dataPart(
        {id: 'function_call_id', name: 'foo', args: {}},
        {'adk_type': 'function_call'},
      );
      const expected: GenAIPart = {
        functionCall: {id: 'function_call_id', name: 'foo', args: {}},
      };
      expect(toGenAIPartData(a2aPart as A2ADataPart)).toEqual(expected);
    });

    it('converts functionResponse', () => {
      const a2aPart = dataPart(
        {id: 'function_response_id', name: 'foo', response: {ok: true}},
        {'adk_type': 'function_response'},
      );
      const expected: GenAIPart = {
        functionResponse: {
          id: 'function_response_id',
          name: 'foo',
          response: {ok: true},
        },
      };
      expect(toGenAIPartData(a2aPart as A2ADataPart)).toEqual(expected);
    });

    it('converts executableCode', () => {
      const a2aPart = dataPart(
        {
          code: 'print("hi")',
          language: Language.PYTHON,
        },
        {'adk_type': 'executable_code'},
      );
      const expected: GenAIPart = {
        executableCode: {code: 'print("hi")', language: Language.PYTHON},
      };
      expect(toGenAIPartData(a2aPart as A2ADataPart)).toEqual(expected);
    });

    it('converts codeExecutionResult', () => {
      const a2aPart = dataPart(
        {
          outcome: Outcome.OUTCOME_OK,
          output: 'hi',
        },
        {'adk_type': 'code_execution_result'},
      );
      const expected: GenAIPart = {
        codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: 'hi'},
      };
      expect(toGenAIPartData(a2aPart as A2ADataPart)).toEqual(expected);
    });

    it('throws if no data in part', () => {
      const a2aPart = dataPart(undefined);
      expect(() => toGenAIPartData(a2aPart as A2ADataPart)).toThrow(
        'No data in part',
      );
    });

    it('throws if data is null', () => {
      const a2aPart = dataPart(null);
      expect(() => toGenAIPartData(a2aPart as A2ADataPart)).toThrow(
        'No data in part',
      );
    });

    it('falls back to stringified text if type is unknown', () => {
      const a2aPart = dataPart({customData: 123});
      const expected: GenAIPart = {
        text: '{"customData":123}',
      };
      expect(toGenAIPartData(a2aPart as A2ADataPart)).toEqual(expected);
    });

    it('serializes data part to JSON text when metadata has no adk_type', () => {
      const data = {key: 'value', number: 123};
      const a2aPart = dataPart(data, {other: 'metadata'});
      expect(toGenAIPartData(a2aPart as A2ADataPart)).toEqual({
        text: JSON.stringify(data),
      });
    });

    it('serializes data part to JSON text when metadata is empty', () => {
      const data = {key: 'value'};
      const a2aPart = dataPart(data, {});
      expect(toGenAIPartData(a2aPart as A2ADataPart)).toEqual({
        text: JSON.stringify(data),
      });
    });

    it('serializes data part with nested arrays, booleans, null, and unicode to JSON text', () => {
      const complexData = {
        nested: {
          array: [1, 2, {inner: 'value'}],
          boolean: true,
          nullValue: null,
        },
        unicode: 'Hello 世界 🌍',
      };
      const a2aPart = dataPart(complexData);
      expect(toGenAIPartData(a2aPart as A2ADataPart)).toEqual({
        text: JSON.stringify(complexData),
      });
    });

    it.each([
      {name: 'a string', value: 'just a string', text: '"just a string"'},
      {name: 'a number', value: 42, text: '42'},
      {name: 'a boolean', value: false, text: 'false'},
      {
        name: 'an array',
        value: [1, 'two', {three: 3}],
        text: '[1,"two",{"three":3}]',
      },
    ])(
      'serializes a non-object data value ($name) to JSON text',
      ({value, text}) => {
        const a2aPart = dataPart(value);
        expect(toGenAIPartData(a2aPart as A2ADataPart)).toEqual({text});
      },
    );

    it('does not map a non-object data value to a function call, even with adk_type', () => {
      const a2aPart = dataPart(['a', 'b'], {'adk_type': 'function_call'});
      expect(toGenAIPartData(a2aPart as A2ADataPart)).toEqual({
        text: '["a","b"]',
      });
    });
  });

  describe('toGenAIPart', () => {
    it('delegates text', () => {
      const a2aPart: A2APart = textPart('hi');
      expect(toGenAIPart(a2aPart)).toEqual({text: 'hi', thought: false});
    });

    it('delegates file', () => {
      const a2aPart = urlPart('gs://hi', 'text/plain');
      expect(toGenAIPart(a2aPart)).toEqual({
        fileData: {fileUri: 'gs://hi', mimeType: 'text/plain'},
      });
    });

    it('delegates raw file bytes', () => {
      const a2aPart = rawPart(PNG_BASE64, 'image/png');
      expect(toGenAIPart(a2aPart)).toEqual({
        inlineData: {data: PNG_BASE64, mimeType: 'image/png'},
      });
    });

    it('delegates data', () => {
      const a2aPart = dataPart(
        {name: 'foo', args: {}},
        {'adk_type': 'function_call'},
      );
      expect(toGenAIPart(a2aPart)).toEqual({
        functionCall: {name: 'foo', args: {}},
      });
    });

    it('throws on unknown content', () => {
      const a2aPart = makePart(undefined);
      expect(() => toGenAIPart(a2aPart)).toThrow('Unknown part content');
    });
  });

  describe('toGenAIParts', () => {
    it('maps array of parts', () => {
      const a2aParts: A2APart[] = [
        textPart('hi'),
        dataPart({name: 'foo', args: {}}, {'adk_type': 'function_call'}),
      ];
      const expected: GenAIPart[] = [
        {text: 'hi', thought: false},
        {functionCall: {name: 'foo', args: {}}},
      ];
      expect(toGenAIParts(a2aParts)).toEqual(expected);
    });
  });

  describe('end-to-end conversion', () => {
    it('toA2APart(toGenAIPart(part)) equals part for text', () => {
      const a2aPart = textPart('hello');
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for thought text', () => {
      const a2aPart = textPart('thinking...', {'adk_thought': true});
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for file bytes', () => {
      const a2aPart = rawPart(PNG_BASE64, 'image/png', {});
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for file url', () => {
      const a2aPart = urlPart('gs://bucket/image.jpg', 'image/jpeg', {});
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for file with videoMetadata', () => {
      const a2aPart = urlPart('gs://bucket/video.mp4', 'video/mp4', {
        'adk_video_metadata': {
          startOffset: '0s',
          endOffset: '10s',
        },
      });
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for file bytes with videoMetadata', () => {
      const a2aPart = rawPart(VIDEO_BASE64, 'video/mp4', {
        'adk_video_metadata': {
          fps: 30,
        },
      });
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for functionCall', () => {
      const a2aPart = dataPart(
        {name: 'getWeather', args: {location: 'London'}},
        {'adk_type': 'function_call'},
      );
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for functionResponse', () => {
      const a2aPart = dataPart(
        {name: 'getWeather', response: {temp: 20}},
        {'adk_type': 'function_response'},
      );
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for executableCode', () => {
      const a2aPart = dataPart(
        {
          code: 'print("hello")',
          language: Language.PYTHON,
        },
        {'adk_type': 'executable_code'},
      );
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for codeExecutionResult', () => {
      const a2aPart = dataPart(
        {
          outcome: Outcome.OUTCOME_OK,
          output: 'hello',
        },
        {'adk_type': 'code_execution_result'},
      );
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });
  });

  describe('inline data round trip', () => {
    it('GenAI base64 -> A2A raw bytes -> GenAI base64', () => {
      const genAiPart: GenAIPart = {
        inlineData: {mimeType: 'application/octet-stream', data: BINARY_BASE64},
      };

      const a2aPart = toA2APart(genAiPart);

      expect(a2aPart.content?.$case).toBe('raw');
      expect(a2aPart.mediaType).toBe('application/octet-stream');
      const bytes = (a2aPart.content as {value: Uint8Array}).value;
      expect(Array.from(bytes)).toEqual(Array.from(BINARY_BYTES));

      expect(toGenAIPart(a2aPart)).toEqual(genAiPart);
    });

    it('preserves bytes that are not valid UTF-8', () => {
      const genAiPart: GenAIPart = {
        inlineData: {mimeType: 'image/png', data: BINARY_BASE64},
      };
      expect(toGenAIPart(toA2APart(genAiPart))).toEqual(genAiPart);
    });

    it('encodes a raw byte view that is offset into a larger buffer', () => {
      const backing = new Uint8Array([9, 9, ...BINARY_BYTES, 9]);
      const view = backing.subarray(2, 2 + BINARY_BYTES.length);
      const a2aPart = makePart(
        {$case: 'raw', value: view as Buffer},
        {mediaType: 'application/octet-stream'},
      );
      expect(toGenAIPart(a2aPart)).toEqual({
        inlineData: {
          data: BINARY_BASE64,
          mimeType: 'application/octet-stream',
        },
      });
    });
  });
});
