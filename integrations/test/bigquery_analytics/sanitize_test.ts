/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  FORMATTER_FAILED_SENTINEL,
  settleFormatterOutcome,
} from '../../src/bigquery_analytics/formatter_outcome.js';
import {
  pythonJsonDumps,
  pythonJsonLoads,
} from '../../src/bigquery_analytics/python_json.js';
import {
  enumLabel,
  MAX_JSON_INSPECT_CHARS,
  MAX_SANITIZE_NODES,
  normalizeJsonNative,
  recursiveSmartTruncate,
  safeGet,
  sanitizeSensitiveText,
  stripBomWs,
} from '../../src/bigquery_analytics/sanitize.js';
import {snakeCaseKeysDeep} from '../../src/bigquery_analytics/snake_case.js';
import {type JsonValue} from '../../src/bigquery_analytics/types.js';

// Ported from adk-python
// tests/unittests/plugins/test_bigquery_agent_analytics_plugin.py.

interface Truncated {
  out: JsonValue;
  truncated: boolean;
}

function truncateWithBudget(
  value: unknown,
  maxLen: number,
  budget: number,
): Truncated {
  const {value: out, isTruncated} = recursiveSmartTruncate({
    value,
    maxLen,
    budget,
  });
  return {out, truncated: isTruncated};
}

function truncate(value: unknown, maxLen: number): Truncated {
  return truncateWithBudget(value, maxLen, MAX_SANITIZE_NODES);
}

function range(count: number): Array<number> {
  const out: Array<number> = [];
  for (let index = 0; index < count; index += 1) {
    out.push(index);
  }
  return out;
}

function field(value: JsonValue, key: string): JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('expected an object');
  }
  const child = value[key];
  if (child === undefined) {
    throw new TypeError(`missing ${key}`);
  }
  return child;
}

function text(value: JsonValue, key: string): string {
  const child = field(value, key);
  if (typeof child !== 'string') {
    throw new TypeError(`${key} is not a string`);
  }
  return child;
}

function dumps(value: JsonValue): string {
  return pythonJsonDumps(value);
}

