/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {File, Storage} from '@google-cloud/storage';
import {
  AgentTool,
  BaseTool,
  FunctionTool,
  ListSkillsTool,
  LlmAgent,
  type LlmRequest,
  LoadSkillResourceTool,
  LoadSkillTool,
  MCPTool,
  RemoteAgent,
  RunSkillInlineScriptTool,
  RunSkillScriptTool,
  SearchSkillsTool,
} from '@google/adk';
import {
  type Content,
  type FunctionDeclaration,
  Language,
  Outcome,
  type Part,
  Type,
} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  formatContent,
  HybridContentParser,
} from '../../src/bigquery_analytics/content_parser.js';
import {FORMATTER_FAILED_SENTINEL} from '../../src/bigquery_analytics/formatter_outcome.js';
import {GcsOffloader} from '../../src/bigquery_analytics/gcs_offloader.js';
import {
  extractToolDeclarations,
  getToolOrigin,
} from '../../src/bigquery_analytics/tool_origin.js';

function llmRequest(
  fields: Partial<LlmRequest> & Pick<LlmRequest, 'contents'>,
): LlmRequest {
  return {liveConnectConfig: {}, toolsDict: {}, ...fields};
}

function inlinePart(data: string, mimeType: string): Part {
  return {inlineData: {data: Buffer.from(data).toString('base64'), mimeType}};
}

interface UploadParams {
  data: Buffer | string;
  contentType: string;
  path: string;
}

class FakeOffloader extends GcsOffloader {
  readonly paths: Array<string> = [];
  readonly upload = vi.fn<(params: UploadParams) => Promise<string>>(
    async ({path}) => {
      this.paths.push(path);
      await Promise.resolve();
      return `gs://bucket/${path}`;
    },
  );

  constructor() {
    super({
      projectId: 'p',
      bucketName: 'bucket',
      storage: new Storage({projectId: 'p'}),
    });
  }

  override uploadContent(params: UploadParams): Promise<string> {
    return this.upload(params);
  }

  uploaded(index: number): UploadParams | undefined {
    return this.upload.mock.calls[index]?.[0];
  }
}

function twoInlineParts(): Content {
  return {parts: [inlinePart('x', 'image/png'), inlinePart('y', 'image/png')]};
}

function parser(
  maxLength: number,
  offloader: GcsOffloader | null = null,
): HybridContentParser {
  return new HybridContentParser({
    offloader,
    traceId: 't',
    spanId: 's',
    maxLength,
  });
}

class NamedTool extends BaseTool {
  constructor(
    name: string,
    description: string,
    private readonly declaration: () => FunctionDeclaration | undefined,
  ) {
    super({name, description});
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declaration();
  }

