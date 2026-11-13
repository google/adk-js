/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AddSessionToEvalSetRequest,
  type AgentRuntimeRequestHooks,
  App,
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  bearerTokenUserBuilder,
  closeRunners,
  convertSessionToEvalInvocations,
  createEmptyState,
  createEvent,
  EVAL_SESSION_ID_PREFIX,
  EvalCase,
  EvalCaseResult,
  EvalMetric,
  Event,
  getFunctionCalls,
  getFunctionResponses,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  InputValidationError,
  isApp,
  LiveRequest,
  LiveRequestQueue,
  loadDotenvForAgent,
  LocalEvalSetResultsManager,
  LocalEvalSetsManager,
  Logger,
  LogLevel,
  normalizeEvalCase,
  NotFoundError,
  publicEvent,
  publicSession,
  RunConfig,
  RunEvalRequest,
  RunEvalResult,
  runEvals,
  RunnableRoot,
  Runner,
  runWithAgentEngineContext,
  Session,
  StreamingMode,
  toA2a,
  tryGetResetFunc,
  validatePathSegment,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {trace, TracerProvider} from '@opentelemetry/api';
import {SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';
import cors from 'cors';
import express, {Request, Response} from 'express';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {Duplex} from 'node:stream';
import {version} from '../version.js';

export type {AddSessionToEvalSetRequest, RunEvalRequest, RunEvalResult};

import {AgentFileOptions, AgentLoader} from '../utils/agent_loader.js';
import {formatHeaderForLog} from '../utils/log_utils.js';
import {AdkLogger} from '../utils/logger.js';
import {
  ApiServerSpanExporter,
  hrTimeToNanoseconds,
  InMemoryExporter,
  setupTelemetry,
} from '../utils/telemetry_utils.js';
import {getAgentGraphAsDot, getWorkflowHighlights} from './agent_graph.js';
import {createAgentRuntimeMiddleware} from './agent_runtime_middleware.js';
import {
  collectSubWorkflows,
  GraphTarget,
  navigateToNode,
  serializeAgent,
  serializeAppInfo,
} from './app_info.js';
import {
  getAllowedRequestHosts,
  isDnsRebindingRequest,
} from './dns_rebinding_guard.js';
import {
  createOriginCheckMiddleware,
  parseAllowedOrigins,
} from './origin_check.js';
import {renderStructureGraphAsDot} from './structure_graph.js';

/**
 * Environment variable holding the shared bearer token used to authenticate
 * the A2A surface, for operators who prefer not to put the secret on the
 * command line.
 */
export const A2A_AUTH_TOKEN_ENV_VAR = 'ADK_A2A_AUTH_TOKEN';

interface ServerOptions {
  agentsDir?: string;
  host?: string;
  port?: number;
  sessionService?: BaseSessionService;
  memoryService?: BaseMemoryService;
  artifactService?: BaseArtifactService;
  agentLoader?: AgentLoader;
  agentFileLoadOptions?: AgentFileOptions;
  serveDebugUI?: boolean;
  /**
   * Comma-separated list of origins allowed to send cross-origin requests.
   * More than a CORS header: an entry both allows that origin at the request
   * gate and adds its host to the DNS-rebinding allowlist. Each entry must be
   * an `http://` or `https://` origin; a scheme-less entry is dropped with a
   * warning. `'*'` allows every origin and disables the DNS-rebinding guard.
   */
  allowOrigins?: string;
  /**
   * Additional Host header values the DNS-rebinding guard accepts besides
   * loopback and any host derivable from `allowOrigins`. Independent of
   * CORS: this widens what the guard accepts without opening
   * `allowOrigins` to `'*'`, which is the only way to do so otherwise. Set
   * this to the host an operator's reverse proxy presents to this server
   * when the server itself binds to loopback behind that proxy.
   */
  allowedHosts?: string[];
  otelToCloud?: boolean;
  logger?: Logger;
  logLevel?: LogLevel;
  a2a?: boolean;
  /**
   * Shared bearer token used to authenticate the A2A surface. Falls back to
   * the `ADK_A2A_AUTH_TOKEN` environment variable. When neither is set and
   * `a2a` is enabled, the A2A surface is mounted WITHOUT authentication.
   */
  a2aAuthToken?: string;
  reloadAgents?: boolean;
  registerProcessors?: (tracerProvider: TracerProvider) => void;
}

/**
 * Returns a readable message for a thrown value. Reads a string `message`
 * property when present, so plain error objects do not print as
 * "[object Object]".
 */
function getErrorMessage(e: unknown): string {
  if (
    typeof e === 'object' &&
    e !== null &&
    'message' in e &&
    typeof e.message === 'string'
  ) {
    return e.message;
  }
  if (typeof e === 'string') {
    return e;
  }
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/**
 * The largest request body the server reads, in bytes. It applies to
 * `express.json` and to the raw body that `/api/reasoning_engine` reads itself.
 */
const MAX_RAW_REQUEST_BODY_BYTES = 50 * 1024 * 1024;

function getBrowserDir(): string {
  const primary = path.join(__dirname, '../../browser');
  if (fs.existsSync(primary)) {
    return primary;
  }
  const fallback = path.join(__dirname, '../../dist/browser');
  if (fs.existsSync(fallback)) {
    return fallback;
  }
  return primary;
}

export class AdkApiServer {
  private readonly host: string;
  private readonly port: number;

  private get effectivePort(): number {
    if (this.server) {
      const address = this.server.address();
      if (address && typeof address !== 'string') {
        return address.port;
      }
    }
    return this.port;
  }

  get url(): string {
    return `http://${this.host}:${this.effectivePort}`;
  }

  readonly app: express.Application;
  private readonly agentsDir?: string;
  private readonly agentLoader: AgentLoader;
  /**
   * Caches below are keyed by request path parameters (`appName`, `eventId`,
   * `sessionId`), so each is created with `Object.create(null)`. On an
   * ordinary `{}` literal, inherited names such as `toString` make
   * `key in cache` report a spurious hit and `cache[key]` yield a `Function`
   * where a `Runner` or trace record is expected, and a key of `__proto__`
   * aliases `Object.prototype` on write.
   */
  private readonly runnerCache: Record<string, Runner> = Object.create(null);
  private readonly sessionService: BaseSessionService;
  private readonly memoryService: BaseMemoryService;
  private readonly artifactService: BaseArtifactService;
  private readonly evalSetsManager: LocalEvalSetsManager;
  private readonly evalSetResultsManager: LocalEvalSetResultsManager;
  private readonly serveDebugUI: boolean;
  private readonly allowedOrigins: string[];
  private readonly allowedHosts?: string[];
  private readonly otelToCloud: boolean;
  private readonly registerProcessors?: (
    tracerProvider: TracerProvider,
  ) => void;
  private server?: http.Server;
  private readonly traceDict: Record<string, Record<string, unknown>> =
    Object.create(null);
  private readonly sessionTraceDict: Record<string, string[]> =
    Object.create(null);
  private memoryExporter: InMemoryExporter;
  private readonly logger: Logger;
  private readonly a2a: boolean;
  private readonly a2aAuthToken?: string;
  private requestHooks?: AgentRuntimeRequestHooks;

  constructor(options: ServerOptions) {
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? 0; // 0 means random free port
    this.agentsDir = options.agentsDir;
    this.sessionService =
      options.sessionService ?? new InMemorySessionService();
    this.memoryService = options.memoryService ?? new InMemoryMemoryService();
    this.artifactService =
      options.artifactService ?? new InMemoryArtifactService();
    const configuredAgentsDir = options.agentsDir ?? process.cwd();
    const evalBaseDir =
      fs.existsSync(configuredAgentsDir) &&
      fs.statSync(configuredAgentsDir).isFile()
        ? path.dirname(path.resolve(configuredAgentsDir))
        : path.resolve(configuredAgentsDir);
    this.evalSetsManager = new LocalEvalSetsManager(evalBaseDir);
    this.evalSetResultsManager = new LocalEvalSetResultsManager(evalBaseDir);
    this.agentLoader =
      options.agentLoader ??
      new AgentLoader(
        options.agentsDir,
        options.agentFileLoadOptions,
        options.reloadAgents ?? false,
      );
    this.serveDebugUI = options.serveDebugUI ?? false;
    // A browser sends one Origin per request, so a comma-separated
    // `--allow_origins` must become a list: `cors` never matches the joined
    // string, and the DNS-rebinding guard reads only its first host from it.
    const {origins: allowedOrigins, rejected: rejectedOrigins} =
      parseAllowedOrigins(options.allowOrigins);
    this.allowedOrigins = allowedOrigins;
    this.allowedHosts = options.allowedHosts;
    const envTraceToCloud = process.env['ADK_TRACE_TO_CLOUD']?.toLowerCase();
    this.otelToCloud =
      options.otelToCloud ??
      (envTraceToCloud === 'true' || envTraceToCloud === '1');
    this.registerProcessors = options.registerProcessors;
    this.memoryExporter = new InMemoryExporter(this.sessionTraceDict);
    this.logger =
      options.logger ??
      new AdkLogger({
        label: 'ADK API Server',
        timestamp: true,
        colorize: {level: true},
        printFormat: (info) => {
          return `${info.level}: [${info.label}] ${info.timestamp} ${info.message}`;
        },
      });
    this.logger.setLogLevel(options.logLevel ?? LogLevel.INFO);
    for (const rejected of rejectedOrigins) {
      this.logger.warn(
        `Ignoring --allow_origins entry ${formatHeaderForLog(rejected)}: ` +
          'only http:// and https:// origins are allowed.',
      );
    }
    this.a2a = options.a2a ?? false;
    // An exported-but-empty value means "no token"; anything else is handed
    // to the authenticator, which rejects a token that is not usable.
    this.a2aAuthToken =
      options.a2aAuthToken || process.env[A2A_AUTH_TOKEN_ENV_VAR] || undefined;
    this.app = express();
  }

  private async setupTelemetry(): Promise<
    AgentRuntimeRequestHooks | undefined
  > {
    const internalExporters = [
      new SimpleSpanProcessor(new ApiServerSpanExporter(this.traceDict)),
      new SimpleSpanProcessor(this.memoryExporter),
    ];

    const requestHooks = await setupTelemetry(
      this.otelToCloud,
      internalExporters,
    );

    if (this.registerProcessors) {
      const tracerProvider = trace.getTracerProvider();
      this.registerProcessors(tracerProvider);
    }

    return requestHooks;
  }

  private async initA2A() {
    const appNames = await this.agentLoader.listAgents();
    const authentication = this.a2aAuthToken
      ? bearerTokenUserBuilder(this.a2aAuthToken)
      : undefined;

    for (const appName of appNames) {
      const agentFile = await this.agentLoader.getAgentFile(appName);
      const loaded = await agentFile.load();
      const agent = isApp(loaded) ? loaded.rootAgent : loaded;
      const adkApp = isApp(loaded) ? loaded : undefined;
      const runner = await this.getRunner(adkApp ?? agent, appName);

      await toA2a(agent, {
        protocol: 'http',
        host: this.host,
        port: this.effectivePort,
        basePath: `/a2a/${appName}`,
        sessionService: this.sessionService,
        memoryService: this.memoryService,
        artifactService: this.artifactService,
        runner,
        app: this.app,
        // `toA2a` fails closed by default. When the operator configured a
        // shared bearer token the A2A surface is authenticated with it;
        // otherwise this local development server explicitly opts out and a
        // loud warning is logged at startup.
        authentication,
        allowUnauthenticated: authentication === undefined,
      });
    }
  }

  private async init() {
    const app = this.app;
    const requestHooks = await this.setupTelemetry();
    this.requestHooks = requestHooks;

    // On Agent Runtime the CPU is throttled once a request ends, so telemetry
    // is exported from the request path. Registered first, so every route,
    // including /health, A2A and rejected requests, is covered.
    if (requestHooks) {
      app.use(
        createAgentRuntimeMiddleware({
          hooks: requestHooks,
          logger: this.logger,
        }),
      );
    }

    // Registered before any route (including /health, /, /version) so the
    // DNS-rebinding guard applies to every endpoint, not just the ones
    // registered after this point. Origin cannot be relied on here: a
    // DNS-rebound page's requests look same-origin to the browser, which
    // omits Origin for them, so safe methods (GET/HEAD/OPTIONS) get the
    // same check as everything else.
    const allowedRequestHosts = getAllowedRequestHosts(
      this.allowedOrigins,
      this.allowedHosts,
    );
    app.use((req: Request, res: Response, next: express.NextFunction) => {
      if (
        isDnsRebindingRequest(req.headers.host, this.host, allowedRequestHosts)
      ) {
        this.logger.warn(
          `Rejected request with Host ${formatHeaderForLog(req.headers.host)}: the server is bound to ` +
            `${this.host} and only loopback hosts are accepted. Set the ` +
            `allowedHosts server option (or --allowed_hosts on the CLI) to ` +
            `the host you are reaching this server through.`,
        );
        res
          .status(403)
          .type('text/plain')
          .send('Forbidden: possible DNS-rebinding request');
        return;
      }
      next();
    });

    // The Origin gate covers cross-origin state-changing requests, which the
    // Host guard above does not. Registered before the CORS block so a rejected
    // origin never receives Access-Control-Allow-Origin headers.
    app.use(createOriginCheckMiddleware(this.allowedOrigins, this.logger));

    // Registered before any route so that /, /health, /dev-ui and /version all
    // carry CORS headers, not only the routes declared further down.
    if (this.allowedOrigins.length > 0) {
      app.use(
        cors({
          // `cors` only emits the wildcard header for the literal '*' string.
          origin: this.allowedOrigins.includes('*') ? '*' : this.allowedOrigins,
          credentials: true,
        }),
      );
    }

    if (this.serveDebugUI) {
      app.get('/', (req: Request, res: Response) => {
        res.redirect('/dev-ui/');
      });
      app.use(
        '/dev-ui',
        express.static(getBrowserDir(), {
          setHeaders: (res: Response, path: string) => {
            if (path.endsWith('.js')) {
              res.setHeader('Content-Type', 'text/javascript');
            }
          },
        }),
      );
    } else {
      app.get('/health', (req: Request, res: Response) => {
        res.status(200).send('OK');
      });
      app.get('/', (req: Request, res: Response) => {
        res.status(200).send('OK');
      });
    }

    app.get('/version', (req: Request, res: Response) => {
      res.status(200).json({version});
    });

    app.use(
      express.json({
        limit: MAX_RAW_REQUEST_BODY_BYTES,
      }),
    );

    // Continues the Agent Engine request trace, when the request carries one,
    // for every route registered after this point, including A2A.
    app.use((req: Request, res: Response, next: express.NextFunction) => {
      runWithAgentEngineContext(req.headers, next);
    });

    app.use((req: Request, res: Response, next: express.NextFunction) => {
      this.logger.info(`${req.method} ${req.originalUrl}`);
      next();
    });

    app.get('/list-apps', async (req: Request, res: Response) => {
      try {
        const apps = await this.agentLoader.listAgents();
        res.json(apps);
      } catch (e: unknown) {
        const error = `Failed to list apps: ${e}`;

        res.status(500).json({error});
        this.logger.error(error);

        return;
      }
    });

    // Both prefixes resolve to the same trace store: the dev UI asks under
    // `/dev/apps/<app>/`, while `adk api_server` clients use the bare path.
    // Traces are keyed by event and session id alone, so the app name in the
    // UI's path is not needed to answer.
    app.get(
      ['/debug/trace/:eventId', '/dev/apps/:appName/debug/trace/:eventId'],
      (req: Request, res: Response) => {
        try {
          const eventId = req.params['eventId'];
          const eventDict = this.traceDict[eventId];

          if (!eventDict) {
            return res.status(404).json({error: 'Trace not found'});
          }

          return res.json(eventDict);
        } catch (e) {
          const error = `Failed to get trace: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);

          return;
        }
      },
    );

    app.get(
      [
        '/debug/trace/session/:sessionId',
        '/dev/apps/:appName/debug/trace/session/:sessionId',
      ],
      (req: Request, res: Response) => {
        try {
          const sessionId = req.params['sessionId'];
          const spans = this.memoryExporter.getFinishedSpans(sessionId);
          if (spans.length === 0) {
            return res.json([]);
          }
          const spanData = spans.map((span) => ({
            name: span.name,
            span_id: span.spanContext().spanId,
            trace_id: span.spanContext().traceId,
            start_time: hrTimeToNanoseconds(span.startTime),
            end_time: hrTimeToNanoseconds(span.endTime),
            attributes: {...span.attributes},
            parent_span_id: span.parentSpanContext?.spanId || null,
          }));

          return res.json(spanData);
        } catch (e) {
          const error = `Failed to get trace: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);

          return;
        }
      },
    );

    app.get(
      '/apps/:appName/users/:userId/sessions/:sessionId/events/:eventId/graph',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];
          const eventId = req.params['eventId'];

          const session = await this.sessionService.getSession({
            appName,
            userId,
            sessionId,
          });

          if (!session) {
            res.status(404).json({error: `Session not found: ${sessionId}`});
            return;
          }

          const sessionEvents = session.events || [];
          const event = sessionEvents.find((e) => e.id === eventId);

          if (!event) {
            res.status(404).json({error: `Event not found: ${eventId}`});
            return;
          }

          const functionCalls = getFunctionCalls(event);
          const functionResponses = getFunctionResponses(event);
          const agentFile = await this.agentLoader.getAgentFile(appName);
          await using _bundleLease = agentFile.retain();
          const loaded = await agentFile.load();
          const rootAgent = isApp(loaded) ? loaded.rootAgent : loaded;

          const workflowHighlights = getWorkflowHighlights(
            sessionEvents,
            event,
          );
          if (workflowHighlights) {
            return res.send({
              dotSrc: await getAgentGraphAsDot(rootAgent, workflowHighlights),
            });
          }

          if (functionCalls.length > 0) {
            const functionCallHighlights: Array<[string, string]> = [];
            for (const functionCall of functionCalls) {
              functionCallHighlights.push([event.author!, functionCall.name!]);
            }

            return res.send({
              dotSrc: await getAgentGraphAsDot(
                rootAgent,
                functionCallHighlights,
              ),
            });
          }

          if (functionResponses.length > 0) {
            const functionCallHighlights: Array<[string, string]> = [];

            for (const functionResponse of functionResponses) {
              functionCallHighlights.push([
                functionResponse.name!,
                event.author!,
              ]);
            }

            return res.send({
              dotSrc: await getAgentGraphAsDot(
                rootAgent!,
                functionCallHighlights,
              ),
            });
          }

          return res.send({
            dotSrc: await getAgentGraphAsDot(rootAgent!, [[event.author!, '']]),
          });
        } catch (e) {
          const error = `Failed to get agent graph: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
          return;
        }
      },
    );

    // ---------------------- Agent structure graph endpoints ------------------
    // The dev UI's graph tab reads the app's structure from these two, under a
    // `/dev` prefix that marks them as debug-UI-only (adk-python registers the
    // same pair in `dev_server.py`).
    app.get(
      '/dev/apps/:appName/build_graph',
      async (req: Request, res: Response) => {
        const appName = req.params['appName'];
        try {
          const rootAgent = await this.loadRootTarget(appName);
          if (!rootAgent) {
            return res.status(404).json({error: `App not found: ${appName}`});
          }

          const agentFile = await this.agentLoader.getAgentFile(appName);
          return res.json(
            serializeAppInfo(appName, rootAgent, await agentFile.readReadme()),
          );
        } catch (e) {
          const error = `Failed to get app info: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
          return;
        }
      },
    );

    app.get(
      '/dev/apps/:appName/build_graph_image',
      async (req: Request, res: Response) => {
        const appName = req.params['appName'];
        try {
          const rootAgent = await this.loadRootTarget(appName);
          if (!rootAgent) {
            return res.status(404).json({error: `App not found: ${appName}`});
          }

          const darkMode = String(req.query['dark_mode']) === 'true';
          const nodePath =
            typeof req.query['node'] === 'string' ? req.query['node'] : '';

          const target = nodePath
            ? navigateToNode(rootAgent, nodePath)
            : rootAgent;
          if (!target) {
            return res.status(404).json({error: `Node not found: ${nodePath}`});
          }

          // One DOT per level, keyed by path, so the UI can preload the whole
          // app in a single request and re-render instantly as the user
          // navigates. A level that owns no workflow graph — a plain agent tree
          // — is drawn whole at its own path, which is why the requested level
          // is always present.
          const levels = collectSubWorkflows(target, nodePath);
          if (!levels.has(nodePath)) {
            levels.set(nodePath, target);
          }

          const results: Record<string, {dotSrc: string}> = {};
          for (const [path, level] of levels) {
            results[path] = {
              dotSrc: renderStructureGraphAsDot(
                serializeAgent(level),
                darkMode,
              ),
            };
          }

          // `dotSrc` for the requested level alongside the map: the UI reads
          // the map when it preloads every level, but reads `o.dotSrc` on the
          // single-level fetch it falls back to when a level is missing from
          // that preload. Returning only the map leaves that fallback blank.
          return res.json({
            ...results,
            dotSrc: results[nodePath]?.dotSrc,
          });
        } catch (e) {
          const error = `Failed to get app graph image: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
          return;
        }
      },
    );

    // ------------------------- Session related endpoints ---------------------
    app.get(
      '/apps/:appName/users/:userId/sessions/:sessionId',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];

          const session = await this.sessionService.getSession({
            appName,
            userId,
            sessionId,
          });

          if (!session) {
            res.status(404).json({error: `Session not found: ${sessionId}`});
            return;
          }

          res.json(publicSession(session));
        } catch (e: unknown) {
          const error = `Failed to get session: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.get(
      '/apps/:appName/users/:userId/sessions',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];

          const sessions = await this.sessionService.listSessions({
            appName,
            userId,
          });

          res.json({
            ...sessions,
            sessions: sessions.sessions
              .filter((s) => !s.id.startsWith(EVAL_SESSION_ID_PREFIX))
              .map((s) => publicSession(s)),
          });
        } catch (e: unknown) {
          const error = `Failed to list sessions: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.post(
      '/apps/:appName/users/:userId/sessions/:sessionId',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];
          const state = req.body['state'] || {};

          const existingSession = await this.sessionService.getSession({
            appName,
            userId,
            sessionId,
          });

          if (existingSession) {
            res
              .status(400)
              .json({error: `Session already exists: ${sessionId}`});
            return;
          }

          const createdSession = await this.sessionService.createSession({
            appName,
            userId,
            state,
            sessionId,
          });

          res.json(publicSession(createdSession));
        } catch (e: unknown) {
          const error = `Failed to create session: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.post(
      '/apps/:appName/users/:userId/sessions',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const state = req.body['state'] || {};

          const createdSession = await this.sessionService.createSession({
            appName,
            userId,
            state,
          });

          res.json(publicSession(createdSession));
        } catch (e: unknown) {
          const error = `Failed to create session: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.delete(
      '/apps/:appName/users/:userId/sessions/:sessionId',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];

          const session = await this.sessionService.getSession({
            appName,
            userId,
            sessionId,
          });

          if (!session) {
            res.status(404).json({error: `Session not found: ${sessionId}`});
            return;
          }

          await this.sessionService.deleteSession({
            appName,
            userId,
            sessionId,
          });

          res.status(204).json({});
        } catch (e: unknown) {
          const error = `Failed to delete session: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    // ----------------------- Artifact related endpoints ----------------------
    app.get(
      '/apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];
          const artifactName = req.params['artifactName'];
          const versionParam = req.query['version'];
          const parsedVersion =
            typeof versionParam === 'string' && versionParam.length > 0
              ? parseInt(versionParam, 10)
              : undefined;

          const artifact = await this.artifactService.loadArtifact({
            appName,
            userId,
            sessionId,
            filename: artifactName,
            ...(parsedVersion !== undefined && !Number.isNaN(parsedVersion)
              ? {version: parsedVersion}
              : {}),
          });

          if (!artifact) {
            res
              .status(404)
              .json({error: `Artifact not found: ${artifactName}`});
            return;
          }

          res.json(artifact);
        } catch (e: unknown) {
          const error = `Failed to load artifact: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.get(
      '/apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName/versions/:versionId',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];
          const artifactName = req.params['artifactName'];
          const versionId = req.params['versionId'];

          const artifact = await this.artifactService.loadArtifact({
            appName,
            userId,
            sessionId,
            filename: artifactName,
            version: parseInt(versionId, 10),
          });

          if (!artifact) {
            res
              .status(404)
              .json({error: `Artifact not found: ${artifactName}`});
            return;
          }

          res.json(artifact);
        } catch (e: unknown) {
          const error = `Failed to load artifact version: ${(e as Error).message}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.get(
      '/apps/:appName/users/:userId/sessions/:sessionId/artifacts',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];

          const artifactKeys = await this.artifactService.listArtifactKeys({
            appName,
            userId,
            sessionId,
          });

          res.json(artifactKeys);
        } catch (e: unknown) {
          const error = `Failed to list artifacts: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.get(
      '/apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName/versions',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];
          const artifactName = req.params['artifactName'];

          const artifactVersions = await this.artifactService.listVersions({
            appName,
            userId,
            sessionId,
            filename: artifactName,
          });

          res.json(artifactVersions);
        } catch (e: unknown) {
          const error = `Failed to list artifact versions: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.delete(
      '/apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];
          const artifactName = req.params['artifactName'];

          await this.artifactService.deleteArtifact({
            appName,
            userId,
            sessionId,
            filename: artifactName,
          });

          res.status(204).json({});
        } catch (e: unknown) {
          const error = `Failed to delete artifact: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    // --------------------- Eval Sets related endpoints -----------------------
    const getEvalBaseDir = (): string => {
      const configured = this.agentsDir ?? process.cwd();
      return fs.existsSync(configured) && fs.statSync(configured).isFile()
        ? path.dirname(path.resolve(configured))
        : path.resolve(configured);
    };
    // These checks are lexical. They keep request-supplied names from leaving
    // the eval base directory, but they do not follow symlinks.
    const resolveAppEvalDir = (appName: string): string => {
      validatePathSegment(appName, 'appName');
      const baseDir = getEvalBaseDir();
      const appDir = path.resolve(baseDir, appName);
      const rel = path.relative(baseDir, appDir);
      if (
        !rel ||
        rel.startsWith('..') ||
        path.isAbsolute(rel) ||
        path.dirname(appDir) !== baseDir
      ) {
        throw new InputValidationError(`Invalid appName '${appName}'.`);
      }
      return appDir;
    };
    app.post(
      [
        '/apps/:appName/eval_sets/:evalSetId',
        '/dev/apps/:appName/eval_sets/:evalSetId',
      ],
      (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const evalSetId = req.params['evalSetId'];
          this.evalSetsManager.createEvalSet(appName, evalSetId);
          return res.status(200).json({});
        } catch (e: unknown) {
          if (e instanceof InputValidationError) {
            return res.status(400).json({error: e.message});
          }
          const error = `Failed to create eval set: ${getErrorMessage(e)}`;
          this.logger.error(error);
          return res.status(500).json({error});
        }
      },
    );

    app.get(
      ['/apps/:appName/eval_sets', '/dev/apps/:appName/eval_sets'],
      (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          return res.json(this.evalSetsManager.listEvalSets(appName));
        } catch (e: unknown) {
          if (e instanceof InputValidationError) {
            return res.status(400).json({error: e.message});
          }
          const error = `Failed to list eval sets: ${getErrorMessage(e)}`;
          this.logger.error(error);
          return res.status(500).json({error});
        }
      },
    );

    app.post(
      [
        '/apps/:appName/eval_sets/:evalSetId/add_session',
        '/dev/apps/:appName/eval_sets/:evalSetId/add_session',
      ],
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const evalSetId = req.params['evalSetId'];
          const body = (req.body ?? {}) as Record<string, unknown>;
          const evalId = String(body['evalId'] ?? body['eval_id'] ?? '');
          const sessionId = String(
            body['sessionId'] ?? body['session_id'] ?? '',
          );
          const userId = String(body['userId'] ?? body['user_id'] ?? '');

          // `addEvalCase` validates the eval ID format below.
          const existingEvalSet = this.evalSetsManager.getEvalSet(
            appName,
            evalSetId,
          );
          if (!existingEvalSet) {
            return res.status(400).json({
              error: `Eval set ${evalSetId} not found.`,
            });
          }

          if (existingEvalSet.evalCases.some((x) => x.evalId === evalId)) {
            return res.status(400).json({
              error: `Eval id ${evalId} already exists in ${evalSetId} eval set.`,
            });
          }

          const session = await this.sessionService.getSession({
            appName,
            userId,
            sessionId,
          });
          if (!session) {
            return res
              .status(404)
              .json({error: `Session not found: ${sessionId}`});
          }

          const invocations = convertSessionToEvalInvocations(session);
          const agentFile = await this.agentLoader.getAgentFile(appName);
          await using _bundleLease = agentFile.retain();
          const loaded = await agentFile.load();
          const rootAgent = isApp(loaded) ? loaded.rootAgent : loaded;
          const initialSessionState = isApp(rootAgent)
            ? {...session.state}
            : 'subAgents' in rootAgent
              ? createEmptyState(rootAgent, session.state)
              : {...session.state};

          const newEvalCase: EvalCase = {
            evalId,
            conversation: invocations,
            sessionInput: {
              appName,
              userId,
              state: initialSessionState,
            },
            creationTimestamp: Date.now() / 1000,
          };

          this.evalSetsManager.addEvalCase(appName, evalSetId, newEvalCase);
          return res.status(200).json({});
        } catch (e: unknown) {
          if (e instanceof InputValidationError || e instanceof NotFoundError) {
            return res.status(400).json({error: e.message});
          }
          const error = `Failed to add session to eval set: ${getErrorMessage(e)}`;
          this.logger.error(error);
          return res.status(500).json({error});
        }
      },
    );

    app.get(
      [
        '/apps/:appName/eval_sets/:evalSetId/evals',
        '/dev/apps/:appName/eval_sets/:evalSetId/evals',
      ],
      (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const evalSetId = req.params['evalSetId'];
          const evalSetData = this.evalSetsManager.getEvalSet(
            appName,
            evalSetId,
          );
          if (!evalSetData) {
            return res.status(400).json({
              error: `Eval set ${evalSetId} not found.`,
            });
          }

          return res.json(evalSetData.evalCases.map((x) => x.evalId).sort());
        } catch (e: unknown) {
          if (e instanceof InputValidationError) {
            return res.status(400).json({error: e.message});
          }
          const error = `Failed to list evals: ${getErrorMessage(e)}`;
          this.logger.error(error);
          return res.status(500).json({error});
        }
      },
    );

    app.get(
      [
        '/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
        '/dev/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
      ],
      (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const evalSetId = req.params['evalSetId'];
          const evalCaseId = req.params['evalCaseId'];
          const evalCaseToFind = this.evalSetsManager.getEvalCase(
            appName,
            evalSetId,
            evalCaseId,
          );
          if (evalCaseToFind) {
            return res.status(200).json(evalCaseToFind);
          }
          return res.status(404).json({
            error: `Eval set \`${evalSetId}\` or Eval \`${evalCaseId}\` not found.`,
          });
        } catch (e: unknown) {
          if (e instanceof NotFoundError || e instanceof InputValidationError) {
            return res.status(404).json({error: e.message});
          }
          const error = `Failed to get eval case: ${getErrorMessage(e)}`;
          this.logger.error(error);
          return res.status(500).json({error});
        }
      },
    );

    app.put(
      [
        '/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
        '/dev/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
      ],
      (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const evalSetId = req.params['evalSetId'];
          const evalCaseId = req.params['evalCaseId'];
          const rawBody: unknown = req.body ?? {};
          if (
            typeof rawBody !== 'object' ||
            rawBody === null ||
            Array.isArray(rawBody)
          ) {
            return res.status(400).json({
              error: 'Invalid EvalCase: expected a JSON object.',
            });
          }
          const body = rawBody as Record<string, unknown>;
          const rawBodyEvalId = body['evalId'] ?? body['eval_id'];
          if (
            rawBodyEvalId !== undefined &&
            typeof rawBodyEvalId !== 'string'
          ) {
            return res.status(400).json({
              error: 'Invalid EvalCase: evalId must be a string.',
            });
          }
          if (
            rawBodyEvalId !== undefined &&
            rawBodyEvalId.length > 0 &&
            rawBodyEvalId !== evalCaseId
          ) {
            return res.status(400).json({
              error:
                'Eval id in EvalCase should match the eval id in the API route.',
            });
          }

          const updatedEvalCase = normalizeEvalCase({
            ...body,
            evalId: evalCaseId,
          });
          this.evalSetsManager.updateEvalCase(
            appName,
            evalSetId,
            updatedEvalCase,
          );
          return res.status(200).json({});
        } catch (e: unknown) {
          if (e instanceof NotFoundError) {
            return res.status(404).json({error: e.message});
          }
          if (e instanceof InputValidationError) {
            return res.status(400).json({error: e.message});
          }
          const error = `Failed to update eval case: ${getErrorMessage(e)}`;
          this.logger.error(error);
          return res.status(500).json({error});
        }
      },
    );

    app.delete(
      [
        '/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
        '/dev/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
      ],
      (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const evalSetId = req.params['evalSetId'];
          const evalCaseId = req.params['evalCaseId'];
          this.evalSetsManager.deleteEvalCase(appName, evalSetId, evalCaseId);
          return res.status(200).json({});
        } catch (e: unknown) {
          if (e instanceof NotFoundError || e instanceof InputValidationError) {
            return res.status(404).json({error: e.message});
          }
          const error = `Failed to delete eval case: ${getErrorMessage(e)}`;
          this.logger.error(error);
          return res.status(500).json({error});
        }
      },
    );

    app.post(
      [
        '/apps/:appName/eval_sets/:evalSetId/run_eval',
        '/dev/apps/:appName/eval_sets/:evalSetId/run_eval',
      ],
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const evalSetId = req.params['evalSetId'];
          const evalSet = this.evalSetsManager.getEvalSet(appName, evalSetId);
          if (!evalSet) {
            return res.status(400).json({
              error: `Eval set ${evalSetId} not found.`,
            });
          }

          const body = (req.body ?? {}) as Record<string, unknown>;
          const evalIds = Array.isArray(body['evalIds'] ?? body['eval_ids'])
            ? ((body['evalIds'] ?? body['eval_ids']) as string[])
            : [];
          const evalMetrics = Array.isArray(
            body['evalMetrics'] ?? body['eval_metrics'],
          )
            ? ((body['evalMetrics'] ?? body['eval_metrics']) as EvalMetric[])
            : [];

          const evalCases =
            evalIds.length > 0
              ? evalSet.evalCases.filter((e) => evalIds.includes(e.evalId))
              : evalSet.evalCases;

          const agentFile = await this.agentLoader.getAgentFile(appName);
          this.loadAgentDotenv(appName);
          await using _bundleLease = agentFile.retain();
          const loaded = await agentFile.load();
          const rootAgent = isApp(loaded) ? loaded.rootAgent : loaded;
          if (!('subAgents' in rootAgent)) {
            return res.status(400).json({
              error: 'Evaluation requires a BaseAgent rootAgent.',
            });
          }

          const resetFunc = this.agentsDir
            ? await tryGetResetFunc(
                fs.existsSync(this.agentsDir) &&
                  fs.statSync(this.agentsDir).isFile()
                  ? this.agentsDir
                  : resolveAppEvalDir(appName),
              )
            : undefined;

          const runEvalResults: RunEvalResult[] = [];
          const evalCaseResults: EvalCaseResult[] = [];
          for await (const evalResult of runEvals(
            {[evalSetId]: evalCases},
            rootAgent,
            resetFunc,
            evalMetrics.length > 0 ? evalMetrics : undefined,
            /* printDetailedResults= */ false,
            this.sessionService,
            this.artifactService,
          )) {
            const sessionDetails =
              evalResult.session_details &&
              publicSession(evalResult.session_details);
            runEvalResults.push({
              ...(evalResult.eval_set_file !== undefined
                ? {evalSetFile: evalResult.eval_set_file}
                : {}),
              evalSetId,
              evalId: evalResult.eval_id,
              finalEvalStatus: evalResult.final_eval_status,
              ...(evalResult.eval_metric_results !== undefined
                ? {evalMetricResults: evalResult.eval_metric_results}
                : {}),
              overallEvalMetricResults: evalResult.overall_eval_metric_results,
              evalMetricResultPerInvocation:
                evalResult.eval_metric_result_per_invocation,
              ...(evalResult.user_id !== undefined
                ? {userId: evalResult.user_id}
                : {}),
              sessionId: evalResult.session_id,
              ...(sessionDetails !== undefined ? {sessionDetails} : {}),
            });
            evalCaseResults.push(evalResult);
          }

          this.evalSetResultsManager.saveEvalSetResult({
            appName,
            evalSetId,
            evalCaseResults,
          });

          return res.json(runEvalResults);
        } catch (e: unknown) {
          if (e instanceof InputValidationError) {
            return res.status(400).json({error: e.message});
          }
          const error = `Failed to run eval: ${getErrorMessage(e)}`;
          this.logger.error(error);
          return res.status(500).json({error});
        }
      },
    );

    // ----------------------- Eval Results related endpoints ------------------
    app.get(
      [
        '/apps/:appName/eval_results/:evalResultId',
        '/dev/apps/:appName/eval_results/:evalResultId',
      ],
      (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const evalResultId = req.params['evalResultId'];
          const evalSetResult = this.evalSetResultsManager.getEvalSetResult(
            appName,
            evalResultId,
          );
          return res.json(evalSetResult);
        } catch (e: unknown) {
          if (e instanceof NotFoundError || e instanceof InputValidationError) {
            return res.status(404).json({error: e.message});
          }
          const error = `Failed to get eval result: ${getErrorMessage(e)}`;
          this.logger.error(error);
          return res.status(500).json({error});
        }
      },
    );

    app.get(
      ['/apps/:appName/eval_results', '/dev/apps/:appName/eval_results'],
      (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          return res.json(
            this.evalSetResultsManager.listEvalSetResults(appName),
          );
        } catch (e: unknown) {
          if (e instanceof InputValidationError) {
            return res.status(404).json({error: e.message});
          }
          const error = `Failed to list eval results: ${getErrorMessage(e)}`;
          this.logger.error(error);
          return res.status(500).json({error});
        }
      },
    );

    app.get('/apps/:appName/eval_metrics', (req: Request, res: Response) => {
      return res.status(501).json({error: 'Not implemented'});
    });

    // -------------------------- Run related endpoints ------------------------
    app.post('/run', async (req: Request, res: Response) => {
      const {
        appName,
        userId,
        sessionId,
        newMessage,
        stateDelta,
        customMetadata,
      } = req.body ?? {};
      const appNameError = getAppNameError(appName);
      if (appNameError) {
        res.status(400).json({error: appNameError});
        return;
      }
      const session = await this.sessionService.getSession({
        appName,
        userId,
        sessionId,
      });

      if (!session) {
        res.status(404).json({error: `Session not found: ${sessionId}`});
        return;
      }

      const abortController = new AbortController();
      let responseCompleted = false;

      req.on('close', () => {
        if (!responseCompleted) {
          this.logger.info(
            `HTTP connection closed. Aborting agent execution for session ${sessionId}`,
          );
          abortController.abort();
        }
      });

      const events: Event[] = [];
      try {
        for await (const e of this.executeAgentRun({
          appName,
          userId,
          sessionId,
          newMessage,
          stateDelta,
          customMetadata,
          abortSignal: abortController.signal,
        })) {
          events.push(e);
        }

        responseCompleted = true;
        res.json(events);
      } catch (e: unknown) {
        const error = `Failed to run agent: ${e}`;

        res.status(500).json({error, events});
        this.logger.error(error);
      }
    });

    // Agent Engine callers send the remote method in `class_method`, use
    // snake_case field names, and omit `appName` when the server hosts a single
    // app. The reasoning engine routes accept both spellings of every field.
    const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);

    const readReasoningEngineBody = (
      req: Request,
      res: Response,
    ): Promise<Record<string, unknown> | undefined> => {
      const isParsed =
        req.body && (Object.keys(req.body).length > 0 || !req.readable);
      if (isParsed) {
        return Promise.resolve(isJsonRecord(req.body) ? req.body : {});
      }
      return new Promise((resolve) => {
        // Some clients send a Content-Type that `express.json` does not
        // match, so read the body here with the same size limit.
        const chunks: Buffer[] = [];
        let rawBodyBytes = 0;
        let rejected = false;
        req.on('data', (chunk: Buffer | string) => {
          if (rejected) {
            return;
          }
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          rawBodyBytes += buf.length;
          if (rawBodyBytes > MAX_RAW_REQUEST_BODY_BYTES) {
            rejected = true;
            chunks.length = 0;
            res.status(413).json({error: 'Request body is too large.'});
            resolve(undefined);
            return;
          }
          chunks.push(buf);
        });
        req.on('error', () => {
          if (rejected) {
            return;
          }
          rejected = true;
          chunks.length = 0;
          this.logger.error('Failed to read raw request body');
          if (!res.headersSent) {
            res.status(400).json({error: 'Request body is not valid JSON.'});
          }
          resolve(undefined);
        });
        req.on('end', () => {
          if (rejected) {
            return;
          }
          const rawBody = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = {};
          if (rawBody) {
            try {
              body = JSON.parse(rawBody);
            } catch {
              this.logger.error('Failed to parse raw body as JSON');
              res.status(400).json({error: 'Request body is not valid JSON.'});
              resolve(undefined);
              return;
            }
            if (
              typeof body !== 'object' ||
              body === null ||
              Array.isArray(body)
            ) {
              this.logger.error('Failed to parse raw body as JSON');
              res.status(400).json({error: 'Request body is not valid JSON.'});
              resolve(undefined);
              return;
            }
          }
          resolve(isJsonRecord(body) ? body : {});
        });
      });
    };

    /** Returns the first value of `keys` found across `sources`, in order. */
    const pickField = (
      sources: ReadonlyArray<Record<string, unknown>>,
      keys: readonly string[],
    ): unknown => {
      for (const source of sources) {
        for (const key of keys) {
          const value = source[key];
          if (value !== undefined && value !== null) {
            return value;
          }
        }
      }
      return undefined;
    };

    const pickString = (
      sources: ReadonlyArray<Record<string, unknown>>,
      keys: readonly string[],
    ): string | undefined => {
      const value = pickField(sources, keys);
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    };

    const pickInteger = (
      sources: ReadonlyArray<Record<string, unknown>>,
      keys: readonly string[],
    ): number | undefined => {
      const value = pickField(sources, keys);
      if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
      }
      if (typeof value === 'string' && value.length > 0) {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) {
          return parsed;
        }
      }
      return undefined;
    };

    const preservedDictKeys = new Set([
      'a2aMetadata',
      'stateDelta',
      'artifactDelta',
      'customMetadata',
    ]);

    /**
     * Converts snake_case keys to camelCase, leaving user-keyed dictionaries
     * (`a2aMetadata`, `stateDelta`, `artifactDelta`, `customMetadata`) as is.
     */
    const snakeToCamelKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(snakeToCamelKeys);
      }
      if (!isJsonRecord(value)) {
        return value;
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => {
          const camelKey = key.replace(/_([a-z])/g, (_match, letter: string) =>
            letter.toUpperCase(),
          );
          return [
            camelKey,
            preservedDictKeys.has(camelKey) ? nested : snakeToCamelKeys(nested),
          ];
        }),
      );
    };

    /**
     * `RunConfig` fields that only the operator or the transport may set. An
     * HTTP caller must not turn off a tool-confirmation safeguard, claim a
     * remote origin for its message, or change telemetry capture.
     */
    const operatorOnlyRunConfigKeys: readonly string[] = [
      'allowRemoteToolConfirmation',
      'plainTextToolConfirmation',
      'remoteDelivered',
      'telemetry',
    ];

    /**
     * Converts a caller-supplied run config to camelCase and removes the
     * fields an HTTP caller may not set. It also removes a `maxLlmCalls` that
     * is not a positive number, because that value removes the call limit.
     */
    const toCallerRunConfig = (
      raw: Record<string, unknown>,
    ): Record<string, unknown> => {
      const converted = snakeToCamelKeys(raw) as Record<string, unknown>;
      const filtered = Object.fromEntries(
        Object.entries(converted).filter(
          ([key]) => !operatorOnlyRunConfigKeys.includes(key),
        ),
      );
      const maxLlmCalls = filtered['maxLlmCalls'];
      if (
        maxLlmCalls !== undefined &&
        !(typeof maxLlmCalls === 'number' && maxLlmCalls > 0)
      ) {
        delete filtered['maxLlmCalls'];
      }
      return filtered;
    };

    /** Turns a string message into user `Content`, and defaults the role. */
    const toReasoningEngineContent = (raw: unknown): Content | undefined => {
      if (typeof raw === 'string') {
        return {role: 'user', parts: [{text: raw}]};
      }
      if (!isJsonRecord(raw)) {
        return undefined;
      }
      // The request body is untrusted JSON; the runner reads only the
      // `Content` fields it knows.
      const content = raw as Content;
      return content.parts && !content.role
        ? {...content, role: 'user'}
        : content;
    };

    /** Normalizes a serialized event object into an ADK `Event`. */
    const toReasoningEngineEvent = (raw: unknown): Event | undefined => {
      if (!isJsonRecord(raw)) {
        return undefined;
      }
      const converted = snakeToCamelKeys(raw) as Record<string, unknown>;
      return createEvent(converted as Parameters<typeof createEvent>[0]);
    };

    /** Normalizes a string or JSON object into a GenAI `Part`. */
    const toReasoningEngineArtifactPart = (raw: unknown): Part | undefined => {
      if (typeof raw === 'string') {
        return {text: raw};
      }
      if (!isJsonRecord(raw)) {
        return undefined;
      }
      return snakeToCamelKeys(raw) as Part;
    };

    /**
     * Normalizes an artifact version's `data` field from a
     * `streaming_agent_run_with_events` request into a GenAI `Part`.
     */
    const toStreamRunArtifactPart = (raw: unknown): Part | undefined => {
      if (typeof raw === 'string') {
        return {
          inlineData: {
            mimeType: 'text/plain',
            data: Buffer.from(raw, 'utf-8').toString('base64'),
          },
        };
      }
      if (!isJsonRecord(raw)) {
        return undefined;
      }
      if (
        'text' in raw ||
        'inlineData' in raw ||
        'inline_data' in raw ||
        'fileData' in raw ||
        'file_data' in raw
      ) {
        return snakeToCamelKeys(raw) as Part;
      }
      return {
        inlineData: {
          mimeType: 'application/json',
          data: Buffer.from(JSON.stringify(raw), 'utf-8').toString('base64'),
        },
      };
    };

    const reasoningEngineQueryMethods: ReadonlyArray<string | undefined> = [
      undefined,
      'query',
      'async_query',
      'stream_query',
      'async_stream_query',
    ];

    type ReasoningEngineRequest =
      | {status: number; error: string}
      | {
          status?: undefined;
          classMethod?: string;
          appName: string;
          userId: string;
          sessionId?: string;
          newMessage?: Content;
          stateDelta?: Record<string, unknown>;
          customMetadata?: Record<string, unknown>;
          runConfig?: RunConfig;
          state?: Record<string, unknown>;
          ttl?: string;
          expireTime?: string;
          query?: string;
          filename?: string;
          version?: number;
          artifact?: Part;
          rawSession?: Record<string, unknown>;
          sessionEvents?: Event[];
          runEvents?: Event[];
          runArtifacts?: Array<Record<string, unknown>>;
        };

    const resolveReasoningEngineRequest = async (
      body: Record<string, unknown>,
    ): Promise<ReasoningEngineRequest> => {
      const input = isJsonRecord(body['input']) ? body['input'] : {};

      const rawClassMethod = pickField([body], ['class_method', 'classMethod']);
      if (rawClassMethod !== undefined && typeof rawClassMethod !== 'string') {
        return {
          status: 400,
          error: `Unsupported class_method: ${JSON.stringify(rawClassMethod)}`,
        };
      }
      const classMethod = rawClassMethod;

      let requestJsonRecord: Record<string, unknown> | undefined;
      const rawRequestJson = pickField(
        [input, body],
        ['request_json', 'requestJson'],
      );
      if (rawRequestJson !== undefined) {
        if (typeof rawRequestJson === 'string') {
          try {
            const parsed: unknown = JSON.parse(rawRequestJson);
            if (!isJsonRecord(parsed)) {
              return {
                status: 400,
                error: 'request_json must be a valid JSON object',
              };
            }
            requestJsonRecord = parsed;
          } catch {
            return {
              status: 400,
              error: 'request_json must be a valid JSON object',
            };
          }
        } else if (isJsonRecord(rawRequestJson)) {
          requestJsonRecord = rawRequestJson;
        } else {
          return {
            status: 400,
            error: 'request_json must be a valid JSON object',
          };
        }
      }

      const sources = requestJsonRecord
        ? [requestJsonRecord, input, body]
        : [input, body];

      let appName = pickString(sources, ['appName', 'app_name']);
      if (appName === undefined) {
        const usesAgentEngineProtocol =
          classMethod !== undefined ||
          pickField(sources, ['message']) !== undefined;
        const apps = usesAgentEngineProtocol
          ? await this.agentLoader.listAgents()
          : [];
        if (apps.length !== 1) {
          return {status: 400, error: 'appName is required in input'};
        }
        appName = apps[0];
      }

      const sessionId = pickString(sources, ['session_id', 'sessionId']);
      const rawSessionEvents = pickField(sources, [
        'session_events',
        'sessionEvents',
      ]);
      let sessionEvents: Event[] | undefined;
      if (rawSessionEvents !== undefined) {
        if (!Array.isArray(rawSessionEvents)) {
          return {status: 400, error: 'session_events must be an array'};
        }
        if (sessionId !== undefined) {
          return {
            status: 400,
            error:
              'Only one of session_id and session_events should be specified.',
          };
        }
        sessionEvents = rawSessionEvents
          .map((item) => toReasoningEngineEvent(item))
          .filter((item): item is Event => item !== undefined);
      }

      const rawRunEvents = pickField(sources, ['events']);
      const runEvents = Array.isArray(rawRunEvents)
        ? rawRunEvents
            .map((item) => toReasoningEngineEvent(item))
            .filter((item): item is Event => item !== undefined)
        : undefined;

      const rawRunArtifacts = pickField(sources, ['artifacts']);
      const runArtifacts = Array.isArray(rawRunArtifacts)
        ? rawRunArtifacts.filter(isJsonRecord)
        : undefined;

      const stateDelta = pickField(sources, ['state_delta', 'stateDelta']);
      let mergedStateDelta = isJsonRecord(stateDelta)
        ? {...stateDelta}
        : undefined;
      const rawAuthorizations = pickField(sources, ['authorizations']);
      if (isJsonRecord(rawAuthorizations)) {
        for (const [authId, authVal] of Object.entries(rawAuthorizations)) {
          if (isJsonRecord(authVal)) {
            const token = pickString(
              [authVal],
              ['access_token', 'accessToken'],
            );
            if (token) {
              mergedStateDelta = mergedStateDelta ?? {};
              mergedStateDelta[`temp:${authId}`] = token;
            }
          }
        }
      }

      const customMetadata = pickField(sources, [
        'custom_metadata',
        'customMetadata',
      ]);
      const rawRunConfig = pickField(sources, ['run_config', 'runConfig']);
      const state = pickField(
        requestJsonRecord ? [requestJsonRecord, input] : [input],
        ['state'],
      );
      const rawSession = pickField(sources, ['session']);

      return {
        classMethod,
        appName,
        userId: pickString(sources, ['user_id', 'userId']) ?? 'default-user',
        sessionId,
        newMessage: toReasoningEngineContent(
          pickField(sources, ['newMessage', 'new_message', 'message']),
        ),
        stateDelta: mergedStateDelta,
        customMetadata: isJsonRecord(customMetadata)
          ? customMetadata
          : undefined,
        // The runner reads only the `RunConfig` fields it knows.
        runConfig: isJsonRecord(rawRunConfig)
          ? (toCallerRunConfig(rawRunConfig) as RunConfig)
          : undefined,
        state: isJsonRecord(state) ? state : undefined,
        ttl: pickString(sources, ['ttl']),
        expireTime: pickString(sources, ['expire_time', 'expireTime']),
        query: pickString(sources, ['query']),
        filename: pickString(sources, [
          'filename',
          'file_name',
          'fileName',
          'artifact_name',
          'artifactName',
        ]),
        version: pickInteger(sources, ['version']),
        artifact: toReasoningEngineArtifactPart(
          pickField(sources, ['artifact']),
        ),
        rawSession: isJsonRecord(rawSession) ? rawSession : undefined,
        sessionEvents,
        runEvents,
        runArtifacts,
      };
    };

    const prepareQuerySession = async (
      request: Extract<ReasoningEngineRequest, {status?: undefined}>,
    ): Promise<{session: Session; cleanup: () => Promise<void>}> => {
      const {appName, userId, sessionId, sessionEvents, state} = request;
      if (sessionEvents !== undefined) {
        const scratch = await this.sessionService.createSession({
          appName,
          userId,
          state: state ?? {},
        });
        for (const event of sessionEvents) {
          await this.sessionService.appendEvent({session: scratch, event});
        }
        return {
          session: scratch,
          cleanup: async () => {
            await this.sessionService.deleteSession({
              appName,
              userId,
              sessionId: scratch.id,
            });
          },
        };
      }
      const session = await this.sessionService.getOrCreateSession({
        appName,
        userId,
        sessionId: sessionId ?? 'default-session',
        state: {},
      });
      return {session, cleanup: async () => {}};
    };

    const prepareStreamRunWithEventsSession = async (
      request: Extract<ReasoningEngineRequest, {status?: undefined}>,
    ): Promise<{session: Session; cleanup: () => Promise<void>}> => {
      const {appName, userId, sessionId, state, runEvents, runArtifacts} =
        request;

      const saveRequestArtifacts = async (targetSessionId: string) => {
        for (const artifactItem of runArtifacts ?? []) {
          const fileName = pickString(
            [artifactItem],
            ['file_name', 'fileName', 'filename'],
          );
          if (!fileName) {
            continue;
          }
          const rawVersions = Array.isArray(artifactItem['versions'])
            ? artifactItem['versions'].filter(isJsonRecord)
            : [];
          const sortedVersions = [...rawVersions].sort(
            (a, b) =>
              (pickInteger([a], ['version']) ?? 0) -
              (pickInteger([b], ['version']) ?? 0),
          );
          for (const ver of sortedVersions) {
            const part = toStreamRunArtifactPart(ver['data']);
            if (!part) {
              continue;
            }
            await this.artifactService.saveArtifact({
              appName,
              userId,
              sessionId: targetSessionId,
              filename: fileName,
              artifact: part,
            });
          }
        }
      };

      if (sessionId) {
        let existing: Session | undefined;
        try {
          existing = await this.sessionService.getSession({
            appName,
            userId,
            sessionId,
          });
        } catch {
          existing = undefined;
        }
        if (existing) {
          await saveRequestArtifacts(existing.id);
          return {session: existing, cleanup: async () => {}};
        }
        const created = await this.sessionService.createSession({
          appName,
          userId,
          state: {
            ...(state ?? {}),
            'agent_engine:upstream_session_id': sessionId,
          },
        });
        for (const event of runEvents ?? []) {
          await this.sessionService.appendEvent({session: created, event});
        }
        await saveRequestArtifacts(created.id);
        return {session: created, cleanup: async () => {}};
      }

      const scratch = await this.sessionService.createSession({
        appName,
        userId,
        state: state ?? {},
      });
      for (const event of runEvents ?? []) {
        await this.sessionService.appendEvent({session: scratch, event});
      }
      await saveRequestArtifacts(scratch.id);
      return {
        session: scratch,
        cleanup: async () => {
          await this.sessionService.deleteSession({
            appName,
            userId,
            sessionId: scratch.id,
          });
        },
      };
    };

    const buildStreamRunWithEventsChunk = async (
      appName: string,
      userId: string,
      activeSessionId: string,
      event: Event,
    ): Promise<Record<string, unknown>> => {
      const artifactDelta = event.actions?.artifactDelta ?? {};
      const artifacts: Array<Record<string, unknown>> = [];
      for (const [fileName, versionNum] of Object.entries(artifactDelta)) {
        const loaded = await this.artifactService.loadArtifact({
          appName,
          userId,
          sessionId: activeSessionId,
          filename: fileName,
          ...(typeof versionNum === 'number' ? {version: versionNum} : {}),
        });
        if (loaded !== undefined) {
          artifacts.push({
            file_name: fileName,
            versions: [{version: versionNum, data: loaded}],
          });
        }
      }
      return {
        events: [publicEvent(event)],
        ...(artifacts.length > 0 ? {artifacts} : {}),
        session_id: activeSessionId,
      };
    };

    app.post('/api/reasoning_engine', async (req: Request, res: Response) => {
      const body = await readReasoningEngineBody(req, res);
      if (body === undefined) {
        return;
      }
      const events: Event[] = [];
      try {
        const request = await resolveReasoningEngineRequest(body);
        if (request.status !== undefined) {
          res.status(request.status).json({error: request.error});
          return;
        }
        const {classMethod, appName, userId, sessionId} = request;

        switch (classMethod) {
          case 'create_session':
          case 'async_create_session': {
            const created = await this.sessionService.createSession({
              appName,
              userId,
              state: request.state ?? {},
              ...(sessionId ? {sessionId} : {}),
              ...(request.ttl ? {ttl: request.ttl} : {}),
              ...(request.expireTime ? {expireTime: request.expireTime} : {}),
            });
            res.json({output: publicSession(created)});
            return;
          }
          case 'get_session':
          case 'async_get_session': {
            if (!sessionId) {
              res.status(400).json({error: 'session_id is required'});
              return;
            }
            const session = await this.sessionService.getSession({
              appName,
              userId,
              sessionId,
            });
            if (!session) {
              res.status(404).json({error: `Session not found: ${sessionId}`});
              return;
            }
            res.json({output: publicSession(session)});
            return;
          }
          case 'list_sessions':
          case 'async_list_sessions': {
            const listed = await this.sessionService.listSessions({
              appName,
              userId,
            });
            res.json({
              output: {
                ...listed,
                sessions: listed.sessions
                  .filter((s) => !s.id.startsWith(EVAL_SESSION_ID_PREFIX))
                  .map((s) => publicSession(s)),
              },
            });
            return;
          }
          case 'delete_session':
          case 'async_delete_session': {
            if (!sessionId) {
              res.status(400).json({error: 'session_id is required'});
              return;
            }
            await this.sessionService.deleteSession({
              appName,
              userId,
              sessionId,
            });
            res.json({output: null});
            return;
          }
          case 'add_session_to_memory':
          case 'async_add_session_to_memory': {
            const rawSession = request.rawSession;
            if (!rawSession && !sessionId) {
              res.status(400).json({error: 'session is required'});
              return;
            }
            const sessionRecord = rawSession ?? {};
            const targetSessionId =
              pickString([sessionRecord], ['id', 'session_id', 'sessionId']) ??
              sessionId;
            const targetUserId =
              pickString([sessionRecord], ['userId', 'user_id']) ?? userId;
            const targetAppName =
              pickString([sessionRecord], ['appName', 'app_name']) ?? appName;
            const rawEvents = Array.isArray(sessionRecord['events'])
              ? sessionRecord['events']
                  .map((item) => toReasoningEngineEvent(item))
                  .filter((item): item is Event => item !== undefined)
              : [];

            let sessionToAdd: Session | undefined;
            if (rawEvents.length > 0) {
              sessionToAdd = {
                id: targetSessionId ?? 'default-session',
                appName: targetAppName,
                userId: targetUserId,
                state: isJsonRecord(sessionRecord['state'])
                  ? sessionRecord['state']
                  : {},
                events: rawEvents,
                lastUpdateTime:
                  typeof sessionRecord['lastUpdateTime'] === 'number'
                    ? sessionRecord['lastUpdateTime']
                    : typeof sessionRecord['last_update_time'] === 'number'
                      ? sessionRecord['last_update_time']
                      : Date.now(),
              };
            } else if (targetSessionId) {
              sessionToAdd = await this.sessionService.getSession({
                appName: targetAppName,
                userId: targetUserId,
                sessionId: targetSessionId,
              });
            }

            if (!sessionToAdd) {
              if (!rawSession) {
                res
                  .status(404)
                  .json({error: `Session not found: ${targetSessionId}`});
                return;
              }
              sessionToAdd = {
                id: targetSessionId ?? 'default-session',
                appName: targetAppName,
                userId: targetUserId,
                state: isJsonRecord(sessionRecord['state'])
                  ? sessionRecord['state']
                  : {},
                events: [],
                lastUpdateTime:
                  typeof sessionRecord['lastUpdateTime'] === 'number'
                    ? sessionRecord['lastUpdateTime']
                    : typeof sessionRecord['last_update_time'] === 'number'
                      ? sessionRecord['last_update_time']
                      : Date.now(),
              };
            }

            await this.memoryService.addSessionToMemory(sessionToAdd);
            res.json({output: null});
            return;
          }
          case 'search_memory':
          case 'async_search_memory': {
            if (!request.query) {
              res.status(400).json({error: 'query is required'});
              return;
            }
            const result = await this.memoryService.searchMemory({
              appName,
              userId,
              query: request.query,
            });
            res.json({output: result});
            return;
          }
          case 'save_artifact':
          case 'async_save_artifact': {
            if (!request.filename) {
              res.status(400).json({error: 'filename is required'});
              return;
            }
            if (!request.artifact) {
              res.status(400).json({error: 'artifact is required'});
              return;
            }
            const savedVersion = await this.artifactService.saveArtifact({
              appName,
              userId,
              sessionId: sessionId ?? 'default-session',
              filename: request.filename,
              artifact: request.artifact,
              ...(request.customMetadata
                ? {customMetadata: request.customMetadata}
                : {}),
            });
            res.json({output: savedVersion});
            return;
          }
          case 'load_artifact':
          case 'async_load_artifact': {
            if (!request.filename) {
              res.status(400).json({error: 'filename is required'});
              return;
            }
            const loaded = await this.artifactService.loadArtifact({
              appName,
              userId,
              sessionId: sessionId ?? 'default-session',
              filename: request.filename,
              ...(request.version !== undefined
                ? {version: request.version}
                : {}),
            });
            res.json({output: loaded ?? null});
            return;
          }
          case 'list_artifact_keys':
          case 'async_list_artifact_keys': {
            const keys = await this.artifactService.listArtifactKeys({
              appName,
              userId,
              sessionId: sessionId ?? 'default-session',
            });
            res.json({output: keys});
            return;
          }
          case 'delete_artifact':
          case 'async_delete_artifact': {
            if (!request.filename) {
              res.status(400).json({error: 'filename is required'});
              return;
            }
            await this.artifactService.deleteArtifact({
              appName,
              userId,
              sessionId: sessionId ?? 'default-session',
              filename: request.filename,
            });
            res.json({output: null});
            return;
          }
          case 'list_versions':
          case 'async_list_versions': {
            if (!request.filename) {
              res.status(400).json({error: 'filename is required'});
              return;
            }
            const versions = await this.artifactService.listVersions({
              appName,
              userId,
              sessionId: sessionId ?? 'default-session',
              filename: request.filename,
            });
            res.json({output: versions});
            return;
          }
          case 'list_artifact_versions':
          case 'async_list_artifact_versions': {
            if (!request.filename) {
              res.status(400).json({error: 'filename is required'});
              return;
            }
            const artifactVersions =
              await this.artifactService.listArtifactVersions({
                appName,
                userId,
                sessionId: sessionId ?? 'default-session',
                filename: request.filename,
              });
            res.json({output: artifactVersions});
            return;
          }
          case 'get_artifact_version':
          case 'async_get_artifact_version': {
            if (!request.filename) {
              res.status(400).json({error: 'filename is required'});
              return;
            }
            const artifactVersion =
              await this.artifactService.getArtifactVersion({
                appName,
                userId,
                sessionId: sessionId ?? 'default-session',
                filename: request.filename,
                ...(request.version !== undefined
                  ? {version: request.version}
                  : {}),
              });
            res.json({output: artifactVersion ?? null});
            return;
          }
          case 'streaming_agent_run_with_events': {
            const {session, cleanup} =
              await prepareStreamRunWithEventsSession(request);
            try {
              const abortController = new AbortController();
              req.on('close', () => {
                abortController.abort();
              });
              const chunks: Array<Record<string, unknown>> = [];
              for await (const e of this.executeAgentRun({
                appName,
                userId,
                sessionId: session.id,
                newMessage: request.newMessage as Content,
                stateDelta: request.stateDelta,
                customMetadata: request.customMetadata,
                runConfig: request.runConfig,
                abortSignal: abortController.signal,
              })) {
                events.push(e);
                chunks.push(
                  await buildStreamRunWithEventsChunk(
                    appName,
                    userId,
                    session.id,
                    e,
                  ),
                );
              }
              res.json({output: chunks});
            } finally {
              await cleanup();
            }
            return;
          }
          default:
            break;
        }

        if (!reasoningEngineQueryMethods.includes(classMethod)) {
          res
            .status(400)
            .json({error: `Unsupported class_method: ${classMethod}`});
          return;
        }

        const {session, cleanup} = await prepareQuerySession(request);
        try {
          const abortController = new AbortController();
          req.on('close', () => {
            abortController.abort();
          });
          for await (const e of this.executeAgentRun({
            appName,
            userId,
            sessionId: session.id,
            // `Runner.runAsync` accepts a run with no new message, which this
            // route has always allowed.
            newMessage: request.newMessage as Content,
            stateDelta: request.stateDelta,
            customMetadata: request.customMetadata,
            runConfig: request.runConfig,
            abortSignal: abortController.signal,
          })) {
            events.push(e);
          }
          res.json({output: events});
        } finally {
          await cleanup();
        }
      } catch (e: unknown) {
        const error = `Failed to run agent via Reasoning Engine API: ${e}`;
        res.status(500).json({error, output: events});
        this.logger.error(error);
      }
    });

    app.post(
      '/api/stream_reasoning_engine',
      async (req: Request, res: Response) => {
        const body = await readReasoningEngineBody(req, res);
        if (body === undefined) {
          return;
        }
        let streaming = false;
        try {
          const request = await resolveReasoningEngineRequest(body);
          if (request.status !== undefined) {
            res.status(request.status).json({error: request.error});
            return;
          }
          const {classMethod, appName, userId} = request;
          const isStreamRunWithEvents =
            classMethod === 'streaming_agent_run_with_events';
          if (
            !isStreamRunWithEvents &&
            !reasoningEngineQueryMethods.includes(classMethod)
          ) {
            res
              .status(400)
              .json({error: `Unsupported class_method: ${classMethod}`});
            return;
          }

          const {session, cleanup} = isStreamRunWithEvents
            ? await prepareStreamRunWithEventsSession(request)
            : await prepareQuerySession(request);
          try {
            const abortController = new AbortController();
            // `req` can emit 'close' as soon as its body is read, so only an
            // early close of the response aborts the run.
            res.on('close', () => {
              if (!res.writableEnded) {
                abortController.abort();
              }
            });

            // Headers go out with the first event, so a failure before it still
            // gets a clean error status.
            const startStream = () => {
              if (!streaming) {
                streaming = true;
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Cache-Control', 'no-cache');
              }
            };
            for await (const event of this.executeAgentRun({
              appName,
              userId,
              sessionId: session.id,
              // `Runner.runAsync` accepts a run with no new message.
              newMessage: request.newMessage as Content,
              stateDelta: request.stateDelta,
              customMetadata: request.customMetadata,
              runConfig: request.runConfig,
              abortSignal: abortController.signal,
            })) {
              const payload = isStreamRunWithEvents
                ? await buildStreamRunWithEventsChunk(
                    appName,
                    userId,
                    session.id,
                    event,
                  )
                : event;
              startStream();
              res.write(`${JSON.stringify(payload)}\n`);
            }
            startStream();
            res.end();
          } finally {
            await cleanup();
          }
        } catch (e: unknown) {
          const error = `Failed to run agent via Reasoning Engine API: ${e}`;
          this.logger.error(error);
          if (!streaming) {
            res.status(500).json({error});
          } else if (!res.writableEnded) {
            res.end(`${JSON.stringify({error})}\n`);
          }
        }
      },
    );

    app.post('/run_sse', async (req: Request, res: Response) => {
      const {
        appName,
        userId,
        sessionId,
        newMessage,
        streaming,
        stateDelta,
        customMetadata,
      } = req.body ?? {};
      const appNameError = getAppNameError(appName);
      if (appNameError) {
        res.status(400).json({error: appNameError});
        return;
      }

      const session = await this.sessionService.getSession({
        appName,
        userId,
        sessionId,
      });

      if (!session) {
        const error = `Session not found: ${sessionId}`;

        res.status(404).json({error});
        this.logger.error(error);
        return;
      }

      const abortController = new AbortController();
      let responseCompleted = false;

      req.on('close', () => {
        if (!responseCompleted) {
          this.logger.info(
            `HTTP connection closed. Aborting agent SSE execution for session ${sessionId}`,
          );
          abortController.abort();
        }
      });

      try {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        for await (const event of this.executeAgentRun({
          appName,
          userId,
          sessionId,
          newMessage,
          stateDelta,
          customMetadata,
          runConfig: {
            streamingMode: streaming ? StreamingMode.SSE : StreamingMode.NONE,
          },
          abortSignal: abortController.signal,
        })) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        responseCompleted = true;
        res.end();
      } catch (e: unknown) {
        if (res.headersSent) {
          if (!responseCompleted) {
            const error = (e as Error).message;
            this.logger.error(error);
            try {
              res.end(`data: ${JSON.stringify({error})}\n\n`);
            } catch {
              // Ignore errors from res.end when the response has already been sent.
            }
          }
        } else {
          const error = `Failed to run agent: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      }
    });
  }

  async start(): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, this.host, async () => {
        try {
          process.env.ADK_API_SERVER_PORT = this.effectivePort.toString();
          if (this.a2a) {
            await this.initA2A();
          }

          console.log(`
+-----------------------------------------------------------------------------+
| ADK API Server started                                                      |
|                                                                             |
| For local testing, access at ${this.url}.${''.padStart(39 - this.url.length)}       |
+-----------------------------------------------------------------------------+`);
          resolve();
        } catch (error) {
          this.logger.error('Error during AdkApiServer startup:', error);
          reject(error);
        }
      });

      this.server.on(
        'upgrade',
        (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
          void runWithAgentEngineContext(req.headers, () =>
            this.handleWebSocketUpgrade(req, socket, head),
          );
        },
      );

      this.server.on('error', (err: unknown) => {
        if ((err as {code: string}).code === 'EADDRINUSE') {
          const error = new Error();
          error.cause = err;
          error.message = `Port ${this.port} is already in use`;
          reject(error);
        } else {
          reject(err);
        }
      });
    });
  }

  private async handleWebSocketUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const requestHooks = this.requestHooks;
    let endRequestPromise: Promise<void> | undefined;
    const endRequest = (): Promise<void> => {
      if (!requestHooks) {
        return Promise.resolve();
      }
      endRequestPromise ??= (async () => {
        try {
          await requestHooks.onRequestEnd();
        } catch (error: unknown) {
          this.logger.warn('Telemetry request-end hook failed.', error);
        }
      })();
      return endRequestPromise;
    };
    if (requestHooks) {
      try {
        requestHooks.onRequestStart();
      } catch (error: unknown) {
        this.logger.warn('Telemetry request-start hook failed.', error);
      }
      socket.once('close', () => {
        void endRequest();
      });
    }

    const reqUrl = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    if (reqUrl.pathname !== '/run_live') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      await endRequest();
      socket.destroy();
      return;
    }

    const wsKey = req.headers['sec-websocket-key'];
    if (typeof wsKey !== 'string' || !wsKey) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      await endRequest();
      socket.destroy();
      return;
    }

    const acceptKey = createHash('sha1')
      .update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
    );

    const sendWsText = (text: string) => {
      if (socket.destroyed || !socket.writable) {
        return;
      }
      const payload = Buffer.from(text, 'utf-8');
      const len = payload.length;
      let header: Buffer;
      if (len < 126) {
        header = Buffer.from([0x81, len]);
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      socket.write(Buffer.concat([header, payload]));
    };

    const sendWsClose = (code = 1000, reason = '') => {
      if (socket.destroyed || !socket.writable) {
        return;
      }
      const reasonBuf = Buffer.from(reason, 'utf-8');
      const payload = Buffer.alloc(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      const header = Buffer.from([0x88, payload.length]);
      socket.write(Buffer.concat([header, payload]));
      // Destroy the socket only once the close frame has been flushed.
      socket.end(() => socket.destroy());
    };

    const appName =
      reqUrl.searchParams.get('app_name') ??
      reqUrl.searchParams.get('appName') ??
      '';
    const userId =
      reqUrl.searchParams.get('user_id') ??
      reqUrl.searchParams.get('userId') ??
      '';
    const sessionId =
      reqUrl.searchParams.get('session_id') ??
      reqUrl.searchParams.get('sessionId') ??
      '';
    const modalitiesParam = reqUrl.searchParams.getAll('modalities');

    if (getAppNameError(appName)) {
      // The close frame has a one-byte length, so never echo appName here.
      sendWsClose(1008, 'Invalid appName');
      return;
    }

    const session = await this.sessionService.getSession({
      appName,
      userId,
      sessionId,
    });
    if (!session) {
      await endRequest();
      sendWsClose(1002, 'Session not found');
      return;
    }

    const liveRequestQueue = new LiveRequestQueue();
    let clientRequestedClose = false;
    let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);

    const parseIncomingFrames = () => {
      while (buffer.length >= 2) {
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const opcode = firstByte & 0x0f;
        const isMasked = (secondByte & 0x80) !== 0;
        let payloadLength = secondByte & 0x7f;
        let offset = 2;

        if (payloadLength === 126) {
          if (buffer.length < 4) {
            return;
          }
          payloadLength = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLength === 127) {
          if (buffer.length < 10) {
            return;
          }
          payloadLength = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }

        const maskLength = isMasked ? 4 : 0;
        if (buffer.length < offset + maskLength + payloadLength) {
          return;
        }

        const mask = isMasked
          ? buffer.subarray(offset, offset + 4)
          : Buffer.alloc(0);
        offset += maskLength;
        const payload = Buffer.from(
          buffer.subarray(offset, offset + payloadLength),
        );
        buffer = buffer.subarray(offset + payloadLength);

        if (isMasked) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i % 4];
          }
        }

        if (opcode === 0x08) {
          liveRequestQueue.close();
          // The close frame is answered in the `finally` block below, after
          // the request-end hook finishes, so telemetry is flushed while the
          // connection still holds the CPU.
          clientRequestedClose = true;
          return;
        } else if (opcode === 0x09) {
          if (!socket.destroyed && socket.writable) {
            socket.write(
              Buffer.concat([Buffer.from([0x8a, payload.length]), payload]),
            );
          }
        } else if (opcode === 0x01 || opcode === 0x02) {
          try {
            const text = payload.toString('utf-8');
            const parsed = JSON.parse(text) as LiveRequest;
            liveRequestQueue.send(parsed);
          } catch (e: unknown) {
            this.logger.error(`Invalid WebSocket LiveRequest payload: ${e}`);
          }
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      parseIncomingFrames();
    });
    socket.on('close', () => {
      liveRequestQueue.close();
    });
    socket.on('error', () => {
      liveRequestQueue.close();
    });

    if (buffer.length > 0) {
      parseIncomingFrames();
    }

    try {
      // Resolve the app through the loader first, so an unknown app name
      // never reaches the `.env` lookup.
      const agentFile = await this.agentLoader.getAgentFile(appName);
      this.loadAgentDotenv(appName);
      await using _bundleLease = agentFile.retain();
      const loaded = await agentFile.load();
      const runner = await this.getRunner(loaded, appName);
      const runConfig: RunConfig =
        modalitiesParam.length > 0
          ? {
              responseModalities: modalitiesParam as NonNullable<
                RunConfig['responseModalities']
              >,
            }
          : {};

      for await (const event of runner.runLive({
        userId: session.userId,
        sessionId: session.id,
        liveRequestQueue,
        runConfig,
      })) {
        sendWsText(JSON.stringify(publicEvent(event)));
      }
    } catch (e: unknown) {
      this.logger.error(`Error in run_live WebSocket: ${e}`);
      await endRequest();
      sendWsClose(1011, String((e as Error)?.message ?? e).slice(0, 120));
    } finally {
      liveRequestQueue.close();
      await endRequest();
      if (clientRequestedClose) {
        sendWsClose(1000);
      }
      if (!socket.destroyed && !socket.writableEnded) {
        socket.destroy();
      }
    }
  }

  async stop(): Promise<void> {
    const runners = Object.values(this.runnerCache);
    for (const key of Object.keys(this.runnerCache)) {
      delete this.runnerCache[key];
    }
    await closeRunners(runners);

    const server = this.server;
    // A failed `start()` (EADDRINUSE) and an already-closed server both leave
    // `this.server` assigned, and `close()` on either rejects with
    // ERR_SERVER_NOT_RUNNING. Neither has a listener left, so both are stopped.
    if (!server?.listening) {
      return;
    }

    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }

        console.log(`
+-----------------------------------------------------------------------------+
| ADK API Server stopped                                                      |
+-----------------------------------------------------------------------------+`);
        resolve();
      });
    });
  }

  /**
   * Loads an app's root agent for the structure-graph endpoints, or returns
   * undefined when no app goes by that name.
   *
   * Membership is checked against `listAgents()` rather than by matching the
   * loader's error text, so an app that exists but throws while loading still
   * surfaces as a 500 with its real cause instead of a misleading 404.
   */
  private async loadRootTarget(
    appName: string,
  ): Promise<GraphTarget | undefined> {
    const apps = await this.agentLoader.listAgents();
    if (!apps.includes(appName)) {
      return undefined;
    }

    const agentFile = await this.agentLoader.getAgentFile(appName);
    await using _bundleLease = agentFile.retain();
    const loaded = await agentFile.load();

    return isApp(loaded) ? loaded.rootAgent : loaded;
  }

  /**
   * Loads the `.env` file of a registered app into `process.env`. Call it only
   * after `agentLoader.getAgentFile(appName)` succeeds.
   */
  private loadAgentDotenv(appName: string): void {
    validatePathSegment(appName, 'appName');
    if (!this.agentsDir) {
      return;
    }
    if (fs.existsSync(this.agentsDir) && fs.statSync(this.agentsDir).isFile()) {
      loadDotenvForAgent(
        path.basename(this.agentsDir),
        path.dirname(this.agentsDir),
      );
      return;
    }
    loadDotenvForAgent(appName, this.agentsDir);
  }

  private async getRunner(
    agentOrApp: RunnableRoot | App,
    appName: string,
  ): Promise<Runner> {
    const isAppInstance = isApp(agentOrApp);
    const agent = isAppInstance ? agentOrApp.rootAgent : agentOrApp;
    if (
      !(appName in this.runnerCache) ||
      this.runnerCache[appName].agent !== agent
    ) {
      this.runnerCache[appName] = new Runner({
        app: isAppInstance ? agentOrApp : undefined,
        appName,
        agent,
        memoryService: this.memoryService,
        sessionService: this.sessionService,
        artifactService: this.artifactService,
      });
    }

    return this.runnerCache[appName];
  }

  private async *executeAgentRun(options: {
    appName: string;
    userId: string;
    sessionId: string;
    newMessage: Content;
    stateDelta?: Record<string, unknown>;
    customMetadata?: Record<string, unknown>;
    runConfig?: RunConfig;
    abortSignal: AbortSignal;
  }): AsyncGenerator<Event> {
    validatePathSegment(options.appName, 'appName');
    // Resolve the agent first, so an unknown appName never loads a .env file.
    const agentFile = await this.agentLoader.getAgentFile(options.appName);
    this.loadAgentDotenv(options.appName);
    await using _bundleLease = agentFile.retain();
    const loaded = await agentFile.load();
    const runner = await this.getRunner(loaded, options.appName);

    // Every run endpoint streams through here, so events leave without
    // ADK-internal customMetadata.
    for await (const event of runner.runAsync({
      userId: options.userId,
      sessionId: options.sessionId,
      newMessage: options.newMessage,
      runConfig: options.runConfig,
      stateDelta: options.stateDelta,
      customMetadata: options.customMetadata,
      abortSignal: options.abortSignal,
    })) {
      yield publicEvent(event);
    }
  }
}

/**
 * Returns the validation message for an invalid request `appName`, or
 * `undefined` when `appName` is a safe single path segment.
 */
function getAppNameError(appName: string): string | undefined {
  try {
    validatePathSegment(appName, 'appName');
    return undefined;
  } catch (e: unknown) {
    if (e instanceof InputValidationError) {
      return e.message;
    }
    throw e;
  }
}