describe('recursiveSmartTruncate', () => {
  it('truncates nested strings', () => {
    const long = 'long string'.repeat(10);
    const {out, truncated} = truncate(
      {a: long, b: ['short', long], c: {d: long}},
      10,
    );
    expect(truncated).toBe(true);
    expect(out).toEqual({
      a: 'long strin...[TRUNCATED]',
      b: ['short', 'long strin...[TRUNCATED]'],
      c: {d: 'long strin...[TRUNCATED]'},
    });
  });

  it('walks class instances like dataclasses', () => {
    class MissedKpi {
      constructor(
        public kpi: string,
        public value: number,
      ) {}
    }
    class Incident {
      constructor(
        public id: string,
        public kpiMissed: Array<MissedKpi>,
        public status: string,
      ) {}
    }
    const {out, truncated} = truncate(
      {
        result: new Incident(
          'inc-123',
          [new MissedKpi('latency', 99.9)],
          'active',
        ),
      },
      1000,
    );
    expect(truncated).toBe(false);
    expect(out).toEqual({
      result: {
        id: 'inc-123',
        kpiMissed: [{kpi: 'latency', value: 99.9}],
        status: 'active',
      },
    });
  });

  it('redacts sensitive and temp: keys case-insensitively', () => {
    const {out, truncated} = truncate(
      {
        client_secret: 'super-secret-123',
        access_token: 'ya29.blah',
        refresh_token: '1//0g',
        id_token: 'eyJhb',
        api_key: 'AIza',
        password: 'my-password',
        private_key: 'private-key-material',
        token: 'generic-token',
        secret: 'generic-secret',
        authorization: 'Bearer credential',
        safe_key: 'safe-value',
        'temp:auth_state': 'some-auth-state',
        nested: {CLIENT_SECRET: 'nested-secret', normal: 'value'},
      },
      1000,
    );
    expect(truncated).toBe(false);
    expect(out).toEqual({
      client_secret: '[REDACTED]',
      access_token: '[REDACTED]',
      refresh_token: '[REDACTED]',
      id_token: '[REDACTED]',
      api_key: '[REDACTED]',
      password: '[REDACTED]',
      private_key: '[REDACTED]',
      token: '[REDACTED]',
      secret: '[REDACTED]',
      authorization: '[REDACTED]',
      safe_key: 'safe-value',
      'temp:auth_state': '[REDACTED]',
      nested: {CLIENT_SECRET: '[REDACTED]', normal: 'value'},
    });
  });

  it('redacts JSON blobs through escapes and arrays, and leaves innocent blobs byte-for-byte', () => {
    const escaped = truncate(
      {blob: '{"access\\u005ftoken": "SECRET-A"}'},
      10_000,
    ).out;
    expect(dumps(escaped)).not.toContain('SECRET-A');
    expect(pythonJsonLoads(text(escaped, 'blob')).value).toEqual({
      access_token: '[REDACTED]',
    });

    const array = truncate(
      {blob: '[{"api_key": "SECRET-B"}, {"plain": "ok"}]'},
      10_000,
    ).out;
    expect(dumps(array)).not.toContain('SECRET-B');
    expect(pythonJsonLoads(text(array, 'blob')).value).toEqual([
      {api_key: '[REDACTED]'},
      {plain: 'ok'},
    ]);
    expect(text(array, 'blob')).toBe(
      '[{"api_key": "[REDACTED]"}, {"plain": "ok"}]',
    );

    const innocent = '{"note":  "spacing preserved"}';
    expect(truncate({blob: innocent}, 10_000).out).toEqual({blob: innocent});
  });

  it('always reserializes a blob with duplicate keys', () => {
    const {out} = truncate(
      {blob: '{"access_token": "SECRET-DUP", "access_token": "[REDACTED]"}'},
      10_000,
    );
    expect(dumps(out)).not.toContain('SECRET-DUP');
    expect(pythonJsonLoads(text(out, 'blob')).value).toEqual({
      access_token: '[REDACTED]',
    });
  });

  it('redacts Map entries', () => {
    const {out} = truncate(
      {map: new Map([['access_token', 'SECRET-MAP']])},
      10_000,
    );
    expect(out).toEqual({map: {access_token: '[REDACTED]'}});
  });

  it('fails closed on JSON nested beyond the fixed limit', () => {
    expect(
      truncate({blob: '['.repeat(10_000) + ']'.repeat(10_000)}, 500 * 1024).out,
    ).toEqual({
      blob: '[UNPARSEABLE_JSON_BLOB]',
    });
  });

  it('ignores brackets inside strings when measuring nesting', () => {
    const blob = pythonJsonDumps({
      note: `prose ${'['.repeat(1001)}${']'.repeat(1001)}`,
    });
    expect(truncate({blob}, 500 * 1024)).toEqual({
      out: {blob},
      truncated: false,
    });
  });

  it('fails closed on integers Python cannot materialize', () => {
    const {out} = truncate(
      {blob: `{"access_token": "SECRET-BIGINT", "n": ${'9'.repeat(5000)}}`},
      500 * 1024,
    );
    expect(out).toEqual({blob: '[UNPARSEABLE_JSON_BLOB]'});
  });

  it.each([
    String.raw`{"access\u005ftoken":"SECRET-TRAIL"} trailing`,
    '{"access_token":"SECRET-MALFORMED"',
    '[{"api_key":"SECRET-ARRAY"}, oops]',
  ])('fails closed on malformed container blob %s', (blob) => {
    expect(truncate({blob}, 10_000).out).toEqual({
      blob: '[UNPARSEABLE_JSON_BLOB]',
    });
  });

  it('fails closed on a container blob over the content limit', () => {
    expect(truncate({blob: `{"k": "${'x'.repeat(5000)}"}`}, 100)).toEqual({
      out: {blob: '[UNPARSEABLE_JSON_BLOB]'},
      truncated: true,
    });
  });

  it('classifies the entire emitted value in unlimited mode', () => {
    const raw = `"${'a'.repeat(MAX_JSON_INSPECT_CHARS + 10)}\\u007b\\"access\\u005ftoken\\":\\"R15-UNLIMITED-SECRET\\"\\u007d"`;
    expect(truncate({blob: raw}, -1)).toEqual({
      out: {blob: '[UNPARSEABLE_JSON_BLOB]'},
      truncated: true,
    });

    const prose = `"${'hello world '.repeat(Math.floor(MAX_JSON_INSPECT_CHARS / 12) + 10)}"`;
    const {out, truncated} = truncate({s: prose}, -1);
    expect(text(out, 's')).toBe(prose);
    expect(truncated).toBe(false);
  });

  it('fails closed on an over-limit quoted value hiding an escaped container', () => {
    const raw = `"note \\u007b\\"access\\u005ftoken\\":\\"R14-OVERLIMIT-SECRET\\"\\u007d${'x'.repeat(10_050)}"`;
    expect(truncate({blob: raw}, 10_000)).toEqual({
      out: {blob: '[UNPARSEABLE_JSON_BLOB]'},
      truncated: true,
    });

    const {out, truncated} = truncate(
      {s: `"${'hello world '.repeat(2000)}"`},
      1000,
    );
    expect(text(out, 's').endsWith('...[TRUNCATED]')).toBe(true);
    expect(truncated).toBe(true);
  });

  it('fails closed on prose inside an encoded string hiding a container', () => {
    const raw = String.raw`"note \u007b\"access\u005ftoken\":\"R13-SECRET\"\u007d"`;
    expect(truncate({blob: raw}, 10_000)).toEqual({
      out: {blob: '[UNPARSEABLE_JSON_BLOB]'},
      truncated: true,
    });
    for (const prose of [
      '"just quoted prose"',
      pythonJsonDumps('he said "hi"'),
    ]) {
      expect(truncate({s: prose}, 10_000)).toEqual({
        out: {s: prose},
        truncated: false,
      });
    }
  });

  it('redacts an encoded document after prose in the suffix', () => {
    const {out} = truncate(
      {b: '"note" then "\\u007b\\"access_token\\":\\"R12-SECRET\\"\\u007d"'},
      10_000,
    );
    expect(dumps(out)).not.toContain('R12-SECRET');
    expect(text(out, 'b')).toContain('[REDACTED]');

    const chain = truncate(
      {
        b: '"note" one "plain" two "\\u007b\\"refresh_token\\":\\"R12-CHAIN-SECRET\\"\\u007d"',
      },
      10_000,
    ).out;
    expect(dumps(chain)).not.toContain('R12-CHAIN-SECRET');

    expect(truncate({s: '"note" \\then "x"'}, 10_000)).toEqual({
      out: {s: '[UNPARSEABLE_JSON_BLOB]'},
      truncated: true,
    });
    expect(truncate({s: '"a" and then "b" happened'}, 10_000)).toEqual({
      out: {s: '"a" and then "b" happened'},
      truncated: false,
    });
  });

  it('redacts a trailing unicode-escaped document', () => {
    const {out} = truncate(
      {b: '"note" "\\u007b\\"access_token\\":\\"R11-SECRET\\"\\u007d"'},
      10_000,
    );
    expect(dumps(out)).not.toContain('R11-SECRET');
    expect(text(out, 'b')).toContain('[REDACTED]');

    expect(truncate({s: '"note" \\x'}, 10_000)).toEqual({
      out: {s: '[UNPARSEABLE_JSON_BLOB]'},
      truncated: true,
    });
    for (const prose of [
      '"hello" she said',
      '"a" and then "b" happened',
      '"note" "just more prose"',
    ]) {
      expect(truncate({s: prose}, 10_000)).toEqual({
        out: {s: prose},
        truncated: false,
      });
    }
  });

  it('fails closed on an unterminated quoted container', () => {
    expect(
      truncate({cache: '"{\\"access_token\\":\\"R10-SECRET\\"}'}, 10_000),
    ).toEqual({
      out: {cache: '[UNPARSEABLE_JSON_BLOB]'},
      truncated: true,
    });
    const prose = '"unterminated prose without a container';
    expect(truncate({s: prose}, 10_000)).toEqual({
      out: {s: prose},
      truncated: false,
    });
  });

  it.each(['\u00a0', '\u2003', '\ufeff'])(
    'normalizes Unicode whitespace and BOM %j inside quoted layers',
    (pad) => {
      const under = pythonJsonDumps(
        pad + pythonJsonDumps({access_token: 'R8-WS-SECRET'}),
      );
      expect(dumps(truncate({b: under}, 10_000).out)).not.toContain(
        'R8-WS-SECRET',
      );

      const inner = pythonJsonDumps({
        access_token: `R8-WS-OVER-SECRET-${'x'.repeat(300)}`,
      });
      const over = JSON.stringify(pad + inner);
      const {out, truncated} = truncate({b: over}, 120);
      expect(dumps(out)).not.toContain('R8-WS-OVER-SECRET');
      expect(truncated).toBe(true);
    },
  );

  it('fails closed on credential JSON smuggled after a quoted prefix', () => {
    for (const value of [
      '"note" {"access_token":"R8-SUFFIX-SECRET"}',
      '"note" blah {"refresh_token":"R8-SUFFIX-SECRET-2"}',
    ]) {
      const {out, truncated} = truncate({b: value}, 10_000);
      expect(dumps(out)).not.toContain('R8-SUFFIX-SECRET');
      expect(truncated).toBe(true);
    }
    const prose = '"hello" she said, "twice"';
    expect(truncate({s: prose}, 10_000)).toEqual({
      out: {s: prose},
      truncated: false,
    });
  });

  it('never calls an overridden toString on a safe scalar', () => {
    class SneakyDate extends Date {
      override toString(): string {
        return 'R8-DATE-SECRET';
      }
      override toISOString(): string {
        return 'R8-DATE-SECRET';
      }
    }
    const {out} = truncate({d: new SneakyDate(0)}, 10_000);
    expect(out).toEqual({d: '1970-01-01T00:00:00.000Z'});
  });

  it('reports truncation of an over-limit safe scalar', () => {
    const {out, truncated} = truncate(new Date(0), 8);
    expect(out).toBe('1970-01-...[TRUNCATED]');
    expect(truncated).toBe(true);
  });

  it('fails closed on hostile container protocols without leaking their errors', () => {
    const evilObject = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('R8-OBJECT-SECRET');
        },
      },
    );
    const evilList = new Proxy([1], {
      getOwnPropertyDescriptor: () => {
        throw new Error('R8-LIST-SECRET');
      },
    });
    const {out, truncated} = truncate({m: evilObject, l: evilList}, 10_000);
    expect(out).toEqual({m: '[UNSUPPORTED_OBJECT]', l: '[UNSUPPORTED_OBJECT]'});
    expect(truncated).toBe(true);
  });

  it('never invokes getters', () => {
    let called = false;
    const value = {
      get secret(): string {
        called = true;
        return 'R8-GETTER-SECRET';
      },
    };
    const {out, truncated} = truncate(value, 10_000);
    expect(called).toBe(false);
    expect(out).toEqual({secret: '[REDACTED]'});
    expect(truncated).toBe(false);

    const other = {
      get note(): string {
        called = true;
        return 'R8-GETTER-NOTE';
      },
    };
    expect(truncate(other, 10_000)).toEqual({
      out: {note: '[UNSUPPORTED_OBJECT]'},
      truncated: true,
    });
    expect(called).toBe(false);
  });

  it('normalizes scalar Map keys to their JSON form and marks collisions', () => {
    for (const pair of [
      new Map<unknown, string>([
        [1, 'n'],
        ['1', 's'],
      ]),
      new Map<unknown, string>([
        [true, 'b'],
        ['true', 's'],
      ]),
      new Map<unknown, string>([
        [null, 'x'],
        ['null', 's'],
      ]),
    ]) {
      const {out, truncated} = truncate(pair, 10_000);
      expect(truncated).toBe(true);
      expect(Object.keys(pythonJsonLoads(dumps(out)).value ?? {})).toHaveLength(
        2,
      );
    }

    const {out, truncated} = truncate(
      new Map<unknown, string>([
        ['[KEY_COLLISION_1]1', 'reserved'],
        ['1', 'string'],
        [1, 'numeric'],
      ]),
      10_000,
    );
    expect(truncated).toBe(true);
    expect(field(out, '[KEY_COLLISION_1]1')).toBe('reserved');
    expect(field(out, '1')).toBe('string');
    expect(
      Object.values(out ?? {}).sort((a, b) =>
        String(a).localeCompare(String(b)),
      ),
    ).toEqual(['numeric', 'reserved', 'string']);
  });

  it('charges the budget per instance attribute and terminates self-references', () => {
    class Big {
      readonly kind = 'big';
    }
    const big = new Big();
    for (let index = 0; index < 200; index += 1) {
      Object.defineProperty(big, `attr${index}`, {
        value: index,
        enumerable: true,
      });
    }
    const {out, truncated} = truncateWithBudget({b: big}, 10_000, 50);
    expect(truncated).toBe(true);
    expect(Object.keys(field(out, 'b') ?? {}).length).toBeLessThanOrEqual(51);

    class Node {
      self: Node | null = null;
      access_token = 'R8-SELF-SECRET';
    }
    const node = new Node();
    node.self = node;
    const selfRef = truncate({n: node}, 10_000).out;
    expect(field(field(selfRef, 'n'), 'self')).toBe('[CIRCULAR_REFERENCE]');
    expect(dumps(selfRef)).not.toContain('R8-SELF-SECRET');
  });

  it('bounds JSON materialization in unlimited mode', () => {
    const big = `[${'1,'.repeat(MAX_JSON_INSPECT_CHARS / 2 + 10)}1]`;
    expect(truncate({b: big}, -1)).toEqual({
      out: {b: '[UNPARSEABLE_JSON_BLOB]'},
      truncated: true,
    });
  });

  it('does not republish over-limit multi-layer quoted JSON or a quoted layer with trailing garbage', () => {
    const secret = `ROUND7-TRIPLE-SECRET-${'x'.repeat(300)}`;
    const triple = pythonJsonDumps(
      pythonJsonDumps(pythonJsonDumps({access_token: secret})),
    );
    const tripleOut = truncate({blob: triple}, 64);
    expect(dumps(tripleOut.out)).not.toContain('ROUND7-TRIPLE-SECRET');
    expect(tripleOut.truncated).toBe(true);

    const trailing = `${pythonJsonDumps(pythonJsonDumps({access_token: 'ROUND7-TRAIL-SECRET'}))} trailing`;
    const {out} = truncate({blob: trailing}, 10_000);
    expect(dumps(out)).not.toContain('ROUND7-TRAIL-SECRET');
    expect(text(out, 'blob')).toContain('[REDACTED]');
    expect(text(out, 'blob').endsWith(' trailing')).toBe(true);

    for (const prose of ['"hello" she said', '"just a quote"']) {
      expect(truncate({s: prose}, 10_000)).toEqual({
        out: {s: prose},
        truncated: false,
      });
    }
  });

  it('covers bytes, BOM-prefixed JSON and toJSON converters', () => {
    const encoder = new TextEncoder();
    class Converter {
      toJSON(): Map<string, string> {
        return new Map([['access_token', 'SECRET-MAPPING']]);
      }
    }
    const {out} = truncate(
      {
        bytes: encoder.encode('{"access_token":"SECRET-BYTES"}'),
        buffer: Buffer.from('{"access_token":"SECRET-BUFFER"}'),
        arrayBuffer: encoder.encode('{"access_token":"SECRET-AB"}').buffer,
        bom: '\ufeff{"access_token":"SECRET-BOM"}',
        converter: new Converter(),
      },
      10_000,
    );
    const dumped = dumps(out);
    for (const marker of [
      'SECRET-BYTES',
      'SECRET-BUFFER',
      'SECRET-AB',
      'SECRET-BOM',
      'SECRET-MAPPING',
    ]) {
      expect(dumped).not.toContain(marker);
    }
  });

  it('reports binary data that is not UTF-8 as content loss', () => {
    expect(truncate({b: new Uint8Array([0xff, 0xfe])}, 10_000)).toEqual({
      out: {b: '[BINARY_DATA]'},
      truncated: true,
    });
  });

  it('redacts double- and triple-encoded string layers and string toJSON results', () => {
    const double = pythonJsonDumps(
      pythonJsonDumps({access_token: 'DOUBLE-ENCODED-SECRET'}),
    );
    expect(dumps(truncate({blob: double}, 10_000).out)).not.toContain(
      'DOUBLE-ENCODED-SECRET',
    );
    expect(
      dumps(truncate({blob: pythonJsonDumps(double)}, 10_000).out),
    ).not.toContain('DOUBLE-ENCODED-SECRET');

    class RootModel {
      toJSON(): string {
        return '{"access_token":"ROOT-SECRET"}';
      }
    }
    expect(dumps(truncate({model: new RootModel()}, 10_000).out)).not.toContain(
      'ROOT-SECRET',
    );
  });

  it('reports truncation when a blob is rewritten past the depth cap', () => {
    const {out, truncated} = truncate(
      {blob: '['.repeat(60) + ']'.repeat(60)},
      10_000,
    );
    expect(text(out, 'blob')).toContain('[MAX_DEPTH_EXCEEDED]');
    expect(truncated).toBe(true);
  });

  it('stops at the node budget with one remainder sentinel', () => {
    const wide = range(MAX_SANITIZE_NODES * 2);
    const {out, truncated} = truncate({wide}, 10_000);
    const list = field(out, 'wide');
    if (!Array.isArray(list)) {
      throw new TypeError('expected a list');
    }
    expect(truncated).toBe(true);
    expect(list.at(-1)).toBe('[SANITIZE_BUDGET_EXCEEDED]');
    expect(
      list.filter((item) => item === '[SANITIZE_BUDGET_EXCEEDED]'),
    ).toHaveLength(1);
    expect(list.length).toBeLessThanOrEqual(MAX_SANITIZE_NODES + 1);
  });

  it('charges the budget for directly redacted entries', () => {
    const wideTemp = Object.fromEntries(
      range(MAX_SANITIZE_NODES * 2).map((index) => [`temp:${index}`, index]),
    );
    const {out, truncated} = truncate(wideTemp, 10_000);
    expect(truncated).toBe(true);
    expect(Object.keys(out ?? {}).length).toBeLessThanOrEqual(
      MAX_SANITIZE_NODES + 1,
    );
    expect(field(out, '[SANITIZE_BUDGET_EXCEEDED]')).toBe(
      '[SANITIZE_BUDGET_EXCEEDED]',
    );
  });

  it('redacts dashed and structured signed-URL keys', () => {
    expect(
      truncate(
        {
          'x-amz-signature': 'STRUCTURED-AMZ-SECRET',
          google_access_id: 'STRUCTURED-GOOGLE-SECRET',
          safe: true,
        },
        -1,
      ).out,
    ).toEqual({
      'x-amz-signature': '[REDACTED]',
      google_access_id: '[REDACTED]',
      safe: true,
    });
  });
});

