/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inputs handed to a tool call that is being resumed after it paused for them,
 * keyed by the id of the interrupt that asked for each one. JSON-serializable.
 *
 * Deliberately separate from `ToolConfirmation`. Both travel the same
 * route — built by a resume processor, threaded through `handleFunctionCallList`
 * onto the tool context — but they say different things. A `ToolConfirmation`
 * says a human looked at an action and approved it, and the confirmation gate
 * runs a tool on the strength of that. `ResumeInputs` says only that the user
 * answered a question the tool asked; it carries no authority and cannot
 * satisfy a gate, which is why it has no `confirmed` field to set.
 *
 * Named here rather than left as a bare mapping so the distinction above has
 * somewhere to live, but the shape mirrors `Context.resume_inputs` in
 * `google/adk-python` (`agents/context.py`): the same flat mapping keyed by
 * interrupt id, defaulting to empty rather than absent.
 *
 * @experimental  (Experimental, subject to change)
 */
export type ResumeInputs = Record<string, unknown>;
