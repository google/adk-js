/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import Anthropic from '@anthropic-ai/sdk';
import {Content, FinishReason, FunctionDeclaration, Part} from '@google/genai';

import {logger} from '../utils/logger.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

export interface ClaudeParams {
  model: string;
  apiKey?: string;
  maxTokens?: number;
  client?: Anthropic;
}

/**
 * Represents the Claude Generative AI model by Anthropic.
 *
 * <p>This class provides methods for interacting with Claude models. Streaming and live connections
 * are not currently supported for Claude.
 */
export class Claude extends BaseLlm {
  private readonly client: Anthropic;
  private readonly maxTokens: number;

  static override readonly supportedModels: Array<string | RegExp> = [
    /claude-.*/,
  ];

  constructor(params: ClaudeParams) {
    super({model: params.model});
    this.maxTokens = params.maxTokens ?? 8192;
    if (params.client) {
      this.client = params.client;
    } else {
      this.client = new Anthropic({
        apiKey: params.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '',
      });
    }
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    if (stream) {
      logger.warn(
        'Streaming is not currently supported for Claude models. Falling back to non-streaming.',
      );
    }

    this.maybeAppendUserContent(llmRequest);

    const messages = this.contentsToAnthropicMessages(llmRequest.contents);
    const tools = this.toolsToAnthropicTools(llmRequest);

    let systemText = '';
    if (llmRequest.config?.systemInstruction) {
      const sysInst = llmRequest.config.systemInstruction as unknown as Record<
        string,
        unknown
      >;
      if (typeof sysInst === 'string') {
        systemText = sysInst;
      } else if (Array.isArray(sysInst.parts)) {
        systemText = sysInst.parts
          .map((p: Record<string, unknown>) =>
            typeof p.text === 'string' ? p.text : '',
          )
          .filter((t: string) => t.length > 0)
          .join('\n');
      } else if (typeof sysInst.text === 'string') {
        systemText = sysInst.text;
      }
    }

    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: llmRequest.model ?? this.model,
      max_tokens: this.maxTokens,
      messages,
    };

    if (systemText) {
      requestParams.system = systemText;
    }

    if (tools.length > 0) {
      requestParams.tools = tools;
      requestParams.tool_choice = {
        type: 'auto',
        disable_parallel_tool_use: true,
      };
    }

    const response = await this.client.messages.create(requestParams);
    logger.debug(`Claude response: ${JSON.stringify(response)}`);

    yield this.convertAnthropicResponseToLlmResponse(response);
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connection is not supported for Claude models.');
  }

  private contentsToAnthropicMessages(
    contents: Content[],
  ): Anthropic.MessageParam[] {
    return contents.map((c) => {
      const role: 'user' | 'assistant' =
        c.role === 'model' || c.role === 'assistant' ? 'assistant' : 'user';
      const content = c.parts
        ?.map((p) => this.partToAnthropicMessageBlock(p))
        .filter(Boolean) as Array<
        | Anthropic.TextBlockParam
        | Anthropic.ImageBlockParam
        | Anthropic.ToolUseBlockParam
        | Anthropic.ToolResultBlockParam
      >;

      return {
        role,
        content: content && content.length > 0 ? content : '',
      };
    });
  }

  private partToAnthropicMessageBlock(
    part: Part,
  ):
    | Anthropic.TextBlockParam
    | Anthropic.ToolUseBlockParam
    | Anthropic.ToolResultBlockParam
    | undefined {
    if (part.text !== undefined && part.text !== null) {
      return {type: 'text', text: part.text};
    } else if (part.functionCall) {
      return {
        type: 'tool_use',
        id: part.functionCall.id ?? '', // ID is required by Anthropic
        name: part.functionCall.name ?? '',
        input: part.functionCall.args ?? {},
      };
    } else if (part.functionResponse) {
      let content = '';
      if (part.functionResponse.response) {
        const respObj = part.functionResponse.response as Record<
          string,
          unknown
        >;
        if (
          respObj &&
          typeof respObj === 'object' &&
          'result' in respObj &&
          respObj.result !== null &&
          respObj.result !== undefined
        ) {
          content = String(respObj.result);
        } else {
          content = JSON.stringify(part.functionResponse.response);
        }
      }
      return {
        type: 'tool_result',
        tool_use_id: part.functionResponse.id ?? '',
        content,
        is_error: false,
      };
    }
    return undefined;
  }

  private toolsToAnthropicTools(llmRequest: LlmRequest): Anthropic.Tool[] {
    const tools: Anthropic.Tool[] = [];
    if (!llmRequest.config?.tools) {
      return tools;
    }

    for (const toolObj of llmRequest.config.tools) {
      if ('functionDeclarations' in toolObj && toolObj.functionDeclarations) {
        for (const funcDecl of toolObj.functionDeclarations) {
          tools.push(this.functionDeclarationToAnthropicTool(funcDecl));
        }
      }
    }
    return tools;
  }

  private functionDeclarationToAnthropicTool(
    funcDecl: FunctionDeclaration,
  ): Anthropic.Tool {
    const inputSchema: Anthropic.Tool.InputSchema = {
      type: 'object',
      properties: {},
    };

    if (funcDecl.parameters) {
      const fullSchema = structuredClone(funcDecl.parameters);
      this.updateTypeString(fullSchema);

      if (fullSchema.properties) {
        inputSchema.properties = fullSchema.properties as Record<
          string,
          unknown
        >;
      }
      if (fullSchema.required) {
        inputSchema.required = fullSchema.required;
      }
    }

    return {
      name: funcDecl.name ?? '',
      description: funcDecl.description ?? '',
      input_schema: inputSchema,
    };
  }

  private updateTypeString(schemaObj: unknown) {
    if (!schemaObj || typeof schemaObj !== 'object') {
      return;
    }

    const obj = schemaObj as Record<string, unknown>;

    if (typeof obj.type === 'string') {
      obj.type = obj.type.toLowerCase();
    }
    if (obj.items) {
      this.updateTypeString(obj.items);
    }
    if (obj.properties && typeof obj.properties === 'object') {
      const props = obj.properties as Record<string, unknown>;
      for (const key in props) {
        this.updateTypeString(props[key]);
      }
    }
  }

  private convertAnthropicResponseToLlmResponse(
    message: Anthropic.Messages.Message,
  ): LlmResponse {
    const parts: Part[] = [];

    for (const block of message.content) {
      const part = this.anthropicContentBlockToPart(block);
      if (part) {
        parts.push(part);
      }
    }

    let finishReason: FinishReason | undefined;
    switch (message.stop_reason) {
      case 'end_turn':
      case 'stop_sequence':
        finishReason = FinishReason.STOP;
        break;
      case 'max_tokens':
        finishReason = FinishReason.MAX_TOKENS;
        break;
      case 'tool_use':
        finishReason = FinishReason.STOP;
        break;
    }

    return {
      content: {
        role: 'model',
        parts,
      },
      usageMetadata: {
        promptTokenCount: message.usage.input_tokens,
        candidatesTokenCount: message.usage.output_tokens,
        totalTokenCount:
          message.usage.input_tokens + message.usage.output_tokens,
      },
      finishReason,
    };
  }

  private anthropicContentBlockToPart(
    block: Anthropic.ContentBlock,
  ): Part | undefined {
    if (block.type === 'text') {
      return {text: block.text};
    } else if (block.type === 'tool_use') {
      return {
        functionCall: {
          id: block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        },
      };
    }
    return undefined;
  }
}