describe('normalizeJsonNative', () => {
  it('redacts sensitive keys and bounds lengths while preserving sentinels and bracketed prose', () => {
    const {value} = normalizeJsonNative({
      value: {prompt: [{role: {access_token: 'R15-NATIVE-SECRET'}}]},
      maxLen: 10_000,
    });
    expect(value).toEqual({prompt: [{role: {access_token: '[REDACTED]'}}]});

    expect(
      normalizeJsonNative({
        value: `R15-ROLE-${'x'.repeat(1_000_000)}`,
        maxLen: 10,
      }),
    ).toEqual({
      value: 'R15-ROLE-x...[TRUNCATED]',
      isTruncated: true,
    });
    for (const preserved of ['[FORMATTER_FAILED]', '[bracketed] prose']) {
      expect(normalizeJsonNative({value: preserved, maxLen: 10_000})).toEqual({
        value: preserved,
        isTruncated: false,
      });
    }
  });

  it('never overwrites an existing key with the budget sentinel', () => {
    expect(
      normalizeJsonNative({
        value: {
          '[SANITIZE_BUDGET_EXCEEDED]': 'reserved',
          '[KEY_COLLISION_1][SANITIZE_BUDGET_EXCEEDED]': 'marker',
          omitted: 'value',
        },
        maxLen: 10_000,
        budget: 3,
      }),
    ).toEqual({
      value: {
        '[SANITIZE_BUDGET_EXCEEDED]': 'reserved',
        '[KEY_COLLISION_1][SANITIZE_BUDGET_EXCEEDED]': 'marker',
        '[KEY_COLLISION_2][SANITIZE_BUDGET_EXCEEDED]':
          '[SANITIZE_BUDGET_EXCEEDED]',
      },
      isTruncated: true,
    });
  });

  it('fails closed on values that are not JSON-native', () => {
    expect(
      normalizeJsonNative({value: {m: new Map([['a', 1]])}, maxLen: 100}),
    ).toEqual({
      value: {m: '[UNSUPPORTED_OBJECT]'},
      isTruncated: true,
    });
  });
});

