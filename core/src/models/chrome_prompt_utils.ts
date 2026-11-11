/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content, FunctionDeclaration, Part} from '@google/genai';

import {genaiSchemaToJsonSchema} from '../utils/genai_schema_to_json.js';

import type {ChromeMessage} from './chrome_prompt_llm.js';
import type {LlmRequest} from './llm_request.js';
import type {LlmResponse} from './llm_response.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * Schema conversion
 * ------------------------------------------------------------------ */

/** Returns the argument schema for a declaration, in JSON Schema form. */
function argumentSchema(
  declaration: FunctionDeclaration,
): Record<string, unknown> {
  if (isRecord(declaration.parametersJsonSchema)) {
    return declaration.parametersJsonSchema;
  }
  if (declaration.parameters) {
    return genaiSchemaToJsonSchema(declaration.parameters);
  }
  return {type: 'object', properties: {}};
}

/** Pulls function declarations out of a request's tool config. */
export function collectFunctionDeclarations(
  llmRequest: LlmRequest,
): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [];
  for (const tool of llmRequest.config?.tools ?? []) {
    if (isRecord(tool) && Array.isArray(tool['functionDeclarations'])) {
      declarations.push(
        ...(tool['functionDeclarations'] as FunctionDeclaration[]),
      );
    }
  }
  return declarations;
}

/**
 * Builds the constrained-decoding schema: a union of "final answer" and one
 * branch per available tool, each carrying that tool's exact argument schema.
 *
 * A single-value `enum` is used rather than `const`, because it is semantically
 * identical and more widely supported across constraint engines.
 *
 * Every branch sets `additionalProperties: false`, and that is load-bearing
 * rather than tidy. Omitted, JSON Schema permits extra keys, so a decoder may
 * emit `,"` after the last required key instead of `}`. The object then never
 * has to close: the model keeps writing until the output runs out, and the
 * reply arrives as truncated JSON. Whether it closes in time is left to
 * sampling, which is why one session can answer a question cleanly and mangle
 * the next. Closing the branch makes `}` the only legal token once `text` is
 * written.
 *
 * It is set on the envelope only, never pushed into a tool's own argument
 * schema. Those belong to the caller; some describe objects that legitimately
 * accept keys they do not list, and forbidding those here would make a valid
 * call impossible to express.
 */
