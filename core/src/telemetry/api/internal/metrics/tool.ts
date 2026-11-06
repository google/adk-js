/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Attributes, Counter, Histogram} from '@opentelemetry/api';

import type {Skill} from '../../../../skills/skill.js';
import {ERROR_TYPE_ATTR, GenAiAttr} from '../common/attributes.js';
import {
  isExperimentalFeatureEnabled,
  type ResolvedTelemetryConfig,
} from '../common/config.js';
import {cachedInstruments, createHistogram} from './meters.js';

const HALLUCINATED = '<hallucinated>';

/** Advisory bucket boundaries for `gen_ai.execute_tool.duration`. */
export const TOOL_DURATION_BUCKETS: readonly number[] = Object.freeze([
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92,
]);

interface ToolInstruments {
  readonly duration: Histogram;
  readonly skillLoads: Counter;
  readonly skillScriptExecutions: Counter;
}

const getToolInstruments = cachedInstruments((meter): ToolInstruments => ({
  duration: createHistogram({
    meter,
    name: 'gen_ai.execute_tool.duration',
    unit: 's',
    description: 'Duration of tool executions.',
    buckets: TOOL_DURATION_BUCKETS,
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
    {
      unit: '1',
      description: 'Number of skill script executions.',
    },
  ),
}));

/** Parameters for {@link recordToolDuration}. */
export interface RecordToolDurationParams {
  readonly agentName: string;
  readonly toolName: string;
  readonly toolType: string;
  readonly durationSeconds: number;
  readonly errorType?: string;
}

/** Records `gen_ai.execute_tool.duration` at the end of a tool call. */
export function recordToolDuration({
  agentName,
  toolName,
  toolType,
  durationSeconds,
  errorType,
}: RecordToolDurationParams): void {
  const attributes: Attributes = {
    [GenAiAttr.AGENT_NAME]: agentName,
    [GenAiAttr.TOOL_NAME]: toolName,
    [GenAiAttr.TOOL_TYPE]: toolType,
    ...(errorType === undefined ? {} : {[ERROR_TYPE_ATTR]: errorType}),
  };
  getToolInstruments().duration.record(durationSeconds, attributes);
}

/** Parameters for {@link recordSkillLoad}. */
export interface RecordSkillLoadParams {
  readonly agentName: string;
  readonly skill?: Skill;
  readonly errorType?: string;
  readonly config: ResolvedTelemetryConfig;
}

/**
 * Records one `adk.experimental.skill.loads` increment when `skills` is
 * enabled, bounding unresolved skill names to `<hallucinated>`.
 */
export function recordSkillLoad({
  agentName,
  skill,
  errorType,
  config,
}: RecordSkillLoadParams): void {
  if (!isExperimentalFeatureEnabled(config, 'skills')) {
    return;
  }
  const attributes: Attributes = {
    [GenAiAttr.AGENT_NAME]: agentName,
    [GenAiAttr.SKILL_NAME]: skill?.frontmatter.name ?? HALLUCINATED,
    ...(errorType === undefined ? {} : {[ERROR_TYPE_ATTR]: errorType}),
  };
  getToolInstruments().skillLoads.add(1, attributes);
}

function hasSkillScript(skill: Skill | undefined, scriptPath: string): boolean {
  const scripts = skill?.resources?.scripts;
  if (!scripts) {
    return false;
  }
  const relativePath = scriptPath.startsWith('scripts/')
    ? scriptPath.slice('scripts/'.length)
    : scriptPath;
  return (
    Object.prototype.hasOwnProperty.call(scripts, relativePath) ||
    Object.prototype.hasOwnProperty.call(scripts, scriptPath)
  );
}

/** Parameters for {@link recordSkillScriptExecution}. */
export interface RecordSkillScriptExecutionParams {
  readonly agentName: string;
  readonly skill?: Skill;
  readonly scriptPath: string;
  readonly config: ResolvedTelemetryConfig;
}

/**
 * Records one `adk.experimental.skill.script.executions` increment when
 * `skills` is enabled, bounding unresolved skill names and script paths to
 * `<hallucinated>`.
 */
export function recordSkillScriptExecution({
  agentName,
  skill,
  scriptPath,
  config,
}: RecordSkillScriptExecutionParams): void {
  if (!isExperimentalFeatureEnabled(config, 'skills')) {
    return;
  }
  const attributes: Attributes = {
    [GenAiAttr.AGENT_NAME]: agentName,
    [GenAiAttr.SKILL_NAME]: skill?.frontmatter.name ?? HALLUCINATED,
    [GenAiAttr.SKILL_RESOURCE_NAME]: hasSkillScript(skill, scriptPath)
      ? scriptPath
      : HALLUCINATED,
  };
  getToolInstruments().skillScriptExecutions.add(1, attributes);
}
