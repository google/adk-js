/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Language, Outcome, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  CodeExecutionLanguage,
  FileContentEncoding,
  buildCodeExecutionResultPart,
  buildExecutableCodePart,
  convertCodeExecutionParts,
  extractCodeAndTruncateContent,
  extractCodeBlockAndTruncateContent,
  getCodeBlockLanguage,
  getEncodedFileContent,
} from '../../src/code_executors/code_execution_utils.js';
import {base64Encode} from '../../src/utils/env_aware_utils.js';

// ---------------------------------------------------------------------------
// getEncodedFileContent
// ---------------------------------------------------------------------------
describe('getEncodedFileContent', () => {
  it('returns data unchanged when already base64 encoded', () => {
    const encoded = base64Encode('hello world');
    expect(getEncodedFileContent(encoded)).toBe(encoded);
  });

  it('base64-encodes plain text that is not already encoded', () => {
    const plain = 'hello world';
    const result = getEncodedFileContent(plain);
    expect(result).toBe(base64Encode(plain));
  });

  it('handles empty string', () => {
    const result = getEncodedFileContent('');
    // empty string is valid base64 (empty), so it should come back unchanged or encoded
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// buildExecutableCodePart
// ---------------------------------------------------------------------------
describe('buildExecutableCodePart', () => {
  it('builds a part with only the executableCode field', () => {
    const code = 'print("hello")';
    const part = buildExecutableCodePart(code);
    expect(part.text).toBeUndefined();
    expect(part.executableCode).toBeDefined();
    expect(part.executableCode!.code).toBe(code);
  });

  it('sets language to PYTHON', () => {
    const part = buildExecutableCodePart('1 + 1');
    expect(part.executableCode!.language).toBe(Language.PYTHON);
  });

  it('handles empty code string', () => {
    const part = buildExecutableCodePart('');
    expect(part.text).toBeUndefined();
    expect(part.executableCode!.code).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildCodeExecutionResultPart
// ---------------------------------------------------------------------------
describe('buildCodeExecutionResultPart', () => {
  it('returns OUTCOME_FAILED when stderr is set', () => {
    const part = buildCodeExecutionResultPart({
      stdout: '',
      stderr: 'NameError: x',
      outputFiles: [],
    });
    expect(part.codeExecutionResult!.outcome).toBe(Outcome.OUTCOME_FAILED);
    expect(part.codeExecutionResult!.output).toBe('NameError: x');
  });

  it('returns OUTCOME_OK with stdout when no stderr', () => {
    const part = buildCodeExecutionResultPart({
      stdout: '42',
      stderr: '',
      outputFiles: [],
    });
    expect(part.codeExecutionResult!.outcome).toBe(Outcome.OUTCOME_OK);
    expect(part.codeExecutionResult!.output).toContain('42');
  });

  it('includes output file names in successful result', () => {
    const part = buildCodeExecutionResultPart({
      stdout: '',
      stderr: '',
      outputFiles: [
        {name: 'chart.png', content: 'abc', mimeType: 'image/png'},
        {name: 'data.csv', content: 'xyz', mimeType: 'text/csv'},
      ],
    });
    expect(part.codeExecutionResult!.outcome).toBe(Outcome.OUTCOME_OK);
    expect(part.codeExecutionResult!.output).toContain('chart.png');
    expect(part.codeExecutionResult!.output).toContain('data.csv');
  });

  it('includes both stdout and saved artifacts when both present', () => {
    const part = buildCodeExecutionResultPart({
      stdout: 'done',
      stderr: '',
      outputFiles: [{name: 'out.txt', content: '', mimeType: 'text/plain'}],
    });
    expect(part.codeExecutionResult!.output).toContain('done');
    expect(part.codeExecutionResult!.output).toContain('out.txt');
  });

  it('prefers stderr over stdout when both are set', () => {
    const part = buildCodeExecutionResultPart({
      stdout: 'some output',
      stderr: 'error occurred',
      outputFiles: [],
    });
    expect(part.codeExecutionResult!.outcome).toBe(Outcome.OUTCOME_FAILED);
    expect(part.codeExecutionResult!.output).toBe('error occurred');
  });

  it('sets codeExecutionResult.output to stderr on failure', () => {
    const part = buildCodeExecutionResultPart({
      stdout: '',
      stderr: 'NameError: x',
      outputFiles: [],
    });
    expect(part.codeExecutionResult!.output).toBe('NameError: x');
  });

  it('sets codeExecutionResult.output to the result text on success', () => {
    const part = buildCodeExecutionResultPart({
      stdout: '42',
      stderr: '',
      outputFiles: [],
    });
    expect(part.codeExecutionResult!.output).toBe(
      'Code execution result:\n42\n',
    );
    expect(part.text).toBeUndefined();
  });

  it('renders empty stdout with no output files as an empty result', () => {
    const part = buildCodeExecutionResultPart({
      stdout: '',
      stderr: '',
      outputFiles: [],
    });
    expect(part.codeExecutionResult!.output).toBe('Code execution result:\n\n');
  });

  it('omits the saved artifacts section when there are no output files', () => {
    const part = buildCodeExecutionResultPart({
      stdout: 'done',
      stderr: '',
      outputFiles: [],
    });
    expect(part.codeExecutionResult!.output).not.toContain('Saved artifacts');
  });

  it('omits the empty stdout section when there are output files', () => {
    const part = buildCodeExecutionResultPart({
      stdout: '',
      stderr: '',
      outputFiles: [{name: 'chart.png', content: 'abc', mimeType: 'image/png'}],
    });
    expect(part.codeExecutionResult!.output).toBe(
      'Saved artifacts:\n`chart.png`',
    );
  });

  it('wraps each saved artifact name in backticks and joins them with commas', () => {
    const part = buildCodeExecutionResultPart({
      stdout: 'done',
      stderr: '',
      outputFiles: [
        {name: 'a.png', content: 'abc', mimeType: 'image/png'},
        {name: 'b.csv', content: 'xyz', mimeType: 'text/csv'},
      ],
    });
    expect(part.codeExecutionResult!.output).toBe(
      'Code execution result:\ndone\n\n\nSaved artifacts:\n`a.png`,`b.csv`',
    );
    expect(part.text).toBeUndefined();
  });

  it('sets no text on a failed result part', () => {
    const part = buildCodeExecutionResultPart({
      stdout: '',
      stderr: 'boom',
      outputFiles: [],
    });
    expect(part.text).toBeUndefined();
  });

  it('round-trips through convertCodeExecutionParts into tool output text', () => {
    const resultDelimiters: [string, string] = ['```tool_output\n', '\n```'];
    for (const stderr of ['', 'Traceback: boom']) {
      const part = buildCodeExecutionResultPart({
        stdout: 'hello',
        stderr,
        outputFiles: [],
      });
      const output = part.codeExecutionResult!.output!;
      const content: Content = {role: 'model', parts: [part]};

      convertCodeExecutionParts(
        content,
        ['```python\n', '\n```'],
        resultDelimiters,
      );

      expect(content.role).toBe('user');
      expect(content.parts![0].text).toBe(
        '```tool_output\n' + output + '\n```',
      );
      expect(content.parts![0].text).toContain(stderr || 'hello');
    }
  });
});

// ---------------------------------------------------------------------------
// extractCodeAndTruncateContent
// ---------------------------------------------------------------------------
const PYTHON_DELIMITERS: Array<[string, string]> = [
  ['```python\n', '\n```'],
  ['```tool_code\n', '\n```'],
];

describe('extractCodeAndTruncateContent', () => {
  it('returns empty string when content has no parts', () => {
    const content = {parts: [], role: 'model'};
    expect(extractCodeAndTruncateContent(content, PYTHON_DELIMITERS)).toBe('');
  });

  it('returns empty string when parts is undefined', () => {
    const content = {role: 'model'} as unknown as Content;
    expect(extractCodeAndTruncateContent(content, PYTHON_DELIMITERS)).toBe('');
  });

  it('extracts code from executableCode part without following result', () => {
    const code = 'print("hi")';
    const content = {
      parts: [{executableCode: {code, language: Language.PYTHON}}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe(code);
    expect(content.parts).toHaveLength(1);
  });

  it('returns empty string for an executableCode part without code', () => {
    const parts: Part[] = [{executableCode: {language: Language.PYTHON}}];
    const content = {parts, role: 'model'};

    expect(extractCodeAndTruncateContent(content, PYTHON_DELIMITERS)).toBe('');
  });

  it('skips executableCode part when followed by codeExecutionResult', () => {
    const code = 'print("hi")';
    const content = {
      parts: [
        {executableCode: {code, language: Language.PYTHON}},
        {codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: 'hi'}},
        {executableCode: {code: 'x=1', language: Language.PYTHON}},
      ],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('x=1');
  });

  it('extracts code block from text parts', () => {
    const content = {
      parts: [{text: '```python\nprint("hello")\n```'}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('print("hello")');
  });

  it('extracts code and preserves prefix text', () => {
    const content = {
      parts: [{text: 'Here is the code:\n```python\nx = 1\n```'}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('x = 1');
    // prefix text part should be present
    const textParts = content.parts.filter(
      (p) => p.text && !('executableCode' in p),
    );
    expect(textParts.some((p) => p.text!.includes('Here is the code:'))).toBe(
      true,
    );
  });

  it('returns empty string when no code block found in text', () => {
    const content = {
      parts: [{text: 'just some text, no code block'}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('');
  });

  it('returns empty string when parts exist but none have text or executableCode', () => {
    const content = {
      parts: [{inlineData: {mimeType: 'image/png', data: 'abc'}}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('');
  });

  it('truncates content after the first executableCode part', () => {
    const code1 = 'a = 1';
    const code2 = 'b = 2';
    const content = {
      parts: [
        {executableCode: {code: code1, language: Language.PYTHON}},
        {executableCode: {code: code2, language: Language.PYTHON}},
      ],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    // first executableCode has no following codeExecutionResult, so it's extracted
    expect(result).toBe(code1);
    expect(content.parts).toHaveLength(1);
  });

  it('handles tool_code delimiter', () => {
    const content = {
      parts: [{text: '```tool_code\nmy_function()\n```'}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('my_function()');
  });

  it('handles multi-part text joined together', () => {
    const content = {
      parts: [{text: 'Part 1\n'}, {text: '```python\nmy_code()\n```'}],
      role: 'model',
    };
    const result = extractCodeAndTruncateContent(content, PYTHON_DELIMITERS);
    expect(result).toBe('my_code()');
  });
});

// ---------------------------------------------------------------------------
// getCodeBlockLanguage and extractCodeBlockAndTruncateContent
// ---------------------------------------------------------------------------
const DEFAULT_DELIMITERS: Array<[string, string]> = [
  ['```tool_code\n', '\n```'],
  ['```python\n', '\n```'],
  ['```javascript\n', '\n```'],
  ['```typescript\n', '\n```'],
  ['```bash\n', '\n```'],
  ['```sh\n', '\n```'],
];

describe('getCodeBlockLanguage', () => {
  it.each([
    ['```tool_code\n', CodeExecutionLanguage.PYTHON],
    ['```python\n', CodeExecutionLanguage.PYTHON],
    ['```javascript\n', CodeExecutionLanguage.JAVASCRIPT],
    ['```js\n', CodeExecutionLanguage.JAVASCRIPT],
    ['```typescript\n', CodeExecutionLanguage.TYPESCRIPT],
    ['```ts\n', CodeExecutionLanguage.TYPESCRIPT],
    ['```bash\n', CodeExecutionLanguage.SHELL],
    ['```sh\n', CodeExecutionLanguage.SHELL],
    ['```shell\n', CodeExecutionLanguage.SHELL],
    ['```Bash\n', CodeExecutionLanguage.SHELL],
    ['```py\n', CodeExecutionLanguage.PYTHON],
    ['```Python\n', CodeExecutionLanguage.PYTHON],
    ['```unknown\n', CodeExecutionLanguage.UNSPECIFIED],
    ['<code>', CodeExecutionLanguage.UNSPECIFIED],
    ['', CodeExecutionLanguage.UNSPECIFIED],
  ])('maps %j to %s', (delimiter, language) => {
    expect(getCodeBlockLanguage(delimiter)).toBe(language);
  });
});

describe('extractCodeBlockAndTruncateContent', () => {
  it.each([
    ['tool_code', 'print(1)', CodeExecutionLanguage.PYTHON],
    ['python', 'print(1)', CodeExecutionLanguage.PYTHON],
    ['javascript', 'console.log(1)', CodeExecutionLanguage.JAVASCRIPT],
    [
      'typescript',
      'console.log(1 as number)',
      CodeExecutionLanguage.TYPESCRIPT,
    ],
    ['bash', 'echo 1', CodeExecutionLanguage.SHELL],
    ['sh', 'echo 1', CodeExecutionLanguage.SHELL],
  ])('returns the language of a %s block', (tag, code, language) => {
    const content: Content = {
      role: 'model',
      parts: [{text: `Here:\n\`\`\`${tag}\n${code}\n\`\`\`\nDone.`}],
    };

    expect(
      extractCodeBlockAndTruncateContent(content, DEFAULT_DELIMITERS),
    ).toEqual({code, language});
    expect(content.parts).toEqual([
      {text: 'Here:\n'},
      {executableCode: {code, language: Language.PYTHON}},
    ]);
  });

  it('uses the language of the first block when blocks differ', () => {
    const content: Content = {
      role: 'model',
      parts: [{text: '```bash\necho 1\n```\n```python\nprint(2)\n```'}],
    };

    expect(
      extractCodeBlockAndTruncateContent(content, DEFAULT_DELIMITERS),
    ).toEqual({code: 'echo 1', language: CodeExecutionLanguage.SHELL});
  });

  it('returns Python for an executableCode part', () => {
    const content: Content = {
      role: 'model',
      parts: [{executableCode: {code: 'print(1)', language: Language.PYTHON}}],
    };

    expect(
      extractCodeBlockAndTruncateContent(content, DEFAULT_DELIMITERS),
    ).toEqual({code: 'print(1)', language: CodeExecutionLanguage.PYTHON});
  });

  it('returns empty code when there is no block', () => {
    const content: Content = {role: 'model', parts: [{text: 'No code here.'}]};

    expect(
      extractCodeBlockAndTruncateContent(content, DEFAULT_DELIMITERS),
    ).toEqual({code: '', language: CodeExecutionLanguage.UNSPECIFIED});
  });

  it('returns an unspecified language for a custom delimiter with an unknown tag', () => {
    const content: Content = {
      role: 'model',
      parts: [{text: '```ruby\nputs 1\n```'}],
    };

    expect(
      extractCodeBlockAndTruncateContent(content, [['```ruby\n', '\n```']]),
    ).toEqual({code: 'puts 1', language: CodeExecutionLanguage.UNSPECIFIED});
  });
});

// ---------------------------------------------------------------------------
// convertCodeExecutionParts
// ---------------------------------------------------------------------------
describe('convertCodeExecutionParts', () => {
  const CODE_DELIM: [string, string] = ['```python\n', '\n```'];
  const RESULT_DELIM: [string, string] = ['```tool_output\n', '\n```'];

  it('does nothing when parts is empty', () => {
    const content = {parts: [], role: 'model'};
    convertCodeExecutionParts(content, CODE_DELIM, RESULT_DELIM);
    expect(content.parts).toHaveLength(0);
  });

  it('does nothing when parts is undefined', () => {
    const content = {role: 'model'} as unknown as Content;
    convertCodeExecutionParts(content, CODE_DELIM, RESULT_DELIM);
    expect(content.parts).toBeUndefined();
  });

  it('converts last executableCode part to text', () => {
    const content: Content = {
      parts: [{executableCode: {code: 'x = 1', language: Language.PYTHON}}],
      role: 'model',
    };
    convertCodeExecutionParts(content, CODE_DELIM, RESULT_DELIM);
    expect(content.parts![0].text).toBe('```python\nx = 1\n```');
    expect(content.parts![0].executableCode).toBeUndefined();
  });

  it('converts an executableCode part without code to an empty code block', () => {
    const parts: Part[] = [{executableCode: {language: Language.PYTHON}}];
    const content = {parts, role: 'model'};

    convertCodeExecutionParts(content, CODE_DELIM, RESULT_DELIM);

    expect(content.parts[0].text).toBe('```python\n\n```');
    expect(content.parts[0].executableCode).toBeUndefined();
    expect(content.role).toBe('model');
  });

  it('converts an executableCode part with a null code to an empty code block', () => {
    // An A2A data part or a persisted event is deserialized straight into the
    // part, so an explicit null reaches the converter even though the SDK types
    // code as string | undefined.
    const content: Content = JSON.parse(
      '{"role":"model","parts":[{"executableCode":{"language":"PYTHON","code":null}}]}',
    );

    convertCodeExecutionParts(content, CODE_DELIM, RESULT_DELIM);

    expect(content.parts?.[0].text).toBe('```python\n\n```');
  });

  it('converts single codeExecutionResult part to text and sets role to user', () => {
    const content: Content = {
      parts: [
        {
          codeExecutionResult: {
            outcome: Outcome.OUTCOME_OK,
            output: 'hello',
          },
        },
      ],
      role: 'model',
    };
    convertCodeExecutionParts(content, CODE_DELIM, RESULT_DELIM);
    expect(content.parts![0].text).toBe('```tool_output\nhello\n```');
    expect(content.role).toBe('user');
  });

  it('converts a codeExecutionResult without output to an empty text part', () => {
    const parts: Part[] = [
      {codeExecutionResult: {outcome: Outcome.OUTCOME_OK}},
    ];
    const content = {parts, role: 'model'};

    convertCodeExecutionParts(content, CODE_DELIM, RESULT_DELIM);

    // No output means no delimiters either - an empty text part, not
    // '```tool_output\nundefined\n```'.
    expect(content.parts[0].text).toBe('');
    expect(content.parts[0].codeExecutionResult).toBeUndefined();
    expect(content.role).toBe('user');
  });

  it('converts a codeExecutionResult with a null output to an empty text part', () => {
    // An A2A data part or a persisted event is deserialized straight into the
    // part, so an explicit null reaches the converter even though the SDK
    // types output as string | undefined.
    const nullOutput = {
      codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: null},
    } as unknown as Part;
    const content = {parts: [nullOutput], role: 'model'};

    convertCodeExecutionParts(content, CODE_DELIM, RESULT_DELIM);

    expect(content.parts[0].text).toBe('');
    expect(content.role).toBe('user');
  });

  it('keeps the delimiters when the output is an empty string', () => {
    const parts: Part[] = [
      {codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: ''}},
    ];
    const content = {parts, role: 'model'};

    convertCodeExecutionParts(content, CODE_DELIM, RESULT_DELIM);

    // '' is not "no output": adk-python guards on `is not None`, so an empty
    // result still renders as an empty tool_output block.
    expect(content.parts[0].text).toBe('```tool_output\n\n```');
    expect(content.role).toBe('user');
  });

  it('does not convert codeExecutionResult when there are multiple parts', () => {
    const content = {
      parts: [
        {text: 'some text'},
        {
          codeExecutionResult: {
            outcome: Outcome.OUTCOME_OK,
            output: 'hello',
          },
        },
      ],
      role: 'model',
    };
    convertCodeExecutionParts(content, CODE_DELIM, RESULT_DELIM);
    // last part has codeExecutionResult but length > 1, so no conversion
    expect(content.parts[1].codeExecutionResult).toBeDefined();
    expect(content.role).toBe('model');
  });

  it('does not modify parts that are plain text', () => {
    const content = {
      parts: [{text: 'just text'}],
      role: 'model',
    };
    convertCodeExecutionParts(content, CODE_DELIM, RESULT_DELIM);
    expect(content.parts[0].text).toBe('just text');
    expect(content.role).toBe('model');
  });
});

// ---------------------------------------------------------------------------
// Enums and interfaces
// ---------------------------------------------------------------------------
describe('FileContentEncoding', () => {
  it('has UTF8 and BASE64 values', () => {
    expect(FileContentEncoding.UTF8).toBe('utf-8');
    expect(FileContentEncoding.BASE64).toBe('base64');
  });
});

describe('CodeExecutionLanguage', () => {
  it('has expected language values', () => {
    expect(CodeExecutionLanguage.UNSPECIFIED).toBe('unspecified');
    expect(CodeExecutionLanguage.PYTHON).toBe('python');
    expect(CodeExecutionLanguage.JAVASCRIPT).toBe('javascript');
    expect(CodeExecutionLanguage.TYPESCRIPT).toBe('typescript');
    expect(CodeExecutionLanguage.SHELL).toBe('shell');
    expect(CodeExecutionLanguage.POWERSHELL).toBe('powershell');
    expect(CodeExecutionLanguage.WINDOWS_CMD).toBe('cmd');
  });
});
