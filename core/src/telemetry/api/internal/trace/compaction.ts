/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Attributes, Span} from '@opentelemetry/api';

import {isCompactedEvent} from '../../../../events/compacted_event.js';
import type {Event} from '../../../../events/event.js';
import {toSnakeCaseName} from '../../../../utils/case_utils.js';
import {GenAiAttr} from '../common/attributes.js';
import {guessGeminiSystemName} from '../common/provider_name.js';
import {getTracer} from './tracer.js';

/** Parameters for {@link startCompactionSpan}. */
export interface StartCompactionSpanParams {
  readonly sessionId: string;
  readonly trigger: string;
}

/** Starts a `compact_events {trigger}` span under the active context. */
export function startCompactionSpan({
  sessionId,
  trigger,
}: StartCompactionSpanParams): Span {
  const triggerName = toSnakeCaseName(trigger);
  return getTracer().startSpan(`compact_events ${triggerName}`, {
    attributes: {
      [GenAiAttr.SYSTEM]: guessGeminiSystemName(),
      [GenAiAttr.OPERATION_NAME]: 'compact_events',
      [GenAiAttr.CONVERSATION_ID]: sessionId,
      [GenAiAttr.COMPACTION_TRIGGER]: triggerName,
    },
  });
}

/**
 * Builds the result attributes of a compaction from the session events before
 * and after it ran: the summary event it added, the time range it covers, and
 * how many of the earlier events fall in that range.
 */
export function buildCompactionResultAttributes(
  eventsBefore: readonly Event[],
  eventsAfter: readonly Event[],
): Attributes {
  const before = new Set(eventsBefore);
  const compactedEvent = eventsAfter
    .filter((event) => !before.has(event))
    .find(isCompactedEvent);
  if (!compactedEvent) {
    return {};
  }
  const {startTime, endTime} = compactedEvent;
  return {
    [GenAiAttr.COMPACTION_EVENT_COUNT]: eventsBefore.filter(
      (event) => event.timestamp >= startTime && event.timestamp <= endTime,
    ).length,
    [GenAiAttr.COMPACTION_RESULT_EVENT_ID]: compactedEvent.id,
    [GenAiAttr.COMPACTION_START_TIMESTAMP]: startTime,
    [GenAiAttr.COMPACTION_END_TIMESTAMP]: endTime,
  };
}