export function buildToolChoiceSchema(
  declarations: FunctionDeclaration[],
): Record<string, unknown> {
  const branches: Array<Record<string, unknown>> = [
    {
      type: 'object',
      properties: {
        kind: {type: 'string', enum: ['final']},
        text: {type: 'string'},
      },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
  ];

  for (const declaration of declarations) {
    if (!declaration.name) continue;
    branches.push({
      type: 'object',
      properties: {
        kind: {type: 'string', enum: ['tool']},
        name: {type: 'string', enum: [declaration.name]},
        args: argumentSchema(declaration),
      },
      required: ['kind', 'name', 'args'],
      additionalProperties: false,
    });
  }

  return branches.length === 1 ? branches[0]! : {anyOf: branches};
}

/** Renders tool declarations into instructions the model can act on. */
export function renderToolInstructions(
  declarations: FunctionDeclaration[],
): string {
  if (!declarations.length) return '';
  const lines = declarations.map(
    (declaration) =>
      `- ${declaration.name}: ${declaration.description ?? ''}\n` +
      `  arguments: ${JSON.stringify(argumentSchema(declaration))}`,
  );
  return [
    'You can call these tools:',
    ...lines,
    '',
    'Reply with JSON only. To call a tool use ' +
      '{"kind":"tool","name":<tool>,"args":{...}}.',
    'When you have the answer use {"kind":"final","text":<answer>}.',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Content mapping
 * ------------------------------------------------------------------ */

/**
 * Renders a tool result as text the model can actually read.
 *
 * ADK wraps a tool's string return value as `{result: "<the string>"}`. Naively
 * JSON-stringifying that produces double-encoded output, in which every quote
 * is escaped twice:
 *
 *     [tool_result] search -> {"result":"{\"matches\":[{\"id\":8, ...
 *
 * A large model shrugs at this. A small one has to spend attention unpicking
 * the encoding before it can read the payload, and often just fails. Unwrapping
 * the single `result` key and re-emitting plain JSON costs nothing and gives
 * the model something legible:
 *
 *     [tool_result] search -> {"matches":[{"id":8, ...
 */
export function renderToolResult(response: unknown): string {
  if (response == null) return '{}';
  let value: unknown = response;

  // Unwrap ADK's {result: ...} envelope.
  if (isRecord(value) && Object.keys(value).length === 1 && 'result' in value) {
    value = value['result'];
  }

  // If it is already a JSON string, splice it in rather than escaping again.
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Maps genai `Content[]` onto Prompt API messages.
 *
 * Function calls and responses have no native representation in a Prompt API
 * message, so they are serialised to text. Without this the model loses the
 * thread of a multi-step tool interaction.
 */
export function contentsToMessages(contents: Content[]): ChromeMessage[] {
  const messages: ChromeMessage[] = [];

  for (const content of contents ?? []) {
    const role = content.role === 'model' ? 'assistant' : 'user';
    const chunks: string[] = [];

    for (const part of (content.parts ?? []) as Part[]) {
      if (part.text) chunks.push(part.text);
      if (part.functionCall) {
        const args = JSON.stringify(part.functionCall.args ?? {});
        chunks.push(`[tool_call] ${part.functionCall.name}(${args})`);
      }
      if (part.functionResponse) {
        const rendered = renderToolResult(part.functionResponse.response);
        chunks.push(
          `[tool_result] ${part.functionResponse.name} -> ${rendered}`,
        );
      }
      // Image parts are dropped on purpose. The Prompt API needs a Blob or
      // BufferSource plus `expectedInputs: [{type: 'image'}]` at create time,
      // and base64 text rejects with a TypeError. Restore this once image
      // input can be decoded and tested.
    }

    if (chunks.length) {
      messages.push({role, content: chunks.join('\n')});
    }
  }

  return messages;
}

/** Extracts the system instruction from a request as plain text. */
export function extractSystemInstruction(llmRequest: LlmRequest): string {
  const instruction: unknown = llmRequest.config?.systemInstruction;
  if (!instruction) return '';
  if (typeof instruction === 'string') return instruction;
  if (Array.isArray(instruction)) {
    return instruction
      .map((entry) =>
        typeof entry === 'string' ? entry : ((entry as Part)?.text ?? ''),
      )
      .filter(Boolean)
      .join('\n');
  }
  if (isRecord(instruction) && Array.isArray(instruction['parts'])) {
    return (instruction['parts'] as Part[])
      .map((part) => part.text ?? '')
      .filter(Boolean)
      .join('\n');
  }
  return String(instruction);
}

/**
 * Removes ADK's per-agent identity preamble from a system prompt.
 *
 * Turns:
 *
 *     You are an agent. Your internal name is "rerank_11".
 *     The description about you is "..."
 *
 *     <the actual instruction>
 *
 * into just the instruction, so that sibling agents sharing one instruction
 * also share one cached session. See
 * {@link ChromeBuiltInLlmParams.normalizeSystemPrompt}.
 */
export function stripAdkIdentityPreamble(systemPrompt: string): string {
  return systemPrompt
    .replace(/^You are an agent\. Your internal name is "[^"]*"\.\s*/m, '')
    .replace(/^The description about you is "[^"]*"\s*/m, '')
    .trimStart();
}

/* ------------------------------------------------------------------ *
 * Response helpers
 * ------------------------------------------------------------------ */

/** Whether an error is an aborted-operation error from a cancelled signal. */
export function isAbortError(error: unknown): boolean {
  return isRecord(error) && error['name'] === 'AbortError';
}

export function finalText(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}, turnComplete: true};
}

export function errorResponse(error: unknown): LlmResponse {
  const details = isRecord(error) ? error : {};
  const name =
    typeof details['name'] === 'string' ? details['name'] : 'UnknownError';
  const message =
    typeof details['message'] === 'string' ? details['message'] : String(error);

  if (name === 'QuotaExceededError') {
    return {
      errorCode: name,
      errorMessage:
        `Prompt exceeded the context window (requested ` +
        `${details['requested']} of ${details['quota']} tokens).`,
      turnComplete: true,
    };
  }
  return {errorCode: name, errorMessage: message, turnComplete: true};
}

/** Shown when a reply is JSON, is broken, and holds no readable answer. */
export const TRUNCATED_REPLY =
  'The model started an answer and did not finish it. Ask again.';

/** True when a reply is the JSON envelope rather than plain prose. */
export function looksLikeEnvelope(raw: string): boolean {
  return /^\s*[[{]/.test(raw) || /"kind"\s*:/.test(raw);
}

/**
 * Reads the answer out of a truncated `{"kind":"final","text":"…` envelope.
 *
 * A constrained reply that stops early is usually still readable: the answer
 * sits in `text` and only the closing quote and brace are missing. Scanning it
 * out by hand beats `JSON.parse`, which needs the whole document, and beats
 * showing the envelope to the caller.
 *
 * Returns undefined when there is no `text` key to read.
 */
export function salvageFinalText(raw: string): string | undefined {
  const key = raw.match(/"text"\s*:\s*"/);
  if (key?.index === undefined) return undefined;

  const escapes: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    b: '\b',
    f: '\f',
    '"': '"',
    '\\': '\\',
    '/': '/',
  };

  let out = '';
  for (let i = key.index + key[0].length; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === '"') break; // the string closed normally
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break; // truncated mid-escape
    if (next === 'u') {
      const hex = raw.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
        continue;
      }
    }
    out += escapes[next] ?? next;
    i++;
  }

  const text = out.trim();
  return text.length ? text : undefined;
}
