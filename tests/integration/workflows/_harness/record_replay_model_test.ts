/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the replay matching in {@link record_replay_model}, in particular that
 * a fixture survives a system-instruction change instead of every sample
 * failing at once — and that nothing weaker than that slips through with it.
 */

import type {BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {BaseLlm, LLMRegistry} from '@google/adk';
import {randomUUID} from 'node:crypto';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  drainRecordedCalls,
  fingerprint,
  installRecordReplay,
  instructionAgnosticFingerprint,
  RecordedCall,
  restoreRecordReplay,
} from './record_replay_model.js';

function request(
  text: string,
  systemInstruction: string,
  tools?: string[],
): LlmRequest {
  return {
    model: 'gemini-2.5-flash',
    contents: [{role: 'user', parts: [{text}]}],
    config: {
      systemInstruction,
      ...(tools
        ? {tools: [{functionDeclarations: tools.map((name) => ({name}))}]}
        : {}),
    },
    // The harness only reads `contents` and `config`; the rest of LlmRequest is
    // irrelevant to fingerprinting.
  } as unknown as LlmRequest;
}

function response(answer: string) {
  return {candidates: [{content: {role: 'model', parts: [{text: answer}]}}]};
}

/** A fixture entry as a record run writes it: both keys, config stored. */
function recorded(req: LlmRequest, answer: string): RecordedCall {
  return {
    key: fingerprint(req),
    instructionAgnosticKey: instructionAgnosticFingerprint(req),
    request: {contents: req.contents, config: req.config},
    response: response(answer),
  };
}

/** Stands in for the live Gemini backend during a record run. */
class StubBackend extends BaseLlm {
  constructor(private readonly answer: string) {
    super({model: 'gemini-2.5-flash'});
  }

  override async *generateContentAsync(
    _llmRequest?: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    yield {content: {role: 'model', parts: [{text: this.answer}]}};
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}

/** Reads a sample's fixture off disk, as `runSample` does. */
function load(file: string): RecordedCall[] {
  return JSON.parse(readFileSync(file, 'utf8')) as RecordedCall[];
}

/** Replays (or records) one request through the installed harness model. */
async function replay(req: LlmRequest): Promise<string | undefined> {
  const model = LLMRegistry.newLlm('gemini-2.5-flash');
  for await (const resp of model.generateContentAsync(req)) {
    return resp.content?.parts?.[0]?.text;
  }
  return undefined;
}

/**
 * Records `reqs` against a stub backend and returns the fixture as a replay run
 * would read it — through the same JSON round trip `runSample` writes and loads.
 */
async function record(
  answer: string,
  ...reqs: LlmRequest[]
): Promise<RecordedCall[]> {
  installRecordReplay({
    mode: 'record',
    liveBackend: () => new StubBackend(answer),
  });
  for (const req of reqs) {
    await replay(req);
  }
  return JSON.parse(JSON.stringify(drainRecordedCalls())) as RecordedCall[];
}

describe('record/replay matching', () => {
  afterEach(() => {
    restoreRecordReplay();
    vi.restoreAllMocks();
  });

  it('replays on an exact request match', async () => {
    const req = request('classify: what is ADK?', 'You are a classifier.');
    installRecordReplay({
      mode: 'replay',
      recordedCalls: [recorded(req, 'doc')],
    });

    expect(await replay(req)).toBe('doc');
  });

  it('still replays when only the system instruction changed', async () => {
    // What #616 did to every fixture: same conversation, different preamble.
    const asRecorded = request('classify: what is ADK?', 'You are classify.');
    const afterPromptChange = request(
      'classify: what is ADK?',
      'You are classify. (preamble dropped)',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installRecordReplay({
      mode: 'replay',
      recordedCalls: [recorded(asRecorded, 'doc')],
    });

    expect(await replay(afterPromptChange)).toBe('doc');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('Stale fixture');
  });

  it('warns once per stale request, not once per call', async () => {
    const asRecorded = request('same question', 'old instruction');
    const afterPromptChange = request('same question', 'new instruction');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installRecordReplay({
      mode: 'replay',
      recordedCalls: [recorded(asRecorded, 'a')],
    });

    await replay(afterPromptChange);
    await replay(afterPromptChange);

    expect(warn).toHaveBeenCalledOnce();
  });

  it('flags the ambiguity when a stale match has several candidates', async () => {
    // Two agents, same conversation, different instructions: the fallback
    // cannot tell them apart, so it must say so.
    const first = request('shared prompt', 'instruction A');
    const second = request('shared prompt', 'instruction B');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installRecordReplay({
      mode: 'replay',
      recordedCalls: [recorded(first, 'A'), recorded(second, 'B')],
    });

    expect(await replay(request('shared prompt', 'instruction C'))).toBe('A');
    expect(warn.mock.calls[0][0]).toContain('recording order');
  });

  it('throws, loudly, when neither key matches', async () => {
    const req = request('recorded question', 'instruction');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    installRecordReplay({mode: 'replay', recordedCalls: [recorded(req, 'a')]});

    await expect(
      replay(request('a question never recorded', 'instruction')),
    ).rejects.toThrow(/No recorded model response/);
    expect(error).toHaveBeenCalled();
  });

  it('tells apart two agents that share contents while prompts are unchanged', async () => {
    const first = request('shared prompt', 'instruction A');
    const second = request('shared prompt', 'instruction B');
    installRecordReplay({
      mode: 'replay',
      recordedCalls: [recorded(first, 'A'), recorded(second, 'B')],
    });

    // Exact keys still hit, so contents collisions resolve correctly and in any
    // order — the property the fallback gives up and warns about.
    expect(await replay(second)).toBe('B');
    expect(await replay(first)).toBe('A');
  });

  it('does not let a dropped tool pass as a prompt change', async () => {
    // The fallback absorbs an edited instruction and nothing else: the rest of
    // the config, tools included, still has to match.
    const req = request('use a tool', 'instruction', ['lookup']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    installRecordReplay({mode: 'replay', recordedCalls: [recorded(req, 'ok')]});

    expect(
      await replay(request('use a tool', 'new instruction', ['lookup'])),
    ).toBe('ok');
    expect(warn).toHaveBeenCalledOnce();
    await expect(replay(request('use a tool', 'instruction'))).rejects.toThrow(
      /No recorded model response/,
    );
    expect(error).toHaveBeenCalled();
  });

  it('ignores the caller abort signal, which is a handle and not a request', async () => {
    // It serializes to `{}`, so it discriminates nothing; a fixture that keyed
    // on it would still match, but would carry a dead field forever.
    const withSignal = (): LlmRequest =>
      ({
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'question'}]}],
        config: {
          systemInstruction: 'instruction',
          abortSignal: new AbortController().signal,
        },
      }) as unknown as LlmRequest;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installRecordReplay({
      mode: 'replay',
      recordedCalls: [recorded(withSignal(), 'answer')],
    });

    expect(await replay(withSignal())).toBe('answer');
    expect(warn).not.toHaveBeenCalled();
  });

