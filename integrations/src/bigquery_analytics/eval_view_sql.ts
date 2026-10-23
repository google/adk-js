/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Templates use Python `str.format` syntax (`{name}`, `{{` for a literal brace)
// so the SQL stays byte-identical to adk-python's; render them with
// `formatSqlTemplate` from `./views`.

export const EVAL_VIEW_CTES_SQL = `WITH
  raw_events AS (
    SELECT
      timestamp,
      event_id,
      event_type,
      agent,
      session_id,
      invocation_id,
      user_id,
      content,
      {content_parts_column},
      {attributes_column},
      {latency_ms_column},
      status,
      error_message,
      is_truncated
    FROM
      \`{full_table_id}\`
    WHERE
      session_id IS NOT NULL
      AND invocation_id IS NOT NULL
  ),
  typed_events AS (
    SELECT
      *,
      COALESCE(
        agent, JSON_VALUE(attributes, '$.root_agent_name'), 'root_agent'
      ) AS author,
      JSON_VALUE(content, '$.tool') AS tool_name,
      TO_JSON_STRING(JSON_QUERY(content, '$.args')) AS tool_args_json,
      CASE
        WHEN event_type != 'USER_MESSAGE_RECEIVED' THEN NULL
        WHEN COALESCE(ARRAY_LENGTH(content_parts), 0) > 0 THEN (
          SELECT
            STRING_AGG(p.text, '\\n' ORDER BY p.part_index)
          FROM
            UNNEST(content_parts) AS p
          WHERE
            p.mime_type = 'text/plain'
            AND COALESCE(p.storage_mode, 'INLINE') = 'INLINE'
            AND COALESCE(p.part_attributes, '{{}}') = '{{}}'
            AND p.text IS NOT NULL
            AND p.text NOT IN ('', '[BINARY DATA]', '[UPLOAD FAILED]')
        )
        WHEN NOT REGEXP_CONTAINS(
          COALESCE(
            JSON_VALUE(content, '$.text_summary'),
            JSON_VALUE(content, '$'),
            ''
          ),
          r'^Function response: '
        ) THEN NULLIF(
          COALESCE(
            JSON_VALUE(content, '$.text_summary'), JSON_VALUE(content, '$')
          ),
          ''
        )
        ELSE NULL
      END AS message_text,
      (
        event_type = 'USER_MESSAGE_RECEIVED'
        AND (
          REGEXP_CONTAINS(
            COALESCE(
              JSON_VALUE(content, '$.text_summary'),
              JSON_VALUE(content, '$'),
              ''
            ),
            r'^Function response: '
          )
          OR EXISTS(
            SELECT 1
            FROM UNNEST(content_parts) AS p
            WHERE
              JSON_QUERY(p.part_attributes, '$.function_response')
              IS NOT NULL
          )
        )
      ) AS is_function_response,
      IF(
        event_type = 'AGENT_RESPONSE',
        COALESCE(
          IF(
            JSON_TYPE(JSON_QUERY(content, '$.text_summary')) = 'string'
              AND TRIM(JSON_VALUE(content, '$.text_summary')) != '',
            JSON_VALUE(content, '$.text_summary'),
            NULL
          ),
          NULLIF(JSON_VALUE(content, '$.response'), ''),
          IF(
            JSON_TYPE(JSON_QUERY(content, '$.response'))
              IN ('object', 'array'),
            TO_JSON_STRING(JSON_QUERY(content, '$.response')),
            NULL
          )
        ),
        NULL
      ) AS formatted_response,
      (
        event_type = 'LLM_RESPONSE'
        AND (
          JSON_VALUE(attributes, '$.finish_reason') IS NOT NULL
          OR JSON_VALUE(attributes, '$.cache_type') IS NOT NULL
        )
      ) AS is_final_llm_response,
      SAFE_CAST(JSON_VALUE(content, '$.usage.total') AS INT64) AS usage_total,
      SAFE_CAST(JSON_VALUE(content, '$.usage.prompt') AS INT64)
        AS usage_prompt,
      SAFE_CAST(JSON_VALUE(content, '$.usage.completion') AS INT64)
        AS usage_completion,
      SAFE_CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms
    FROM
      raw_events
  ),
  response_events AS (
    SELECT
      *,
      (
        event_type = 'TOOL_STARTING'
        AND COALESCE(tool_name, '') != 'transfer_to_agent'
      ) AS is_tool_call,
      CASE
        WHEN
          REGEXP_CONTAINS(formatted_response, r"(?s)^text: '.*'$")
          AND NOT REGEXP_CONTAINS(
            formatted_response,
            r" [|] (?:call: |resp: |Executable code |Code execution result )"
          )
          AND NOT REGEXP_CONTAINS(formatted_response, r" [|] other(?: [|] |$)")
          THEN NULLIF(
            REGEXP_REPLACE(
              REGEXP_REPLACE(formatted_response, r"^text: '|'$", ''),
              r"' [|] text: '",
              CHR(10)
            ),
            ''
          )
        WHEN
          NOT REGEXP_CONTAINS(
            formatted_response,
            r"^(?:call: |resp: |Executable code |Code execution result )"
          )
          AND NOT REGEXP_CONTAINS(
            formatted_response, r"^(?:None$|text: '|other(?: [|] |$))"
          )
          THEN NULLIF(formatted_response, '')
      END AS response_text
    FROM
      typed_events
  ),
  annotated_events AS (
    SELECT
      *,
      (
        COUNTIF(is_final_llm_response)
          OVER (PARTITION BY session_id, invocation_id)
      ) > 0 AS turn_has_final_llm_response,
      ROW_NUMBER() OVER (
        PARTITION BY session_id, invocation_id, is_tool_call
        ORDER BY timestamp, event_id
      ) - ROW_NUMBER() OVER (
        PARTITION BY
          session_id, invocation_id, is_tool_call, tool_name, tool_args_json
        ORDER BY timestamp, event_id
      ) AS tool_call_island
    FROM
      response_events
  ),
  trace_events AS (
    SELECT
      session_id,
      invocation_id,
      timestamp,
      event_id,
      event_type,
      user_id,
      agent,
      JSON_VALUE(attributes, '$.root_agent_name') AS root_agent_name,
      status,
      error_message,
      is_truncated,
      message_text,
      response_text,
      is_function_response,
      is_tool_call,
      IF(is_tool_call, NULLIF(tool_name, ''), NULL) AS invoked_tool_name,
      IF(
        is_tool_call,
        COUNT(*) OVER (
          PARTITION BY
            session_id,
            invocation_id,
            is_tool_call,
            tool_name,
            tool_args_json,
            tool_call_island
        ),
        NULL
      ) AS tool_call_run_length,
      (
        event_type = 'LLM_RESPONSE'
        AND (is_final_llm_response OR NOT turn_has_final_llm_response)
      ) AS is_usage_row,
      usage_total,
      usage_prompt,
      usage_completion,
      total_ms,
      CASE
        WHEN event_type = 'USER_MESSAGE_RECEIVED' THEN 1
        WHEN
          event_type IN (
            'TOOL_STARTING',
            'HITL_CREDENTIAL_REQUEST',
            'HITL_CONFIRMATION_REQUEST',
            'HITL_INPUT_REQUEST'
          )
          THEN 2
        WHEN event_type = 'AGENT_TRANSFER' THEN 3
        WHEN
          event_type IN (
            'TOOL_COMPLETED',
            'HITL_CREDENTIAL_REQUEST_COMPLETED',
            'HITL_CONFIRMATION_REQUEST_COMPLETED',
            'HITL_INPUT_REQUEST_COMPLETED'
          )
          THEN 4
        ELSE 5
      END AS event_seq,
      CASE event_type
        WHEN 'USER_MESSAGE_RECEIVED' THEN 'user'
        WHEN 'AGENT_TRANSFER'
          THEN COALESCE(JSON_VALUE(content, '$.from_agent'), author)
        ELSE author
      END AS event_author,
      CASE
        WHEN event_type = 'USER_MESSAGE_RECEIVED' AND message_text IS NOT NULL
          THEN JSON_OBJECT(
            'role', 'user',
            'parts', JSON_ARRAY(JSON_OBJECT('text', message_text))
          )
        WHEN
          (
            is_tool_call
            AND COALESCE(tool_name, '') NOT IN (
              'adk_request_credential',
              'adk_request_confirmation',
              'adk_request_input'
            )
          )
          OR event_type IN (
            'HITL_CREDENTIAL_REQUEST',
            'HITL_CONFIRMATION_REQUEST',
            'HITL_INPUT_REQUEST'
          )
          THEN JSON_OBJECT(
            'role', 'model',
            'parts', JSON_ARRAY(
              JSON_OBJECT(
                'function_call', JSON_OBJECT(
                  'name', COALESCE(tool_name, ''),
                  'args', IF(
                    JSON_TYPE(JSON_QUERY(content, '$.args')) = 'object',
                    JSON_QUERY(content, '$.args'),
                    JSON_OBJECT()
                  )
                )
              )
            )
          )
        WHEN event_type = 'AGENT_TRANSFER'
          THEN JSON_OBJECT(
            'role', 'model',
            'parts', JSON_ARRAY(
              JSON_OBJECT(
                'function_call', JSON_OBJECT(
                  'name', 'transfer_to_agent',
                  'args', JSON_OBJECT(
                    'agent_name',
                    COALESCE(JSON_VALUE(content, '$.to_agent'), '')
                  )
                )
              )
            )
          )
        WHEN
          (
            event_type = 'TOOL_COMPLETED'
            AND COALESCE(tool_name, '') NOT IN (
              'transfer_to_agent',
              'adk_request_credential',
              'adk_request_confirmation',
              'adk_request_input'
            )
          )
          OR event_type IN (
            'HITL_CREDENTIAL_REQUEST_COMPLETED',
            'HITL_CONFIRMATION_REQUEST_COMPLETED',
            'HITL_INPUT_REQUEST_COMPLETED'
          )
          THEN JSON_OBJECT(
            'role', 'user',
            'parts', JSON_ARRAY(
              JSON_OBJECT(
                'function_response', JSON_OBJECT(
                  'name', COALESCE(tool_name, ''),
                  'response', IF(
                    JSON_TYPE(JSON_QUERY(content, '$.result')) = 'object',
                    JSON_QUERY(content, '$.result'),
                    JSON_OBJECT('result', JSON_QUERY(content, '$.result'))
                  )
                )
              )
            )
          )
        WHEN event_type = 'AGENT_RESPONSE' AND response_text IS NOT NULL
          THEN JSON_OBJECT(
            'role', 'model',
            'parts', JSON_ARRAY(JSON_OBJECT('text', response_text))
          )
      END AS event_content
    FROM
      annotated_events
  ),
  turn_rollup AS (
    SELECT
      session_id,
      invocation_id,
      ARRAY_AGG(
        user_id IGNORE NULLS ORDER BY timestamp LIMIT 1
      )[SAFE_OFFSET(0)] AS user_id,
      ARRAY_AGG(
        root_agent_name IGNORE NULLS ORDER BY timestamp LIMIT 1
      )[SAFE_OFFSET(0)] AS first_root_agent_name,
      ARRAY_AGG(
        agent IGNORE NULLS ORDER BY timestamp LIMIT 1
      )[SAFE_OFFSET(0)] AS first_agent,
      MIN(timestamp) AS turn_start_timestamp,
      MAX(timestamp) AS turn_end_timestamp,
      COUNTIF(is_tool_call) AS tool_call_count,
      COUNTIF(event_type = 'TOOL_ERROR') AS tool_error_count,
      COUNTIF(event_type = 'LLM_ERROR') AS llm_error_count,
      COUNTIF(event_type = 'AGENT_ERROR') AS agent_error_count,
      COALESCE(
        LOGICAL_OR(
          status = 'ERROR'
          OR (COALESCE(status, '') != 'OK' AND error_message IS NOT NULL)
          OR (event_type = 'LLM_RESPONSE' AND error_message IS NOT NULL)
        ),
        FALSE
      ) AS has_error,
      LOGICAL_OR(COALESCE(is_truncated, FALSE)) AS has_truncated_content,
      COALESCE(MAX(tool_call_run_length), 0) >= 3 AS has_tool_loop,
      COALESCE(MAX(tool_call_run_length), 0)
        AS max_consecutive_identical_tool_calls,
      COALESCE(
        ARRAY_AGG(
          DISTINCT invoked_tool_name IGNORE NULLS ORDER BY invoked_tool_name
        ),
        ARRAY<STRING>[]
      ) AS distinct_tools_used,
      COALESCE(SUM(IF(is_usage_row, usage_prompt, NULL)), 0)
        AS total_prompt_tokens,
      COALESCE(SUM(IF(is_usage_row, usage_completion, NULL)), 0)
        AS total_completion_tokens,
      COALESCE(SUM(IF(is_usage_row, usage_total, NULL)), 0) AS total_tokens,
      COALESCE(
        MAX(IF(event_type = 'INVOCATION_COMPLETED', total_ms, NULL)),
        MAX(IF(event_type = 'AGENT_COMPLETED', total_ms, NULL))
      ) AS turn_latency_ms,
      (
        COUNTIF(event_type = 'INVOCATION_COMPLETED') > 0
        AND COUNTIF(
          event_type = 'AGENT_RESPONSE' AND response_text IS NOT NULL
        ) = 0
        AND COUNTIF(
          event_type IN (
            'TOOL_PAUSED',
            'HITL_CREDENTIAL_REQUEST',
            'HITL_CONFIRMATION_REQUEST',
            'HITL_INPUT_REQUEST'
          )
        ) > 0
      ) AS is_paused,
      (
        COUNTIF(event_type = 'INVOCATION_COMPLETED') > 0
        AND COUNTIF(
          event_type = 'AGENT_RESPONSE' AND response_text IS NOT NULL
        ) > 0
      ) AS is_complete,
      COUNTIF(
        event_type = 'USER_MESSAGE_RECEIVED' AND message_text IS NOT NULL
      ) > 0 AS has_user_message,
      COUNTIF(is_function_response) > 0 AS has_function_response,
      ARRAY_AGG(
        IF(
          event_content IS NULL,
          NULL,
          JSON_OBJECT(
            'author', event_author,
            'content', event_content,
            'event_time',
            FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', timestamp)
          )
        )
        IGNORE NULLS
        ORDER BY timestamp, event_seq, event_id
      ) AS events
    FROM
      trace_events
    GROUP BY
      session_id,
      invocation_id
  ),
  turns AS (
    SELECT
      *,
      COALESCE(first_root_agent_name, first_agent) AS root_agent,
      ROW_NUMBER() OVER (
        PARTITION BY session_id
        ORDER BY turn_start_timestamp, invocation_id
      ) - 1 AS turn_index,
      IF(
        COALESCE(ARRAY_LENGTH(events), 0) > 0, TO_JSON(events), JSON_ARRAY()
      ) AS events_json,
      (
        has_user_message
        AND is_complete
        AND COALESCE(ARRAY_LENGTH(events), 0) > 0
      ) AS eval_ready,
      (
        (
          has_user_message
          OR (
            has_function_response
            AND COALESCE(
              LAG(is_paused) OVER (
                PARTITION BY session_id
                ORDER BY turn_start_timestamp, invocation_id
              ),
              FALSE
            )
          )
        )
        AND (
          is_complete
          OR (
            is_paused
            AND COALESCE(
              LEAD(has_function_response) OVER (
                PARTITION BY session_id
                ORDER BY turn_start_timestamp, invocation_id
              ),
              FALSE
            )
          )
        )
        AND COALESCE(ARRAY_LENGTH(events), 0) > 0
      ) AS session_turn_eval_ready
    FROM
      turn_rollup
  ),
  agent_rows AS (
    SELECT
      session_id,
      invocation_id,
      agent AS agent_id,
      timestamp,
      IF(
        event_type = 'AGENT_STARTING',
        COALESCE(
          JSON_VALUE(content, '$.text_summary'),
          IF(
            REGEXP_CONTAINS(
              JSON_VALUE(content, '$'),
              r'^(?:<(?:function|bound method) |<.+ at 0x[0-9a-fA-F]+>|functools\\.partial\\()'
            ),
            NULL,
            JSON_VALUE(content, '$')
          ),
          JSON_VALUE(attributes, '$.static_instruction')
        ),
        NULL
      ) AS instruction,
      IF(
        event_type = 'AGENT_STARTING',
        JSON_VALUE(attributes, '$.agent_description'),
        NULL
      ) AS description,
      IF(
        event_type = 'AGENT_STARTING'
        AND JSON_TYPE(JSON_QUERY(attributes, '$.sub_agents')) = 'array',
        JSON_QUERY(attributes, '$.sub_agents'),
        NULL
      ) AS sub_agents,
      IF(
        event_type = 'LLM_REQUEST'
        AND JSON_TYPE(JSON_QUERY(attributes, '$.tools')) = 'array',
        JSON_QUERY(attributes, '$.tools'),
        NULL
      ) AS tool_declarations
    FROM
      raw_events
    WHERE
      agent IS NOT NULL
  ),
  agent_latest AS (
    SELECT
      {scope_columns},
      agent_id,
      ARRAY_AGG(
        instruction IGNORE NULLS ORDER BY timestamp DESC LIMIT 1
      )[SAFE_OFFSET(0)] AS instruction,
      ARRAY_AGG(
        description IGNORE NULLS ORDER BY timestamp DESC LIMIT 1
      )[SAFE_OFFSET(0)] AS description,
      ARRAY_AGG(
        sub_agents IGNORE NULLS ORDER BY timestamp DESC LIMIT 1
      )[SAFE_OFFSET(0)] AS sub_agents,
      ARRAY_AGG(
        tool_declarations IGNORE NULLS ORDER BY timestamp DESC LIMIT 1
      )[SAFE_OFFSET(0)] AS tool_declarations
    FROM
      agent_rows
    GROUP BY
      {scope_columns},
      agent_id
  ),
  agent_tool_declarations AS (
    SELECT
      {scope_columns},
      agent_id,
      ARRAY_AGG(
        IF(
          JSON_TYPE(JSON_QUERY(declaration, '$.parameters')) = 'object',
          JSON_OBJECT(
            'name', JSON_VALUE(declaration, '$.name'),
            'description',
            COALESCE(JSON_VALUE(declaration, '$.description'), ''),
            'parameters_json_schema', JSON_QUERY(declaration, '$.parameters')
          ),
          JSON_OBJECT(
            'name', JSON_VALUE(declaration, '$.name'),
            'description',
            COALESCE(JSON_VALUE(declaration, '$.description'), '')
          )
        )
        ORDER BY declaration_offset
      ) AS function_declarations
    FROM
      agent_latest,
      UNNEST(JSON_QUERY_ARRAY(tool_declarations)) AS declaration
        WITH OFFSET AS declaration_offset
    WHERE
      JSON_VALUE(declaration, '$.name') IS NOT NULL
    GROUP BY
      {scope_columns},
      agent_id
  ),
  session_agent_prompts AS (
    SELECT
      session_id,
      agent AS agent_id,
      ARRAY_AGG(
        IF(
          JSON_TYPE(JSON_QUERY(content, '$.system_prompt')) = 'string'
            AND TRIM(JSON_VALUE(content, '$.system_prompt')) != '',
          JSON_VALUE(content, '$.system_prompt'),
          NULL
        )
        IGNORE NULLS
        ORDER BY timestamp, event_id
        LIMIT 1
      )[SAFE_OFFSET(0)] AS logged_system_prompt
    FROM
      raw_events
    WHERE
      event_type = 'LLM_REQUEST'
      AND agent IS NOT NULL
    GROUP BY
      session_id,
      agent
  ),
  agent_configs AS (
    SELECT
      {scope_columns},
      agent_id,
      JSON_OBJECT(
        'agent_id', agent_id,
        'instruction',
        COALESCE(NULLIF(instruction, ''), logged_system_prompt, ''),
        'description', COALESCE(description, ''),
        'sub_agents', COALESCE(sub_agents, JSON_ARRAY()),
        'tools', IF(
          function_declarations IS NULL,
          JSON_ARRAY(),
          JSON_ARRAY(
            JSON_OBJECT(
              'function_declarations', TO_JSON(function_declarations)
            )
          )
        )
      ) AS agent_config
    FROM
      agent_latest
    LEFT JOIN
      session_agent_prompts
      USING (session_id, agent_id)
    LEFT JOIN
      agent_tool_declarations
      USING ({scope_columns}, agent_id)
  ),
  agent_maps AS (
    SELECT
      {scope_columns},
      JSON_OBJECT(
        ARRAY_AGG(agent_id ORDER BY agent_id),
        ARRAY_AGG(agent_config ORDER BY agent_id)
      ) AS agents
    FROM
      agent_configs
    GROUP BY
      {scope_columns}
  )`;

