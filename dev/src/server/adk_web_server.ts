/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, BaseArtifactService, BaseMemoryService, BaseSessionService, Event, InMemoryArtifactService, InMemoryMemoryService, InMemorySessionService, Runner, Session} from '@google/adk';
import bodyparser = require('body-parser');
import express = require('express');
import type {Request, Response} from 'express';
import * as os from 'os';
import * as path from 'path';
import {Readable} from 'stream';

import {AgentLoader} from './agent_loader.js';

interface ServerOptions {
  host?: string;
  port?: number;
  sessionService?: BaseSessionService;
  memoryService?: BaseMemoryService;
  artifactService?: BaseArtifactService;
  agentLoader?: AgentLoader;
}

const defaultOptions: ServerOptions = {
  host: os.hostname(),
  port: 8000,
  sessionService: new InMemorySessionService(),
  memoryService: new InMemoryMemoryService(),
  artifactService: new InMemoryArtifactService(),
  agentLoader: new AgentLoader(),
};

export class AdkWebServer {
  private readonly host: string;
  private readonly port: number;
  private readonly app: express.Application;
  private readonly agentLoader: AgentLoader;
  private readonly runnerRecord: Record<string, Runner> = {};
  private readonly sessionService: BaseSessionService;
  private readonly memoryService: BaseMemoryService;
  private readonly artifactService: BaseArtifactService;

  constructor(options = defaultOptions) {
    this.host = options.host ?? defaultOptions.host!;
    this.port = options.port ?? defaultOptions.port!;
    this.sessionService =
        options.sessionService ?? defaultOptions.sessionService!;
    this.memoryService = options.memoryService ?? defaultOptions.memoryService!;
    this.artifactService =
        options.artifactService ?? defaultOptions.artifactService!;
    this.agentLoader = options.agentLoader ?? defaultOptions.agentLoader!;
    this.app = express();

    this.init();
  }

  private init() {
    const app = this.app;

    app.get('/', (req: Request, res: Response) => {res.redirect('/dev-ui')});
    app.use('/dev-ui', express.static(path.join(__dirname, '../browser'), {
      setHeaders: (res: Response, path: string) => {
        if (path.endsWith('.js')) {
          res.setHeader('Content-Type', 'text/javascript');
        }
      }
    }));

    app.use(bodyparser.urlencoded({extended: true}));
    app.use(bodyparser.json());

    app.get('/list-apps', async (req: Request, res: Response) => {
      try {
        const apps = await this.agentLoader.listAgents();

        res.json(apps);
      } catch (e: unknown) {
        res.status(500).json({error: (e as Error).message});
      }
    });

    app.get('/debug/trace/:eventId', (req: Request, res: Response) => {
      return res.status(501).json({error: 'Not implemented'});
    });

    app.get(
        '/debug/trace/session/:sessionId', (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.get(
        '/apps/:appName/users/:userId/sessions/:sessionId/events/:eventId/graph',
        async (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

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
        });

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
        });

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
              res.status(400).json(
                  {error: `Session already exists: ${sessionId}`});
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
        });

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
        });

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

            res.status(204);
          } catch (e: unknown) {
            res.status(500).json({error: (e as Error).message});
          }
        });

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
              res.status(404).json(
                  {error: `Artifact not found: ${artifactName}`});
              return;
            }

            res.json(artifact);
          } catch (e: unknown) {
            res.status(500).json({error: (e as Error).message});
          }
        });

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
              res.status(404).json(
                  {error: `Artifact not found: ${artifactName}`});
              return;
            }

            res.json(artifact);
          } catch (e: unknown) {
            res.status(500).json({error: (e as Error).message});
          }
        });

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
        });

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
        });

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

            res.status(204);
          } catch (e: unknown) {
            res.status(500).json({error: (e as Error).message});
          }
        });

    // --------------------- Eval Sets related endpoints -----------------------
    // TODO: Implement eval set related endpoints.
    app.post(
        '/apps/:appName/eval_sets/:evalSetId',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.get('/apps/:appName/eval_sets', (req: Request, res: Response) => {
      return res.status(501).json({error: 'Not implemented'});
    });

    app.post(
        '/apps/:appName/eval_sets/:evalSetId/add_session',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.get(
        '/apps/:appName/eval_sets/:evalSetId/evals',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.get(
        '/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.put(
        '/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.delete(
        '/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.post(
        '/apps/:appName/eval_sets/:evalSetId/run_eval',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    // ----------------------- Eval Results related endpoints ------------------
    // TODO: Implement eval results related endpoints.
    app.get(
        '/apps/:appName/eval_results/:evalResultId',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

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
        const runner = await this.getRunner(appName);
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
        const runner = await this.getRunner(appName);

        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        for await (const event of runner.runAsync({
          userId,
          sessionId,
          newMessage,
        })) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        res.end();
      } catch (e: unknown) {
        res.status(500).json({error: (e as Error).message});
      }
    });
  }

  start() {
    this.app.listen(this.port);

    const url = `${this.host}:${this.port}`;
    console.log(`
+-----------------------------------------------------------------------------+
| ADK Web Server started                                                      |
|                                                                             |
| For local testing, access at http://${url}.${''.padStart(39 - url.length)}|
+-----------------------------------------------------------------------------+`);
  }

  private async getRunner(appName: string): Promise<Runner> {
    if (!(appName in this.runnerRecord)) {
      const agent = await this.agentLoader.loadAgent(appName);

      if (!agent) {
        throw new Error(`Agent not found: ${appName}`);
      }

      const runner = new Runner({
        appName,
        agent,
        memoryService: this.memoryService,
        sessionService: this.sessionService,
        artifactService: this.artifactService,
      });
      this.runnerRecord[appName] = runner;
    }

    return this.runnerRecord[appName];
  }
}