describe('sanitizeSensitiveText', () => {
  it.each([
    ['access_token=[REDACTED]SECRET', 'SECRET'],
    ['access_token=[REDACTED]]SECRET', 'SECRET'],
    ['access_token=[REDACTED]/SECRET', 'SECRET'],
    [
      'Authorization: Digest username="u", response="DIGEST-SECRET"',
      'DIGEST-SECRET',
    ],
    [
      'Authorization: AWS4-HMAC-SHA256 Credential=AWS-SECRET, SignedHeaders=host',
      'AWS-SECRET',
    ],
    ['Proxy-Authorization: Negotiate NEGOTIATE-SECRET', 'NEGOTIATE-SECRET'],
    ['Bearer\nBEARER-SECRET', 'BEARER-SECRET'],
    ['Basic\tdXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['Basic dXNlcg==', 'dXNlcg=='],
    ['sig=SIG-SECRET', 'SIG-SECRET'],
    ['x-amz-signature=AMZ-SIGNATURE-SECRET', 'AMZ-SIGNATURE-SECRET'],
    ['x_amz_credential=AMZ-CREDENTIAL-SECRET', 'AMZ-CREDENTIAL-SECRET'],
    ['google-access-id=GOOGLE-ID-SECRET', 'GOOGLE-ID-SECRET'],
    [String.raw`access\u005ftoken=UNICODE-SECRET`, 'UNICODE-SECRET'],
    [String.raw`access\x5ftoken=HEX-SECRET`, 'HEX-SECRET'],
    ['access_token%3DPERCENT-SECRET', 'PERCENT-SECRET'],
    ['access%255Ftoken%253DDOUBLE-SECRET', 'DOUBLE-SECRET'],
  ])('redacts %j', (value, secret) => {
    const {text: sanitized, isTruncated} = sanitizeSensitiveText({
      text: value,
      maxLen: -1,
    });
    expect(isTruncated).toBe(true);
    expect(sanitized).not.toContain(secret);
  });

  it('keeps a complete sentinel value idempotent', () => {
    expect(
      sanitizeSensitiveText({text: 'access_token=[REDACTED]', maxLen: -1}),
    ).toEqual({
      text: 'access_token=[REDACTED]',
      isTruncated: false,
    });
  });

  it.each([
    String.raw`C:\Users\secret\project\file.json`,
    String.raw`Invalid \escape at position 4`,
    String.raw`can't decode \x5c in position 2`,
    'the bearer of bad news',
    'a basic principle',
    'a basic test',
    'design=balanced',
    'signal=strong',
    'progress%3D100%25 complete',
    'literal%2525value',
    '[INFO] bracket-led log line',
  ])('preserves safe text %j exactly', (value) => {
    expect(sanitizeSensitiveText({text: value, maxLen: -1})).toEqual({
      text: value,
      isTruncated: false,
    });
  });

  it('preserves a wide safe input', () => {
    const wide = String.raw`C:\safe\secret\file%25.txt; `
      .repeat(20_000)
      .trimEnd();
    expect(sanitizeSensitiveText({text: wide, maxLen: wide.length})).toEqual({
      text: wide,
      isTruncated: false,
    });
  });

  it('redacts complete JSON documents structurally', () => {
    const {text: sanitized, isTruncated} = sanitizeSensitiveText({
      text: '{"access_token": "JSON-SECRET"}',
      maxLen: -1,
    });
    expect(sanitized).toBe('{"access_token": "[REDACTED]"}');
    expect(isTruncated).toBe(true);
  });

  it('truncates past the length bound', () => {
    expect(sanitizeSensitiveText({text: 'abcdefghij', maxLen: 4})).toEqual({
      text: 'abcd...[TRUNCATED]',
      isTruncated: true,
    });
  });
});

describe('stripBomWs', () => {
  it('strips an alternating whitespace and BOM prefix in linear time', () => {
    const started = performance.now();
    expect(stripBomWs(`${' \ufeff'.repeat(200_000)}{}`)).toBe('{}');
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('settleFormatterOutcome', () => {
  it.each([null, undefined, 'text', {a: 1}, [1, 2]])(
    'logs a native result %j as it is',
    (formatted) => {
      expect(
        settleFormatterOutcome({
          formatted,
          failure: null,
          eventType: 'LLM_REQUEST',
          debug: false,
        }),
      ).toEqual({
        content: formatted,
        errorMessage: null,
      });
    },
  );

  it('normalizes a String object to the primitive', () => {
    // the boxed form is the case under test
    const boxed = new String('boxed');
    expect(
      settleFormatterOutcome({
        formatted: boxed,
        failure: null,
        eventType: 'X',
        debug: false,
      }).content,
    ).toBe('boxed');
  });

  it('names a raised built-in error by its fixed label', () => {
    expect(
      settleFormatterOutcome({
        formatted: null,
        failure: new TypeError('SECRET-MESSAGE'),
        eventType: 'X',
        debug: false,
      }),
    ).toEqual({
      content: FORMATTER_FAILED_SENTINEL,
      errorMessage: 'content_formatter raised TypeError',
    });
  });

  it('names a custom error class only by its nearest built-in ancestor', () => {
    class LeakyNameError extends RangeError {}
    expect(
      settleFormatterOutcome({
        formatted: null,
        failure: new LeakyNameError('x'),
        eventType: 'X',
        debug: true,
      }).errorMessage,
    ).toBe('content_formatter raised <subclass of RangeError>');
  });

  it('rejects class instances and other unsupported results', () => {
    class Secret {
      value = 'SECRET';
    }
    expect(
      settleFormatterOutcome({
        formatted: new Secret(),
        failure: null,
        eventType: 'X',
        debug: false,
      }),
    ).toEqual({
      content: FORMATTER_FAILED_SENTINEL,
      errorMessage:
        'content_formatter returned unsupported type <subclass of Object>',
    });
    expect(
      settleFormatterOutcome({
        formatted: 42,
        failure: null,
        eventType: 'X',
        debug: false,
      }).errorMessage,
    ).toBe('content_formatter returned unsupported type number');
    expect(
      settleFormatterOutcome({
        formatted: new Map(),
        failure: null,
        eventType: 'X',
        debug: false,
      }).errorMessage,
    ).toBe('content_formatter returned unsupported type Map');
  });

  it('releases a rejected promise without an unhandled rejection', async () => {
    const rejected = Promise.reject(new Error('SECRET'));
    const outcome = settleFormatterOutcome({
      formatted: rejected,
      failure: null,
      eventType: 'X',
      debug: false,
    });
    expect(outcome).toEqual({
      content: FORMATTER_FAILED_SENTINEL,
      errorMessage: 'content_formatter returned unsupported type Promise',
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });

  it('falls back to <unknown class> for an object without a prototype', () => {
    expect(
      settleFormatterOutcome({
        formatted: null,
        failure: Object.create(null),
        eventType: 'X',
        debug: false,
      }).errorMessage,
    ).toBe('content_formatter raised <unknown class>');
  });
});

describe('snakeCaseKeysDeep', () => {
  it('converts SDK camelCase keys deeply and leaves leaves untouched', () => {
    const date = new Date(0);
    expect(
      snakeCaseKeysDeep({
        promptTokenCount: 1,
        cachedContentTokenCount: 2,
        promptTokensDetails: [{modality: 'TEXT', tokenCount: 3}],
        already_snake: date,
      }),
    ).toEqual({
      prompt_token_count: 1,
      cached_content_token_count: 2,
      prompt_tokens_details: [{modality: 'TEXT', token_count: 3}],
      already_snake: date,
    });
  });

  it('terminates on cycles', () => {
    const node: Record<string, unknown> = {childNode: null};
    node.childNode = node;
    expect(snakeCaseKeysDeep(node)).toEqual({
      child_node: '[CIRCULAR_REFERENCE]',
    });
  });
});

describe('safeGet and enumLabel', () => {
  it('reads inherited data properties but never runs a getter', () => {
    let called = false;
    class Lazy {
      get lazy(): string {
        called = true;
        return 'x';
      }
    }
    Object.defineProperty(Lazy.prototype, 'tag', {value: 'inherited'});
    const value = new Lazy();
    expect(safeGet(value, 'tag')).toBe('inherited');
    expect(safeGet(value, 'lazy')).toBeUndefined();
    expect(called).toBe(false);
  });

  it.each([
    [null, 'unknown'],
    ['', 'unknown'],
    ['STOP', 'STOP'],
    [3, '3'],
    [{}, 'unknown'],
  ])('labels %j as %j', (value, label) => {
    expect(enumLabel(value)).toBe(label);
  });
});
