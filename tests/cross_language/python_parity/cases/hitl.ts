/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Human-in-the-loop cases: the `hitl/*` samples plus the three
 * `workflows/request_input*` samples, which are the workflow-side spelling of
 * the same pause.
 *
 * How a pause is answered here
 * ----------------------------
 * `adk run --replay` is not interactive on either side: `run_input_file`
 * (Python) and `runFromInputFile` (TS) both send every query as a plain-text
 * user turn, so the answer to a pause has to be the NEXT query in `queries`.
 * The upstream `tests/*.json` transcripts answer with a structured
 * `adk_request_input` / `adk_request_confirmation` function response; the
 * queries below are the plain-text spelling of exactly those answers, and the
 * seeded state is the upstream file's (minus the `__session_metadata__` display
 * name, which is dev-UI bookkeeping rather than sample state).
 *
 * That is where the two runtimes are expected to part company, and the reason
 * these cases exist:
 *
 *   - Confirmation. The TS CLI opts into `runConfig.plainTextToolConfirmation`,
 *     so a bare "yes"/"no" immediately after an `adk_request_confirmation` gate
 *     resolves it. adk-python's `_RequestConfirmationLlmRequestProcessor` reads
 *     confirmations ONLY out of structured function responses — the plain-text
 *     mapping in `cli.py` lives in `run_interactively` / `run_once_cli`, neither
 *     of which `--replay` goes through — so on the Python side "yes" is just
 *     another user message.
 *
 *   - Request-input. adk-js resumes a paused workflow across invocations
 *     (`eventsForCurrentRun` walks back over prior runs that ended paused) and
 *     maps a plain-text turn onto the single pending interrupt. adk-python
 *     filters rehydration by `invocation_id`, and a plain-text turn opens a new
 *     one, so the workflow restarts from the top instead of resuming.
 *
 * Both are recorded rather than papered over: the queries are the ones a human
 * would actually type at either CLI, so whatever the run shows is the real
 * behaviour of each runtime.
 */

import type {ParityCase} from '../harness/types.ts';

