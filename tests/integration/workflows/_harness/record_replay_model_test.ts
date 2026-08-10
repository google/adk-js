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
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  contentsFingerprint,
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

/** A fixture entry in the current format: both keys, config stored. */
function recorded(req: LlmRequest, answer: string): RecordedCall {
  return {
    key: fingerprint(req),
    instructionAgnosticKey: instructionAgnosticFingerprint(req),
    request: {contents: req.contents, config: req.config},
    response: response(answer),
  };
}

/**
 * A fixture entry as recorded before the config was fingerprinted: no
 * `instructionAgnosticKey`, and only the system instruction kept of the config.
 */
function legacyRecorded(req: LlmRequest, answer: string): RecordedCall {
  return {
    key: fingerprint(req),
    contentsKey: contentsFingerprint(req.contents),
    request: {
      contents: req.contents,
      systemInstruction: req.config?.systemInstruction,
    },
    response: response(answer),
  };
}

/** Stands in for the live Gemini backend during a record run. */
class StubBackend extends BaseLlm {
  constructor(private readonly answer: string) {
    super({model: 'gemini-2.5-flash'});
  }

  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {content: {role: 'model', parts: [{text: this.answer}]}};
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
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

  describe('fixtures recorded before the config was fingerprinted', () => {
    it('recomputes the fallback key for a fixture recorded without one', async () => {
      const req = request('legacy fixture', 'old instruction');
      const legacy = legacyRecorded(req, 'served');
      delete legacy.contentsKey;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      installRecordReplay({mode: 'replay', recordedCalls: [legacy]});

      expect(await replay(request('legacy fixture', 'new instruction'))).toBe(
        'served',
      );
    });

    it('says which coverage the contents-only match gives up', async () => {
      // No config was recorded, so the match cannot check one: say so rather
      // than let a dropped tool look like a pass.
      const req = request('use a tool', 'old instruction', ['lookup']);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      installRecordReplay({
        mode: 'replay',
        recordedCalls: [legacyRecorded(req, 'served')],
      });

      expect(await replay(request('use a tool', 'new instruction'))).toBe(
        'served',
      );
      expect(warn.mock.calls[0][0]).toContain('unverified');
    });
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
