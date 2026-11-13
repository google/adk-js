/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The content of a rubric. */
export interface RubricContent {
  /**
   * The property being evaluated, for example "The agent's response is
   * grammatically correct."
   */
  textProperty?: string;
}

/** A single rubric: a testable criterion applied to an agent's behavior. */
export interface Rubric {
  /** Unique identifier for the rubric. */
  rubricId: string;

  /** The actual testable criterion for the rubric. */
  rubricContent: RubricContent;

  /**
   * A description of the rubric that gives details on how the results of the
   * rubric assessment are interpreted.
   */
  description?: string;

  /**
   * A type designator for the rubric, which can inform how it is evaluated or
   * interpreted, for example `TOOL_USE_QUALITY` or `FINAL_RESPONSE_QUALITY`.
   */
  type?: string;
}

/** The score obtained after applying a rubric to the agent's response. */
export interface RubricScore {
  /** The id of the rubric that was assessed. */
  rubricId: string;

  /** Reasoning or rationale for the score. */
  rationale?: string;

  /**
   * Score obtained after assessing the rubric. Optional, as the assessment
   * might not have happened.
   */
  score?: number;
}
