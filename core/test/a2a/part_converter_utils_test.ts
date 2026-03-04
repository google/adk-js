/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DataPart as A2ADataPart,
  FilePart as A2AFilePart,
  Part as A2APart,
  TextPart as A2ATextPart,
} from '@a2a-js/sdk';
import {Part as GenAIPart, Language, Outcome} from '@google/genai';
import {describe, expect, it} from 'vitest';
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

describe('part_converter_utils', () => {
  describe('toA2ATextPart', () => {
    it('converts basic text part', () => {
      const genAiPart: GenAIPart = {text: 'hello world'};
      const expected: A2APart = {kind: 'text', text: 'hello world'};
      expect(toA2ATextPart(genAiPart)).toEqual(expected);
    });

    it('converts thought text part', () => {
      const genAiPart = {text: 'thinking...', thought: true};
      const expected: A2APart = {
        kind: 'text',
        text: 'thinking...',
        metadata: {'adk_thought': true},
      };
      expect(toA2ATextPart(genAiPart)).toEqual(expected);
    });
  });

  describe('toA2AFilePart', () => {
    it('converts fileData part', () => {
      const genAiPart: GenAIPart = {
        fileData: {mimeType: 'image/jpeg', fileUri: 'gs://bucket/image.jpg'},
      };
      const expected: A2APart = {
        kind: 'file',
        file: {uri: 'gs://bucket/image.jpg', mimeType: 'image/jpeg'},
        metadata: {},
      };
      expect(toA2AFilePart(genAiPart)).toEqual(expected);
    });

    it('converts inlineData part', () => {
      const genAiPart: GenAIPart = {
        inlineData: {mimeType: 'image/png', data: 'base64data'},
      };
      const expected: A2APart = {
        kind: 'file',
        file: {bytes: 'base64data', mimeType: 'image/png'},
        metadata: {},
      };
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
      const expected: A2APart = {
        kind: 'data',
        data: {
          id: 'function_call_id',
          name: 'getWeather',
          args: {location: 'London'},
        },
        metadata: {'adk_type': 'function_call'},
      };
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
      const expected: A2APart = {
        kind: 'data',
        data: {
          id: 'function_call_id',
          name: 'getWeather',
          args: {location: 'London'},
        },
        metadata: {'adk_type': 'function_call', 'adk_is_long_running': true},
      };
      expect(toA2ADataPart(genAiPart, ['function_call_id'])).toEqual(expected);
    });

    it('converts functionResponse', () => {
      const genAiPart: GenAIPart = {
        functionResponse: {
          id: 'function_response_id',
          name: 'getWeather',
          response: {temp: 20},
        },
      };
      const expected: A2APart = {
        kind: 'data',
        data: {
          id: 'function_response_id',
          name: 'getWeather',
          response: {temp: 20},
        },
        metadata: {'adk_type': 'function_response'},
      };
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
      const expected: A2APart = {
        kind: 'data',
        data: {
          id: 'function_response_id',
          name: 'getWeather',
          response: {temp: 20},
        },
        metadata: {
          'adk_type': 'function_response',
          'adk_is_long_running': true,
        },
      };
      expect(toA2ADataPart(genAiPart, ['function_response_id'])).toEqual(
        expected,
      );
    });

    it('converts executableCode', () => {
      const genAiPart: GenAIPart = {
        executableCode: {code: 'print("hello")', language: Language.PYTHON},
      };
      const expected: A2APart = {
        kind: 'data',
        data: {
          code: 'print("hello")',
          language: Language.PYTHON,
        },
        metadata: {'adk_type': 'executable_code'},
      };
      expect(toA2ADataPart(genAiPart)).toEqual(expected);
    });

    it('converts codeExecutionResult', () => {
      const genAiPart: GenAIPart = {
        codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: 'hello'},
      };
      const expected: A2APart = {
        kind: 'data',
        data: {
          outcome: Outcome.OUTCOME_OK,
          output: 'hello',
        },
        metadata: {'adk_type': 'code_execution_result'},
      };
      expect(toA2ADataPart(genAiPart)).toEqual(expected);
    });

    it('throws on unknown data part type', () => {
      expect(() => toA2ADataPart({text: 'text'})).toThrow('Unknown part type');
    });
  });

  describe('toA2APart', () => {
    it('delegates text part', () => {
      const genAiPart: GenAIPart = {text: 'hello'};
      expect(toA2APart(genAiPart)).toEqual({kind: 'text', text: 'hello'});
    });

    it('delegates fileData part', () => {
      const genAiPart: GenAIPart = {
        fileData: {mimeType: 'image/jpeg', fileUri: 'gs://foo'},
      };
      expect(toA2APart(genAiPart)).toEqual({
        kind: 'file',
        file: {uri: 'gs://foo', mimeType: 'image/jpeg'},
        metadata: {},
      });
    });

    it('delegates inlineData part', () => {
      const genAiPart: GenAIPart = {
        inlineData: {mimeType: 'image/jpeg', data: 'xyz'},
      };
      expect(toA2APart(genAiPart)).toEqual({
        kind: 'file',
        file: {bytes: 'xyz', mimeType: 'image/jpeg'},
        metadata: {},
      });
    });

    it('delegates data part', () => {
      const genAiPart: GenAIPart = {
        functionCall: {id: 'foo', name: 'getWeather', args: {}},
      };
      expect(toA2APart(genAiPart)).toEqual({
        kind: 'data',
        data: {id: 'foo', name: 'getWeather', args: {}},
        metadata: {'adk_type': 'function_call'},
      });
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
        {kind: 'text', text: 'hello'},
        {
          kind: 'data',
          data: {
            id: 'long_running_function_call_id',
            name: 'getWeather',
            args: {},
          },
          metadata: {'adk_type': 'function_call', 'adk_is_long_running': true},
        },
      ];
      expect(toA2AParts(genAiParts, ['long_running_function_call_id'])).toEqual(
        expected,
      );
    });
  });

  // Now the backward conversions
  describe('toGenAIPartText', () => {
    it('converts to text part', () => {
      const a2aPart: A2ATextPart = {kind: 'text', text: 'hello'};
      const expected: GenAIPart = {text: 'hello', thought: false};
      expect(toGenAIPartText(a2aPart)).toEqual(expected);
    });

    it('converts thought text part', () => {
      const a2aPart: A2ATextPart = {
        kind: 'text',
        text: 'thinking...',
        metadata: {'adk_thought': true},
      };
      const expected: GenAIPart = {text: 'thinking...', thought: true};
      expect(toGenAIPartText(a2aPart)).toEqual(expected);
    });
  });

  describe('toGenAIPartFile', () => {
    it('converts from file with bytes', () => {
      const a2aPart: A2AFilePart = {
        kind: 'file',
        file: {bytes: 'data', mimeType: 'image/png'},
      };
      const expected: GenAIPart = {
        inlineData: {mimeType: 'image/png', data: 'data'},
      };
      expect(toGenAIPartFile(a2aPart)).toEqual(expected);
    });

    it('converts from file with uri', () => {
      const a2aPart: A2AFilePart = {
        kind: 'file',
        file: {uri: 'gs://bucket/file', mimeType: 'image/png'},
      };
      const expected: GenAIPart = {
        fileData: {mimeType: 'image/png', fileUri: 'gs://bucket/file'},
      };
      expect(toGenAIPartFile(a2aPart)).toEqual(expected);
    });

    it('throws if neither uri nor bytes', () => {
      const a2aPart = {kind: 'file', file: {}} as unknown as A2AFilePart;
      expect(() => toGenAIPartFile(a2aPart)).toThrow(
        'Not a file part: {"kind":"file","file":{}}',
      );
    });
  });

  describe('toGenAIPartData', () => {
    it('converts functionCall', () => {
      const a2aPart: A2ADataPart = {
        kind: 'data',
        data: {id: 'function_call_id', name: 'foo', args: {}},
        metadata: {'adk_type': 'function_call'},
      };
      const expected: GenAIPart = {
        functionCall: {id: 'function_call_id', name: 'foo', args: {}},
      };
      expect(toGenAIPartData(a2aPart)).toEqual(expected);
    });

    it('converts functionResponse', () => {
      const a2aPart: A2ADataPart = {
        kind: 'data',
        data: {id: 'function_response_id', name: 'foo', response: {ok: true}},
        metadata: {'adk_type': 'function_response'},
      };
      const expected: GenAIPart = {
        functionResponse: {
          id: 'function_response_id',
          name: 'foo',
          response: {ok: true},
        },
      };
      expect(toGenAIPartData(a2aPart)).toEqual(expected);
    });

    it('converts executableCode', () => {
      const a2aPart: A2ADataPart = {
        kind: 'data',
        data: {
          code: 'print("hi")',
          language: Language.PYTHON,
        },
        metadata: {'adk_type': 'executable_code'},
      };
      const expected: GenAIPart = {
        executableCode: {code: 'print("hi")', language: Language.PYTHON},
      };
      expect(toGenAIPartData(a2aPart)).toEqual(expected);
    });

    it('converts codeExecutionResult', () => {
      const a2aPart: A2ADataPart = {
        kind: 'data',
        data: {
          outcome: Outcome.OUTCOME_OK,
          output: 'hi',
        },
        metadata: {'adk_type': 'code_execution_result'},
      };
      const expected: GenAIPart = {
        codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: 'hi'},
      };
      expect(toGenAIPartData(a2aPart)).toEqual(expected);
    });

    it('throws if no data in part', () => {
      const a2aPart = {
        kind: 'data',
      } as unknown as A2ADataPart;
      expect(() => toGenAIPartData(a2aPart)).toThrow('No data in part');
    });

    it('falls back to stringified text if type is unknown', () => {
      const a2aPart: A2ADataPart = {
        kind: 'data',
        data: {customData: 123},
      };
      const expected: GenAIPart = {
        text: '{"customData":123}',
      };
      expect(toGenAIPartData(a2aPart)).toEqual(expected);
    });
  });

  describe('toGenAIPart', () => {
    it('delegates text', () => {
      const a2aPart: A2APart = {kind: 'text', text: 'hi'};
      expect(toGenAIPart(a2aPart)).toEqual({text: 'hi', thought: false});
    });

    it('delegates file', () => {
      const a2aPart: A2APart = {
        kind: 'file',
        file: {uri: 'gs://hi', mimeType: 'text/plain'},
      };
      expect(toGenAIPart(a2aPart)).toEqual({
        fileData: {fileUri: 'gs://hi', mimeType: 'text/plain'},
      });
    });

    it('delegates data', () => {
      const a2aPart: A2APart = {
        kind: 'data',
        data: {name: 'foo', args: {}},
        metadata: {'adk_type': 'function_call'},
      };
      expect(toGenAIPart(a2aPart)).toEqual({
        functionCall: {name: 'foo', args: {}},
      });
    });

    it('throws on unknown kind', () => {
      const a2aPart = {kind: 'unknown'} as unknown as A2APart;
      expect(() => toGenAIPart(a2aPart)).toThrow('Unknown part kind');
    });
  });

  describe('toGenAIParts', () => {
    it('maps array of parts', () => {
      const a2aParts: A2APart[] = [
        {kind: 'text', text: 'hi'},
        {
          kind: 'data',
          data: {name: 'foo', args: {}},
          metadata: {'adk_type': 'function_call'},
        },
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
      const a2aPart: A2APart = {kind: 'text', text: 'hello'};
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for thought text', () => {
      const a2aPart: A2APart = {
        kind: 'text',
        text: 'thinking...',
        metadata: {'adk_thought': true},
      };
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for file base64', () => {
      const a2aPart: A2APart = {
        kind: 'file',
        file: {bytes: 'base64data', mimeType: 'image/png'},
        metadata: {},
      };
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for file uri', () => {
      const a2aPart: A2APart = {
        kind: 'file',
        file: {uri: 'gs://bucket/image.jpg', mimeType: 'image/jpeg'},
        metadata: {},
      };
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for functionCall', () => {
      const a2aPart: A2APart = {
        kind: 'data',
        data: {name: 'getWeather', args: {location: 'London'}},
        metadata: {'adk_type': 'function_call'},
      };
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for functionResponse', () => {
      const a2aPart: A2APart = {
        kind: 'data',
        data: {name: 'getWeather', response: {temp: 20}},
        metadata: {'adk_type': 'function_response'},
      };
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for executableCode', () => {
      const a2aPart: A2APart = {
        kind: 'data',
        data: {
          code: 'print("hello")',
          language: Language.PYTHON,
        },
        metadata: {'adk_type': 'executable_code'},
      };
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });

    it('toA2APart(toGenAIPart(part)) equals part for codeExecutionResult', () => {
      const a2aPart: A2APart = {
        kind: 'data',
        data: {
          outcome: Outcome.OUTCOME_OK,
          output: 'hello',
        },
        metadata: {'adk_type': 'code_execution_result'},
      };
      expect(toA2APart(toGenAIPart(a2aPart))).toEqual(a2aPart);
    });
  });
});
