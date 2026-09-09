/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {stringifyWithRedactedInlineData} from '../../src/utils/redact_inline_data.js';

const PAYLOAD = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNk';

describe('stringifyWithRedactedInlineData', () => {
  it('drops the payload of an inline blob but keeps its mime type', () => {
    const out = stringifyWithRedactedInlineData({
      content: {
        role: 'model',
        parts: [{inlineData: {mimeType: 'image/png', data: PAYLOAD}}],
      },
    });

    expect(out).not.toContain(PAYLOAD);
    expect(out).toContain('image/png');
    expect(out).toContain('<redacted');
  });

  it('reports the character count of the elided payload', () => {
    const payload = 'a'.repeat(36);

    expect(
      stringifyWithRedactedInlineData({
        inlineData: {mimeType: 'audio/wav', data: payload},
      }),
    ).toBe(
      '{"inlineData":{"mimeType":"audio/wav","data":"<redacted 36 chars>"}}',
    );
  });

  it('keeps every sibling field of the blob', () => {
    const out = stringifyWithRedactedInlineData({
      inlineData: {
        mimeType: 'application/pdf',
        displayName: 'invoice.pdf',
        data: PAYLOAD,
      },
    });

    expect(JSON.parse(out)).toEqual({
      inlineData: {
        mimeType: 'application/pdf',
        displayName: 'invoice.pdf',
        data: `<redacted ${PAYLOAD.length} chars>`,
      },
    });
  });

  it('serializes a text-only event exactly as JSON.stringify does', () => {
    const event = {
      id: 'e1',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{text: 'Hello'}]},
    };

    expect(stringifyWithRedactedInlineData(event)).toBe(JSON.stringify(event));
  });

  it('redacts repeated and deeply nested blobs alike', () => {
    const out = stringifyWithRedactedInlineData({
      content: {
        parts: [
          {inlineData: {mimeType: 'image/png', data: PAYLOAD}},
          {inlineData: {mimeType: 'image/jpeg', data: PAYLOAD}},
          {
            functionResponse: {
              name: 'load_file',
              response: {
                blob: {
                  inlineData: {mimeType: 'application/pdf', data: PAYLOAD},
                },
              },
            },
          },
        ],
      },
    });

    expect(out).not.toContain(PAYLOAD);
    expect(out.match(/<redacted \d+ chars>/g)).toHaveLength(3);
    expect(out).toContain('application/pdf');
  });

  it('passes a null inlineData through untouched', () => {
    expect(stringifyWithRedactedInlineData({inlineData: null})).toBe(
      '{"inlineData":null}',
    );
  });

  it('passes an inlineData whose data is not a string through untouched', () => {
    expect(
      stringifyWithRedactedInlineData({inlineData: {mimeType: 'x', data: 7}}),
    ).toBe('{"inlineData":{"mimeType":"x","data":7}}');
  });

  it('leaves a data property that is not under inlineData alone', () => {
    expect(stringifyWithRedactedInlineData({data: PAYLOAD})).toBe(
      JSON.stringify({data: PAYLOAD}),
    );
  });

  it('returns JSON that parses back to a well-formed object', () => {
    const parsed: unknown = JSON.parse(
      stringifyWithRedactedInlineData({
        author: 'sub_agent1',
        content: {parts: [{inlineData: {mimeType: 'image/png', data: 'AAAA'}}]},
      }),
    );

    expect(parsed).toEqual({
      author: 'sub_agent1',
      content: {
        parts: [
          {inlineData: {mimeType: 'image/png', data: '<redacted 4 chars>'}},
        ],
      },
    });
  });
});
