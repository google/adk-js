/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  Event,
  getFunctionCalls,
  getFunctionResponses,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  Runner,
  StreamingMode,
} from '@google/adk';
import {trace, TracerProvider} from '@opentelemetry/api';
import {SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';
import cors from 'cors';
import express, {Request, Response} from 'express';
import * as http from 'http';
import * as path from 'path';

import {AgentLoader} from '../utils/agent_loader.js';
import {
  ApiServerSpanExporter,
  hrTimeToNanoseconds,
  InMemoryExporter,
  setupTelemetry,
} from '../utils/telemetry_utils.js';

import {getAgentGraphAsDot} from './agent_graph.js';

interface ServerOptions {
  agentsDir?: string;
  host?: string;
  port?: number;
  sessionService?: BaseSessionService;
  memoryService?: BaseMemoryService;
  artifactService?: BaseArtifactService;
  agentLoader?: AgentLoader;
  serveDebugUI?: boolean;
  allowOrigins?: string;
  otelToCloud?: boolean;
  registerProcessors?: (tracerProvider: TracerProvider) => void;
}

export class AdkWebServer {
  private readonly host: string;
  private readonly port: number;
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

  constructor(options: ServerOptions) {
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? 8000;
    this.sessionService =
      options.sessionService ?? new InMemorySessionService();
    this.memoryService = options.memoryService ?? new InMemoryMemoryService();
    this.artifactService =
      options.artifactService ?? new InMemoryArtifactService();
    this.agentLoader =
      options.agentLoader ?? new AgentLoader(options.agentsDir);
    this.serveDebugUI = options.serveDebugUI ?? false;
    this.allowOrigins = options.allowOrigins;
    this.otelToCloud = options.otelToCloud ?? false;
    this.registerProcessors = options.registerProcessors;
    this.memoryExporter = new InMemoryExporter(this.sessionTraceDict);

    this.app = express();

    this.init();
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

  private init() {
    const app = this.app;
    this.setupTelemetry();

    if (this.serveDebugUI) {
      app.get('/', (req: Request, res: Response) => {
        res.redirect('/dev-ui');
      });
      app.use(
        '/dev-ui',
        express.static(path.join(__dirname, '../browser'), {
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

    app.get('/list-apps', async (req: Request, res: Response) => {
      try {
        const apps = await this.agentLoader.listAgents();
        res.json(apps);
      } catch (e: unknown) {
        res.status(500).json({error: (e as Error).message});
      }
    });

    app.get('/debug/trace/:eventId', (req: Request, res: Response) => {
      const eventId = req.params['eventId'];
      const eventDict = this.traceDict[eventId];

      if (!eventDict) {
        return res.status(404).json({error: 'Trace not found'});
      }

      return res.json(eventDict);
    });

    app.get(
      '/debug/trace/session/:sessionId',
      (req: Request, res: Response) => {
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
          res.status(500).json({error: (e as Error).message});
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
          res.status(500).json({error: (e as Error).message});
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
          res.status(500).json({error: (e as Error).message});
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
            state: {},
            sessionId,
          });

          res.json(createdSession);
        } catch (e: unknown) {
          res.status(500).json({error: (e as Error).message});
        }
      },
    );

    app.post(
      '/apps/:appName/users/:userId/sessions',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];

          const createdSession = await this.sessionService.createSession({
            appName,
            userId,
          });

          res.json(createdSession);
        } catch (e: unknown) {
          res.status(500).json({error: (e as Error).message});
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
          res.status(500).json({error: (e as Error).message});
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
          res.status(500).json({error: (e as Error).message});
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
          res.status(500).json({error: (e as Error).message});
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
          res.status(500).json({error: (e as Error).message});
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
          res.status(500).json({error: (e as Error).message});
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
          res.status(500).json({error: (e as Error).message});
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
      const {appName, userId, sessionId, newMessage} = req.body;
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
        })) {
          events.push(e);
        }

        res.json(events);
      } catch (e: unknown) {
        res.status(500).json({error: (e as Error).message});
      }
    });

    app.post('/run_sse', async (req: Request, res: Response) => {
      const {appName, userId, sessionId, newMessage, streaming} = req.body;

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
        })) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        res.end();
      } catch (e: unknown) {
        if (res.headersSent) {
          res.end(`data: ${JSON.stringify({error: (e as Error).message})}\n\n`);
        } else {
          res.status(500).json({error: (e as Error).message});
        }
      }
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        const url = `${this.host}:${this.port}`;

        console.log(`
+-----------------------------------------------------------------------------+
| ADK Web Server started                                                      |
|                                                                             |
| For local testing, access at http://${url}.${''.padStart(39 - url.length)}|
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
| ADK Web Server stopped                                                      |
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
