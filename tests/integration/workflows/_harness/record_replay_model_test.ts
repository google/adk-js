/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the replay matching in {@link record_replay_model}, in particular that
 * a fixture survives a system-instruction change instead of every sample
 * failing at once.
 */

import type {LlmRequest} from '@google/adk';
import {LLMRegistry} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  contentsFingerprint,
  fingerprint,
  installRecordReplay,
  RecordedCall,
  restoreRecordReplay,
} from './record_replay_model.js';

function request(text: string, systemInstruction: string): LlmRequest {
  return {
    model: 'gemini-2.5-flash',
    contents: [{role: 'user', parts: [{text}]}],
    config: {systemInstruction},
    // The harness only reads `contents` and `config`; the rest of LlmRequest is
    // irrelevant to fingerprinting.
  } as unknown as LlmRequest;
}

function recorded(req: LlmRequest, answer: string): RecordedCall {
  return {
    key: fingerprint(req),
    contentsKey: contentsFingerprint(req.contents),
    request: {
      contents: req.contents,
      systemInstruction: req.config?.systemInstruction,
    },
    response: {
      candidates: [{content: {role: 'model', parts: [{text: answer}]}}],
    },
  };
}

/** Replays one request through the installed harness model. */
async function replay(req: LlmRequest): Promise<string | undefined> {
  const model = LLMRegistry.newLlm('gemini-2.5-flash');
  for await (const resp of model.generateContentAsync(req)) {
    return resp.content?.parts?.[0]?.text;
  }
  return undefined;
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

  it('recomputes the fallback key for a fixture recorded without one', async () => {
    const req = request('legacy fixture', 'old instruction');
    const legacy = recorded(req, 'served');
    delete legacy.contentsKey;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    installRecordReplay({mode: 'replay', recordedCalls: [legacy]});

    expect(await replay(request('legacy fixture', 'new instruction'))).toBe(
      'served',
    );
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
});