export const EVAL_SESSION_VIEW_SQL_TEMPLATE = `CREATE OR REPLACE VIEW \`{view_ref}\` AS
{ctes},
  session_rollup AS (
    SELECT
      session_id,
      ARRAY_AGG(
        user_id IGNORE NULLS ORDER BY turn_start_timestamp LIMIT 1
      )[SAFE_OFFSET(0)] AS user_id,
      COALESCE(
        ARRAY_AGG(
          first_root_agent_name IGNORE NULLS
          ORDER BY turn_start_timestamp
          LIMIT 1
        )[SAFE_OFFSET(0)],
        ARRAY_AGG(
          first_agent IGNORE NULLS ORDER BY turn_start_timestamp LIMIT 1
        )[SAFE_OFFSET(0)]
      ) AS root_agent,
      MIN(turn_start_timestamp) AS session_start_timestamp,
      MAX(turn_end_timestamp) AS session_end_timestamp,
      COUNT(DISTINCT invocation_id) AS turn_count,
      SUM(tool_call_count) AS tool_call_count,
      SUM(tool_error_count) AS tool_error_count,
      SUM(llm_error_count) AS llm_error_count,
      SUM(agent_error_count) AS agent_error_count,
      LOGICAL_OR(has_error) AS has_error,
      LOGICAL_OR(has_truncated_content) AS has_truncated_content,
      LOGICAL_OR(has_tool_loop) AS has_tool_loop,
      MAX(max_consecutive_identical_tool_calls)
        AS max_consecutive_identical_tool_calls,
      ARRAY_CONCAT_AGG(distinct_tools_used) AS tools_used_by_turn,
      SUM(total_prompt_tokens) AS total_prompt_tokens,
      SUM(total_completion_tokens) AS total_completion_tokens,
      SUM(total_tokens) AS total_tokens,
      SUM(turn_latency_ms) AS total_latency_ms,
      LOGICAL_AND(session_turn_eval_ready) AS eval_ready,
      ARRAY_AGG(
        JSON_OBJECT(
          'turn_index', turn_index,
          'turn_id', invocation_id,
          'events', events_json
        )
        ORDER BY turn_index
      ) AS turn_traces
    FROM
      turns
    GROUP BY
      session_id
  )
SELECT
  s.session_id AS session_id,
  s.user_id AS user_id,
  s.root_agent AS root_agent,
  s.session_start_timestamp AS session_start_timestamp,
  s.session_end_timestamp AS session_end_timestamp,
  s.turn_count AS turn_count,
  s.tool_call_count AS tool_call_count,
  s.tool_error_count AS tool_error_count,
  s.llm_error_count AS llm_error_count,
  s.agent_error_count AS agent_error_count,
  s.has_error AS has_error,
  s.has_truncated_content AS has_truncated_content,
  s.has_tool_loop AS has_tool_loop,
  s.max_consecutive_identical_tool_calls
    AS max_consecutive_identical_tool_calls,
  ARRAY(
    SELECT DISTINCT tool FROM UNNEST(s.tools_used_by_turn) AS tool ORDER BY tool
  ) AS distinct_tools_used,
  s.total_prompt_tokens AS total_prompt_tokens,
  s.total_completion_tokens AS total_completion_tokens,
  s.total_tokens AS total_tokens,
  s.total_latency_ms AS total_latency_ms,
  s.eval_ready AS eval_ready,
  JSON_OBJECT(
    'agents', COALESCE(m.agents, JSON_OBJECT()),
    'turns', TO_JSON(s.turn_traces)
  ) AS trace
FROM
  session_rollup AS s
LEFT JOIN
  agent_maps AS m
  ON m.session_id = s.session_id
`;

