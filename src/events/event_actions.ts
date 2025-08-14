/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// TODO: b/425992518 - Replace 'any' with a proper AuthConfig.
type AuthConfig = any;

/**
 * Represents the actions attached to an event.
 */
export class EventActions {
  /**
   * If true, it won't call model to summarize function response.
   * Only used for function_response event.
   */
  skipSummarization?: boolean;

  /**
   * Indicates that the event is updating the state with the given delta.
   */
  stateDelta: {[key: string]: any} = {};

  /**
   * Indicates that the event is updating an artifact. key is the filename,
   * value is the version.
   */
  artifactDelta: {[key: string]: number} = {};

  /**
   * If set, the event transfers to the specified agent.
   */
  transferToAgent?: string;

  /**
   * The agent is escalating to a higher level agent.
   */
  escalate?: boolean;

  /**
   * Authentication configurations requested by tool responses.
   *
   * This field will only be set by a tool response event indicating tool
   * request auth credential.
   * - Keys: The function call id. Since one function response event could
   * contain multiple function responses that correspond to multiple function
   * calls. Each function call could request different auth configs. This id is
   * used to identify the function call.
   * - Values: The requested auth config.
   */
  requestedAuthConfigs: {[key: string]: AuthConfig} = {};

  /**
   * Creates an instance of EventActions.
   */
  constructor(initialData?: Partial<EventActions>) {
    if (initialData) {
      Object.assign(this, initialData);
    }
  }

  /**
   * Serializes the EventActions instance to JSON.
   */
  toJSON(): Omit<EventActions, 'toJSON'> {
    return Object.assign({}, this);
  }

  /**
   * Creates a new EventActions instance from a JSON string
   */
  static fromJSON(source: object|string): EventActions {
    const plainObject =
        typeof source === 'string' ? JSON.parse(source) : source;
    return new EventActions(plainObject as Partial<EventActions>);
  }
}

/**
 * Merges a list of EventActions objects into a single EventActions object.
 *
 * 1. It merges dictionaries (stateDelta, artifactDelta, requestedAuthConfigs)
 * by adding all the properties from each source.
 *
 * 2. For other properties (skipSummarization,transferToAgent, escalate), the
 * last one wins.
 */
export function mergeEventActions(
    sources: Array<Partial<EventActions>>,
    target?: EventActions): EventActions {
  const result: EventActions = new EventActions({});
  if (target) {
    Object.assign(result, target);
  }

  for (const source of sources) {
    if (!source) continue;

    if (source.stateDelta) {
      Object.assign(result.stateDelta, source.stateDelta);
    }
    if (source.artifactDelta) {
      Object.assign(result.artifactDelta, source.artifactDelta);
    }
    if (source.requestedAuthConfigs) {
      Object.assign(result.requestedAuthConfigs, source.requestedAuthConfigs);
    }

    if (source.skipSummarization !== undefined) {
      result.skipSummarization = source.skipSummarization;
    }
    if (source.transferToAgent !== undefined) {
      result.transferToAgent = source.transferToAgent;
    }
    if (source.escalate !== undefined) {
      result.escalate = source.escalate;
    }
  }
  return result;
}
