/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Attributes, Span} from '@opentelemetry/api';

import type {Event} from '../../../../events/event.js';
import type {Skill} from '../../../../skills/skill.js';
import type {BaseTool} from '../../../../tools/base_tool.js';
import {
  AdkAttr,
  ERROR_TYPE_ATTR,
  GcpAttr,
  GenAiAttr,
} from '../common/attributes.js';
import type {ResolvedTelemetryConfig} from '../common/config.js';
import {shouldAddContentToSpans} from '../common/config.js';
import {redactCredentialSecrets} from '../common/redaction.js';
import {safeJsonSerialize} from '../common/serialization.js';

const UNSPECIFIED = '<not specified>';

/** The outcome of one tool call, as recorded on its `execute_tool` span. */
export type ToolCallOutcome =
  | {
      readonly kind: 'response';
      readonly functionResponseEvent?: Event;
      /** An error type the tool reported in its response instead of throwing. */
      readonly errorType?: string;
    }
  | {readonly kind: 'error'; readonly errorType: string};

/** Parameters for {@link buildToolCallAttributes}. */
export interface ToolCallAttributesParams {
  readonly tool: BaseTool;
  readonly args: Record<string, unknown>;
  readonly agentName?: string;
  readonly outcome: ToolCallOutcome;
  readonly config: ResolvedTelemetryConfig;
}

function serializeToolResult(result: unknown): string {
  try {
    return safeJsonSerialize(redactCredentialSecrets(result));
  } catch {
    return '<not serializable>';
  }
}

/**
 * Builds the attributes of an `execute_tool` span.
 *
 * The call arguments and result are message content, so they are recorded
 * only when content capture includes spans, and the result has credential
 * secrets removed.
 */
export function buildToolCallAttributes({
  tool,
  args,
  agentName,
  outcome,
  config,
}: ToolCallAttributesParams): Attributes {
  const functionResponseEvent =
    outcome.kind === 'response' ? outcome.functionResponseEvent : undefined;
  const functionResponse =
    functionResponseEvent?.content?.parts?.[0]?.functionResponse;
  const errorType = outcome.errorType;
  const captureContent = shouldAddContentToSpans(config);
  const result = functionResponse?.response;

  return {
    [GenAiAttr.OPERATION_NAME]: 'execute_tool',
    [GenAiAttr.TOOL_DESCRIPTION]: tool.description,
    [GenAiAttr.TOOL_NAME]: tool.name,
    [GenAiAttr.TOOL_TYPE]: tool.constructor.name,
    ...(agentName ? {[GenAiAttr.AGENT_NAME]: agentName} : {}),
    ...(errorType === undefined ? {} : {[ERROR_TYPE_ATTR]: errorType}),
    [GenAiAttr.TOOL_CALL_ID]: functionResponse?.id ?? UNSPECIFIED,
    ...(functionResponseEvent
      ? {[GcpAttr.EVENT_ID]: functionResponseEvent.id}
      : {}),
    ...(captureContent
      ? {[GenAiAttr.TOOL_CALL_ARGUMENTS]: safeJsonSerialize(args)}
      : {}),
    ...(captureContent && result !== undefined && result !== null
      ? {[GenAiAttr.TOOL_CALL_RESULT]: serializeToolResult(result)}
      : {}),
  };
}

/** Builds the attributes of an `execute_tool (merged)` span. */
export function buildMergedToolCallsAttributes(
  responseEventId: string,
): Attributes {
  return {
    [GenAiAttr.OPERATION_NAME]: 'execute_tool',
    [GenAiAttr.TOOL_NAME]: '(merged tools)',
    [GenAiAttr.TOOL_DESCRIPTION]: '(merged tools)',
    [GenAiAttr.TOOL_CALL_ID]: responseEventId,
    [GcpAttr.EVENT_ID]: responseEventId,
  };
}

/** What a skill tool reported about the skill it worked on. */
export interface SkillReport {
  /** The skill name the tool was asked for, which may not exist. */
  readonly skillName: string;
  /** The resource or script path, for a resource load or a script run. */
  readonly resourceName?: string;
  /** Whether the tool loaded the skill itself, as opposed to part of it. */
  readonly isSkillLoad: boolean;
  /** The skill, once the tool has resolved it. */
  readonly skill?: Skill;
}

/** Names an `execute_tool` span after the skill and resource it touched. */
export function buildSkillSpanName(
  toolName: string,
  report: SkillReport,
): string {
  return report.resourceName === undefined
    ? `execute_tool ${toolName} ${report.skillName}`
    : `execute_tool ${toolName} ${report.skillName} ${report.resourceName}`;
}

/** Builds the skill attributes of an `execute_tool` span. */
export function buildSkillAttributes(report: SkillReport): Attributes {
  const {skill} = report;
  const additionalTools = skill?.frontmatter.metadata?.['adk_additional_tools'];
  return {
    [GenAiAttr.SKILL_NAME]: report.skillName,
    ...(skill
      ? {[GenAiAttr.SKILL_DESCRIPTION]: skill.frontmatter.description}
      : {}),
    ...(report.resourceName === undefined
      ? {}
      : {[GenAiAttr.SKILL_RESOURCE_NAME]: report.resourceName}),
    ...(report.isSkillLoad && skill && Array.isArray(additionalTools)
      ? {
          [AdkAttr.SKILL_ADDITIONAL_TOOLS]: additionalTools.filter(
            (name): name is string => typeof name === 'string',
          ),
        }
      : {}),
  };
}

/** Records a skill on its `execute_tool` span: the span name and attributes. */
export function setSkillSpanAttributes(
  span: Span,
  toolName: string,
  report: SkillReport,
): void {
  span.updateName(buildSkillSpanName(toolName, report));
  span.setAttributes(buildSkillAttributes(report));
}
