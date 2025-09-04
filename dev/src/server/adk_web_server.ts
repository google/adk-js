/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'os';
import * as path from 'path';
import bodyparser = require('body-parser');
import express = require('express');
import type {Request, Response} from 'express';
import {AgentLoader} from './agent_loader';

interface ServerOptions {
  host?: string;
  port?: number;
  agentLoader?: AgentLoader;
}

const defaultOptions: ServerOptions = {
  host: os.hostname(),
  port: 8000,
};

/**
 * ADK Web Server
 * Skeleton only, endpoints needs to be implemented.
 */
export class AdkWebServer {
  private readonly host: string;
  private readonly port: number;
  private readonly app: express.Application;
  private readonly agentLoader: AgentLoader;

  constructor(options = defaultOptions) {
    this.host = options.host ?? defaultOptions.host!;
    this.port = options.port ?? defaultOptions.port!;
    this.agentLoader = options.agentLoader ?? new AgentLoader();
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
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    // ------------------------- Session related endpoints ---------------------
    app.get(
        '/apps/:appName/users/:userId/sessions/:sessionId',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.get(
        '/apps/:appName/users/:userId/sessions',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.post(
        '/apps/:appName/users/:userId/sessions/:sessionId',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.post(
        '/apps/:appName/users/:userId/sessions',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.delete(
        '/apps/:appName/users/:userId/sessions/:sessionId',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    // ----------------------- Artifact related endpoints ----------------------
    app.get(
        '/apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.get(
        '/apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName/versions/:versionId',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.get(
        '/apps/:appName/users/:userId/sessions/:sessionId/artifacts',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.get(
        '/apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName/versions',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
        });

    app.delete(
        '/apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName',
        (req: Request, res: Response) => {
          return res.status(501).json({error: 'Not implemented'});
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
      return res.status(501).json({error: 'Not implemented'});
    });

    app.post('/run_sse', async (req: Request, res: Response) => {
      return res.status(501).json({error: 'Not implemented'});
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
}
