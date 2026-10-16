/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  GenerateContentConfig,
  Part,
  ThinkingLevel,
} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

import {Context} from '../../../src/agents/context.js';
import {
  InvocationContext,
  InvocationContextParams,
} from '../../../src/agents/invocation_context.js';
import {
  InstructionProvider,
  LlmAgent,
  ToolUnion,
} from '../../../src/agents/llm_agent.js';
import {
  ModelConsultContextConfig as TopLevelContextConfig,
  ModelConsultTool as TopLevelModelConsultTool,
} from '../../../src/common.js';
import {createEvent, Event} from '../../../src/events/event.js';
import {
  createEventActions,
  mergeEventActions,
} from '../../../src/events/event_actions.js';
import {BaseLlm} from '../../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../../src/models/base_llm_connection.js';
import {
  appendInstructions,
  LlmRequest,
} from '../../../src/models/llm_request.js';
import {LlmResponse} from '../../../src/models/llm_response.js';
import {PluginManager} from '../../../src/plugins/plugin_manager.js';
import {InMemorySessionService} from '../../../src/sessions/in_memory_session_service.js';
import {createSession, Session} from '../../../src/sessions/session.js';
import {State} from '../../../src/sessions/state.js';
import {FunctionTool} from '../../../src/tools/function_tool.js';
import * as modelConsultPkg from '../../../src/tools/model_consult/index.js';
import {
  ModelConsultContextConfig,
  ModelConsultTool,
  ModelConsultToolOptions,
} from '../../../src/tools/model_consult/index.js';
import {
  ADVISOR_SYSTEM_INSTRUCTION,
  DEFAULT_ADVISOR_MODEL,
  DEFAULT_TOOL_NAME,
  EXECUTOR_INSTRUCTION,
  TOOL_DESCRIPTION,
} from '../../../src/tools/model_consult/prompts.js';
import {ToolContext} from '../../../src/tools/tool_context.js';

function textResponse(
  text = '1. Diagnosis. 2. Plan. 3. Watch out.',
  options: {
    thought?: string;
    promptTokens?: number;
    outputTokens?: number;
    thoughtsTokens?: number;
    modelVersion?: string;
  } = {},
): LlmResponse {
  const {
    thought,
    promptTokens = 1000,
    outputTokens = 120,
    thoughtsTokens = 50,
    modelVersion = 'fake-advisor-001',
  } = options;
  const parts: Part[] = [];
  if (thought !== undefined) {
    parts.push({text: thought, thought: true});
  }
  parts.push({text});
  return {
    modelVersion,
    content: {role: 'model', parts},
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: outputTokens,
      thoughtsTokenCount: thoughtsTokens,
      totalTokenCount: promptTokens + outputTokens + thoughtsTokens,
    },
  };
}

class FakeAdvisorLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  private readonly responses: LlmResponse[];
  private readonly errors: Array<Error | null>;
  private readonly delaySeconds: number;
  private readonly perCallDelays: number[];
  private callIndex = 0;

  constructor(
    options: {
      model?: string;
      responses?: LlmResponse[];
      errors?: Array<Error | null>;
      delaySeconds?: number;
      perCallDelays?: number[];
    } = {},
  ) {
    super({model: options.model ?? 'fake-advisor'});
    this.responses = options.responses ?? [textResponse()];
    this.errors = options.errors ?? [];
    this.delaySeconds = options.delaySeconds ?? 0;
    this.perCallDelays = options.perCallDelays ?? [];
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(llmRequest);
    const idx = this.callIndex;
    this.callIndex += 1;
    const delay =
      idx < this.perCallDelays.length
        ? this.perCallDelays[idx]
        : this.delaySeconds;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
    if (idx < this.errors.length && this.errors[idx] !== null) {
      throw this.errors[idx]!;
    }
    const resp =
      idx < this.responses.length
        ? this.responses[idx]
        : this.responses[this.responses.length - 1];
    yield resp;
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
}

function userEvent(text: string, invocationId = 'inv-1'): Event {
  return createEvent({
    invocationId,
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

function agentEvent(
  parts: Part[],
  options: {author?: string; invocationId?: string} = {},
): Event {
  return createEvent({
    invocationId: options.invocationId ?? 'inv-1',
    author: options.author ?? 'executor',
    content: {role: 'model', parts},
  });
}

function toolResultEvent(
  name: string,
  response: Record<string, unknown>,
  options: {callId?: string; invocationId?: string} = {},
): Event {
  return createEvent({
    invocationId: options.invocationId ?? 'inv-1',
    author: 'executor',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: options.callId ?? 'fc-1',
            name,
            response,
          },
        },
      ],
    },
  });
}

function makeToolContext(
  events?: Event[],
  options: {
    instruction?: string | InstructionProvider;
    staticInstruction?: unknown;
    tools?: ToolUnion[];
    session?: Session;
    invocationId?: string;
    functionCallId?: string;
  } = {},
): ToolContext {
  const agent = new LlmAgent({
    name: 'executor',
    model: 'gemini-2.5-flash',
    instruction:
      options.instruction ?? 'Investigate production issues carefully.',
    tools: options.tools ?? [],
  });
  if (options.staticInstruction !== undefined) {
    (agent as unknown as {staticInstruction?: unknown}).staticInstruction =
      options.staticInstruction;
  }

  let session = options.session;
  if (!session) {
    session = createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: 'user-1',
      state: {},
      events: [...(events ?? [])],
    });
  } else if (events !== undefined) {
    session.events = [...events];
  }

  const invocationContext = new InvocationContext({
    sessionService: new InMemorySessionService(),
    invocationId:
      options.invocationId !== undefined ? options.invocationId : 'inv-1',
    agent,
    session,
    pluginManager: new PluginManager(),
  });

  return new Context({
    invocationContext,
    functionCallId:
      options.functionCallId !== undefined
        ? options.functionCallId
        : 'fc-consult',
  });
}

