/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Language, Outcome, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {createEvent, Event} from '../../../src/events/event.js';
import {createEventActions} from '../../../src/events/event_actions.js';
import {
  buildAdvisorContents,
  ModelConsultContextConfig,
} from '../../../src/tools/model_consult/context.js';

function userEvent(text: string, invocationId = 'inv-1'): Event {
  return createEvent({
    invocationId,
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

function agentEvent(
  parts: Part[],
  options: {author?: string; invocationId?: string; partial?: boolean} = {},
): Event {
  return createEvent({
    invocationId: options.invocationId ?? 'inv-1',
    author: options.author ?? 'executor',
    partial: options.partial,
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

function texts(contents: Content[]): string[] {
  const out: string[] = [];
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (part.text) {
        out.push(part.text);
      }
    }
  }
  return out;
}

describe('context', () => {
  it('empty session yields no contents', () => {
    expect(buildAdvisorContents([])).toEqual([]);
  });

  it('user and agent text turns reach the advisor', () => {
    const events = [
      userEvent('Debug the flaky checkout test.'),
      agentEvent([{text: 'Running the test suite first.'}]),
    ];

    const contents = buildAdvisorContents(events);

    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
    expect(texts(contents)).toEqual([
      '[user] Debug the flaky checkout test.',
      '[agent:executor] Running the test suite first.',
    ]);
  });

  it('tool calls and results are rendered as readable text', () => {
    const events = [
      userEvent('Check the logs.'),
      agentEvent([
        {
          functionCall: {
            id: 'fc-1',
            name: 'query_logs',
            args: {service: 'checkout', limit: 10},
          },
        },
      ]),
      toolResultEvent('query_logs', {errors: 3, sample: 'timeout'}),
    ];

    const contents = buildAdvisorContents(events);

    expect(contents.map((c) => c.role)).toEqual(['user']);
    const rendered = texts(contents);
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toBe('[user] Check the logs.');
    expect(rendered[1]).toContain('[tool_call] query_logs(');
    expect(rendered[1]).toContain('service="checkout"');
    expect(rendered[1]).toContain('limit=10');
    expect(rendered[2]).toContain('[tool_result] query_logs ->');
    expect(rendered[2]).toContain('"errors": 3');
  });

  it('in-flight consult call is skipped so question is not sent twice', () => {
    const events = [
      userEvent('Start.'),
      agentEvent([
        {text: 'I am stuck on two options.'},
        {
          functionCall: {
            id: 'fc-consult-99',
            name: 'model_consult',
            args: {question: 'Option A or B?'},
          },
        },
      ]),
    ];

    const contents = buildAdvisorContents(events, {
      skipFunctionCallIds: ['fc-consult-99'],
    });

    const rendered = texts(contents);
    expect(rendered).toEqual([
      '[user] Start.',
      '[agent:executor] I am stuck on two options.',
    ]);
  });

  it('partial streaming chunks are ignored', () => {
    const events = [
      userEvent('Hello'),
      agentEvent([{text: 'stream chunk'}], {partial: true}),
      agentEvent([{text: 'final answer'}], {partial: false}),
    ];

    const contents = buildAdvisorContents(events);

    expect(texts(contents)).toEqual([
      '[user] Hello',
      '[agent:executor] final answer',
    ]);
  });

  it('thoughts are hidden by default', () => {
    const events = [
      agentEvent([
        {text: 'secret reasoning', thought: true},
        {text: 'visible reply'},
      ]),
    ];

    const contents = buildAdvisorContents(events);

    expect(texts(contents)).toEqual(['[agent:executor] visible reply']);
  });

  it('thoughts are included when configured', () => {
    const events = [
      agentEvent([
        {text: 'secret reasoning', thought: true},
        {text: 'visible reply'},
      ]),
    ];

    const contents = buildAdvisorContents(events, {
      config: new ModelConsultContextConfig({includeThoughts: true}),
    });

    expect(texts(contents)).toEqual([
      '[thought] secret reasoning',
      '[agent:executor] visible reply',
    ]);
  });

  it('rewound turns are excluded from the handover', () => {
    const events = [
      userEvent('keep me', 'inv-1'),
      userEvent('drop me', 'inv-2'),
      agentEvent([{text: 'also drop me'}], {invocationId: 'inv-2'}),
      createEvent({
        invocationId: 'inv-3',
        author: 'user',
        actions: createEventActions({rewindBeforeInvocationId: 'inv-2'}),
      }),
      userEvent('after rewind', 'inv-4'),
    ];

    const contents = buildAdvisorContents(events);

    expect(texts(contents)).toEqual(['[user] keep me', '[user] after rewind']);
  });

  it('maxEvents keeps only the most recent events', () => {
    const events = [
      userEvent('first'),
      userEvent('second'),
      userEvent('third'),
    ];

    const contents = buildAdvisorContents(events, {
      config: new ModelConsultContextConfig({maxEvents: 2}),
    });

    expect(texts(contents)).toEqual(['[user] second', '[user] third']);
  });

  it('oversized tool output is truncated with a notice', () => {
    const huge = 'x'.repeat(500);
    const events = [toolResultEvent('read_file', {body: huge})];

    const contents = buildAdvisorContents(events, {
      config: new ModelConsultContextConfig({maxPartChars: 80}),
    });

    const rendered = texts(contents)[0];
    expect(rendered).toContain('[tool_result] read_file ->');
    expect(rendered).toContain('chars truncated]');
    expect(rendered.length).toBeLessThan(200);
  });

  it('char budget preserves opening and recent turns when middle is dropped', () => {
    const events = [
      userEvent('Initial goal: fix latency without downtime.'),
      userEvent('Middle turn 1 ' + 'a'.repeat(120)),
      userEvent('Middle turn 2 ' + 'b'.repeat(120)),
      userEvent('Latest finding: connection pool is saturated.'),
    ];

    const contents = buildAdvisorContents(events, {
      config: new ModelConsultContextConfig({maxChars: 260}),
    });

    const rendered = texts(contents);
    expect(rendered[0]).toBe(
      '[user] Initial goal: fix latency without downtime.',
    );
    expect(
      rendered.some((t) =>
        t.includes('earlier turn(s) omitted to fit the context budget'),
      ),
    ).toBe(true);
    expect(rendered[rendered.length - 1]).toBe(
      '[user] Latest finding: connection pool is saturated.',
    );
  });

  it('char budget keeps newest turn even when it exceeds the budget alone', () => {
    const events = [
      userEvent('old context ' + 'a'.repeat(100)),
      userEvent('critical latest turn ' + 'b'.repeat(500)),
    ];

    const contents = buildAdvisorContents(events, {
      config: new ModelConsultContextConfig({maxChars: 200}),
    });

    const rendered = texts(contents);
    expect(
      rendered.some((t) => t.includes('[user] critical latest turn')),
    ).toBe(true);
    expect(rendered.some((t) => t.includes('chars truncated]'))).toBe(true);
  });

  it('tiny budget prioritizes newest turn over the omission marker', () => {
    const events = [
      userEvent('first turn ' + 'a'.repeat(100)),
      userEvent('latest turn ' + 'b'.repeat(100)),
    ];

    const contents = buildAdvisorContents(events, {
      config: new ModelConsultContextConfig({maxChars: 64}),
    });

    const rendered = texts(contents);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain('[user] latest turn');
  });

  it('oversized media turn is replaced when budget is tight', () => {
    const media: Part = {
      inlineData: {
        mimeType: 'image/png',
        data: Buffer.from('\x89PNG').toString('base64'),
      },
    };
    const filePart: Part = {
      fileData: {
        fileUri: 'gs://bucket/very_long_filename_for_budget_test.pdf',
      },
    };
    const events = [
      userEvent('earlier ' + 'a'.repeat(100)),
      agentEvent([{text: 'short'}, media, filePart, {text: 'x'.repeat(400)}]),
    ];

    const contents = buildAdvisorContents(events, {
      config: new ModelConsultContextConfig({
        maxChars: 120,
        includeMedia: true,
      }),
    });

    const rendered = texts(contents);
    expect(rendered.some((t) => t.includes('omitted for budget'))).toBe(true);
  });

  it('unusual event shapes do not crash context building', () => {
    const badArgs: Record<string, unknown> = {};
    badArgs['self'] = badArgs; // circular reference

    const events = [
      // Event with empty content.
      createEvent({author: 'executor', content: undefined}),
      // In-flight functionResponse skipped by ID + empty-args functionCall.
      agentEvent([
        {functionCall: {id: 'fc-empty', name: 'ping', args: {}}},
        {
          functionCall: {
            id: 'fc-bad-args',
            name: 'weird',
            args: badArgs,
          },
        },
        {
          functionResponse: {
            id: 'fc-skip-resp',
            name: 'model_consult',
            response: {status: 'ok'},
          },
        },
        {
          functionResponse: {
            id: 'fc-none-resp',
            name: 'noop',
            response: undefined as unknown as Record<string, unknown>,
          },
        },
        // Unrecognized Part with no fields set.
        {},
      ]),
    ];

    const contents = buildAdvisorContents(events, {
      skipFunctionCallIds: ['fc-skip-resp'],
    });

    const rendered = texts(contents);
    expect(rendered).toContain('[tool_call] ping()');
    expect(rendered.some((t) => t.includes('[tool_call] weird('))).toBe(true);
    expect(rendered).toContain('[tool_result] noop -> null');
    expect(rendered.every((t) => !t.includes('model_consult'))).toBe(true);
  });

  it('media parts reach the advisor by default', () => {
    const media: Part = {
      inlineData: {
        mimeType: 'image/png',
        data: Buffer.from('\x89PNG fake').toString('base64'),
      },
    };

    const contents = buildAdvisorContents([agentEvent([media])]);

    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts?.[0].inlineData).toBeDefined();
  });

  it('media parts are described in text for text-only advisors', () => {
    const media: Part = {
      inlineData: {
        mimeType: 'image/png',
        data: Buffer.from('\x89PNG fake').toString('base64'),
      },
    };

    const contents = buildAdvisorContents([agentEvent([media])], {
      config: new ModelConsultContextConfig({includeMedia: false}),
    });

    expect(texts(contents)).toEqual(['[media omitted: image/png]']);
  });

  it('code parts are rendered as text', () => {
    const events = [
      agentEvent([
        {
          executableCode: {
            code: 'print(1)',
            language: Language.PYTHON,
          },
        },
        {
          codeExecutionResult: {
            outcome: Outcome.OUTCOME_OK,
            output: '1',
          },
        },
      ]),
    ];

    const contents = buildAdvisorContents(events);

    expect(texts(contents)).toEqual(['[code]\nprint(1)', '[code_result] 1']);
  });

  it('whitespace-only text is dropped', () => {
    const events = [agentEvent([{text: '   \n  '}])];

    const contents = buildAdvisorContents(events);

    expect(contents).toEqual([]);
  });

  it('session can be withheld entirely', () => {
    const events = [userEvent('secret internal transcript')];

    const contents = buildAdvisorContents(events, {
      config: new ModelConsultContextConfig({includeSession: false}),
    });

    expect(contents).toEqual([]);
  });

  it('file parts reach the advisor by default', () => {
    const filePart: Part = {
      fileData: {
        fileUri: 'gs://bucket/spec.pdf',
        mimeType: 'application/pdf',
      },
    };

    const contents = buildAdvisorContents([agentEvent([filePart])]);

    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts?.[0].fileData?.fileUri).toBe(
      'gs://bucket/spec.pdf',
    );
  });

  it('file parts are described in text for text-only advisors', () => {
    const filePart: Part = {
      fileData: {
        fileUri: 'gs://bucket/spec.pdf',
        mimeType: 'application/pdf',
      },
    };

    const contents = buildAdvisorContents([agentEvent([filePart])], {
      config: new ModelConsultContextConfig({includeMedia: false}),
    });

    expect(texts(contents)).toEqual(['[file omitted: gs://bucket/spec.pdf]']);
  });

  it('config rejects unknown fields', () => {
    expect(
      () =>
        new ModelConsultContextConfig({
          max_char: 100,
        } as unknown as Record<string, unknown>),
    ).toThrow(/Unknown ModelConsultContextConfig field/);
  });

  it.each([
    'maxEvents',
    'maxChars',
    'maxPartChars',
    'max_events',
    'max_chars',
    'max_part_chars',
  ])('config rejects degenerate cap for %s', (field) => {
    expect(
      () =>
        new ModelConsultContextConfig({
          [field]: 0,
        }),
    ).toThrow(/must be an integer >= 1/);
  });
});
