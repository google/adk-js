/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OAuth Authentication: a FunctionNode with GitHub OAuth2 token request. The
 * `list_github_repos` node declares an OAuth2 `authConfig`, so the framework
 * pauses the workflow to request a GitHub OAuth token; once the user completes
 * the flow, the node calls the GitHub API to list the user's repositories.
 * Faithful port of Python `contributing/samples/workflows/auth_oauth`.
 *
 * To use this sample, register an OAuth application on GitHub and set the
 * GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET environment variables.
 *
 * TypeScript notes: Python reads the credential via `ctx.get_auth_response(cfg)`;
 * here the framework stores it at `temp:<credentialKey>` in state. Python uses
 * the `requests` library; this port uses the built-in `fetch`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/auth_oauth/agent.ts
 * Turn 1: any message ("start") -> requests GitHub OAuth credentials.
 * Turn 2: complete the auth flow to list your repositories.
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  createEvent,
  node,
  NodeContext,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

// Uses GitHub OAuth2 authorization code flow.
const authConfig: AuthConfig = {
  authScheme: {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        scopes: {
          user: 'Read user profile',
          repo: 'Access public repositories',
        },
      },
    },
  } as AuthScheme,
  rawAuthCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: process.env.GITHUB_CLIENT_ID ?? 'YOUR_GITHUB_CLIENT_ID',
      clientSecret:
        process.env.GITHUB_CLIENT_SECRET ?? 'YOUR_GITHUB_CLIENT_SECRET',
    },
  },
  credentialKey: 'github_oauth_token',
};

interface RepoResult {
  status: 'Success' | 'Error';
  repos?: string[];
  message?: string;
}

// Fetches GitHub repositories for the authenticated user.
const listGithubRepos = node(
  async (ctx: NodeContext): Promise<RepoResult> => {
    // After auth completes, the credential is available in state.
    const cred = ctx.state.get<AuthCredential>('temp:github_oauth_token');
    const accessToken = cred?.oauth2?.accessToken;

    if (!accessToken) {
      return {status: 'Error', message: 'No access token found'};
    }

    // GitHub API requires a User-Agent header.
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'ADK-Sample-Agent',
      Accept: 'application/json',
    };

    try {
      const response = await fetch('https://api.github.com/user/repos', {
        headers,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const reposData = (await response.json()) as Array<{name: string}>;
      return {status: 'Success', repos: reposData.map((repo) => repo.name)};
    } catch (e) {
      return {status: 'Error', message: `Failed to fetch repos: ${e}`};
    }
  },
  {name: 'list_github_repos', authConfig, rerunOnResume: true},
);

/** Emits a plain display message (Python `Event(message=...)`). */
const message = (text: string) =>
  createEvent({content: {role: 'model', parts: [{text}]}});

// Displays the result of accessing the resource.
const displayResult = node(
  (_ctx: NodeContext, nodeInput: RepoResult) => {
    if (nodeInput.status === 'Success') {
      return message(
        `Successfully fetched repositories: ${(nodeInput.repos ?? []).join(', ')}`,
      );
    }
    return message(
      `Failed to fetch repositories. Error: ${nodeInput.message ?? 'Unknown error'}`,
    );
  },
  {name: 'display_result'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'auth_oauth',
    edges: [['START', listGithubRepos, displayResult]],
  }),
);
