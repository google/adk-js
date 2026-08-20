/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Part, Type} from '@google/genai';
import type {
  BlobResourceContents,
  TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';

import {appendInstructions, LlmRequest} from '../../models/llm_request.js';
import {logger} from '../../utils/logger.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from '../base_tool.js';

import {MCPToolset} from './mcp_toolset.js';

/**
 * A tool that loads MCP server resources and adds them to the session.
 *
 * This mirrors the in-repo `LoadArtifactsTool` idiom: the model calls
 * `load_mcp_resource` with the names of the resources it wants, and on the next
 * turn {@link processLlmRequest} reads those resources over the MCP session and
 * appends their contents (text and base64-encoded binary) to the request
 * context.
 */
export class LoadMcpResourceTool extends BaseTool {
  private readonly mcpToolset: MCPToolset;

  constructor(mcpToolset: MCPToolset) {
    super({
      name: 'load_mcp_resource',
      description: `Loads resources from the MCP server.\n\nNOTE: Call when you need access to resources.`,
    });
    this.mcpToolset = mcpToolset;
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          resource_names: {
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
            },
            description: 'The names of the MCP resources to load.',
          },
        },
      },
    };
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const resourceNames = (args['resource_names'] as string[]) || [];
    return {
      resource_names: resourceNames,
      status:
        'resource contents temporarily inserted and removed. to access these resources, call load_mcp_resource tool again.',
    };
  }

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(request);
    await this.appendResourcesToLlmRequest(request.llmRequest);
  }

  private async appendResourcesToLlmRequest(
    llmRequest: LlmRequest,
  ): Promise<void> {
    try {
      const availableResourceNames = await this.mcpToolset.listResources();
      if (availableResourceNames.length > 0) {
        appendInstructions(llmRequest, [
          `You have a list of MCP resources:\n${JSON.stringify(
            availableResourceNames,
          )}\n\nWhen the user asks questions about any of the resources, you should call the\n\`load_mcp_resource\` function to load the resource. Always call load_mcp_resource\nbefore answering questions related to the resources.`,
        ]);
      }
    } catch (e) {
      logger.warn(`Failed to list MCP resources: ${e}`);
    }

    const lastContent = llmRequest.contents.at(-1);
    const functionResponse = lastContent?.parts?.[0]?.functionResponse;
    if (!functionResponse || functionResponse.name !== this.name) {
      return;
    }

    const response =
      (functionResponse.response as Record<string, unknown>) || {};
    const requestedResourceNames =
      (response['resource_names'] as string[]) || [];

    for (const resourceName of requestedResourceNames) {
      try {
        const resourceContents =
          await this.mcpToolset.readResource(resourceName);
        for (const content of resourceContents) {
          llmRequest.contents.push({
            role: 'user',
            parts: [
              {text: `Resource ${resourceName} is:`},
              this.mcpContentToPart(content, resourceName),
            ],
          });
        }
      } catch (e) {
        logger.warn(`Failed to read MCP resource '${resourceName}': ${e}`);
      }
    }
  }

  private mcpContentToPart(
    content: TextResourceContents | BlobResourceContents,
    resourceName: string,
  ): Part {
    if ('text' in content) {
      return {text: content.text};
    }
    if ('blob' in content) {
      // The MCP SDK blob and Part.inlineData.data are both base64 strings, so
      // the blob is assigned directly with no decode/re-encode step.
      return {
        inlineData: {
          data: content.blob,
          mimeType: content.mimeType ?? 'application/octet-stream',
        },
      };
    }
    return {text: `[Unknown content type for ${resourceName}]`};
  }
}
