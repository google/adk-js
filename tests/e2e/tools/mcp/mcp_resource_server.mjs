/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server exposing two resources (one text, one binary) over
 * stdio. It is spawned as a child process by the LoadMcpResourceTool e2e test to
 * exercise the resource path end-to-end with no mocks.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({name: 'e2e-resource-server', version: '1.0.0'});

server.registerResource(
  'readme',
  'file:///readme.txt',
  {mimeType: 'text/plain'},
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'text/plain',
        text: 'hello from mcp resource',
      },
    ],
  }),
);

server.registerResource(
  'logo',
  'file:///logo.png',
  {mimeType: 'image/png'},
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'image/png',
        blob: Buffer.from('binary-logo-bytes').toString('base64'),
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