  describe('record mode', () => {
    it('writes keys that a later replay matches exactly', async () => {
      // The keys are computed once at record time and again at load time, from
      // a JSON round trip of the request. If those two ever disagreed, every
      // new fixture would quietly serve from a fallback and CI would stay green.
      const req = request('record me', 'You are a recorder.', ['lookup']);
      const fixture = await record('live answer', req);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      installRecordReplay({mode: 'replay', recordedCalls: fixture});

      expect(await replay(req)).toBe('live answer');
      expect(warn).not.toHaveBeenCalled();
    });

    it('stores the config the keys were taken over, minus the abort signal', async () => {
      // The stored request is what a later fingerprint change re-derives keys
      // from, so it has to be the normalized one, not the raw call.
      const req = request('record me', 'You are a recorder.', ['lookup']);
      (req.config as Record<string, unknown>)['abortSignal'] =
        new AbortController().signal;
      const [call] = await record('live answer', req);

      expect(call.request.config).toEqual({
        systemInstruction: 'You are a recorder.',
        tools: [{functionDeclarations: [{name: 'lookup'}]}],
      });
      expect(call.key).toBe(fingerprint(req));
      expect(call.instructionAgnosticKey).toBe(
        instructionAgnosticFingerprint(req),
      );
    });

    it('snapshots the request before the backend can edit it', async () => {
      // `Gemini.preprocessRequest` clears `config.labels` on the Gemini API
      // path, i.e. after the keys are computed. Storing the request as the
      // backend left it would make it disagree with its own keys.
      const req = request('record me', 'You are a recorder.');
      (req.config as Record<string, unknown>)['labels'] = {
        adk_agent_name: 'recorder',
      };
      installRecordReplay({
        mode: 'record',
        liveBackend: () =>
          new (class extends StubBackend {
            override async *generateContentAsync(
              llmRequest: LlmRequest,
            ): AsyncGenerator<LlmResponse, void> {
              (llmRequest.config as Record<string, unknown>)['labels'] =
                undefined;
              yield* super.generateContentAsync();
            }
          })('live answer'),
      });
      await replay(req);
      const [call] = drainRecordedCalls();

      expect(
        (call.request.config as Record<string, unknown>)['labels'],
      ).toEqual({adk_agent_name: 'recorder'});
      expect(fingerprint(call.request as unknown as LlmRequest)).toBe(call.key);
    });

    it('writes a fallback key that survives a prompt change', async () => {
      const req = request('record me', 'You are a recorder.', ['lookup']);
      const fixture = await record('live answer', req);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      installRecordReplay({mode: 'replay', recordedCalls: fixture});

      expect(
        await replay(
          request('record me', 'You are a recorder v2.', ['lookup']),
        ),
      ).toBe('live answer');
      expect(warn.mock.calls[0][0]).toContain('Stale fixture');
    });

    it('normalizes an id the sample printed into its prompt', async () => {
      // A HITL sample interpolates state built from a function response, so the
      // id the framework generated for it lands in the instruction. Keyed on,
      // the exact match would be lost on every run — and a re-record could not
      // win it back, since recording generates a fresh id too.
      const withId = (id: string) =>
        request('revise it', `The reviewer said: {"id":"${id}"}`);
      const fixture = await record('live answer', withId(randomUUID()));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      installRecordReplay({mode: 'replay', recordedCalls: fixture});

      expect(await replay(withId(randomUUID()))).toBe('live answer');
      expect(warn).not.toHaveBeenCalled();
    });

    it('normalizes volatile function-call ids the same way on both sides', async () => {
      // Ids are generated per run, so a recorded key only matches a replayed
      // one because both sides scrub them.
      const withId = (id: string): LlmRequest =>
        ({
          model: 'gemini-2.5-flash',
          contents: [
            {
              role: 'model',
              parts: [{functionCall: {id, name: 'lookup', args: {q: 'adk'}}}],
            },
          ],
          config: {systemInstruction: 'You are a caller.'},
        }) as unknown as LlmRequest;
      const fixture = await record('live answer', withId('call-1'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      installRecordReplay({mode: 'replay', recordedCalls: fixture});

      expect(await replay(withId('call-2'))).toBe('live answer');
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('replay across the scenarios that share a fixture', () => {
  afterEach(() => {
    restoreRecordReplay();
    vi.restoreAllMocks();
  });

  /** Two scenarios recording the same request, in the order they ran. */
  const twoScenarios = (req: LlmRequest) => [
    recorded(req, 'scenario 1 draft'),
    recorded(req, 'scenario 2 draft'),
  ];

  it('serves a repeated request in recording order, one scenario after another', async () => {
    // A scenario is its own `runSample`, so this only holds if the read
    // position survives the reinstall between them. When it does not, both
    // scenarios draft "scenario 1 draft", and a later call whose conversation
    // quotes the draft — the revise turn of a HITL sample — matches nothing.
    const req = request('phone broke', 'You are a drafter.');
    const fixture = twoScenarios(req);

    installRecordReplay({
      mode: 'replay',
      recordedCalls: fixture,
      fixtureId: '/samples/drafter/model_responses.json',
    });
    expect(await replay(req)).toBe('scenario 1 draft');
    restoreRecordReplay();

    installRecordReplay({
      mode: 'replay',
      recordedCalls: fixture,
      fixtureId: '/samples/drafter/model_responses.json',
    });
    expect(await replay(req)).toBe('scenario 2 draft');
  });

  it('keeps each sample on its own read position', async () => {
    const req = request('phone broke', 'You are a drafter.');
    const fixture = twoScenarios(req);

    installRecordReplay({
      mode: 'replay',
      recordedCalls: fixture,
      fixtureId: '/samples/first/model_responses.json',
    });
    expect(await replay(req)).toBe('scenario 1 draft');
    restoreRecordReplay();

    installRecordReplay({
      mode: 'replay',
      recordedCalls: fixture,
      fixtureId: '/samples/second/model_responses.json',
    });
    expect(await replay(req)).toBe('scenario 1 draft');
  });
});

describe('the checked-in fixtures', () => {
  const samples = path.join(import.meta.dirname, '..');
  const fixtures = readdirSync(samples, {withFileTypes: true})
    .filter((e) => e.isDirectory())
    .map((e) => path.join(samples, e.name, 'model_responses.json'))
    .filter((f) => existsSync(f))
    .sort();

  it('are all present and in the current format', () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const file of fixtures) {
      for (const call of load(file)) {
        expect(Object.keys(call).sort()).toEqual([
          'instructionAgnosticKey',
          'key',
          'request',
          'response',
        ]);
      }
    }
  });

  const named: Array<[string, string]> = fixtures.map((f) => [
    path.basename(path.dirname(f)),
    f,
  ]);
  it.each(named)(
    'stores in %s the exact request its keys were taken over',
    (_name, file) => {
      // The promise the stored request makes: a future fingerprint change can
      // re-derive keys from it offline, no live model needed. That only holds
      // while it round-trips to the keys already written beside it.
      for (const call of load(file)) {
        const req = call.request as unknown as LlmRequest;
        expect(fingerprint(req)).toBe(call.key);
        expect(instructionAgnosticFingerprint(req)).toBe(
          call.instructionAgnosticKey,
        );
      }
    },
  );
});
