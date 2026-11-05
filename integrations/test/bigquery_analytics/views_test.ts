/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {DEFAULT_LOGGER_CONFIG} from '../../src/bigquery_analytics/config.js';
import {
  EVAL_VIEW_REQUIRED_EVENTS,
  EVENT_VIEW_DEFS,
  analyticsViewStatements,
  buildEvalSessionViewSql,
  buildEvalTurnViewSql,
  formatSqlTemplate,
  projectViewColumns,
  validateEvalViewConfig,
  validateViewIdentifiers,
} from '../../src/bigquery_analytics/views.js';
import {golden} from './golden.js';

function defaultStatements() {
  return analyticsViewStatements({
    projectId: 'p',
    datasetId: 'd',
    tableId: 't',
    viewPrefix: 'v',
    denied: new Set(),
  });
}

describe('golden SQL from adk-python', () => {
  it('records the adk-python commit it was rendered from', () => {
    expect(golden.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each(golden.analytics)(
    'per-event views match for prefix $prefix, denied $denied',
    (testCase) => {
      const statements = analyticsViewStatements({
        projectId: testCase.project,
        datasetId: testCase.dataset,
        tableId: testCase.table,
        viewPrefix: testCase.prefix,
        denied: new Set(testCase.denied),
      });
      expect(statements.map(({sql}) => sql)).toEqual(testCase.sql);
    },
  );

  it.each(golden.eval)(
    'eval views match for $fullTableId, prefix $prefix, denied $denied',
    (testCase) => {
      const params = {
        fullTableId: testCase.fullTableId,
        viewPrefix: testCase.prefix,
        denied: new Set(testCase.denied),
      };
      expect(buildEvalSessionViewSql(params)).toBe(testCase.session);
      expect(buildEvalTurnViewSql(params)).toBe(testCase.turn);
    },
  );
});

describe('analyticsViewStatements', () => {
  it('creates one view per event type, each filtered on its event_type', () => {
    const statements = defaultStatements();
    expect(statements.map(({viewName}) => viewName)).toEqual(
      Object.keys(EVENT_VIEW_DEFS).map(
        (eventType) => `v_${eventType.toLowerCase()}`,
      ),
    );
    for (const [index, eventType] of Object.keys(EVENT_VIEW_DEFS).entries()) {
      const sql = statements[index]?.sql ?? '';
      expect(sql).toContain('CREATE OR REPLACE VIEW `p.d.v_');
      expect(sql).toContain(`WHERE\n  event_type = '${eventType}'`);
    }
  });

  it('gives the error views a traceback column', () => {
    const byName = new Map(
      defaultStatements().map(({viewName, sql}) => [viewName, sql]),
    );
    expect(byName.get('v_agent_error')).toContain('error_traceback');
    expect(byName.get('v_agent_error')).toContain('total_ms');
    expect(byName.get('v_invocation_error')).toContain('error_traceback');
  });

  it('exposes token usage and finish reason on LLM_RESPONSE', () => {
    const sql =
      defaultStatements().find(({viewName}) => viewName === 'v_llm_response')
        ?.sql ?? '';
    for (const fragment of [
      'usage_cached_tokens',
      'usage_thinking_tokens',
      'usage_tool_use_tokens',
      '$.usage_metadata.thoughts_token_count',
      '$.usage_metadata.tool_use_prompt_token_count',
      "JSON_VALUE(attributes, '$.finish_reason') AS finish_reason",
    ]) {
      expect(sql).toContain(fragment);
    }
  });

  it('reads the agent instruction from text_summary or a non-callable string', () => {
    expect(EVENT_VIEW_DEFS.AGENT_STARTING[0]).toBe(
      String.raw`COALESCE(JSON_VALUE(content, '$.text_summary'), IF(REGEXP_CONTAINS(JSON_VALUE(content, '$'), r'^(?:<(?:function|bound method) |<.+ at 0x[0-9a-fA-F]+>|functools\.partial\()'), NULL, JSON_VALUE(content, '$'))) AS agent_instruction`,
    );
  });

  it.each(['TOOL_PAUSED', 'TOOL_COMPLETED'] as const)(
    '%s exposes the pause pair keys',
    (eventType) => {
      expect(EVENT_VIEW_DEFS[eventType]).toEqual(
        expect.arrayContaining([
          "JSON_VALUE(attributes, '$.adk.pause_kind') AS pause_kind",
          "JSON_VALUE(attributes, '$.adk.function_call_id') AS function_call_id",
        ]),
      );
    },
  );

  it.each([
    'NODE_OUTPUT',
    'NODE_ERROR',
    'WORKFLOW_NODE_FIRST_OBSERVED',
    'WORKFLOW_NODE_OBSERVATION_SUMMARY',
  ] as const)('%s exposes workflow node identity', (eventType) => {
    expect(EVENT_VIEW_DEFS[eventType]).toEqual(
      expect.arrayContaining([
        "JSON_VALUE(attributes, '$.adk.node.path') AS node_path",
      ]),
    );
  });

  it('creates the workflow node observation views last', () => {
    expect(
      defaultStatements()
        .slice(-2)
        .map(({viewName}) => viewName),
    ).toEqual([
      'v_workflow_node_first_observed',
      'v_workflow_node_observation_summary',
    ]);
  });

  it('uses a custom prefix for every view', () => {
    const statements = analyticsViewStatements({
      projectId: 'p',
      datasetId: 'd',
      tableId: 't',
      viewPrefix: 'v_staging',
      denied: new Set(),
    });
    expect(
      statements.every(
        ({viewName, sql}) =>
          viewName.startsWith('v_staging_') && sql.includes(`.${viewName}\``),
      ),
    ).toBe(true);
  });
});

describe('projectViewColumns', () => {
  it('drops only expressions that reference a denied column as a whole word', () => {
    const columns = [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_VALUE(attributes, '$.model') AS model",
      'content_parts AS parts',
    ];
    expect(projectViewColumns({columns, denied: new Set(['content'])})).toEqual(
      columns.slice(1),
    );
    expect(projectViewColumns({columns, denied: new Set()})).toEqual(columns);
  });
});

describe('eval view SQL', () => {
  it('starts with the view DDL and reads the table once', () => {
    const session = buildEvalSessionViewSql({fullTableId: 'p.d.t'});
    const turn = buildEvalTurnViewSql({fullTableId: 'p.d.t'});
    expect(
      session.startsWith(
        'CREATE OR REPLACE VIEW `p.d.v_eval_session` AS\nWITH\n',
      ),
    ).toBe(true);
    expect(
      turn.startsWith('CREATE OR REPLACE VIEW `p.d.v_eval_turn` AS\nWITH\n'),
    ).toBe(true);
    for (const sql of [session, turn]) {
      expect(sql.split('`p.d.t`')).toHaveLength(2);
      expect(sql.split('\nSELECT\n')).toHaveLength(2);
      expect(sql).not.toContain(' AS status');
      expect(sql).toContain(
        "FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', timestamp)",
      );
      expect(sql).toContain(
        "WHEN event_type = 'AGENT_RESPONSE' AND response_text IS NOT NULL",
      );
    }
    expect(turn).toContain("'turn_index', 0,");
    expect(session).toContain("'turn_index', turn_index,");
  });

  it('reads denied payload columns as empty or NULL', () => {
    const sql = buildEvalTurnViewSql({
      fullTableId: 'p.d.t',
      denied: new Set(['content_parts', 'attributes', 'latency_ms']),
    });
    expect(sql).toContain(
      'ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, part_attributes STRING, storage_mode STRING>>[] AS content_parts,\n      CAST(NULL AS JSON) AS attributes,\n      CAST(NULL AS JSON) AS latency_ms,\n',
    );
    expect(buildEvalTurnViewSql({fullTableId: 'p.d.t'})).toContain(
      '      content_parts,\n      attributes,\n      latency_ms,\n',
    );
  });

  it('rejects a denied content column and an unqualified table', () => {
    for (const build of [buildEvalSessionViewSql, buildEvalTurnViewSql]) {
      expect(() =>
        build({fullTableId: 'p.d.t', denied: new Set(['content'])}),
      ).toThrow('Cannot build eval view SQL');
    }
    expect(() => buildEvalTurnViewSql({fullTableId: 'agent_events'})).toThrow(
      'dataset-qualified',
    );
  });
});

describe('validateEvalViewConfig', () => {
  const pauseEvents = [
    'TOOL_PAUSED',
    'HITL_CREDENTIAL_REQUEST',
    'HITL_CONFIRMATION_REQUEST',
    'HITL_INPUT_REQUEST',
    'HITL_CREDENTIAL_REQUEST_COMPLETED',
    'HITL_CONFIRMATION_REQUEST_COMPLETED',
    'HITL_INPUT_REQUEST_COMPLETED',
  ];
  const requiredEvents = [
    'USER_MESSAGE_RECEIVED',
    'AGENT_STARTING',
    'LLM_REQUEST',
    'TOOL_STARTING',
    'TOOL_COMPLETED',
    'AGENT_TRANSFER',
    'AGENT_RESPONSE',
    'INVOCATION_COMPLETED',
    ...pauseEvents,
  ];
  function validate(
    overrides: Partial<typeof DEFAULT_LOGGER_CONFIG>,
    denied: ReadonlySet<string> = new Set(),
    fromInit = true,
  ) {
    validateEvalViewConfig({
      config: {...DEFAULT_LOGGER_CONFIG, ...overrides},
      denied,
      fromInit,
    });
  }

  it('requires the documented events', () => {
    expect([...EVAL_VIEW_REQUIRED_EVENTS].sort()).toEqual(
      [...requiredEvents].sort(),
    );
  });

  it('rejects a denied content column, worded for init and refresh', () => {
    expect(() => validate({}, new Set(['content']))).toThrow(
      'createEvalViews=true cannot be used',
    );
    expect(() => validate({}, new Set(['content']), false)).toThrow(
      'Cannot create eval views',
    );
  });

  const validatedEvents = requiredEvents.filter(
    (event) => event !== 'AGENT_STARTING',
  );

  it.each(validatedEvents)('rejects %s in the denylist', (event) => {
    expect(() => validate({eventDenylist: [event]})).toThrow(
      'required events are in eventDenylist',
    );
  });

  it('rejects an allowlist missing required events, listing them sorted', () => {
    expect(() =>
      validate({
        eventAllowlist: [
          'USER_MESSAGE_RECEIVED',
          'AGENT_RESPONSE',
          'TOOL_STARTING',
          'TOOL_COMPLETED',
          'INVOCATION_COMPLETED',
        ],
      }),
    ).toThrow('eventAllowlist includes all required events');
    for (const missing of [['AGENT_TRANSFER'], pauseEvents]) {
      expect(() =>
        validate({
          eventAllowlist: requiredEvents.filter(
            (event) => !missing.includes(event),
          ),
        }),
      ).toThrow(
        `missing: [${[...missing]
          .sort()
          .map((event) => `'${event}'`)
          .join(', ')}].`,
      );
    }
  });

  it('does not insist on AGENT_STARTING, which the runner never emits', () => {
    expect(() => validate({eventAllowlist: validatedEvents})).not.toThrow();
    expect(() => validate({eventDenylist: ['AGENT_STARTING']})).not.toThrow();
  });

  it('accepts a full allowlist and treats an empty allowlist as unset', () => {
    expect(() => validate({eventAllowlist: requiredEvents})).not.toThrow();
    expect(() => validate({eventAllowlist: []})).not.toThrow();
  });

  it('needs only the conversation events in conversation_only mode', () => {
    expect(() =>
      validate({
        evalViewMode: 'conversation_only',
        eventAllowlist: [
          'USER_MESSAGE_RECEIVED',
          'AGENT_RESPONSE',
          'INVOCATION_COMPLETED',
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validate({
        evalViewMode: 'conversation_only',
        eventDenylist: ['TOOL_STARTING'],
      }),
    ).not.toThrow();
  });
});

describe('formatSqlTemplate', () => {
  it('substitutes names and unescapes doubled braces like Python str.format', () => {
    expect(
      formatSqlTemplate({template: "{a} '{{}}' {b}", values: {a: 'x', b: 'y'}}),
    ).toBe("x '{}' y");
  });

  it('throws on a missing value', () => {
    expect(() => formatSqlTemplate({template: '{a}', values: {}})).toThrow(
      "Missing SQL template value 'a'.",
    );
  });

  it('does not resolve names from Object.prototype', () => {
    for (const name of ['toString', 'constructor']) {
      expect(() =>
        formatSqlTemplate({template: `{${name}}`, values: {}}),
      ).toThrow(`Missing SQL template value '${name}'.`);
    }
  });
});

describe('view DDL identifier validation', () => {
  const unsafe = [
    '',
    'a`b',
    String.raw`a\b`,
    'a\nb',
    'a\rb',
    'a\x00b',
    'a\x7fb',
    'a\x85b',
    'a\u2028b',
    'a\u2029b',
  ];

  it.each(unsafe)('rejects %j', (value) => {
    expect(() => validateViewIdentifiers({tableId: value})).toThrow(RangeError);
  });

  it('allows spaces and Unicode', () => {
    expect(() =>
      validateViewIdentifiers({tableId: 'agent events ø 表', viewPrefix: 'v'}),
    ).not.toThrow();
  });

  it.each(['projectId', 'datasetId', 'tableId', 'viewPrefix'] as const)(
    'rejects an unsafe %s before rendering per-event views',
    (field) => {
      expect(() =>
        analyticsViewStatements({
          projectId: 'p',
          datasetId: 'd',
          tableId: 't',
          viewPrefix: 'v',
          denied: new Set(),
          [field]: 'x` AS SELECT 1; --',
        }),
      ).toThrow(`${field} must not contain backticks`);
    },
  );

  it('rejects an unsafe fullTableId or viewPrefix in the eval views', () => {
    for (const build of [buildEvalSessionViewSql, buildEvalTurnViewSql]) {
      expect(() => build({fullTableId: 'p.d.t`\n'})).toThrow(
        'fullTableId must not contain backticks',
      );
      expect(() => build({fullTableId: 'p.d.t', viewPrefix: ''})).toThrow(
        'viewPrefix must be a non-empty string.',
      );
    }
  });
});
