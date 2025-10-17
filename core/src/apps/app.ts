
import { BaseAgent, isAdkAgentInstance } from '../agents/base_agent.js';
import { BaseEventsSummarizer } from './base_events_summarizer.js';
import { BasePlugin } from '../plugins/base_plugin.js';

/**
 * The config of the resumability for an application.

  The "resumability" in ADK refers to the ability to:
  1. pause an invocation upon a long running function call.
  2. resume an invocation from the last event, if it's paused or failed midway
  through.

  Note: ADK resumes the invocation in a best-effort manner:
  1. Tool call to resume needs to be idempotent because we only guarantee
  an at-least-once behavior once resumed.
  2. Any temporary / in-memory state will be lost upon resumption.
  */
export interface ResumabilityConfig {
  /**
   * Whether the app supports agent resumption.
If enabled, the feature will be enabled for all agents in the app.
   */
  isResumable: boolean;
}

/**
 * The config of event compaction for an application.
 */
export interface EventsCompactionConfig {
  summarizer: BaseEventsSummarizer;
  /**
   * The number of *new* user-initiated invocations that, once fully
   * represented in the session's events, will trigger a compaction.
   */
  compactionInterval: number;
  /**
   * The number of preceding invocations to include from the
   * end of the last compacted range. This creates an overlap between consecutive
   * compacted summaries, maintaining context.
   */
  overlapSize: number;
}

/**
 * Represents an LLM-backed agentic application.
*
*  An `App` is the top-level container for an agentic system powered by LLMs.
*  It manages a root agent (`root_agent`), which serves as the root of an agent
*  tree, enabling coordination and communication across all agents in the
*  hierarchy.
*  The `plugins` are application-wide components that provide shared capabilities
*  and services to the entire system.
*/
export interface App {
  /** The name of the application. */
  name: string;

  /** The root agent in the application. One app can only have one root agent. */
  rootAgent: BaseAgent;

  /** The plugins used in the application. */
  plugins: BasePlugin[];

  /** The config of event compaction for the application. */
  eventsCompactionConfig?: EventsCompactionConfig;

  /** The config of the resumability for the application. If configured, will be applied to all agents in the app. */
  resumabilityConfig?: ResumabilityConfig;
}

export function isAdkAppInstance(obj: unknown): obj is App {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  if (!('rootAgent' in obj) || !('name' in obj) || !('plugins' in obj)) {
    return false;
  }

  return isAdkAgentInstance((obj as App).rootAgent) && typeof (obj as App).name === 'string' && Array.isArray((obj as App).plugins);
}