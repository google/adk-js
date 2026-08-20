/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OAuth Authentication sample: FunctionNode with GitHub OAuth2 token request.
 * One-to-one port of Python
 * `contributing/samples/workflows/auth_oauth/agent.py`.
 *
 * Demonstrates how to use `authConfig` with GitHub OAuth2 on a FunctionNode to
 * pause the workflow, request an OAuth token from the user, and use it to list
 * the user's GitHub repositories.
 *
 * Flow:
 *   1. User sends any message to start the workflow.
 *   2. The `list_github_repos` node pauses and requests GitHub OAuth
 *      credentials.
 *   3. The user provides the credentials (after logging in to GitHub).
 *   4. The node runs, calls the GitHub API to list repos, and returns the list.
 *   5. The `display_result` node displays the repository names.
 *
 * TypeScript note: Python reads the credential via `ctx.get_auth_response(cfg)`.
 * `NodeContext` has no such helper; the framework stores the exchanged
 * credential at `temp:<credentialKey>` in state (see `AuthHandler`), which the
 * node reads instead. Same as `auth_api_key`.
 *
 * Sample queries:
 *   - "start"
 *   - "list my repos"
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
} from '@google/adk';

const CREDENTIAL_KEY = 'github_oauth_token';

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
      clientId: process.env['GITHUB_CLIENT_ID'] ?? 'YOUR_GITHUB_CLIENT_ID',
      clientSecret:
        process.env['GITHUB_CLIENT_SECRET'] ?? 'YOUR_GITHUB_CLIENT_SECRET',
    },
  },
  credentialKey: CREDENTIAL_KEY,
};

interface RepoResult {
  status: 'Success' | 'Error';
  repos?: string[];
  message?: string;
}

/** Fetches GitHub repositories for the authenticated user. */
const listGithubRepos = node(
  async (ctx: NodeContext): Promise<RepoResult> => {
    const cred = ctx.state.get<AuthCredential>('temp:' + CREDENTIAL_KEY);
    const accessToken = cred?.oauth2?.accessToken;

    if (!accessToken) {
      return {status: 'Error', message: 'No access token found'};
    }

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
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const reposData = (await response.json()) as Array<{name: string}>;
      return {status: 'Success', repos: reposData.map((repo) => repo.name)};
    } catch (e) {
      return {
        status: 'Error',
        message: `Failed to fetch repos: ${e instanceof Error ? e.message : e}`,
      };
    }
  },
  {name: 'list_github_repos', authConfig, rerunOnResume: true},
);

/** Displays the result of accessing the resource. */
const displayResult = node(
  function* (_ctx: NodeContext, nodeInput: RepoResult) {
    const text =
      nodeInput.status === 'Success'
        ? `Successfully fetched repositories: ${(nodeInput.repos ?? []).join(', ')}`
        : `Failed to fetch repositories. Error: ${nodeInput.message ?? 'Unknown error'}`;
    yield createEvent({content: {role: 'user', parts: [{text}]}});
  },
  {name: 'display_result'},
);

export const rootAgent = new Workflow({
  name: 'auth_oauth',
  edges: [['START', listGithubRepos, displayResult]],
});