export const HITL_CASES: ParityCase[] = [
  {
    id: 'hitl_human_in_loop',
    family: 'hitl',
    pySample: 'hitl/human_in_loop',
    tsAgent: 'hitl/human_in_loop',
    // The two upstream transcripts, in one session: under $100 auto-approves
    // via `reimburse`, over $100 goes to the long-running `ask_for_approval`.
    // Neither turn answers a pause — the sample's HITL is a long-running tool
    // id a caller resolves out of band — so this is the one case in the family
    // both CLIs can script identically.
    queries: [
      'Can I get a reimbursement of $15.50 for some coffee?',
      'I would like to request a reimbursement of $150 for a client dinner.',
    ],
  },
  {
    id: 'hitl_human_tool_confirmation',
    family: 'hitl',
    pySample: 'hitl/human_tool_confirmation',
    tsAgent: 'hitl/human_tool_confirmation',
    // No upstream tests/*.json for this sample. Both gates it demonstrates are
    // exercised: `request_time_off` asks for confirmation itself (> 2 days),
    // and `reimburse` gates on the `confirmation_threshold` predicate (> 1000).
    // "yes" is the plain-text answer; see the divergence note at the top.
    queries: [
      'I would like to request 5 days off.',
      'yes',
      'Please reimburse me $2000.',
      'yes',
    ],
  },
  {
    id: 'hitl_request_input_tool',
    family: 'hitl',
    pySample: 'hitl/request_input_tool',
    tsAgent: 'hitl/request_input_tool',
    // From tests/create_support_ticket.json: the first turn leaves description
    // and priority missing, so the model calls `adk_request_input` with a
    // schema for just those two. The upstream answer is the structured
    // function response `{"description": ..., "priority": "HIGH"}`; the
    // scripted equivalent is that same object as the next query.
    queries: [
      'I want to file a technical ticket for a database crash.',
      '{"description": "The MySQL server is throwing OOM errors and restarting repeatedly.", "priority": "HIGH"}',
    ],
  },
  {
    id: 'hitl_tool_confirmation',
    family: 'hitl',
    pySample: 'hitl/tool_confirmation',
    tsAgent: 'hitl/tool_confirmation',
    // tests/transfer_50.json then tests/transfer_200_confirmed.json: below the
    // $100 threshold `transfer_funds` runs straight through, above it the tool
    // raises its own confirmation and "yes" answers it.
    queries: ['Transfer $50 to Alice', 'Transfer $200 to Bob', 'yes'],
  },
  {
    id: 'hitl_tool_confirmation_close_account',
    family: 'hitl',
    pySample: 'hitl/tool_confirmation',
    tsAgent: 'hitl/tool_confirmation',
    // tests/close_account_acc123.json. The other half of the same sample: a
    // static `require_confirmation=True` gate, where the framework (not the
    // tool body) raises `adk_request_confirmation`.
    queries: ['Close account ACC123', 'yes'],
  },

  // --- workflows/request_input*, filed here because they are the same pause.
  {
    id: 'workflow_request_input',
    family: 'workflows',
    pySample: 'workflows/request_input',
    tsAgent: 'workflows/request_input',
    // tests/phone_broke.json, verbatim: the reviewer asks for a shorter draft,
    // the graph routes back to `draft_email`, and the second review approves.
    state: {
      complaint: 'phone broke',
      draft:
        "Subject: Regarding Your Phone Issue\n\nDear [Customer Name],\n\nI'm sorry to hear your phone has broken. I understand how inconvenient this must be.\n\nTo help us investigate and find the best solution for you, please reply with details about your phone (model, purchase date) and what happened. If you have an order number, please include that too.\n\nWe're ready to assist you further once we have this information.\n\nSincerely,\n[Your Name/Company Support Team]",
      feedback: 'shorter',
    },
    queries: ['phone broke', 'shorter', 'approve'],
    // The drafted email is free model text and never compares byte for byte.
    volatileStateKeys: ['draft'],
  },
  {
    id: 'workflow_request_input_reject',
    family: 'workflows',
    pySample: 'workflows/request_input',
    tsAgent: 'workflows/request_input',
    // tests/phone_broke_reject.json: the `rejected` route, which the revise
    // transcript above never reaches. That file seeds no state.
    queries: ['phone broke', 'reject'],
    volatileStateKeys: ['draft'],
  },
  {
    id: 'workflow_request_input_advanced',
    family: 'workflows',
    pySample: 'workflows/request_input_advanced',
    tsAgent: 'workflows/request_input_advanced',
    // tests/2_sick_days.json, verbatim. Two days is over the auto-approve
    // threshold, so `evaluate_request` returns a `RequestInput` carrying the
    // request as payload and `TimeOffDecision` as the response schema. The
    // upstream answer is `{"result": "{\"approved\": true}"}` — the JSON
    // decision as text, which is what the scripted query below is.
    state: {request: {days: 2, reason: 'sick days'}},
    queries: ['2 sick days', '{"approved": true}'],
    // `reason` is whatever the extractor model wrote ("sick" vs "sick days").
    volatileStateKeys: ['request'],
  },
  {
    id: 'workflow_request_input_rerun',
    family: 'workflows',
    pySample: 'workflows/request_input_rerun',
    tsAgent: 'workflows/request_input_rerun',
    // tests/phone_broke.json for the rerun variant: same transcript as
    // `workflow_request_input`, but the reviewing node re-runs on resume and
    // reads the answer from `resume_inputs['human_review']` instead of
    // receiving it as its input.
    state: {
      complaint: 'phone broke',
      draft:
        "Subject: Regarding Your Broken Phone\n\nDear [Customer Name],\n\nWe're very sorry to hear your phone has broken. We understand this is frustrating, and we want to help resolve it for you as quickly as possible.\n\nTo assist you best, please reply with some additional details:\n*   Your phone's model\n*   When you purchased it\n*   A brief description of what happened\n*   Whether it is currently under warranty\n\nYou can also find immediate support and repair options on our website here: [Link to Repair/Support Page]\n\nAlternatively, please feel free to call us directly at [Phone Number] if you prefer to speak with someone.\n\nWe appreciate your patience and look forward to helping.\n\nSincerely,\n\nThe [Your Company Name] Team",
      feedback: 'shorter',
    },
    queries: ['phone broke', 'shorter', 'approve'],
    volatileStateKeys: ['draft'],
  },
];
