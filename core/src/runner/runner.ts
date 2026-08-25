/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, createPartFromText, Modality, Part} from '@google/genai';
import {context, trace} from '@opentelemetry/api';

import {BaseAgent, isBaseAgent} from '../agents/base_agent.js';
import {reservedFunctionCallName} from '../agents/framework_function_calls.js';
import {findMatchingFunctionCall} from '../agents/functions.js';
import {
  InvocationContext,
  newInvocationContextId,
  requireAgent,
} from '../agents/invocation_context.js';
import {LiveRequestQueue} from '../agents/live_request_queue.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {createRunConfig, RunConfig} from '../agents/run_config.js';
import {App} from '../apps/app.js';
import {ResumabilityConfig} from '../apps/resumability_config.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {ScopedArtifactService} from '../artifacts/scoped_artifact_service.js';

import {BaseCredentialService} from '../auth/credential_service/base_credential_service.js';
import {
  BuiltInCodeExecutor,
  isBuiltInCodeExecutor,
} from '../code_executors/built_in_code_executor.js';
import {createEvent, Event} from '../events/event.js';
import {createEventActions} from '../events/event_actions.js';
import {BaseMemoryService} from '../memory/base_memory_service.js';
import {BasePlugin} from '../plugins/base_plugin.js';
import {PluginManager} from '../plugins/plugin_manager.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {CompositeSessionKey, Session} from '../sessions/session.js';
import {
  runAsyncGeneratorWithOtelContext,
  tracer,
} from '../telemetry/tracing.js';
import {BaseToolset, isBaseToolset} from '../tools/base_toolset.js';
import {logger} from '../utils/logger.js';
import {isGemini2OrAbove} from '../utils/model_name.js';
import type {RunnableNode} from '../workflow/graph.js';
import {
  asRunnableRoot,
  RunnableRoot,
  runNodeAsInvocation,
} from '../workflow/run_node_as_invocation.js';

/**
 * The configuration parameters for the Runner.
 */
export interface RunnerConfig {
  /**
   * The application object. If provided, `appName`, `agent`, and `plugins` will default from this app.
   */
  app?: App;

  /**
   * The application name. Required if `app` is not provided.
   */
  appName?: string;

  /**
   * The agent or workflow to run. Required if `app` is not provided.
   *
   * A bare node — a `Workflow`, most usefully — is accepted as the root and
   * driven directly, so a graph does not have to be wrapped by hand to be run.
   * The accepted set is the one an edge takes: any other node-like value
   * becomes the single node of a one-node workflow. Mirrors adk-python, whose
   * `Runner.agent` is typed `BaseNode`.
   */
  agent?: RunnableNode;

  /**
   * An optional list of plugins to apply globally across all agents.
   */
  plugins?: BasePlugin[];

  /**
   * An optional service for storing and retrieving artifacts.
   */
  artifactService?: BaseArtifactService;

  /**
   * The service for managing sessions.
   */
  sessionService: BaseSessionService;

  /**
   * An optional service for storing and querying agent memory.
   */
  memoryService?: BaseMemoryService;

  /**
   * An optional service for managing authentication credentials.
   */
  credentialService?: BaseCredentialService;

