/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {name: 'pagination-test-server', version: '1.0.0'},
  {capabilities: {tools: {}, resources: {}}},
);

// An empty intermediate page and an empty-string cursor are both valid.
function page(params, values) {
  switch (params?.cursor) {
    case undefined:
      return {values: [values[0]], nextCursor: ''};
    case '':
      return {values: [], nextCursor: 'last/page?token=opaque'};
    case 'last/page?token=opaque':
      return {values: [values[1]]};
    default:
      throw new Error('Unexpected cursor');
  }
}

server.setRequestHandler(ListToolsRequestSchema, async ({params}) => {
  const {values, ...rest} = page(params, [
    {name: 'first', inputSchema: {type: 'object'}},
    {name: 'last', inputSchema: {type: 'object'}},
  ]);
  return {tools: values, ...rest};
});
server.setRequestHandler(CallToolRequestSchema, async ({params}) => ({
  content: [{type: 'text', text: `called ${params.name}`}],
}));
server.setRequestHandler(ListResourcesRequestSchema, async ({params}) => {
  const {values, ...rest} = page(params, [
    {name: 'first', uri: 'test:///first'},
    {name: 'last', uri: 'test:///last'},
  ]);
  return {resources: values, ...rest};
});
server.setRequestHandler(ReadResourceRequestSchema, async ({params}) => ({
  contents: [{uri: params.uri, text: `read ${params.uri}`}],
}));

await server.connect(new StdioServerTransport());
