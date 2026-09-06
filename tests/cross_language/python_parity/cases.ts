/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The parity case catalogue.
 *
 * Every case names an adk-python sample under `contributing/samples` and, when
 * one exists, the TS counterpart under `agents/ts`. Cases without a TS port
 * still belong here: "adk-js has no equivalent for this" is a parity finding,
 * and the report lists them with the reason.
 *
 * Split per family so the files can be edited independently.
 */

import type {ParityCase} from './harness/types.ts';

import {CONTEXT_CASES} from './cases/context_management.ts';
import {CORE_CASES} from './cases/core.ts';
import {HITL_CASES} from './cases/hitl.ts';
import {LEGACY_WORKFLOW_CASES} from './cases/legacy_workflows.ts';
import {MISC_CASES} from './cases/misc.ts';
import {MULTI_AGENT_CASES} from './cases/multi_agent.ts';
import {PATTERN_CASES} from './cases/patterns_plugins.ts';
import {TOOL_CASES} from './cases/tools.ts';
import {WORKFLOW_CASES} from './cases/workflows.ts';

export const CASES: ParityCase[] = [
  ...CORE_CASES,
  ...TOOL_CASES,
  ...MULTI_AGENT_CASES,
  ...LEGACY_WORKFLOW_CASES,
  ...WORKFLOW_CASES,
  ...HITL_CASES,
  ...PATTERN_CASES,
  ...CONTEXT_CASES,
  ...MISC_CASES,
];