  override runAsync(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

function remoteAgent(name: string): RemoteAgent {
  // SAFETY: a prototype-only instance plus the signature RemoteAgent's
  // constructor stamps is what isRemoteAgent checks; nothing but `name` is read
  // from it.
  const agent = Object.create(RemoteAgent.prototype) as RemoteAgent;
  Object.defineProperty(agent, 'name', {value: name});
  Object.defineProperty(agent, Symbol.for('google.adk.remoteAgent'), {
    value: true,
  });
  return agent;
}

interface AgentNode {
  name: string;
  subAgents: Array<AgentNode | RemoteAgent>;
  parentAgent: AgentNode | undefined;
}

function agentNamed(
  name: string,
  subAgents: Array<AgentNode | RemoteAgent>,
  parentAgent: AgentNode | undefined,
): AgentNode {
  return {name, subAgents, parentAgent};
}

function transferTool(): FunctionTool {
  return new FunctionTool({
    name: 'transfer_to_agent',
    description: 'Transfer.',
    execute: () => Promise.resolve({}),
  });
}

describe('formatContent', () => {
  it('returns None for missing or empty content', () => {
    expect(formatContent({content: undefined})).toEqual({
      text: 'None',
      isTruncated: false,
    });
    expect(formatContent({content: {parts: []}})).toEqual({
      text: 'None',
      isTruncated: false,
    });
  });

  it('formats text, and truncates with a marker', () => {
    expect(formatContent({content: {parts: [{text: 'Hello world'}]}})).toEqual({
      text: "text: 'Hello world'",
      isTruncated: false,
    });
    expect(
      formatContent({content: {parts: [{text: 'a'.repeat(20)}]}, maxLen: 5}),
    ).toEqual({
      text: "text: 'aaaaa...[TRUNCATED]'",
      isTruncated: true,
    });
  });

  it('formats function calls and responses by name', () => {
    const content: Content = {
      parts: [
        {functionCall: {name: 'foo', args: {}}},
        {functionResponse: {name: 'foo', response: {}}},
      ],
    };
    expect(formatContent({content})).toEqual({
      text: 'call: foo | resp: foo',
      isTruncated: false,
    });
  });

  it('formats code and execution results, with unknown for unspecified enums', () => {
    const content: Content = {
      parts: [
        {executableCode: {language: Language.PYTHON, code: "print('hi')"}},
        {codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: 'hi\n'}},
        {executableCode: {code: 'x = 1'}},
        {codeExecutionResult: {output: 'done'}},
      ],
    };
    expect(formatContent({content}).text).toBe(
      "Executable code (PYTHON): print('hi') | Code execution result (OUTCOME_OK): hi\n | " +
        'Executable code (unknown): x = 1 | Code execution result (unknown): done',
    );
  });

  it('redacts credentials in text, code and output', () => {
    const content: Content = {
      parts: [
        {text: 'api_key: secret-api-key-12345'},
        {
          executableCode: {
            language: Language.PYTHON,
            code: "headers = {'Authorization': 'Bearer super-secret-token'}",
          },
        },
        {
          codeExecutionResult: {
            outcome: Outcome.OUTCOME_OK,
            output:
              'Connecting with Authorization: Bearer response-token-xyz\n',
          },
        },
      ],
    };
    const {text, isTruncated} = formatContent({content});
    expect(text).not.toContain('super-secret-token');
    expect(text).not.toContain('response-token-xyz');
    expect(text).not.toContain('secret-api-key-12345');
    expect(text).toContain('Authorization: [REDACTED]');
    expect(isTruncated).toBe(true);
  });

  it('bounds code and output, and -1 disables the bound', () => {
    const content: Content = {
      parts: [
        {executableCode: {language: Language.PYTHON, code: 'a'.repeat(100)}},
        {
          codeExecutionResult: {
            outcome: Outcome.OUTCOME_OK,
            output: 'b'.repeat(100),
          },
        },
      ],
    };
    expect(formatContent({content, maxLen: 10})).toEqual({
      text: `Executable code (PYTHON): ${'a'.repeat(10)}...[TRUNCATED] | Code execution result (OUTCOME_OK): ${'b'.repeat(10)}...[TRUNCATED]`,
      isTruncated: true,
    });
    expect(formatContent({content, maxLen: -1})).toEqual({
      text: `Executable code (PYTHON): ${'a'.repeat(100)} | Code execution result (OUTCOME_OK): ${'b'.repeat(100)}`,
      isTruncated: false,
    });
  });

  it('renders unrecognised parts as other', () => {
    const content: Content = {
      parts: [
        {fileData: {fileUri: 'gs://bucket/file', mimeType: 'text/plain'}},
      ],
    };
    expect(formatContent({content})).toEqual({
      text: 'other',
      isTruncated: false,
    });
  });
});

describe('getToolOrigin', () => {
  it('classifies local, sub-agent, a2a, mcp and unknown tools', () => {
    const local = new FunctionTool({
      name: 'f',
      description: 'f',
      execute: () => Promise.resolve({}),
    });
    const subAgent = new AgentTool({
      agent: new LlmAgent({name: 'sub', model: 'gemini-2.5-flash'}),
    });
    const a2a = new AgentTool({
      agent: new LlmAgent({name: 'remote', model: 'gemini-2.5-flash'}),
    });
    Object.defineProperty(a2a, 'agent', {value: remoteAgent('remote')});
    // SAFETY: getToolOrigin classifies by class only; the prototype-only
    // instance is never run.
    const mcp = Object.create(MCPTool.prototype) as MCPTool;
    const unknown = new NamedTool('mystery', 'mystery', () => undefined);

    expect(getToolOrigin({tool: local})).toBe('LOCAL');
    expect(getToolOrigin({tool: subAgent})).toBe('SUB_AGENT');
    expect(getToolOrigin({tool: a2a})).toBe('A2A');
    expect(getToolOrigin({tool: mcp})).toBe('MCP');
    expect(getToolOrigin({tool: unknown})).toBe('UNKNOWN');
  });

  it('classifies every SkillToolset tool as SKILL', () => {
    const skillTools = [
      ListSkillsTool,
      LoadSkillResourceTool,
      LoadSkillTool,
      RunSkillInlineScriptTool,
      RunSkillScriptTool,
      SearchSkillsTool,
    ].map(
      // SAFETY: getToolOrigin classifies by class only; the prototype-only
      // instances are never run.
      (cls) => Object.create(cls.prototype) as BaseTool,
    );
    expect(skillTools.map((tool) => getToolOrigin({tool}))).toEqual(
      skillTools.map(() => 'SKILL'),
    );
  });

  it('classifies transfers per call against the agent tree', () => {
    const local = agentNamed('local_sub', [], undefined);
    const remote = remoteAgent('remote_a2a');
    const root = agentNamed('root', [remote, local], undefined);
    const context = {invocationContext: {agent: root}};

    expect(getToolOrigin({tool: transferTool()})).toBe('TRANSFER_AGENT');
    expect(
      getToolOrigin({
        tool: transferTool(),
        toolArgs: {agent_name: 'remote_a2a'},
        toolContext: context,
      }),
    ).toBe('TRANSFER_A2A');
    expect(
      getToolOrigin({
        tool: transferTool(),
        toolArgs: {agent_name: 'local_sub'},
        toolContext: context,
      }),
    ).toBe('TRANSFER_AGENT');
  });

  it('resolves an a2a peer through the parent agent', () => {
    const peer = remoteAgent('remote_peer');
    const parent = agentNamed('parent', [], undefined);
    const child = agentNamed('child', [], parent);
    parent.subAgents.push(child, peer);

    expect(
      getToolOrigin({
        tool: transferTool(),
        toolArgs: {agent_name: 'remote_peer'},
        toolContext: {invocationContext: {agent: child}},
      }),
    ).toBe('TRANSFER_A2A');
  });
});

describe('extractToolDeclarations', () => {
  it('logs the description and snake_case parameter schema, keeping property names', () => {
    const tool = new NamedTool(
      'execute_sql',
      'Run a SQL query against BigQuery.',
      () => ({
        name: 'execute_sql',
        parameters: {
          type: Type.OBJECT,
          properties: {queryText: {type: Type.STRING, maxLength: '10'}},
          required: ['queryText'],
          propertyOrdering: ['queryText'],
        },
      }),
    );
    expect(extractToolDeclarations({execute_sql: tool})).toEqual([
      {
        name: 'execute_sql',
        description: 'Run a SQL query against BigQuery.',
        parameters: {
          type: 'OBJECT',
          properties: {queryText: {type: 'STRING', max_length: '10'}},
          required: ['queryText'],
          property_ordering: ['queryText'],
        },
      },
    ]);
  });

  it('prefers parametersJsonSchema verbatim', () => {
    const schema = {
      type: 'object',
      properties: {filePath: {type: 'string'}},
      required: ['filePath'],
    };
    const tool = new NamedTool('read_file', 'Read.', () => ({
      name: 'read_file',
      description: 'Read a file.',
      parametersJsonSchema: schema,
    }));
    expect(extractToolDeclarations({read_file: tool})).toEqual([
      {name: 'read_file', description: 'Read.', parameters: schema},
    ]);
  });

  it('isolates a tool whose declaration throws, and falls back to the declaration description', () => {
    const raiser = new NamedTool('raiser', 'Raises.', () => {
      throw new Error('boom');
    });
    const undescribed = new NamedTool('ok', '', () => ({
      name: 'ok',
      description: 'From declaration.',
    }));
    expect(extractToolDeclarations({raiser, ok: undescribed})).toEqual([
      {name: 'raiser', description: 'Raises.'},
      {name: 'ok', description: 'From declaration.'},
    ]);
  });
});

describe('HybridContentParser offload decisions', () => {
  it('offloads multi-byte text over the 32KB byte limit', async () => {
    const offloader = new FakeOffloader();
    const text = '\u{1F600}'.repeat(10_000);
    const {parts} = await parser(-1, offloader).parse({parts: [{text}]});
    expect(offloader.upload).toHaveBeenCalledOnce();
    expect(parts[0]?.storage_mode).toBe('GCS_REFERENCE');
    expect(parts[0]?.text).toBe(`${'\u{1F600}'.repeat(200)}... [OFFLOADED]`);
  });

  it('keeps text inline when under both limits, counting characters as code points', async () => {
    const offloader = new FakeOffloader();
    const ascii = 'A'.repeat(1000);
    const ascii_ = await parser(50_000, offloader).parse({
      parts: [{text: ascii}],
    });
    const emoji = await parser(10_000, offloader).parse({
      parts: [{text: '\u{1F600}'.repeat(3000)}],
    });
    expect(offloader.upload).not.toHaveBeenCalled();
    expect(ascii_.parts[0]).toMatchObject({
      storage_mode: 'INLINE',
      text: ascii,
    });
    expect(emoji.parts[0]?.storage_mode).toBe('INLINE');
  });

  it('offloads text over the character limit', async () => {
    const offloader = new FakeOffloader();
    const {parts} = await parser(100, offloader).parse({
      parts: [{text: 'X'.repeat(200)}],
    });
    expect(offloader.upload).toHaveBeenCalledOnce();
    expect(parts[0]?.storage_mode).toBe('GCS_REFERENCE');
  });

  it('truncates inline without an offloader', async () => {
    const {parts, isTruncated} = await parser(50).parse({
      parts: [{text: 'Z'.repeat(200)}],
    });
    expect(isTruncated).toBe(true);
    expect(parts[0]?.storage_mode).toBe('INLINE');
    expect(parts[0]?.text).toBe(`${'Z'.repeat(50)}...[TRUNCATED]`);
  });

  it('falls back to inline truncation when the text upload fails', async () => {
    const offloader = new FakeOffloader();
    offloader.upload.mockRejectedValueOnce(new Error('denied'));
    const {parts, isTruncated} = await parser(10, offloader).parse({
      parts: [{text: 'Q'.repeat(20)}],
    });
    expect(parts[0]).toMatchObject({
      storage_mode: 'INLINE',
      text: `${'Q'.repeat(10)}...[TRUNCATED]`,
    });
    expect(isTruncated).toBe(true);
  });
});

describe('HybridContentParser media and paths', () => {
  it('uploads decoded bytes with an ObjectRef in snake_case', async () => {
    const offloader = new FakeOffloader();
    const p = new HybridContentParser({
      offloader,
      traceId: 't',
      spanId: 's',
      connectionId: 'us.conn',
    });
    const {parts} = await p.parse({
      parts: [inlinePart('png-bytes', 'image/png')],
    });
    expect(offloader.uploaded(0)).toMatchObject({
      data: Buffer.from('png-bytes'),
      contentType: 'image/png',
    });
    const uri = String(parts[0]?.uri);
    expect(parts[0]).toEqual({
      part_index: 0,
      mime_type: 'image/png',
      uri,
      text: '[MEDIA OFFLOADED]',
      part_attributes: '{}',
      storage_mode: 'GCS_REFERENCE',
      object_ref: {
        uri,
        version: null,
        authorizer: 'us.conn',
        details: '{"gcs_metadata": {"content_type": "image/png"}}',
      },
    });
  });

  it('records upload failure and binary data without an offloader', async () => {
    const offloader = new FakeOffloader();
    offloader.upload.mockRejectedValueOnce(new Error('denied'));
    const failed = await parser(100, offloader).parse({
      parts: [inlinePart('x', 'image/png')],
    });
    const noOffloader = await parser(100).parse({
      parts: [inlinePart('x', 'image/png')],
    });
    expect(failed.parts[0]?.text).toBe('[UPLOAD FAILED]');
    expect(noOffloader.parts[0]).toMatchObject({
      text: '[BINARY DATA]',
      storage_mode: 'INLINE',
      mime_type: 'text/plain',
    });
  });

  it('builds call-local, unique, full-uid object paths', async () => {
    const offloader = new FakeOffloader();
    const p = parser(20_000, offloader);
    await Promise.all([
      p.parse(twoInlineParts(), {traceId: 'trace-a', spanId: 'span-a'}),
      p.parse(twoInlineParts(), {traceId: 'trace-b', spanId: 'span-b'}),
      p.parse(
        llmRequest({
          contents: [
            {role: 'user', parts: [inlinePart('a', 'image/png')]},
            {role: 'user', parts: [inlinePart('b', 'image/png')]},
          ],
        }),
        {traceId: 'trace-x', spanId: 'span-x'},
      ),
    ]);
    const {paths} = offloader;
    expect(new Set(paths).size).toBe(6);
    expect(
      paths.filter((path) => path.includes('trace-a/span-a')),
    ).toHaveLength(2);
    expect(
      paths.filter((path) => path.includes('trace-x/span-x')),
    ).toHaveLength(2);
    const sample = paths.find((path) => path.includes('span-b_')) ?? '';
    expect(sample).toMatch(
      /^\d{4}-\d{2}-\d{2}\/trace-b\/span-b_[0-9a-f]{32}_c0_p[01]\.png$/,
    );
  });
});

describe('HybridContentParser structured parts', () => {
  it('writes snake_case attributes for file data and function calls', async () => {
    const {parts} = await parser(1000).parse({
      parts: [
        {
          fileData: {
            fileUri: 'gs://bucket/doc.pdf',
            mimeType: 'application/pdf',
          },
        },
        {functionCall: {name: 'lookup', args: {userId: 1}}},
      ],
    });
    expect(parts[0]).toMatchObject({
      storage_mode: 'EXTERNAL_URI',
      uri: 'gs://bucket/doc.pdf',
      mime_type: 'application/pdf',
    });
    expect(parts[1]).toMatchObject({
      mime_type: 'application/json',
      text: 'Function: lookup',
      part_attributes: '{"function_name": "lookup"}',
    });
  });

  it('dumps function responses with snake_case model keys and untouched user keys', async () => {
    const {payload, parts} = await parser(1000).parse({
      parts: [
        {
          functionResponse: {
            name: 'lookup',
            willContinue: false,
            response: {userId: 'u1'},
            parts: [{inlineData: {mimeType: 'text/plain', data: 'aGk='}}],
          },
        },
      ],
    });
    expect(payload).toEqual({text_summary: 'Function response: lookup'});
    expect(JSON.parse(String(parts[0]?.part_attributes))).toEqual({
      function_response: {
        name: 'lookup',
        will_continue: false,
        response: {userId: 'u1'},
        parts: [{inline_data: {mime_type: 'text/plain', data: 'aGk='}}],
      },
    });
  });

  it('keeps structured non-text parts complete and private', async () => {
    const secret = 'STRUCTURED-PART-SECRET';
    const {payload, parts, isTruncated} = await parser(1000).parse({
      parts: [
        {
          functionResponse: {
            name: 'lookup',
            response: {access_token: secret, ok: true},
          },
        },
        {
          executableCode: {
            language: Language.PYTHON,
            code: JSON.stringify({private_key: secret}),
          },
        },
        {
          codeExecutionResult: {
            outcome: Outcome.OUTCOME_OK,
            output: `Authorization: Bearer ${secret}`,
          },
        },
      ],
    });
    expect(JSON.stringify({payload, parts})).not.toContain(secret);
    expect(isTruncated).toBe(true);
    const summary = JSON.stringify(payload);
    expect(summary).toMatch(/^\{"text_summary":/);
    expect(summary).toContain('Function response: lookup');
    expect(summary).toContain('Executable code');
    expect(summary).toContain('Code execution result');
    expect(parts[1]?.part_attributes).toMatch(/^\{"executable_code": /);
    expect(parts[2]?.part_attributes).toMatch(/^\{"code_execution_result": /);
  });

  it('unpacks a list into parts and gives non-part members an empty entry', async () => {
    const list = await parser(50_000).parse(
      llmRequest({
        contents: [],
        config: {systemInstruction: [{text: 'hi'}, {text: 'there'}]},
      }),
    );
    expect(list.payload).toEqual({system_prompt: 'hi | there'});
    expect(list.parts.map((part) => part.text)).toEqual(['hi', 'there']);
  });
});

describe('HybridContentParser LlmRequest payloads', () => {
  it('writes prompt and system_prompt keys, and truncates a long string system prompt', async () => {
    const {payload, isTruncated} = await parser(50).parse(
      llmRequest({
        contents: [{parts: [{text: 'Hi'}]}],
        config: {systemInstruction: 'A'.repeat(200)},
      }),
    );
    expect(payload).toEqual({
      prompt: [{role: 'unknown', content: 'Hi'}],
      system_prompt: `${'A'.repeat(50)}...[TRUNCATED]`,
    });
    expect(isTruncated).toBe(true);
  });

  it('redacts raw prompt, role and system text', async () => {
    const secret = 'INLINE-CONTENT-SECRET';
    const {payload, parts} = await parser(-1).parse(
      llmRequest({
        contents: [
          {
            role: JSON.stringify({authorization: secret}),
            parts: [{text: JSON.stringify({secret})}],
          },
        ],
        config: {systemInstruction: JSON.stringify({private_key: secret})},
      }),
    );
    const stored = JSON.stringify({content: payload, content_parts: parts});
    expect(stored).not.toContain(secret);
    expect(stored.split('[REDACTED]').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('uploads only sanitized text to GCS', async () => {
    const offloader = new FakeOffloader();
    const secret = 'GCS-CONTENT-SECRET';
    const text = JSON.stringify({
      token: secret,
      padding: 'x'.repeat(33 * 1024),
    });
    const {payload, parts} = await parser(-1, offloader).parse({
      parts: [{text}],
    });
    const uploaded = String(offloader.uploaded(0)?.data);
    expect(uploaded).not.toContain(secret);
    expect(uploaded).toContain('[REDACTED]');
    expect(JSON.stringify({payload, parts})).not.toContain(secret);
  });
});

describe('HybridContentParser raw text', () => {
  it('preserves the formatter sentinel', async () => {
    const {payload} = await parser(20_000).parse(FORMATTER_FAILED_SENTINEL);
    expect(payload).toBe(FORMATTER_FAILED_SENTINEL);
  });

  it('preserves bracket prose inline and in GCS', async () => {
    for (const value of [
      '[INFO] ready',
      '[link](https://example.test)',
      '{not json}',
    ]) {
      const {payload, parts, isTruncated} = await parser(-1).parse({
        parts: [{text: value}],
      });
      expect(payload).toEqual({text_summary: value});
      expect(parts[0]?.text).toBe(value);
      expect(isTruncated).toBe(false);
    }
    const offloader = new FakeOffloader();
    const large = `[INFO] ${'safe prose '.repeat(4000)}`;
    await parser(-1, offloader).parse({parts: [{text: large}]});
    expect(offloader.uploaded(0)?.data).toBe(large);
  });

  it('fails closed on credential-bearing bracket text', async () => {
    const unsafe = [
      ['[WARN] Bearer\tBRACKET-BEARER-SECRET', 'BRACKET-BEARER-SECRET'],
      ['[WARN] sig=BRACKET-SIG-SECRET', 'BRACKET-SIG-SECRET'],
      ['{"access_token":"MALFORMED-SECRET"', 'MALFORMED-SECRET'],
    ] as const;
    for (const [value, secret] of unsafe) {
      const {payload, parts, isTruncated} = await parser(-1).parse({
        parts: [{text: value}],
      });
      const stored = JSON.stringify({payload, parts});
      expect(stored).not.toContain(secret);
      expect(stored).toContain('[UNPARSEABLE_JSON_BLOB]');
      expect(isTruncated).toBe(true);
    }
  });

  it('routes json values through the truncator and stringifies scalars', async () => {
    const [json, empty, scalar] = await Promise.all([
      parser(20_000).parse({a: 1}),
      parser(20_000).parse(null),
      parser(20_000).parse(true),
    ]);
    expect(json.payload).toEqual({a: 1});
    expect(empty.payload).toBeNull();
    expect(scalar.payload).toBe('True');
  });
});

describe('HybridContentParser external URIs', () => {
  interface UriResult {
    uri: string | null | undefined;
    isTruncated: boolean;
  }

  async function uriOf(fileUri: string | undefined): Promise<UriResult> {
    const {parts, isTruncated} = await parser(-1).parse({
      parts: [{fileData: {fileUri, mimeType: 'text/plain'}}],
    });
    return {uri: parts[0]?.uri, isTruncated};
  }

  it('redacts signed query values, fragments and userinfo', async () => {
    const signed = await uriOf(
      'https://storage.example.test/safe/path?safe=kept&X-Goog-Credential=URI-CREDENTIAL&X-Goog-Signature=URI-SIGNATURE#access-token=FRAGMENT-SECRET',
    );
    expect(String(signed.uri)).toMatch(
      /^https:\/\/storage\.example\.test\/safe\/path\?/,
    );
    expect(String(signed.uri)).toContain('safe=kept');
    for (const secret of [
      'URI-CREDENTIAL',
      'URI-SIGNATURE',
      'FRAGMENT-SECRET',
    ]) {
      expect(String(signed.uri)).not.toContain(secret);
    }
    expect(signed.isTruncated).toBe(true);
    expect(await uriOf('https://user:password@example.test/safe')).toEqual({
      uri: '[REDACTED_SENSITIVE_URI]',
      isTruncated: true,
    });
    expect(await uriOf(undefined)).toEqual({
      uri: '[REDACTED_SENSITIVE_URI]',
      isTruncated: true,
    });
  });

  it('redacts sensitive path segments and keeps safe URIs byte-identical', async () => {
    const redacted = await uriOf(
      'https://example.test/public/access-token/PATH-SECRET/report?x-amz-signature=QUERY-SIGNATURE-SECRET&access%255Ftoken%253DDOUBLE-QUERY-SECRET',
    );
    for (const secret of [
      'PATH-SECRET',
      'QUERY-SIGNATURE-SECRET',
      'DOUBLE-QUERY-SECRET',
    ]) {
      expect(String(redacted.uri)).not.toContain(secret);
    }
    expect(String(redacted.uri)).toContain(
      '/public/%5BREDACTED%5D/%5BREDACTED%5D/report',
    );
    const safe = 'https://example.test/design/signal/public/progress%25/report';
    expect(await uriOf(safe)).toEqual({uri: safe, isTruncated: false});
  });
});

describe('GcsOffloader', () => {
  it('uploads create-only and returns the gs:// URI', async () => {
    const save = vi.spyOn(File.prototype, 'save').mockResolvedValue();
    const offloader = new GcsOffloader({
      projectId: 'p',
      bucketName: 'my-bucket',
      storage: new Storage({projectId: 'p'}),
    });

    await expect(
      offloader.uploadContent({
        data: 'abc',
        contentType: 'text/plain',
        path: 'a/b.txt',
      }),
    ).resolves.toBe('gs://my-bucket/a/b.txt');
    expect(save.mock.contexts[0]).toMatchObject({name: 'a/b.txt'});
    expect(save).toHaveBeenCalledWith('abc', {
      contentType: 'text/plain',
      resumable: false,
      preconditionOpts: {ifGenerationMatch: 0},
    });
  });
});
