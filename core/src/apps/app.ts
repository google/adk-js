import {BaseAgent} from '../agents/base_agent.js';
import {BasePlugin} from '../plugins/base_plugin.js';

/**
 * The config of the resumability for an application.
 *
 * The "resumability" in ADK refers to the ability to:
 *  1. pause an invocation upon a long-running function call.
 *  2. resume an invocation from the last event, if it's paused or failed midway through.
 *
 * Note: ADK resumes the invocation in a best-effort manner:
 *  1. Tool call to resume needs to be idempotent because we only guarantee an at-least-once behavior once resumed.
 *  2. Any temporary / in-memory state will be lost upon resumption.
 */
export interface ResumabilityConfig {
  /**
   * Whether the app supports agent resumption.
   * If enabled, the feature will be enabled for all agents in the app.
   */
  isResumable: boolean;
}

export interface App {
  name: string;
  rootAgent?: BaseAgent;
  plugins: BasePlugin[];
  resumabilityConfig?: ResumabilityConfig;
}