  /**
   * An optional resumability configuration applied to the runner.
   */
  resumabilityConfig?: ResumabilityConfig;
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all Runner instances.
 */
const RUNNER_SIGNATURE_SYMBOL = Symbol.for('google.adk.runner');

/**
 * Type guard to check if an object is an instance of Runner.
 * @param obj The object to check.
 * @returns True if the object is an instance of Runner, false otherwise.
 */
export function isRunner(obj: unknown): obj is Runner {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    RUNNER_SIGNATURE_SYMBOL in obj &&
    obj[RUNNER_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Orchestrates agent execution for a given application.
 *
 * The Runner manages the full lifecycle of an agent invocation: it loads the
 * session, invokes plugin callbacks, runs the root agent, and yields the
 * resulting events. Use {@link InMemoryRunner} for quick prototyping without
 * external services.
 *
 * Example:
 * ```typescript
 * const runner = new Runner({
 *   appName: 'my_app',
 *   agent: myAgent,
 *   sessionService: new InMemorySessionService(),
 * });
 *
 * for await (const event of runner.runAsync({
 *   userId: 'user1',
 *   sessionId: 'session1',
 *   newMessage: {parts: [{text: 'Hello'}]},
 * })) {
 *   console.log(event);
 * }
 * ```
 */
export class Runner {
  readonly [RUNNER_SIGNATURE_SYMBOL] = true;
  readonly appName: string;
  /**
   * The root being run: an agent, or a bare node (a `Workflow`) that the
   * runner drives directly.
   */
  readonly agent: RunnableRoot;
  readonly pluginManager: PluginManager;
  readonly artifactService?: BaseArtifactService;
  readonly sessionService: BaseSessionService;
  readonly memoryService?: BaseMemoryService;
  readonly credentialService?: BaseCredentialService;
  readonly resumabilityConfig?: ResumabilityConfig;

  /**
   * Creates a new Runner instance.
   *
   * @param input The configuration for the runner.
   */
  constructor(input: RunnerConfig) {
    const appName = input.app?.name ?? input.appName;
    const agent = input.app?.rootAgent ?? input.agent;
    if (!agent) {
      throw new Error(
        'agent must be provided in runner constructor (or via app.rootAgent)',
      );
    }
    this.appName = appName!;
    // A workflow is kept as itself rather than wrapped: the runner drives a
    // node directly (see `runRoot`), so there is no agent to manufacture.
    this.agent = asRunnableRoot(agent);
    const appPlugins = input.app?.plugins ?? [];
    const configPlugins = input.plugins ?? [];
    this.pluginManager = new PluginManager([...appPlugins, ...configPlugins]);
    this.artifactService = input.artifactService;
    this.sessionService = input.sessionService;
    this.memoryService = input.memoryService;
    this.credentialService = input.credentialService;
    this.resumabilityConfig =
      input.app?.resumabilityConfig ?? input.resumabilityConfig;
  }

  /**
   * Runs the agent with a new, ephemeral session.
   *
   * @param params.userId The user ID of the session.
   * @param params.newMessage A new message to append to the session.
   * @param params.stateDelta An optional state delta to apply to the session.
   * @param params.runConfig The run config for the agent.
   * @yields The Events generated by the agent.
   */
  async *runEphemeral(params: {
    userId: string;
    newMessage: Content;
    stateDelta?: Record<string, unknown>;
    runConfig?: RunConfig;
    customMetadata?: Record<string, unknown>;
  }): AsyncGenerator<Event, void, undefined> {
    const session = await this.sessionService.createSession({
      appName: this.appName,
      userId: params.userId,
    });
    const sessionId = session.id;

    try {
      yield* this.runAsync({
        userId: params.userId,
        sessionId,
        newMessage: params.newMessage,
        stateDelta: params.stateDelta,
        runConfig: params.runConfig,
        customMetadata: params.customMetadata,
      });
    } finally {
      await this.sessionService.deleteSession({
        appName: this.appName,
        userId: params.userId,
        sessionId,
      });
    }
  }

  /**
   * Runs the agent with the given message, and returns an async generator of
   * events.
   *
   * @param params.userId The user ID of the session.
   * @param params.sessionId The session ID of the session.
   * @param params.newMessage A new message to append to the session.
   * @param params.stateDelta An optional state delta to apply to the session.
   * @param params.runConfig The run config for the agent.
   * @yields The events generated by the agent.
   */
  // TODO - b/425992518: user, sessionId, and runConfig can be internalized.
  async *runAsync(params: {
    userId: string;
    sessionId: string;
    newMessage: Content;
    stateDelta?: Record<string, unknown>;
    runConfig?: RunConfig;
    abortSignal?: AbortSignal;
    customMetadata?: Record<string, unknown>;
  }): AsyncGenerator<Event, void, undefined> {
    const {userId, sessionId, stateDelta} = params;
    const runConfig = createRunConfig(params.runConfig);
    let newMessage = params.newMessage;
    if (newMessage && !newMessage.role) {
      newMessage.role = 'user';
    }
    rejectReservedFunctionCalls(newMessage);

    // =========================================================================
    // Setup the session and invocation context
    // =========================================================================
    const span = tracer.startSpan('invocation');
    const ctx = trace.setSpan(context.active(), span);
    try {
      yield* runAsyncGeneratorWithOtelContext<Runner, Event>(
        ctx,
        this,
        async function* () {
          const session = await this.sessionService.getSession({
            appName: this.appName,
            userId,
            sessionId,
          });

          if (params.abortSignal?.aborted) {
            return;
          }

          if (!session) {
            if (!this.appName) {
              throw new Error(
                `Session lookup failed: appName must be provided in runner constructor (or via app.name)`,
              );
            }
            throw new Error(`Session not found: ${sessionId}`);
          }

          if (runConfig.supportCfc && isLlmAgent(this.agent)) {
            const modelName = this.agent.canonicalModel.model;
            if (!isGemini2OrAbove(modelName)) {
              throw new Error(
                `CFC is not supported for model: ${
                  modelName
                } in agent: ${this.agent.name}`,
              );
            }

            if (!isBuiltInCodeExecutor(this.agent.codeExecutor)) {
              this.agent.codeExecutor = new BuiltInCodeExecutor();
            }
          }

          const invocationContext = new InvocationContext({
            artifactService: this.artifactService
              ? new ScopedArtifactService(
                  this.artifactService,
                  this.appName,
                  userId,
                  sessionId,
                )
              : undefined,
            sessionService: this.sessionService,
            memoryService: this.memoryService,
            credentialService: this.credentialService,
            invocationId: newInvocationContextId(),
            agent: isBaseAgent(this.agent) ? this.agent : undefined,
            session,
            userContent: newMessage,
            runConfig,
            a2aMetadata: runConfig.a2aMetadata,
            pluginManager: this.pluginManager,
            abortSignal: params.abortSignal,
          });

          // =========================================================================
          // Preprocess plugins on user message
          // =========================================================================
          const pluginUserMessage =
            await this.pluginManager.runOnUserMessageCallback({
              userMessage: newMessage,
              invocationContext,
            });

          if (params.abortSignal?.aborted) {
            return;
          }

          if (pluginUserMessage) {
            newMessage = pluginUserMessage as Content;
          }

          // =========================================================================
          // Append user message to session
          // =========================================================================
          if (newMessage) {
            if (!newMessage.parts?.length) {
              throw new Error('No parts in the newMessage.');
            }

            // Directly saves the artifacts (if applicable) in the user message and
            // replaces the artifact data with a file name placeholder.
            // TODO - b/425992518: fix Runner<>>ArtifactService leaky abstraction.
            if (runConfig.saveInputBlobsAsArtifacts) {
              newMessage = await this.saveArtifacts(
                invocationContext.invocationId,
                session.userId,
                session.id,
                newMessage,
              );
              if (params.abortSignal?.aborted) {
                return;
              }
            }
            // Append the user message to the session with optional state delta.
            await this.sessionService.appendEvent({
              session,
              event: createEvent({
                invocationId: invocationContext.invocationId,
                author: 'user',
                actions: stateDelta
                  ? createEventActions({stateDelta})
                  : undefined,
                content: newMessage,
                customMetadata: params.customMetadata,
              }),
            });
            if (params.abortSignal?.aborted) {
              return;
            }
          }

          // =========================================================================
          // Determine which agent should handle the workflow resumption.
          // =========================================================================
          // Only meaningful for an agent root: this resolves an event author
          // against the agent tree, and a node subtree is not in that tree.
          if (isBaseAgent(this.agent)) {
            invocationContext.agent = this.determineAgentForResumption(
              session,
              this.agent,
            );
          }

          // =========================================================================
          // Run the agent with the plugins (aka hooks to apply in the lifecycle)
          // =========================================================================
          if (newMessage) {
            // =========================================================================
            // Run the agent with the plugins (aka hooks to apply in the lifecycle)
            // =========================================================================
            // Step 1: Run the before_run callbacks to see if we should early exit.
            const beforeRunCallbackResponse =
              await this.pluginManager.runBeforeRunCallback({
                invocationContext,
              });
            if (params.abortSignal?.aborted) {
              return;
            }

            if (beforeRunCallbackResponse) {
              const earlyExitEvent = createEvent({
                invocationId: invocationContext.invocationId,
                author: 'model',
                content: beforeRunCallbackResponse,
              });
              // TODO: b/447446338 - In the future, do *not* save live call audio
              // content to session This is a feature in Python ADK
              await this.sessionService.appendEvent({
                session,
                event: earlyExitEvent,
              });
              if (params.abortSignal?.aborted) {
                return;
              }

              yield earlyExitEvent;
            } else {
              // Step 2: Otherwise continue with normal execution
              for await (const event of this.runRoot(invocationContext)) {
                if (params.abortSignal?.aborted) {
                  return;
                }

                // Step 3: Run the on_event callbacks before persisting so callback
                // changes are stored in the session and match the streamed event.
                const modifiedEvent =
                  await this.pluginManager.runOnEventCallback({
                    invocationContext,
                    event,
                  });
                const outputEvent = modifiedEvent
                  ? {
                      ...modifiedEvent,
                      id: event.id,
                      invocationId: event.invocationId,
                      timestamp: event.timestamp,
                      author: modifiedEvent.author || event.author,
                      branch: modifiedEvent.branch ?? event.branch,
                    }
                  : event;
                if (!event.partial) {
                  await this.sessionService.appendEvent({
                    session,
                    event: outputEvent,
                  });
                }
                if (params.abortSignal?.aborted) {
                  return;
                }

                yield outputEvent;
              }
              // Step 4: Run the after_run callbacks to optionally modify the context.
              await this.pluginManager.runAfterRunCallback({invocationContext});
              if (params.abortSignal?.aborted) {
                return;
              }
            }
          }
        },
      );
    } finally {
      span.end();
      const toolsets = isBaseAgent(this.agent)
        ? getAllToolsets(this.agent)
        : [];
      await Promise.allSettled(toolsets.map((t) => t.close()));
    }
  }

  /**
   * Runs whatever this runner was given as its root.
   *
   * An agent is run through `runAsync`, as always. A bare node — a `Workflow`
   * handed to the runner directly — is driven by {@link runNodeAsInvocation}.
   *
   * Only the execution differs. Everything around it (the run callbacks, event
   * persistence, cancellation) is shared, so the node path cannot drift from
   * the agent path on the things that are not about execution. adk-python has
   * two separate loops here and a TODO noting its node one lacks tracing and
   * plugins; there is nothing to lack if there is only one loop.
   */
  private async *runRoot(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    if (isBaseAgent(this.agent)) {
      yield* requireAgent(invocationContext).runAsync(invocationContext);
      return;
    }
    yield* runNodeAsInvocation(this.agent, invocationContext);
  }

  /**
   * Saves artifacts from the message parts and replaces the inline data with
   * a file name placeholder and optional file reference.
   *
   * @param invocationId The current invocation ID.
   * @param userId The user ID of the session.
   * @param sessionId The session ID of the session.
   * @param message The message containing parts to process.
   */
  private async saveArtifacts(
    invocationId: string,
    userId: string,
    sessionId: string,
    message: Content,
  ): Promise<Content> {
    if (!this.artifactService || !message.parts?.length) {
      return message;
    }

    const sessionKey: CompositeSessionKey = {
      appName: this.appName,
      userId,
      sessionId,
    };
    const newParts: Part[] = [];
    let modified = false;

    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i];
      if (!part.inlineData) {
        newParts.push(part);
        continue;
      }

      try {
        const inlineData = part.inlineData;
        const fileName =
          inlineData.displayName || `artifact_${invocationId}_${i}`;

        const version = await this.artifactService.saveArtifact({
          ...sessionKey,
          filename: fileName,
          artifact: part,
        });

        newParts.push(createPartFromText(`[Uploaded Artifact: "${fileName}"]`));

        try {
          const artifactVersion = await this.artifactService.getArtifactVersion(
            {
              ...sessionKey,
              filename: fileName,
              version,
            },
          );
          if (
            artifactVersion?.canonicalUri &&
            /^(gs|https?):/i.test(artifactVersion.canonicalUri)
          ) {
            newParts.push({
              fileData: {
                fileUri: artifactVersion.canonicalUri,
                mimeType: artifactVersion.mimeType || inlineData.mimeType || '',
                displayName: fileName,
              },
            });
          }
        } catch (error) {
          logger.warn(
            `Failed to resolve artifact version for ${fileName}:`,
            error,
          );
        }
        modified = true;
        logger.info(`Successfully saved artifact: ${fileName}`);
      } catch (error) {
        logger.error(`Failed to save artifact for part ${i}:`, error);
        newParts.push(part);
      }
    }

    if (!modified) {
      return message;
    }

    return {
      ...message,
      parts: newParts,
    };
  }

  /**
   * Determines the next agent to run to continue the session. This is primarily
   * used for session resumption.
   */
  /**
   * Determines the next agent to run to continue the session. This is primarily
   * used for session resumption across tool and LRO boundaries.
   */
  private determineAgentForResumption(
    session: Session,
    rootAgent: BaseAgent,
  ): BaseAgent {
    return determineAgentForResumption(
      session,
      rootAgent,
      this.resumabilityConfig,
    );
  }

  /**
   * Whether the agent to run can transfer to any other agent in the agent tree.
   *
   * @param agentToRun The agent to check for transferability.
   * @returns True if the agent can transfer, False otherwise.
   */
  private isRoutableLlmAgent(agentToRun: BaseAgent): boolean {
    return isRoutableLlmAgent(agentToRun);
  }
  /**
   * Runs the agent in the live (bidirectional streaming) mode.
   *
   * Model media events that carry raw inline bytes (audio, video, or image)
   * are yielded but not appended to the session to avoid persisting large
   * blobs; events with `fileData` references and most other live events
   * (transcriptions, tool calls, usage) are persisted as in `runAsync`.
   *
   * This feature is **experimental** and its API may change.
   *
   * @param params.userId The user ID of the session.
   * @param params.sessionId The session ID of the session.
   * @param params.liveRequestQueue The queue used to feed the live model.
   * @param params.runConfig The run config for the agent.
   * @param params.abortSignal Optional signal to abort the live run.
   * @param params.liveSessionResumptionHandle Optional session resumption
   *     handle observed from a prior `runLive` cycle on the same conversation.
   *     When set, the agent's live flow opens the connection with
   *     `liveConnectConfig.sessionResumption.handle` so the server restores its
   *     state instead of relying on client-side history replay.
   * @yields The events generated by the agent.
   */
  async *runLive(params: {
    userId: string;
    sessionId: string;
    liveRequestQueue: LiveRequestQueue;
    runConfig?: RunConfig;
    abortSignal?: AbortSignal;
    liveSessionResumptionHandle?: string;
  }): AsyncGenerator<Event, void, undefined> {
    if (!params.liveRequestQueue) {
      throw new Error('liveRequestQueue is required for runLive.');
    }

    if (!isBaseAgent(this.agent)) {
      throw new Error('runLive is only supported for agents.');
    }
    const agent = this.agent;

    const runConfig = createRunConfig(params.runConfig);
    if (!runConfig.responseModalities?.length) {
      runConfig.responseModalities = [Modality.AUDIO];
    }
    // For multi-agent live setups, the model's text transcription is needed
    // as context for the transferred agent.
    if (agent.subAgents?.length) {
      if (runConfig.responseModalities.includes(Modality.AUDIO)) {
        runConfig.outputAudioTranscription ??= {};
      }
      runConfig.inputAudioTranscription ??= {};
    }

    const span = tracer.startSpan('invocation');
    const ctx = trace.setSpan(context.active(), span);
    try {
      yield* runAsyncGeneratorWithOtelContext<Runner, Event>(
        ctx,
        this,
        async function* () {
          const session = await this.sessionService.getOrCreateSession({
            appName: this.appName,
            userId: params.userId,
            sessionId: params.sessionId,
          });

          if (params.abortSignal?.aborted) {
            return;
          }

          const invocationContext = new InvocationContext({
            artifactService: this.artifactService
              ? new ScopedArtifactService(
                  this.artifactService,
                  this.appName,
                  params.userId,
                  params.sessionId,
                )
              : undefined,
            sessionService: this.sessionService,
            memoryService: this.memoryService,
            credentialService: this.credentialService,
            invocationId: newInvocationContextId(),
            agent,
            session,
            runConfig,
            a2aMetadata: runConfig.a2aMetadata,
            pluginManager: this.pluginManager,
            liveRequestQueue: params.liveRequestQueue,
            abortSignal: params.abortSignal,
            liveSessionResumptionHandle: params.liveSessionResumptionHandle,
          });

          invocationContext.agent = this.determineAgentForResumption(
            session,
            agent,
          );

          // Step 1: before-run plugin hook (early exit if it returns content).
          const beforeRunCallbackResponse =
            await this.pluginManager.runBeforeRunCallback({
              invocationContext,
            });
          if (params.abortSignal?.aborted) {
            return;
          }
          if (beforeRunCallbackResponse) {
            const earlyExitEvent = createEvent({
              invocationId: invocationContext.invocationId,
              author: 'model',
              content: beforeRunCallbackResponse,
            });
            await this.sessionService.appendEvent({
              session,
              event: earlyExitEvent,
            });
            yield earlyExitEvent;
            return;
          }

          // Step 2: drive the agent's runLive and propagate events.
          for await (const event of requireAgent(invocationContext).runLive(
            invocationContext,
          )) {
            if (params.abortSignal?.aborted) {
              return;
            }

            const modifiedEvent = await this.pluginManager.runOnEventCallback({
              invocationContext,
              event,
            });
            if (params.abortSignal?.aborted) {
              return;
            }

            const eventToProcess = modifiedEvent ?? event;

            if (
              !eventToProcess.partial &&
              !isLiveModelMediaEventWithInlineData(eventToProcess)
            ) {
              await this.sessionService.appendEvent({
                session,
                event: eventToProcess,
              });
            }

            yield eventToProcess;
          }

          // Step 3: after-run plugin hook for cleanup/metrics.
          await this.pluginManager.runAfterRunCallback({invocationContext});
        },
      );
    } finally {
      span.end();
    }
  }
}

/**
 * Whether a live event is a model media event carrying inline data (audio,
 * video, or image).
 *
 * Such events are deliberately not persisted to the session to avoid storing
 * large raw blobs. Media referenced via `fileData` (e.g. saved as artifacts)
 * and all non-media events (transcriptions, tool calls, usage) are persisted
 * as in `runAsync`.
 */
function isLiveModelMediaEventWithInlineData(event: Event): boolean {
  const parts = event.content?.parts;
  if (!parts?.length) {
    return false;
  }
  return parts.some((part) => {
    const mimeType = part.inlineData?.mimeType?.toLowerCase();
    return (
      mimeType !== undefined &&
      (mimeType.startsWith('audio/') ||
        mimeType.startsWith('video/') ||
        mimeType.startsWith('image/'))
    );
  });
}

/**
 * Determines the next agent to run to continue the session. This is primarily
 * used for session resumption across tool and LRO boundaries.
 */
export function determineAgentForResumption(
  session: Session,
  rootAgent: BaseAgent,
  resumabilityConfig?: ResumabilityConfig,
): BaseAgent {
  // =========================================================================
  // Case 1: If the last event is a function response and resumability is enabled,
  // this returns the agent that made the original function call.
  // =========================================================================
  const event = findEventByLastFunctionResponseId(session.events);
  const isResumable = Boolean(resumabilityConfig?.isResumable);
  if (event && event.author && isResumable) {
    const resumedAgent = rootAgent.findAgent(event.author);
    if (resumedAgent) {
      return resumedAgent;
    }
    if (!isWorkflowNodeEvent(event)) {
      logger.warn(
        `Function response from an unknown agent: ${event.author}, event id: ${event.id}`,
      );
    }
  }

  // =========================================================================
  // Case 2: Otherwise, find the last agent that emitted a message and is
  // transferable across the agent tree.
  // =========================================================================
  // simplicity: O(N) backward event scan, upgrade to indexed lookups or map if N > 1000.
  for (let i = session.events.length - 1; i >= 0; i--) {
    logger.debug('event:', JSON.stringify(session.events[i]));
    const event = session.events[i];
    if (event.author === 'user' || !event.author) {
      continue;
    }

    if (event.author === rootAgent.name) {
      return rootAgent;
    }

    const agent = rootAgent.findSubAgent(event.author);
    if (!agent) {
      if (!isWorkflowNodeEvent(event)) {
        logger.warn(
          `Event from an unknown agent: ${event.author}, event id: ${event.id}`,
        );
      }
      continue;
    }
    if (isRoutableLlmAgent(agent)) {
      return agent;
    }
  }
  // =========================================================================
  // Case 3: default to root agent.
  // =========================================================================
  return rootAgent;
}

/**
 * Whether the event was emitted by a graph-workflow node, and so may be
 * authored by a node name rather than an agent name.
 *
 * `nodeInfo.path` is stamped on everything a node emits (`node_runner.ts`).
 * When the node emits an event of its own — a function node's output, or a HITL
 * interrupt, which carries no author at all — the node name is stamped as the
 * author. Nodes are not in the agent tree and never will be: a workflow
 * keeps its structure in `edges`, so its `subAgents` is empty. Looking such an
 * author up could only ever miss, so the miss is not worth warning about — it
 * fired on the happy path of every human-in-the-loop resume.
 *
 * Only the warning is suppressed, never the lookup: a node that wraps an agent
 * (`LLMAgentWrapper`) yields the agent's own events, so the author is a real
 * agent name that must still resolve.
 */
function isWorkflowNodeEvent(event: Event): boolean {
  return Boolean(event.nodeInfo?.path);
}

/**
 * Whether the agent to run can transfer to any other agent in the agent tree.
 *
 * An agent is transferable if:
 *  - It is an instance of `LlmAgent`.
 *  - All its ancestors are also transferable (i.e., they have
 *    `disallowTransferToParent` set to false).
 *
 * @param agentToRun The agent to check for transferability.
 * @returns True if the agent can transfer, False otherwise.
 */
export function isRoutableLlmAgent(agentToRun: BaseAgent): boolean {
  let agent: BaseAgent | undefined = agentToRun;
  while (agent) {
    if (!isLlmAgent(agent)) {
      return false;
    }
    if (agent.disallowTransferToParent) {
      return false;
    }
    agent = agent.parentAgent;
  }
  return true;
}

/**
 * It iterates through the events in reverse order, and returns the event
 * containing a function call with a functionCall.id matching the
 * functionResponse.id from the last event in the session.
 */
export function findEventByLastFunctionResponseId(
  events: Event[],
): Event | null {
  return findMatchingFunctionCall(events) ?? null;
}

function getAllToolsets(agent: BaseAgent): BaseToolset[] {
  const toolsets: BaseToolset[] = [];
  const visited = new Set<BaseAgent>();

  function traverse(curr: BaseAgent) {
    if (visited.has(curr)) return;
    visited.add(curr);

    if (isLlmAgent(curr)) {
      for (const tool of curr.tools) {
        if (isBaseToolset(tool)) {
          toolsets.push(tool);
        }
      }
    }

    for (const sub of curr.subAgents) {
      traverse(sub);
    }
  }

  traverse(agent);
  return toolsets;
}

/**
 * Refuses a client message that carries one of the framework's own
 * control-plane function calls.
 *
 * `adk_request_confirmation`, `adk_request_credential` and `adk_request_input`
 * are questions the framework raises into agent-authored events. A client
 * answers one with a function *response*, which stays perfectly legal here; a
 * client that sends the *call* is writing the question — the first half of
 * approving its own action. There is no legitimate reason to do it, so the
 * message is rejected at the door rather than allowed into the event log for
 * later checks to sort out.
 *
 * @param newMessage The message about to be appended to the session.
 * @throws {Error} If the message contains a reserved function call.
 */
function rejectReservedFunctionCalls(newMessage: Content | undefined): void {
  const reserved = reservedFunctionCallName(newMessage);
  if (reserved) {
    throw new Error(
      `A client message may not contain a '${reserved}' function call: it is ` +
        'raised by the framework, and can only be answered with a function ' +
        'response.',
    );
  }
}