export const EVAL_TURN_VIEW_SQL_TEMPLATE = `CREATE OR REPLACE VIEW \`{view_ref}\` AS
{ctes}
SELECT
  t.session_id AS session_id,
  t.invocation_id AS invocation_id,
  t.turn_index AS turn_index,
  t.user_id AS user_id,
  t.root_agent AS root_agent,
  t.turn_start_timestamp AS turn_start_timestamp,
  t.turn_end_timestamp AS turn_end_timestamp,
  t.tool_call_count AS tool_call_count,
  t.tool_error_count AS tool_error_count,
  t.llm_error_count AS llm_error_count,
  t.agent_error_count AS agent_error_count,
  t.has_error AS has_error,
  t.has_truncated_content AS has_truncated_content,
  t.has_tool_loop AS has_tool_loop,
  t.max_consecutive_identical_tool_calls
    AS max_consecutive_identical_tool_calls,
  t.distinct_tools_used AS distinct_tools_used,
  t.total_prompt_tokens AS total_prompt_tokens,
  t.total_completion_tokens AS total_completion_tokens,
  t.total_tokens AS total_tokens,
  t.turn_latency_ms AS turn_latency_ms,
  t.eval_ready AS eval_ready,
  JSON_OBJECT(
    'agents', COALESCE(m.agents, JSON_OBJECT()),
    'turns', JSON_ARRAY(
      JSON_OBJECT(
        'turn_index', 0,
        'turn_id', t.invocation_id,
        'events', t.events_json
      )
    )
  ) AS trace
FROM
  turns AS t
LEFT JOIN
  agent_maps AS m
  ON m.session_id = t.session_id AND m.invocation_id = t.invocation_id
`;