async function runConsult(
  tool: ModelConsultTool,
  toolContext: ToolContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return tool.runAsync({args, toolContext});
}

function extractTexts(contents: Content[]): string[] {
  const texts: string[] = [];
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (part.text) {
        texts.push(part.text);
      }
    }
  }
  return texts;
}

describe('ModelConsultTool', () => {
  it('verifies public exports and prompt constants', () => {
    expect(TopLevelModelConsultTool).toBe(ModelConsultTool);
    expect(TopLevelContextConfig).toBe(ModelConsultContextConfig);
    expect(Object.keys(modelConsultPkg).sort()).toEqual([
      'ModelConsultContextConfig',
      'ModelConsultTool',
    ]);
    for (const privateName of [
      'ADVISOR_SYSTEM_INSTRUCTION',
      'DEFAULT_ADVISOR_MODEL',
      'DEFAULT_TOOL_NAME',
      'EXECUTOR_INSTRUCTION',
      'TOOL_DESCRIPTION',
    ]) {
      expect(privateName in modelConsultPkg).toBe(false);
    }
    expect(DEFAULT_TOOL_NAME).toBe('model_consult');
    expect(DEFAULT_ADVISOR_MODEL).toBe('gemini-3.1-pro-preview');
    expect(TOOL_DESCRIPTION.toLowerCase()).toContain('advisor');
    expect(EXECUTOR_INSTRUCTION).toContain('`model_consult`');
    expect(ADVISOR_SYSTEM_INSTRUCTION).toContain('senior technical advisor');
  });

  it('verifies function declaration schema and required question field', () => {
    const tool = new ModelConsultTool({model: new FakeAdvisorLlm()});

    const decl = tool._getDeclaration();

    expect(decl.name).toBe('model_consult');
    expect(decl.parameters).toBeDefined();
    expect(decl.parameters?.required).toEqual(['question']);
    expect(Object.keys(decl.parameters?.properties ?? {}).sort()).toEqual([
      'context',
      'question',
    ]);
    expect((decl.description ?? '').toLowerCase()).toContain('stuck');
  });

  it('allows overriding name and description', () => {
    const tool = new ModelConsultTool({
      model: new FakeAdvisorLlm(),
      name: 'consult_expert',
      description: 'Custom escalation description.',
    });

    expect(tool.name).toBe('consult_expert');
    expect(tool._getDeclaration().description).toBe(
      'Custom escalation description.',
    );
  });

  it('processLlmRequest appends EXECUTOR_INSTRUCTION once without duplicates', async () => {
    const tool = new ModelConsultTool({model: new FakeAdvisorLlm()});
    const ctx = makeToolContext([userEvent('go')]);
    const llmRequest: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };
    appendInstructions(llmRequest, ['You are an SRE assistant.']);

    await tool.processLlmRequest({toolContext: ctx, llmRequest});
    await tool.processLlmRequest({toolContext: ctx, llmRequest});

    expect('model_consult' in llmRequest.toolsDict).toBe(true);
    const sysInst = String(llmRequest.config?.systemInstruction ?? '');
    expect(sysInst.split(EXECUTOR_INSTRUCTION).length - 1).toBe(1);

    const renamedTool = new ModelConsultTool({
      model: new FakeAdvisorLlm(),
      name: 'consult_sre',
    });
    const renamedRequest: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };
    await renamedTool.processLlmRequest({
      toolContext: ctx,
      llmRequest: renamedRequest,
    });
    const renamedInst = String(renamedRequest.config?.systemInstruction ?? '');
    expect(renamedInst).toContain('`consult_sre`');
    expect(renamedInst).not.toContain('`model_consult`');

    const customTool = new ModelConsultTool({
      model: new FakeAdvisorLlm(),
      executorInstruction: 'Custom escalation rule.',
    });
    const customRequest: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };
    await customTool.processLlmRequest({
      toolContext: ctx,
      llmRequest: customRequest,
    });
    expect(customRequest.config?.systemInstruction).toBe(
      'Custom escalation rule.',
    );

    const disabledTool = new ModelConsultTool({
      model: new FakeAdvisorLlm(),
      executorInstruction: '',
    });
    const disabledRequest: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };
    await disabledTool.processLlmRequest({
      toolContext: ctx,
      llmRequest: disabledRequest,
    });
    expect(disabledRequest.config?.systemInstruction ?? '').toBe('');
  });

  it('returns guidance, usage, and budget accounting', async () => {
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({
      model: llm,
      maxUses: 2,
      sessionMaxUses: 5,
    });
    const ctx = makeToolContext([userEvent('Why is checkout slow?')]);

    const result = await runConsult(tool, ctx, {
      question: 'Should I bisect deploys or profile CPU?',
    });

    expect(result.status).toBe('ok');
    expect(result.guidance).toBe('1. Diagnosis. 2. Plan. 3. Watch out.');
    expect(result.advisor_model).toBe('fake-advisor-001');
    expect(result.thinking_level).toBe('high');
    expect(result.consults).toEqual({
      used_this_turn: 1,
      max_uses: 2,
      used_this_session: 1,
      session_max_uses: 5,
      remaining: 1,
    });
    const usage = result.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBe(1000);
    expect(usage.thoughts_tokens).toBe(50);
    expect(Number(result.latency_ms)).toBeGreaterThanOrEqual(0);
  });

  it('advisor sees session tool calls, tool results, and handoff', async () => {
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({model: llm});
    const ctx = makeToolContext([
      userEvent('Investigate the paging alert.'),
      agentEvent([
        {
          functionCall: {
            id: 'fc-1',
            name: 'query_logs',
            args: {service: 'checkout'},
          },
        },
      ]),
      toolResultEvent('query_logs', {errors: 42}),
    ]);

    await runConsult(tool, ctx, {
      question: 'Which subsystem should I inspect next?',
      context: 'p99 latency is flat across regions',
    });

    const request = llm.requests[0];
    const texts = extractTexts(request.contents);
    expect(texts).toContain('[user] Investigate the paging alert.');
    expect(texts.some((t) => t.includes('[tool_call] query_logs'))).toBe(true);
    expect(
      texts.some((t) =>
        t.includes('[tool_result] query_logs -> {"errors": 42}'),
      ),
    ).toBe(true);

    const lastContent = request.contents[request.contents.length - 1];
    const parts = lastContent.parts ?? [];
    const handoff = parts[parts.length - 1]?.text ?? '';
    expect(handoff.startsWith('--- END OF EXECUTOR SESSION ---')).toBe(true);
    expect(lastContent.role).toBe('user');
    expect(handoff).toContain(' (executor)');
    expect(handoff).toContain('Which subsystem should I inspect next?');
    expect(handoff).toContain('p99 latency is flat across regions');
  });

  it('advisor request always sends a single user Content', async () => {
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({model: llm});
    const ctx = makeToolContext([
      userEvent('first'),
      agentEvent([{text: 'reply'}]),
      toolResultEvent('query_logs', {errors: 1}),
    ]);

    await runConsult(tool, ctx, {question: 'Next?'});

    expect(llm.requests[0].contents).toHaveLength(1);
    expect(llm.requests[0].contents[0].role).toBe('user');
  });

  it('executor instruction is forwarded to advisor without escalation instruction', async () => {
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({
      model: llm,
      includeAgentInstruction: true,
    });
    const ctx = makeToolContext([userEvent('go')], {
      instruction: `Never restart production databases.\n\n${EXECUTOR_INSTRUCTION}`,
    });

    await runConsult(tool, ctx, {question: 'Can I restart the DB?'});

    expect(llm.requests[0].config?.systemInstruction).toBe(
      ADVISOR_SYSTEM_INSTRUCTION,
    );
    const texts = extractTexts(llm.requests[0].contents);
    expect(
      texts.some(
        (t) =>
          t.includes('--- EXECUTOR AGENT INSTRUCTION (executor) ---') &&
          t.includes('Never restart production databases.'),
      ),
    ).toBe(true);
    expect(texts.every((t) => !t.includes(EXECUTOR_INSTRUCTION))).toBe(true);
  });

  it('executor instruction is withheld when disabled', async () => {
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({
      model: llm,
      includeAgentInstruction: false,
    });
    const ctx = makeToolContext([userEvent('go')], {
      instruction: 'Never restart production databases.',
    });

    await runConsult(tool, ctx, {question: 'Can I restart the DB?'});

    expect(llm.requests[0].config?.systemInstruction).toBe(
      ADVISOR_SYSTEM_INSTRUCTION,
    );
    const texts = extractTexts(llm.requests[0].contents);
    expect(
      texts.every((t) => !t.includes('Never restart production databases.')),
    ).toBe(true);
    expect(texts.every((t) => !t.includes('EXECUTOR AGENT INSTRUCTION'))).toBe(
      true,
    );
  });

  it('executor instruction injects state and staticInstruction', async () => {
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({model: llm});
    const session = createSession({
      id: 'session-1',
      appName: 'app',
      userId: 'user-1',
      state: {target_env: 'prod-eu-west'},
      events: [userEvent('go')],
    });
    const ctx = makeToolContext(undefined, {
      session,
      instruction: 'Only inspect cluster {target_env}.',
      staticInstruction: {
        role: 'user',
        parts: [{text: 'Global policy: read-only mode.'}],
      },
    });

    await runConsult(tool, ctx, {question: 'Which cluster?'});

    const prompt1 = extractTexts(llm.requests[0].contents).join('\n');
    expect(prompt1).toContain('Global policy: read-only mode.');
    expect(prompt1).toContain('Only inspect cluster prod-eu-west.');

    // Verify string staticInstruction and fallback when an unset {placeholder}
    // coexists with a populated {target_env} state key.
    const ctxFallback = makeToolContext(undefined, {
      session,
      instruction: 'Cluster {target_env} with {unset_var}.',
      staticInstruction: 'String static instruction.',
      invocationId: 'inv-2',
    });
    await runConsult(tool, ctxFallback, {question: 'Fallback check?'});
    const prompt2 = extractTexts(llm.requests[1].contents).join('\n');
    expect(prompt2).toContain('String static instruction.');
    expect(prompt2).toContain('Cluster prod-eu-west with {unset_var}.');

    // Verify callable instruction provider (bypass state injection).
    const ctxProvider = makeToolContext(undefined, {
      session,
      instruction: () => 'Callable provider {target_env} literal.',
      invocationId: 'inv-3',
    });
    await runConsult(tool, ctxProvider, {question: 'Provider check?'});
    const prompt3 = extractTexts(llm.requests[2].contents).join('\n');
    expect(prompt3).toContain('Callable provider {target_env} literal.');

    // Verify Part and list forms of staticInstruction.
    const ctxPart = makeToolContext(undefined, {
      session,
      instruction: 'Dynamic instruction.',
      staticInstruction: {text: 'Part static instruction.'},
      invocationId: 'inv-4',
    });
    await runConsult(tool, ctxPart, {question: 'Part static check?'});
    const prompt4 = extractTexts(llm.requests[3].contents).join('\n');
    expect(prompt4).toContain('Part static instruction.');

    const ctxList = makeToolContext(undefined, {
      session,
      instruction: 'Dynamic instruction.',
      staticInstruction: [
        'List static part 1.',
        {text: 'List static part 2.'},
        {text: 'Dict static part 3.'},
        {inlineData: {data: 'aW1n', mimeType: 'image/png'}},
      ],
      invocationId: 'inv-5',
    });
    await runConsult(tool, ctxList, {question: 'List static check?'});
    const prompt5 = extractTexts(llm.requests[4].contents).join('\n');
    expect(prompt5).toContain(
      'List static part 1.\nList static part 2.\nDict static part 3.',
    );
  });

  it('pending model_consult call is not duplicated while completed stay', async () => {
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({model: llm});
    const ctx = makeToolContext(
      [
        userEvent('go'),
        createEvent({
          author: 'executor',
          content: {role: 'model', parts: []},
        }),
        agentEvent([
          {
            functionCall: {
              id: 'fc-answered',
              name: 'model_consult',
              args: {question: 'Earlier question?'},
            },
          },
        ]),
        createEvent({
          author: 'executor',
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'fc-answered',
                  name: 'model_consult',
                  response: {guidance: 'Check connection pool.'},
                },
              },
            ],
          },
        }),
        agentEvent([
          {
            functionCall: {
              id: 'fc-current',
              name: 'model_consult',
              args: {question: 'What now?'},
            },
          },
          {
            functionCall: {
              id: 'fc-sibling-parallel',
              name: 'model_consult',
              args: {question: 'Parallel question?'},
            },
          },
        ]),
      ],
      {functionCallId: 'fc-current'},
    );

    await runConsult(tool, ctx, {question: 'What now?'});

    const texts = extractTexts(llm.requests[0].contents);
    expect(texts.some((t) => t.includes('Earlier question?'))).toBe(true);
    expect(texts.some((t) => t.includes('Check connection pool.'))).toBe(true);
    expect(texts.every((t) => !t.includes('Parallel question?'))).toBe(true);
    expect(
      texts.every(
        (t) =>
          !(t.includes('[tool_call] model_consult') && t.includes('What now?')),
      ),
    ).toBe(true);
  });

  it('single user Content orders all sections in canonical order', async () => {
    const queryLogs = new FunctionTool({
      name: 'query_logs',
      description: 'Queries service logs.',
      execute: async (args: unknown) => ({service: String(args)}),
    });

    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({model: llm});
    const ctx = makeToolContext(
      [userEvent('go'), agentEvent([{text: 'checking logs'}])],
      {
        instruction: 'Follow production safety rules.',
        tools: [queryLogs, tool],
      },
    );

    await runConsult(tool, ctx, {question: 'Next?'});

    const contents = llm.requests[0].contents;
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
    const partTexts = (contents[0].parts ?? []).map((p) => p.text ?? '');
    expect(partTexts).toHaveLength(5);
    expect(
      partTexts[0].startsWith('--- EXECUTOR AGENT INSTRUCTION (executor)'),
    ).toBe(true);
    expect(partTexts[0]).toContain('Follow production safety rules.');
    expect(
      partTexts[1].startsWith('--- TOOLS AVAILABLE TO THE EXECUTOR ---'),
    ).toBe(true);
    expect(partTexts[1]).toContain('- query_logs: Queries service logs.');
    expect(partTexts[2]).toBe('[user] go');
    expect(partTexts[3]).toBe('[agent:executor] checking logs');
    expect(partTexts[4].startsWith('--- END OF EXECUTOR SESSION ---')).toBe(
      true,
    );
  });

  it.each([
    ['minimal', ThinkingLevel.MINIMAL, 'minimal'],
    ['low', ThinkingLevel.LOW, 'low'],
    ['medium', ThinkingLevel.MEDIUM, 'medium'],
    ['high', ThinkingLevel.HIGH, 'high'],
    [ThinkingLevel.HIGH, ThinkingLevel.HIGH, 'high'],
  ] as const)(
    'thinkingLevel=%s populates ThinkingConfig',
    async (level, expectedEnum, expectedName) => {
      const llm = new FakeAdvisorLlm();
      const tool = new ModelConsultTool({model: llm, thinkingLevel: level});
      const ctx = makeToolContext([userEvent('go')]);

      const result = await runConsult(tool, ctx, {question: 'Next?'});

      expect(llm.requests[0].config?.thinkingConfig?.thinkingLevel).toBe(
        expectedEnum,
      );
      expect(result.thinking_level).toBe(expectedName);
    },
  );

  it('thinkingLevel=null omits ThinkingConfig from advisor request', async () => {
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({model: llm, thinkingLevel: null});
    const ctx = makeToolContext([userEvent('go')]);

    const result = await runConsult(tool, ctx, {question: 'Next?'});

    expect(llm.requests[0].config?.thinkingConfig).toBeUndefined();
    expect(result.thinking_level).toBeNull();
  });

  it.each([
    [{thinkingLevel: 'turbo'}, /thinking_level/],
    [{maxUses: 0}, /max_uses/],
    [{maxUses: -1}, /max_uses/],
    [{sessionMaxUses: 0}, /session_max_uses/],
    [{sessionMaxUses: -2}, /session_max_uses/],
    [{maxOutputTokens: 0}, /max_output_tokens/],
    [
      {generateContentConfig: {maxOutputTokens: 0}},
      /generate_content_config\.max_output_tokens/,
    ],
    [
      {
        maxOutputTokens: 2048,
        generateContentConfig: {maxOutputTokens: 512},
      },
      /Conflicting max_output_tokens/,
    ],
    [{timeoutSeconds: 0}, /timeout_seconds/],
    [{model: '   '}, /non-empty model string/],
  ] as Array<[ModelConsultToolOptions, RegExp]>)(
    'rejects invalid init arguments at construction (%o)',
    (kwargs, errorMatch) => {
      const initArgs: ModelConsultToolOptions = {
        model: new FakeAdvisorLlm(),
        ...kwargs,
      };
      expect(() => new ModelConsultTool(initArgs)).toThrow(errorMatch);
    },
  );

  it('resolves model string through LLMRegistry', () => {
    const prevKey = process.env['GEMINI_API_KEY'];
    process.env['GEMINI_API_KEY'] = 'test-api-key';
    try {
      const tool = new ModelConsultTool({model: 'gemini-3.1-pro-preview'});

      expect(tool.advisorModel.model).toBe('gemini-3.1-pro-preview');
      expect(tool.advisorModel.constructor.name).toBe('Gemini');
    } finally {
      if (prevKey === undefined) {
        delete process.env['GEMINI_API_KEY'];
      } else {
        process.env['GEMINI_API_KEY'] = prevKey;
      }
    }
  });

  it('multiple tool instances have independent budgets', async () => {
    const llm = new FakeAdvisorLlm();
    const archTool = new ModelConsultTool({
      model: llm,
      name: 'consult_arch',
      maxUses: 1,
      sessionMaxUses: 1,
    });
    const secTool = new ModelConsultTool({
      model: llm,
      name: 'consult_sec',
      maxUses: 1,
      sessionMaxUses: 1,
    });
    const session = createSession({
      id: 'session-1',
      appName: 'app',
      userId: 'user-1',
      state: {},
      events: [],
    });
    const ctx = makeToolContext([userEvent('review design')], {
      session,
      invocationId: 'inv-1',
    });

    const rArch1 = await runConsult(archTool, ctx, {
      question: 'Check architecture',
    });
    const rArch2 = await runConsult(archTool, ctx, {
      question: 'Check architecture again',
    });
    const rSec1 = await runConsult(secTool, ctx, {
      question: 'Check security',
    });

    expect(rArch1.status).toBe('ok');
    expect(rArch2.status).toBe('limit_reached');
    expect(rSec1.status).toBe('ok');
  });

  it('generateContentConfig does not mutate caller input and maxOutputTokens syncs', async () => {
    const llm = new FakeAdvisorLlm();
    const callerCfg: GenerateContentConfig = {temperature: 0.2};
    const tool = new ModelConsultTool({
      model: llm,
      maxOutputTokens: 2048,
      generateContentConfig: callerCfg,
    });
    const ctx = makeToolContext([userEvent('go')]);

    await runConsult(tool, ctx, {question: 'Next?'});

    const sentCfg = llm.requests[0].config;
    expect(sentCfg?.temperature).toBe(0.2);
    expect(sentCfg?.maxOutputTokens).toBe(2048);
    expect(tool.maxOutputTokens).toBe(2048);
    expect(callerCfg.maxOutputTokens).toBeUndefined();
    expect(sentCfg?.systemInstruction).toBeTruthy();

    const cfgWithTokens: GenerateContentConfig = {
      temperature: 0.3,
      maxOutputTokens: 512,
    };
    const toolFromCfg = new ModelConsultTool({
      model: llm,
      generateContentConfig: cfgWithTokens,
    });
    expect(toolFromCfg.maxOutputTokens).toBe(512);
    await runConsult(toolFromCfg, ctx, {question: 'Second?'});
    expect(llm.requests[1].config?.maxOutputTokens).toBe(512);
  });

  it('maxUses enforced per turn and resets on next turn', async () => {
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({model: llm, maxUses: 1});
    const session = createSession({
      id: 'session-1',
      appName: 'app',
      userId: 'user-1',
      state: {},
      events: [],
    });

    const turn1 = makeToolContext([userEvent('turn 1')], {
      session,
      invocationId: 'inv-1',
    });
    expect(tool.hasRemainingBudget(turn1)).toBe(true);
    const first = await runConsult(tool, turn1, {question: 'q1'});
    expect(tool.hasRemainingBudget(turn1)).toBe(false);
    const second = await runConsult(tool, turn1, {question: 'q2'});

    expect(first.status).toBe('ok');
    expect(second.status).toBe('limit_reached');
    expect(String(second.message)).toContain(
      'for this turn is exhausted (1 of 1 used)',
    );
    expect(second.consults).toEqual({
      used_this_turn: 1,
      max_uses: 1,
      used_this_session: 1,
      session_max_uses: null,
      remaining: 0,
    });
    expect(llm.requests).toHaveLength(1);

    const turn2 = makeToolContext([userEvent('turn 2')], {
      session,
      invocationId: 'inv-2',
    });
    expect(tool.hasRemainingBudget(turn2)).toBe(true);
    const third = await runConsult(tool, turn2, {question: 'q3'});
    expect(third.status).toBe('ok');
    expect((third.consults as Record<string, unknown>).used_this_turn).toBe(1);
    expect((third.consults as Record<string, unknown>).used_this_session).toBe(
      2,
    );
    expect(llm.requests).toHaveLength(2);
  });

  it('sessionMaxUses enforced across turns', async () => {
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({
      model: llm,
      maxUses: 2,
      sessionMaxUses: 2,
    });
    const session = createSession({
      id: 'session-1',
      appName: 'app',
      userId: 'user-1',
      state: {},
      events: [],
    });

    const turn1 = makeToolContext([userEvent('turn 1')], {
      session,
      invocationId: 'inv-1',
    });
    const r1 = await runConsult(tool, turn1, {question: 'q1'});
    expect(r1.status).toBe('ok');
    expect((r1.consults as Record<string, unknown>).remaining).toBe(1);

    const turn2 = makeToolContext([userEvent('turn 2')], {
      session,
      invocationId: 'inv-2',
    });
    const r2 = await runConsult(tool, turn2, {question: 'q2'});
    expect(r2.status).toBe('ok');
    expect((r2.consults as Record<string, unknown>).remaining).toBe(0);

    const turn3 = makeToolContext([userEvent('turn 3')], {
      session,
      invocationId: 'inv-3',
    });
    expect(tool.hasRemainingBudget(turn3)).toBe(false);
    const r3 = await runConsult(tool, turn3, {question: 'q3'});
    expect(r3.status).toBe('limit_reached');
    expect(String(r3.message)).toContain(
      'for this session is exhausted (2 of 2 used)',
    );
    expect(r3.consults).toEqual({
      used_this_turn: 0,
      max_uses: 2,
      used_this_session: 2,
      session_max_uses: 2,
      remaining: 0,
    });
    expect(llm.requests).toHaveLength(2);
    expect(session.state['model_consult:model_consult:session_uses']).toBe(2);
  });

  it('sessionMaxUses without turn cap and standalone token cap', async () => {
    const llm = new FakeAdvisorLlm({
      responses: [textResponse('ok', {modelVersion: ''})],
    });
    const tool = new ModelConsultTool({
      model: llm,
      maxUses: null,
      sessionMaxUses: 2,
      maxOutputTokens: 1024,
    });
    const ctx = makeToolContext([userEvent('turn 1')]);

    const r1 = await runConsult(tool, ctx, {question: 'q1'});

    expect(r1.status).toBe('ok');
    expect(r1.advisor_model).toBe('fake-advisor');
    expect(llm.requests[0].config?.maxOutputTokens).toBe(1024);
    expect(r1.consults).toEqual({
      used_this_turn: 1,
      max_uses: null,
      used_this_session: 1,
      session_max_uses: 2,
      remaining: 1,
    });
  });

  it('parallel consult calls respect caps and preserve deltas', async () => {
    // 1) Turn cap saturation only (maxUses=1, sessionMaxUses=5).
    const llmTurnCap = new FakeAdvisorLlm({delaySeconds: 0.02});
    const toolTurnCap = new ModelConsultTool({
      model: llmTurnCap,
      maxUses: 1,
      sessionMaxUses: 5,
    });
    const sessionTurn = createSession({
      id: 's-turn',
      appName: 'app',
      userId: 'u1',
      state: {},
      events: [],
    });
    const ctxTurnA = makeToolContext([userEvent('go')], {
      session: sessionTurn,
      invocationId: 'inv-turn',
      functionCallId: 'fc-a',
    });
    const ctxTurnB = makeToolContext([userEvent('go')], {
      session: sessionTurn,
      invocationId: 'inv-turn',
      functionCallId: 'fc-b',
    });
    const [resTa, resTb] = await Promise.all([
      runConsult(toolTurnCap, ctxTurnA, {question: 'q1'}),
      runConsult(toolTurnCap, ctxTurnB, {question: 'q2'}),
    ]);
    expect([resTa.status, resTb.status].sort()).toEqual([
      'limit_reached',
      'ok',
    ]);
    expect(llmTurnCap.requests).toHaveLength(1);

    // 2) Session cap saturation only (maxUses=5, sessionMaxUses=1).
    const llmSessCap = new FakeAdvisorLlm({delaySeconds: 0.02});
    const toolSessCap = new ModelConsultTool({
      model: llmSessCap,
      maxUses: 5,
      sessionMaxUses: 1,
    });
    const sessionSess = createSession({
      id: 's-sess',
      appName: 'app',
      userId: 'u1',
      state: {},
      events: [],
    });
    const ctxSessA = makeToolContext([userEvent('go')], {
      session: sessionSess,
      invocationId: 'inv-sess',
      functionCallId: 'fc-sa',
    });
    const ctxSessB = makeToolContext([userEvent('go')], {
      session: sessionSess,
      invocationId: 'inv-sess',
      functionCallId: 'fc-sb',
    });
    const [resSa, resSb] = await Promise.all([
      runConsult(toolSessCap, ctxSessA, {question: 'q1'}),
      runConsult(toolSessCap, ctxSessB, {question: 'q2'}),
    ]);
    expect([resSa.status, resSb.status].sort()).toEqual([
      'limit_reached',
      'ok',
    ]);
    expect(llmSessCap.requests).toHaveLength(1);

    // 3) maxUses=5 where Call 1 takes longer than Call 2 so Call 2 finishes
    // first, and verify merged actions preserve count=2.
    const llmCap5 = new FakeAdvisorLlm({
      perCallDelays: [0.03, 0.005, 0.03, 0.005],
    });
    const toolCap5 = new ModelConsultTool({
      model: llmCap5,
      maxUses: 5,
      sessionMaxUses: 5,
    });
    const sessionService = new InMemorySessionService();
    const sessionCap5 = await sessionService.createSession({
      appName: 'app',
      userId: 'u1',
      sessionId: 's5',
    });
    const invCtx = new InvocationContext({
      sessionService,
      invocationId: 'inv-5',
      agent: new LlmAgent({name: 'executor', model: 'gemini-2.5-flash'}),
      session: sessionCap5,
      pluginManager: new PluginManager(),
    } as InvocationContextParams);
    const ctx5_1 = new Context({
      invocationContext: invCtx,
      functionCallId: 'fc-1',
      eventActions: createEventActions(),
    });
    const ctx5_2 = new Context({
      invocationContext: invCtx,
      functionCallId: 'fc-2',
      eventActions: createEventActions(),
    });

    const [r5_1, r5_2] = await Promise.all([
      runConsult(toolCap5, ctx5_1, {question: 'q1'}),
      runConsult(toolCap5, ctx5_2, {question: 'q2'}),
    ]);
    const mergedActions = mergeEventActions([ctx5_1.actions, ctx5_2.actions]);
    const mergedEvent = createEvent({
      invocationId: 'inv-5',
      author: 'executor',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {name: 'model_consult', response: r5_1}},
          {functionResponse: {name: 'model_consult', response: r5_2}},
        ],
      },
      actions: mergedActions,
    });
    await sessionService.appendEvent({
      session: sessionCap5,
      event: mergedEvent,
    });
    expect(sessionCap5.state['model_consult:model_consult:session_uses']).toBe(
      2,
    );

    // Verify two sequential consults in the same invocation do not mutate the
    // already-emitted first event's stateDelta (invDeltas is pruned when
    // activeCalls drops to 0).
    const sessionSeq = await sessionService.createSession({
      appName: 'app',
      userId: 'u1',
    });
    const ctxSeq1 = makeToolContext([userEvent('seq')], {
      session: sessionSeq,
      invocationId: 'inv-seq',
      functionCallId: 'fc-seq-1',
    });
    const ctxSeq2 = makeToolContext([userEvent('seq')], {
      session: sessionSeq,
      invocationId: 'inv-seq',
      functionCallId: 'fc-seq-2',
    });
    await runConsult(toolCap5, ctxSeq1, {question: 'seq-1'});
    expect(
      ctxSeq1.actions.stateDelta[
        'temp:model_consult:model_consult:inv-seq:uses'
      ],
    ).toBe(1);
    await runConsult(toolCap5, ctxSeq2, {question: 'seq-2'});
    expect(
      ctxSeq1.actions.stateDelta[
        'temp:model_consult:model_consult:inv-seq:uses'
      ],
    ).toBe(1);
    expect(
      ctxSeq2.actions.stateDelta[
        'temp:model_consult:model_consult:inv-seq:uses'
      ],
    ).toBe(2);
  });

  it('sessionMaxUses persists with strict state schema', async () => {
    const strictSchema = z.object({allowed_field: z.string().default('ok')});
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({model: llm, sessionMaxUses: 1});
    const session = createSession({
      id: 'session-strict',
      appName: 'app',
      userId: 'u1',
      state: {},
      events: [],
    });
    const ctx1 = makeToolContext([userEvent('t1')], {
      session,
      invocationId: 'inv-1',
    });
    (ctx1 as unknown as {currentState: State}).currentState = new State(
      session.state,
      ctx1.actions.stateDelta,
      strictSchema,
    );

    const r1 = await runConsult(tool, ctx1, {question: 'q1'});
    expect(r1.status).toBe('ok');
    expect(session.state['model_consult:model_consult:session_uses']).toBe(1);
    expect(
      ctx1.actions.stateDelta['model_consult:model_consult:session_uses'],
    ).toBe(1);

    const ctx2 = makeToolContext([userEvent('t2')], {
      session,
      invocationId: 'inv-2',
    });
    (ctx2 as unknown as {currentState: State}).currentState = new State(
      session.state,
      ctx2.actions.stateDelta,
      strictSchema,
    );
    const r2 = await runConsult(tool, ctx2, {question: 'q2'});
    expect(r2.status).toBe('limit_reached');
    expect(llm.requests).toHaveLength(1);
  });

  it('missing or blank question rejected without calling advisor', async () => {
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({model: llm});
    const ctx = makeToolContext([userEvent('go')]);

    const resultBlank = await runConsult(tool, ctx, {question: '   '});
    const resultMissing = await tool.runAsync({args: {}, toolContext: ctx});

    expect(resultBlank.status).toBe('invalid_request');
    expect(resultMissing.status).toBe('invalid_request');
    expect(llm.requests).toEqual([]);
  });

  it('advisor failure degrades gracefully without burning budget', async () => {
    const failingLlm = new FakeAdvisorLlm({
      errors: [new Error('503 backend unavailable')],
    });
    const tool = new ModelConsultTool({
      model: failingLlm,
      maxUses: 1,
      sessionMaxUses: 1,
    });
    const ctx = makeToolContext([userEvent('go')]);

    const result = await runConsult(tool, ctx, {question: 'Next?'});

    expect(result.status).toBe('error');
    expect(String(result.error)).toContain('503');
    expect(String(result.message)).toContain('own best judgment');
    const consults = result.consults as Record<string, unknown>;
    expect(consults.used_this_turn).toBe(0);
    expect(consults.used_this_session).toBe(0);
    expect(consults.remaining).toBe(1);
  });

  it('advisor timeout degrades gracefully without burning budget', async () => {
    const slowLlm = new FakeAdvisorLlm({delaySeconds: 0.2});
    const timeoutTool = new ModelConsultTool({
      model: slowLlm,
      maxUses: 1,
      sessionMaxUses: 1,
      timeoutSeconds: 0.01,
    });
    const ctx = makeToolContext([userEvent('go')]);

    const timeoutResult = await runConsult(timeoutTool, ctx, {
      question: 'Next?',
    });

    expect(timeoutResult.status).toBe('error');
    expect(String(timeoutResult.error)).toContain('timed out');
    const consults = timeoutResult.consults as Record<string, unknown>;
    expect(consults.used_this_turn).toBe(0);
    expect(consults.remaining).toBe(1);
  });

  it('thinkingConfig rejection falls back and still answers', async () => {
    const llm = new FakeAdvisorLlm({
      responses: [textResponse('fallback advice')],
      errors: [
        new Error('thinking_level is not supported by this model'),
        null,
      ],
    });
    const tool = new ModelConsultTool({model: llm, thinkingLevel: 'high'});
    const ctx = makeToolContext([userEvent('go')]);

    const result = await runConsult(tool, ctx, {question: 'Next?'});

    expect(result.status).toBe('ok');
    expect(result.guidance).toBe('fallback advice');
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0].config?.thinkingConfig).toBeDefined();
    expect(llm.requests[1].config?.thinkingConfig).toBeUndefined();
  });

  it('advisor receives executor tool inventory and caches canonicalTools', async () => {
    const listDeploys = new FunctionTool({
      name: 'list_deploys',
      description: 'Lists recent deploys for a service.',
      execute: async (args: unknown) => ({service: String(args)}),
    });
    const verboseTool = new FunctionTool({
      name: 'verbose_tool',
      description: 'A'.repeat(350),
      execute: async (args: unknown) => String(args),
    });
    const noDocTool = new FunctionTool({
      name: 'no_doc_tool',
      description: '',
      execute: async (args: unknown) => String(args),
    });

    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({
      model: llm,
      advisorInstruction: 'Custom advisor system prompt.',
      maxUses: 2,
    });
    const ctx = makeToolContext([userEvent('go')], {
      tools: [listDeploys, verboseTool, noDocTool, tool],
    });
    expect(ctx.invocationContext.canonicalToolsCache).toBeUndefined();

    await runConsult(tool, ctx, {question: 'What next?'});

    expect(ctx.invocationContext.canonicalToolsCache).toBeDefined();
    const system = llm.requests[0].config?.systemInstruction;
    expect(system).toBe('Custom advisor system prompt.');
    const prompt1 = extractTexts(llm.requests[0].contents).join('\n');
    expect(prompt1).toContain('TOOLS AVAILABLE TO THE EXECUTOR');
    const inventorySection = prompt1.split(
      'TOOLS AVAILABLE TO THE EXECUTOR',
    )[1];
    expect(inventorySection).toContain(
      '- list_deploys: Lists recent deploys for a service.',
    );
    expect(inventorySection).toContain(`- verbose_tool: ${'A'.repeat(300)}...`);
    expect(inventorySection).toContain('- no_doc_tool');
    expect(inventorySection).not.toContain('- no_doc_tool:');
    expect(inventorySection).not.toContain('model_consult');

    // Second call within the same invocation reuses canonicalToolsCache
    // without calling agent.canonicalTools again.
    (
      ctx.invocationContext.agent as unknown as {
        canonicalTools: () => Promise<never>;
      }
    ).canonicalTools = async () => {
      throw new Error('canonicalTools should not be re-resolved');
    };
    await runConsult(tool, ctx, {question: 'Second check?'});
    const prompt2 = extractTexts(llm.requests[1].contents).join('\n');
    expect(prompt2).toContain(
      '- list_deploys: Lists recent deploys for a service.',
    );
  });

  it('tool inventory is withheld when disabled', async () => {
    const listDeploys = new FunctionTool({
      name: 'list_deploys',
      description: 'Lists recent deploys for a service.',
      execute: async (args: unknown) => ({service: String(args)}),
    });
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({
      model: llm,
      includeToolInventory: false,
    });
    const ctx = makeToolContext([userEvent('go')], {
      tools: [listDeploys, tool],
    });

    await runConsult(tool, ctx, {question: 'What next?'});

    expect(llm.requests[0].config?.systemInstruction).toBe(
      ADVISOR_SYSTEM_INSTRUCTION,
    );
    const prompt = extractTexts(llm.requests[0].contents).join('\n');
    expect(prompt).not.toContain('TOOLS AVAILABLE TO THE EXECUTOR');
  });

  it('corrupt state and broken agent callbacks degrade gracefully', async () => {
    const llm = new FakeAdvisorLlm();
    const tool = new ModelConsultTool({model: llm, maxUses: 3});
    const ctx = makeToolContext([userEvent('go')], {
      instruction: 'Executor rule.',
      invocationId: '',
    });
    ctx.state.set(tool._turnUsesStateKey(ctx), -5);
    ctx.state.set(tool._sessionUsesStateKey(), 'not-an-int');
    (ctx.invocationContext.agent as unknown as {name: unknown}).name = 123;

    const res0 = await runConsult(tool, ctx, {
      question: 'Non-str agent name check?',
    });
    expect(res0.status).toBe('ok');
    expect(extractTexts(llm.requests[0].contents).join('\n')).toContain(
      '(the executor)',
    );
    expect(tool._turnUsesStateKey(ctx).endsWith(':unknown:uses')).toBe(true);

    (ctx.invocationContext.agent as unknown as {name: string}).name = 'unknown';
    ctx.invocationContext.canonicalToolsCache = undefined;
    (
      ctx.invocationContext.agent as unknown as {
        canonicalInstruction: () => Promise<never>;
        canonicalTools: () => Promise<never>;
      }
    ).canonicalInstruction = async () => {
      throw new Error('instruction callback boom');
    };
    (
      ctx.invocationContext.agent as unknown as {
        canonicalTools: () => Promise<never>;
      }
    ).canonicalTools = async () => {
      throw new Error('tools callback boom');
    };

    const res = await runConsult(tool, ctx, {
      question: 12345,
      context: 67890,
    });

    expect(res.status).toBe('ok');
    const consults = res.consults as Record<string, unknown>;
    expect(consults.used_this_turn).toBe(2);
    expect(consults.used_this_session).toBe(2);
    const lastContent =
      llm.requests[1].contents[llm.requests[1].contents.length - 1];
    const parts = lastContent.parts ?? [];
    const handoffText = parts[parts.length - 1]?.text ?? '';
    expect(handoffText).not.toContain('(unknown)');
    expect(handoffText).toContain('12345');
    expect(handoffText).toContain('67890');

    // Verify non-callable instruction/tools attributes and failing state write.
    ctx.invocationContext.canonicalToolsCache = undefined;
    (
      ctx.invocationContext.agent as unknown as {
        canonicalInstruction: unknown;
        canonicalTools: unknown;
      }
    ).canonicalInstruction = 42;
    (
      ctx.invocationContext.agent as unknown as {
        canonicalTools: unknown;
      }
    ).canonicalTools = 42;
    (ctx as unknown as {currentState: unknown}).currentState = {
      get: () => 2,
      set: () => {
        throw new Error('storage write failure');
      },
    };
    const res2 = await runConsult(tool, ctx, {question: 'Still works?'});
    expect(res2.status).toBe('ok');
  });
});
