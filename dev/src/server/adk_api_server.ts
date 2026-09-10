/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  bearerTokenUserBuilder,
  Event,
  getFunctionCalls,
  getFunctionResponses,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  isApp,
  Logger,
  LogLevel,
  RunConfig,
  RunnableRoot,
  Runner,
  StreamingMode,
  toA2a,
} from '@google/adk';
import {Content} from '@google/genai';
import {trace, TracerProvider} from '@opentelemetry/api';
import {SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';
import cors from 'cors';
import express, {Request, Response} from 'express';
import * as http from 'node:http';
import * as path from 'node:path';
import {version} from '../version.js';

import {AgentFileOptions, AgentLoader} from '../utils/agent_loader.js';
import {AdkLogger} from '../utils/logger.js';
import {
  ApiServerSpanExporter,
  hrTimeToNanoseconds,
  InMemoryExporter,
  setupTelemetry,
} from '../utils/telemetry_utils.js';
import {getAgentGraphAsDot, getWorkflowHighlights} from './agent_graph.js';
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

export class AdkApiServer {
  private readonly host: string;
  private readonly port: number;

  get url(): string {
    if (this.server) {
      const address = this.server.address();
      if (address && typeof address !== 'string') {
        return `http://${this.host}:${address.port}`;
      }
    }
    return `http://${this.host}:${this.port}`;
  }

  readonly app: express.Application;
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
  private readonly serveDebugUI: boolean;
  private readonly allowOrigins?: string;
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

  constructor(options: ServerOptions) {
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? 0; // 0 means random free port
    this.sessionService =
      options.sessionService ?? new InMemorySessionService();
    this.memoryService = options.memoryService ?? new InMemoryMemoryService();
    this.artifactService =
      options.artifactService ?? new InMemoryArtifactService();
    this.agentLoader =
      options.agentLoader ??
      new AgentLoader(
        options.agentsDir,
        options.agentFileLoadOptions,
        options.reloadAgents ?? false,
      );
    this.serveDebugUI = options.serveDebugUI ?? false;
    this.allowOrigins = options.allowOrigins;
    this.allowedHosts = options.allowedHosts;
    this.otelToCloud = options.otelToCloud ?? false;
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
    this.a2a = options.a2a ?? false;
    // An exported-but-empty value means "no token"; anything else is handed
    // to the authenticator, which rejects a token that is not usable.
    this.a2aAuthToken =
      options.a2aAuthToken || process.env[A2A_AUTH_TOKEN_ENV_VAR] || undefined;
    this.app = express();
  }

  private async setupTelemetry(): Promise<void> {
    const internalExporters = [
      new SimpleSpanProcessor(new ApiServerSpanExporter(this.traceDict)),
      new SimpleSpanProcessor(this.memoryExporter),
    ];

    await setupTelemetry(this.otelToCloud, internalExporters);

    if (this.registerProcessors) {
      const tracerProvider = trace.getTracerProvider();
      this.registerProcessors(tracerProvider);
    }
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
        port: this.port,
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
    await this.setupTelemetry();

    // Registered before any route (including /health, /, /version) so the
    // DNS-rebinding guard applies to every endpoint, not just the ones
    // registered after this point. Origin cannot be relied on here: a
    // DNS-rebound page's requests look same-origin to the browser, which
    // omits Origin for them, so safe methods (GET/HEAD/OPTIONS) get the
    // same check as everything else.
    const allowedRequestHosts = getAllowedRequestHosts(
      this.allowOrigins,
      this.allowedHosts,
    );
    app.use((req: Request, res: Response, next: express.NextFunction) => {
      if (
        isDnsRebindingRequest(req.headers.host, this.host, allowedRequestHosts)
      ) {
        this.logger.warn(
          `Rejected request with Host ${JSON.stringify(String(req.headers.host).slice(0, 128))}: the server is bound to ` +
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

    if (this.serveDebugUI) {
      app.get('/', (req: Request, res: Response) => {
        res.redirect('/dev-ui');
      });
      app.use(
        '/dev-ui',
        express.static(path.join(__dirname, '../../browser'), {
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

    if (this.allowOrigins) {
      app.use(
        cors({
          origin: this.allowOrigins!,
        }),
      );
    }

    app.use(
      express.json({
        limit: '50mb',
      }),
    );

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
          await using agentFile = await this.agentLoader.getAgentFile(appName);
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

          return res.json(serializeAppInfo(appName, rootAgent));
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

          res.json(session);
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

          res.json(sessions);
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

          res.json(createdSession);
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

          res.json(createdSession);
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

          const artifact = await this.artifactService.loadArtifact({
            appName,
            userId,
            sessionId,
            filename: artifactName,
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
    // TODO: Implement eval set related endpoints.
    app.post(
      '/apps/:appName/eval_sets/:evalSetId',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.get('/apps/:appName/eval_sets', (req: Request, res: Response) => {
      return res.status(501).json({error: 'Not implemented'});
    });

    app.post(
      '/apps/:appName/eval_sets/:evalSetId/add_session',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.get(
      '/apps/:appName/eval_sets/:evalSetId/evals',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.get(
      '/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.put(
      '/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.delete(
      '/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.post(
      '/apps/:appName/eval_sets/:evalSetId/run_eval',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    // ----------------------- Eval Results related endpoints ------------------
    // TODO: Implement eval results related endpoints.
    app.get(
      '/apps/:appName/eval_results/:evalResultId',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.get('/apps/:appName/eval_results', (req: Request, res: Response) => {
      return res.status(501).json({error: 'Not implemented'});
    });

    app.get('/apps/:appName/eval_metrics', (req: Request, res: Response) => {
      return res.status(501).json({error: 'Not implemented'});
    });

    // -------------------------- Run related endpoints ------------------------
    app.post('/run', async (req: Request, res: Response) => {
      const {appName, userId, sessionId, newMessage, stateDelta} = req.body;
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

    app.post('/api/reasoning_engine', async (req: Request, res: Response) => {
      this.logger.info(
        `Received Reasoning Engine query headers: ${JSON.stringify(req.headers)}`,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const executeQuery = async (body: any) => {
        const input = body.input || {};
        const appName = input.appName || body.appName;
        const userId = input.userId || body.userId || 'default-user';
        const sessionId =
          input.sessionId || body.sessionId || 'default-session';
        const newMessage = input.newMessage || body.newMessage;
        const stateDelta = input.stateDelta || body.stateDelta;
        if (!appName) {
          res.status(400).json({error: 'appName is required in input'});
          return;
        }
        const events: Event[] = [];
        try {
          await this.sessionService.getOrCreateSession({
            appName,
            userId,
            sessionId,
            state: {},
          });
          const abortController = new AbortController();
          req.on('close', () => {
            abortController.abort();
          });
          for await (const e of this.executeAgentRun({
            appName,
            userId,
            sessionId,
            newMessage,
            stateDelta,
            abortSignal: abortController.signal,
          })) {
            events.push(e);
          }
          res.json({output: events});
        } catch (e: unknown) {
          const error = `Failed to run agent via Reasoning Engine API: ${e}`;
          res.status(500).json({error, output: events});
          this.logger.error(error);
        }
      };

      const isParsed =
        req.body && (Object.keys(req.body).length > 0 || !req.readable);
      if (isParsed) {
        this.logger.info(
          `Using already parsed body: ${JSON.stringify(req.body)}`,
        );
        await executeQuery(req.body);
      } else {
        let rawBody = '';
        req.on('data', (chunk) => {
          rawBody += chunk;
        });
        req.on('end', async () => {
          this.logger.info(`Received Reasoning Engine raw body: ${rawBody}`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let body: any = {};
          if (rawBody) {
            try {
              body = JSON.parse(rawBody);
            } catch (e) {
              this.logger.error(`Failed to parse raw body as JSON: ${e}`);
            }
          }
          await executeQuery(body);
        });
      }
    });

    app.post('/run_sse', async (req: Request, res: Response) => {
      const {appName, userId, sessionId, newMessage, streaming, stateDelta} =
        req.body;

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

  stop(): Promise<void> {
    if (!this.server) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
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

    await using agentFile = await this.agentLoader.getAgentFile(appName);
    const loaded = await agentFile.load();

    return isApp(loaded) ? loaded.rootAgent : loaded;
  }

  private async getRunner(
    agentOrApp: RunnableRoot | App,
    appName: string,
  ): Promise<Runner> {
    if (!(appName in this.runnerCache)) {
      const isAppInstance = isApp(agentOrApp);
      const agent = isAppInstance ? agentOrApp.rootAgent : agentOrApp;
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
    runConfig?: RunConfig;
    abortSignal: AbortSignal;
  }): AsyncGenerator<Event> {
    await using agentFile = await this.agentLoader.getAgentFile(
      options.appName,
    );
    const loaded = await agentFile.load();
    const runner = await this.getRunner(loaded, options.appName);

    yield* runner.runAsync({
      userId: options.userId,
      sessionId: options.sessionId,
      newMessage: options.newMessage,
      runConfig: options.runConfig,
      stateDelta: options.stateDelta,
      abortSignal: options.abortSignal,
    });
  }
}
