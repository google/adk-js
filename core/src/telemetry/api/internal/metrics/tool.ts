/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Skill} from '../../../../skills/skill.js';
import {ERROR_TYPE_ATTR, GenAiAttr} from '../common/attributes.js';
import {
  isExperimentalFeatureEnabled,
  type ResolvedTelemetryConfig,
} from '../common/config.js';
import {cachedInstruments, createHistogram} from './meters.js';

/**
 * Recorded in place of a model-supplied name that did not resolve, so a name
 * the model made up cannot add a new series.
 */
const HALLUCINATED = '<hallucinated>';

const SCRIPTS_PREFIX = 'scripts/';

const getInstruments = cachedInstruments((meter) => ({
  duration: createHistogram(meter, {
    name: 'gen_ai.execute_tool.duration',
    unit: 's',
    description: 'Duration of tool executions.',
    buckets: [
      0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
      40.96, 81.92,
    ],
  }),
  skillLoads: meter.createCounter('adk.experimental.skill.loads', {
    unit: '1',
    description:
      'Number of times a skill was loaded. Counts the attempt,' +
      ' so a load that resolved no skill is counted too, under its' +
      ' `error.type`.',
  }),
  skillScriptExecutions: meter.createCounter(
    'adk.experimental.skill.script.executions',
    {unit: '1', description: 'Number of skill script executions.'},
  ),
}));

/** Parameters for {@link recordToolMetrics}. */
export interface ToolMetricsParams {
  readonly agentName: string;
  readonly toolName: string;
  readonly toolType: string;
  readonly elapsedSeconds: number;
  /** The type of the error the tool threw or reported, if any. */
  readonly errorType?: string;
}

/** Records the duration of one tool execution. */
export function recordToolMetrics({
  agentName,
  toolName,
  toolType,
  elapsedSeconds,
  errorType,
}: ToolMetricsParams): void {
  getInstruments().duration.record(elapsedSeconds, {
    [GenAiAttr.AGENT_NAME]: agentName,
    [GenAiAttr.TOOL_NAME]: toolName,
    [GenAiAttr.TOOL_TYPE]: toolType,
    ...(errorType === undefined ? {} : {[ERROR_TYPE_ATTR]: errorType}),
  });
}

/** What a skill tool asked for and what it resolved. */
export interface SkillMetricsParams {
  readonly config: ResolvedTelemetryConfig;
  readonly agentName: string;
  /** The skill, if the tool resolved one. */
  readonly skill?: Skill;
}

/** Parameters for {@link recordSkillLoad}. */
export interface SkillLoadMetricsParams extends SkillMetricsParams {
  /** The type of the error the load threw or reported, if any. */
  readonly errorType?: string;
}

/**
 * Records one skill load attempt, whether or not it resolved a skill, when the
 * `skills` feature is enabled.
 */
export function recordSkillLoad({
  config,
  agentName,
  skill,
  errorType,
}: SkillLoadMetricsParams): void {
  if (!isExperimentalFeatureEnabled(config, 'skills')) {
    return;
  }
  getInstruments().skillLoads.add(1, {
    [GenAiAttr.AGENT_NAME]: agentName,
    [GenAiAttr.SKILL_NAME]: skill?.frontmatter.name ?? HALLUCINATED,
    ...(errorType === undefined ? {} : {[ERROR_TYPE_ATTR]: errorType}),
  });
}

/** Parameters for {@link recordSkillScriptExecution}. */
export interface SkillScriptMetricsParams extends SkillMetricsParams {
  /** The script path the model asked for. */
  readonly scriptPath: string;
}

/**
 * Whether `skill` has the script at `scriptPath`, looked up as the script
 * tool does: with any `scripts/` prefix removed, then as given.
 */
function hasScript(skill: Skill, scriptPath: string): boolean {
  const scripts = skill.resources?.scripts;
  if (!scripts) {
    return false;
  }
  const relativePath = scriptPath.startsWith(SCRIPTS_PREFIX)
    ? scriptPath.substring(SCRIPTS_PREFIX.length)
    : scriptPath;
  return (
    Object.hasOwn(scripts, relativePath) || Object.hasOwn(scripts, scriptPath)
  );
}

/**
 * Records one skill script execution when the `skills` feature is enabled.
 *
 * The script path is recorded only when the resolved skill has that script.
 */
export function recordSkillScriptExecution({
  config,
  agentName,
  skill,
  scriptPath,
}: SkillScriptMetricsParams): void {
  if (!isExperimentalFeatureEnabled(config, 'skills')) {
    return;
  }
  getInstruments().skillScriptExecutions.add(1, {
    [GenAiAttr.AGENT_NAME]: agentName,
    [GenAiAttr.SKILL_NAME]: skill?.frontmatter.name ?? HALLUCINATED,
    [GenAiAttr.SKILL_RESOURCE_NAME]:
      skill && hasScript(skill, scriptPath) ? scriptPath : HALLUCINATED,
  });
}
