/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AGENT_CARD_PATH} from '@a2a-js/sdk';
import {DefaultRequestHandler, InMemoryTaskStore} from '@a2a-js/sdk/server';
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express';
import {
  A2AAgentExecutor,
  BaseAgent,
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  Event,
  getA2AAgentCard,
  getFunctionCalls,
  getFunctionResponses,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  Logger,
  LogLevel,
  Runner,
  StreamingMode,
} from '@google/adk';
import {trace, TracerProvider} from '@opentelemetry/api';
import {SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';
import cors from 'cors';
import express, {Request, Response} from 'express';
import * as http from 'node:http';
import * as path from 'node:path';

import {AgentFileOptions, AgentLoader} from '../utils/agent_loader.js';
import {
  ApiServerSpanExporter,
  hrTimeToNanoseconds,
  InMemoryExporter,
  setupTelemetry,
} from '../utils/telemetry_utils.js';
import {ApiServerLogger} from './adk_api_server_logger.js';
import {getAgentGraphAsDot} from './agent_graph.js';

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
  otelToCloud?: boolean;
  logger?: Logger;
  logLevel?: LogLevel;
  a2a?: boolean;
  registerProcessors?: (tracerProvider: TracerProvider) => void;
}

export class AdkApiServer {
  private readonly host: string;
  private readonly port: number;
  readonly url: string;
  readonly app: express.Application;
  private readonly agentLoader: AgentLoader;
  private readonly runnerCache: Record<string, Runner> = {};
  private readonly sessionService: BaseSessionService;
  private readonly memoryService: BaseMemoryService;
  private readonly artifactService: BaseArtifactService;
  private readonly serveDebugUI: boolean;
  private readonly allowOrigins?: string;
  private readonly otelToCloud: boolean;
  private readonly registerProcessors?: (
    tracerProvider: TracerProvider,
  ) => void;
  private server?: http.Server;
  private readonly traceDict: Record<string, Record<string, unknown>> = {};
  private readonly sessionTraceDict: Record<string, string[]> = {};
  private memoryExporter: InMemoryExporter;
  private readonly logger: Logger;
  private readonly a2a: boolean;

  constructor(options: ServerOptions) {
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? 8000;
    this.sessionService =
      options.sessionService ?? new InMemorySessionService();
    this.memoryService = options.memoryService ?? new InMemoryMemoryService();
    this.artifactService =
      options.artifactService ?? new InMemoryArtifactService();
    this.agentLoader =
      options.agentLoader ??
      new AgentLoader(options.agentsDir, options.agentFileLoadOptions);
    this.serveDebugUI = options.serveDebugUI ?? false;
    this.allowOrigins = options.allowOrigins;
    this.otelToCloud = options.otelToCloud ?? false;
    this.registerProcessors = options.registerProcessors;
    this.memoryExporter = new InMemoryExporter(this.sessionTraceDict);
    this.logger = options.logger ?? new ApiServerLogger('ADK API Server');
    this.logger.setLogLevel(options.logLevel ?? LogLevel.INFO);
    this.a2a = options.a2a ?? false;
    this.app = express();
    this.url = `http://${this.host}:${this.port}`;
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

    for (const appName of appNames) {
      const agentFile = await this.agentLoader.getAgentFile(appName);
      const agent = await agentFile.load();
      const agentCard = await getA2AAgentCard(agent, [
        {
          url: `${this.url}/a2a/${appName}/rest`,
          transport: 'rest',
        },
        {
          url: `${this.url}/a2a/${appName}/jsonrpc`,
          transport: 'jsonrpc',
        },
      ]);

      const agentExecutor = new A2AAgentExecutor({
        runner: {
          agent,
          appName,
          sessionService: this.sessionService,
          memoryService: this.memoryService,
          artifactService: this.artifactService,
        },
        runConfig: {
          streamingMode: StreamingMode.SSE,
        },
      });
      const requestHandler = new DefaultRequestHandler(
        agentCard,
        new InMemoryTaskStore(),
        agentExecutor,
      );

      this.app.use(
        `/a2a/${appName}/${AGENT_CARD_PATH}`,
        agentCardHandler({agentCardProvider: requestHandler}),
      );
      this.app.use(
        `/a2a/${appName}/rest`,
        restHandler({
          requestHandler,
          userBuilder: UserBuilder.noAuthentication,
        }),
      );
      this.app.use(
        `/a2a/${appName}/jsonrpc`,
        jsonRpcHandler({
          requestHandler,
          userBuilder: UserBuilder.noAuthentication,
        }),
      );
    }
  }

  private async init() {
    const app = this.app;
    await this.setupTelemetry();

    if (this.serveDebugUI) {
      app.get('/', (req: Request, res: Response) => {
        res.redirect('/dev-ui');
      });
      app.use(
        '/dev-ui',
        express.static(path.join(__dirname, './browser'), {
          setHeaders: (res: Response, path: string) => {
            if (path.endsWith('.js')) {
              res.setHeader('Content-Type', 'text/javascript');
            }
          },
        }),
      );
    }

    if (this.allowOrigins) {
      app.use(
        cors({
          origin: this.allowOrigins!,
        }),
      );
    }

    app.use(express.urlencoded({limit: '50mb', extended: true}));
    app.use(
      express.json({
        limit: '50mb',
      }),
    );

    if (this.a2a) {
      await this.initA2A();
    }

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

    app.get('/debug/trace/:eventId', (req: Request, res: Response) => {
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
    });

    app.get(
      '/debug/trace/session/:sessionId',
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
          const rootAgent = await agentFile.load();

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

      try {
        await using agentFile = await this.agentLoader.getAgentFile(appName);
        const agent = await agentFile.load();
        const runner = await this.getRunner(agent, appName);
        const events: Event[] = [];

        for await (const e of runner.runAsync({
          userId,
          sessionId,
          newMessage,
          stateDelta,
        })) {
          events.push(e);
        }

        res.json(events);
      } catch (e: unknown) {
        const error = `Failed to run agent: ${e}`;

        res.status(500).json({error});
        this.logger.error(error);
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

      try {
        await using agentFile = await this.agentLoader.getAgentFile(appName);
        const agent = await agentFile.load();
        const runner = await this.getRunner(agent, appName);

        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        for await (const event of runner.runAsync({
          userId,
          sessionId,
          newMessage,
          runConfig: {
            streamingMode: streaming ? StreamingMode.SSE : StreamingMode.NONE,
          },
          stateDelta,
        })) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        res.end();
      } catch (e: unknown) {
        if (res.headersSent) {
          const error = (e as Error).message;

          res.end(`data: ${JSON.stringify({error})}\n\n`);
          this.logger.error(error);
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

    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`
+-----------------------------------------------------------------------------+
| ADK API Server started                                                      |
|                                                                             |
| For local testing, access at ${this.url}.${''.padStart(39 - this.url.length)}       |
+-----------------------------------------------------------------------------+`);
        resolve();
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

  private async getRunner(agent: BaseAgent, appName: string): Promise<Runner> {
    if (!(appName in this.runnerCache)) {
      this.runnerCache[appName] = new Runner({
        appName,
        agent,
        memoryService: this.memoryService,
        sessionService: this.sessionService,
        artifactService: this.artifactService,
      });
    }

    return this.runnerCache[appName];
  }
}
