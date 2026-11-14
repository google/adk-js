/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Message,
  MessageSendParams,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {describe, expect, it} from 'vitest';
import {A2AEvent} from '../../src/a2a/a2a_event.js';
import {
  buildA2ARequestLog,
  buildA2AResponseLog,
  buildMessagePartLog,
} from '../../src/a2a/log_utils.js';

const SEPARATOR = '-----------------------------------------------------------';

/**
 * Returns a payload as a peer sends it on the wire, where a field can be null
 * or absent although its type requires it.
 */
function fromWire(payload: object) {
  return JSON.parse(JSON.stringify(payload));
}

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    kind: 'message',
    messageId: 'message-1',
    role: 'user',
    taskId: 'task-1',
    contextId: 'context-1',
    parts: [{kind: 'text', text: 'Hello'}],
    ...overrides,
  };
}

describe('log_utils', () => {
  describe('buildMessagePartLog', () => {
    it('prints a short text part in full', () => {
      expect(buildMessagePartLog({kind: 'text', text: 'Hello, world!'})).toBe(
        'TextPart: Hello, world!',
      );
    });

    it('prints a text part of exactly 100 characters in full', () => {
      expect(buildMessagePartLog({kind: 'text', text: 'x'.repeat(100)})).toBe(
        `TextPart: ${'x'.repeat(100)}`,
      );
    });

    it('cuts a long text part at 100 characters', () => {
      expect(buildMessagePartLog({kind: 'text', text: 'x'.repeat(150)})).toBe(
        `TextPart: ${'x'.repeat(100)}...`,
      );
    });

    it('prints a small data part in full', () => {
      expect(
        buildMessagePartLog({
          kind: 'data',
          data: {key1: 'value1', key2: 42},
        }),
      ).toBe('DataPart: {\n  "key1": "value1",\n  "key2": 42\n}');
    });

    it('summarizes large object and array values and keeps small ones', () => {
      const log = buildMessagePartLog({
        kind: 'data',
        data: {
          smallValue: 'hello',
          smallObject: {a: 1},
          largeObject: Object.fromEntries(
            Array.from({length: 50}, (_, index) => [
              `key-${index}`,
              `value-${index}`,
            ]),
          ),
          largeArray: Array.from({length: 100}, (_, index) => index),
        },
      });

      expect(log).toContain('"smallValue": "hello"');
      expect(log).toContain('"a": 1');
      expect(log).toContain('"largeObject": "<object>"');
      expect(log).toContain('"largeArray": "<array>"');
      expect(log).not.toContain('value-49');
    });

    it.each(['args', 'response'])(
      'leaves out the %s of a credential request',
      (field) => {
        const log = buildMessagePartLog({
          kind: 'data',
          data: {
            id: 'credential-call',
            name: 'adk_request_credential',
            [field]: {accessToken: 'token-1'},
          },
        });

        expect(log).toContain('"name": "adk_request_credential"');
        expect(log).toContain(`"${field}": "<redacted>"`);
        expect(log).not.toContain('token-1');
      },
    );

    it('prints the small args of an ordinary function call', () => {
      expect(
        buildMessagePartLog({
          kind: 'data',
          data: {id: 'call-1', name: 'lookup', args: {city: 'Paris'}},
        }),
      ).toContain('"city": "Paris"');
    });

    it('prints a file part without its bytes', () => {
      const log = buildMessagePartLog({
        kind: 'file',
        file: {name: 'report.pdf', mimeType: 'application/pdf', bytes: 'QUJD'},
      });

      expect(log).toContain('FilePart: ');
      expect(log).toContain('"name": "report.pdf"');
      expect(log).toContain('"mimeType": "application/pdf"');
      expect(log).not.toContain('QUJD');
      expect(log).not.toContain('bytes');
    });

    it('prints the uri of a file part', () => {
      expect(
        buildMessagePartLog({
          kind: 'file',
          file: {uri: 'gs://bucket/report.pdf'},
        }),
      ).toContain('"uri": "gs://bucket/report.pdf"');
    });

    it('appends the part metadata', () => {
      expect(
        buildMessagePartLog({
          kind: 'text',
          text: 'Hello',
          metadata: {key: 'value', nested: {id: 1}},
        }),
      ).toBe(
        'TextPart: Hello\n' +
          '    Part Metadata: {\n' +
          '      "key": "value",\n' +
          '      "nested": {\n' +
          '        "id": 1\n' +
          '      }\n' +
          '    }',
      );
    });

    it('prints no metadata section for empty part metadata', () => {
      expect(
        buildMessagePartLog({kind: 'text', text: 'Hello', metadata: {}}),
      ).toBe('TextPart: Hello');
    });

    it('prints a placeholder for part metadata that JSON cannot represent', () => {
      const circular: Record<string, unknown> = {};
      circular['parent'] = circular;

      expect(
        buildMessagePartLog({kind: 'text', text: 'Hello', metadata: circular}),
      ).toBe('TextPart: Hello\n    Part Metadata: <unserializable>');
      expect(
        buildMessagePartLog({
          kind: 'text',
          text: 'Hello',
          metadata: {count: BigInt(1)},
        }),
      ).toBe('TextPart: Hello\n    Part Metadata: <unserializable>');
    });

    it('prints a placeholder for part metadata that serializes to nothing', () => {
      expect(
        buildMessagePartLog({
          kind: 'text',
          text: 'Hello',
          metadata: {toJSON: () => undefined},
        }),
      ).toBe('TextPart: Hello\n    Part Metadata: <unserializable>');
    });

    it('prints a placeholder for a part of an unknown kind', () => {
      const part: Part = JSON.parse('{"kind": "video", "video": "QUJD"}');

      expect(buildMessagePartLog(part)).toBe('UnknownPart');
    });
  });

  describe('buildA2ARequestLog', () => {
    it('prints the message, its parts, the configuration and the request metadata', () => {
      const params: MessageSendParams = {
        message: createMessage({
          parts: [
            {kind: 'text', text: 'Hello'},
            {kind: 'data', data: {key: 'value'}},
          ],
        }),
        configuration: {
          acceptedOutputModes: ['text'],
          blocking: true,
          historyLength: 10,
          pushNotificationConfig: {
            url: 'https://example.com/notify',
            token: 'token-1',
          },
        },
        metadata: {tenant: 'tenant-1'},
      };

      expect(buildA2ARequestLog(params)).toBe(`
A2A Send Message Request:
${SEPARATOR}
Message:
  ID: message-1
  Role: user
  Task ID: task-1
  Context ID: context-1
  Message Parts:
  Part 0: TextPart: Hello
  Part 1: DataPart: {
      "key": "value"
    }
${SEPARATOR}
Configuration:
{
  "acceptedOutputModes": [
    "text"
  ],
  "blocking": true,
  "historyLength": 10,
  "pushNotificationConfig": true
}
${SEPARATOR}
Metadata:
{
  "tenant": "tenant-1"
}
${SEPARATOR}
`);
    });

    it('never prints the push notification configuration content', () => {
      const log = buildA2ARequestLog({
        message: createMessage(),
        configuration: {
          pushNotificationConfig: {
            url: 'https://example.com/notify',
            token: 'token-1',
          },
        },
      });

      expect(log).not.toContain('token-1');
      expect(log).not.toContain('example.com');
    });

    it('prints placeholders for a request with no parts, configuration or metadata', () => {
      const log = buildA2ARequestLog({message: createMessage({parts: []})});

      expect(log).toContain('  Message Parts:\n  No parts\n');
      expect(log).toContain('Configuration:\nNo configuration\n');
      expect(log).toContain('Metadata:\nNo metadata\n');
    });

    it('prints the message metadata under the message', () => {
      const log = buildA2ARequestLog({
        message: createMessage({metadata: {key: 'value'}}),
      });

      expect(log).toContain(
        '  Part 0: TextPart: Hello\n  Metadata:\n  {\n    "key": "value"\n  }\n',
      );
    });
  });

  describe('buildA2AResponseLog', () => {
    it('prints a task with no status message and no history', () => {
      const task: Task = {
        kind: 'task',
        id: 'task-1',
        contextId: 'context-1',
        status: {state: 'working', timestamp: '2024-01-01T00:00:00.000Z'},
        artifacts: [{artifactId: 'artifact-1', parts: []}],
        metadata: {key: 'value'},
      };

      expect(buildA2AResponseLog(task)).toBe(`
A2A Response:
${SEPARATOR}
Result Type: Task
${SEPARATOR}
Task ID: task-1
Context ID: context-1
Status State: working
Status Timestamp: 2024-01-01T00:00:00.000Z
History Length: 0
Artifacts Count: 1
Task Metadata:
{
  "key": "value"
}
${SEPARATOR}
Status Message:
No status message
${SEPARATOR}
History:
No history
${SEPARATOR}
`);
    });

    it('leaves out the ids and the timestamp that are absent', () => {
      const task: Task = {
        kind: 'task',
        id: 'task-1',
        contextId: 'context-1',
        status: {
          state: 'working',
          message: {
            kind: 'message',
            messageId: 'status-message-1',
            role: 'agent',
            parts: [],
          },
        },
      };

      expect(buildA2AResponseLog(task)).toBe(`
A2A Response:
${SEPARATOR}
Result Type: Task
${SEPARATOR}
Task ID: task-1
Context ID: context-1
Status State: working
History Length: 0
Artifacts Count: 0
${SEPARATOR}
Status Message:
ID: status-message-1
Role: agent
Message Parts:
No parts
${SEPARATOR}
History:
No history
${SEPARATOR}
`);
    });

    it('prints a placeholder for a response of an unknown kind', () => {
      const response: A2AEvent = JSON.parse('{"kind": "other", "secret": 1}');

      expect(buildA2AResponseLog(response)).toBe(`
A2A Response:
${SEPARATOR}
Result Type: Unknown
${SEPARATOR}
No details
${SEPARATOR}
`);
    });

    it('prints the status message and the history of a task', () => {
      const task: Task = {
        kind: 'task',
        id: 'task-1',
        contextId: 'context-1',
        status: {
          state: 'input-required',
          message: createMessage({
            messageId: 'status-message-1',
            role: 'agent',
            parts: [{kind: 'text', text: 'Which city?'}],
          }),
        },
        history: [
          createMessage({messageId: 'history-message-1'}),
          createMessage({
            messageId: 'history-message-2',
            role: 'agent',
            parts: [],
          }),
        ],
      };

      const log = buildA2AResponseLog(task);

      expect(log).toContain('History Length: 2');
      expect(log).toContain(
        'Status Message:\nID: status-message-1\nRole: agent\n',
      );
      expect(log).toContain('Part 0: TextPart: Which city?');
      expect(log).toContain(
        'Message 1:\n  ID: history-message-1\n  Role: user\n',
      );
      expect(log).toContain('  Message Parts:\n  Part 0: TextPart: Hello\n');
      expect(log).toContain(
        'Message 2:\n  ID: history-message-2\n  Role: agent\n',
      );
      expect(log).toContain('  Message Parts:\n  No parts');
    });

    it('prints a message with its parts and metadata', () => {
      const log = buildA2AResponseLog(
        createMessage({
          role: 'agent',
          parts: [{kind: 'text', text: 'Response'}],
          metadata: {key: 'value'},
        }),
      );

      expect(log).toBe(`
A2A Response:
${SEPARATOR}
Result Type: Message
${SEPARATOR}
ID: message-1
Role: agent
Task ID: task-1
Context ID: context-1
Message Parts:
Part 0: TextPart: Response
Metadata:
{
  "key": "value"
}
${SEPARATOR}
`);
    });

    it('prints a message with no parts', () => {
      const log = buildA2AResponseLog(createMessage({parts: []}));

      expect(log).toContain('Message Parts:\nNo parts\n');
      expect(log).not.toContain('Metadata:');
    });

    it('prints the ids, state and status message of a status update', () => {
      const event: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId: 'task-1',
        contextId: 'context-1',
        final: true,
        status: {
          state: 'auth-required',
          message: createMessage({
            role: 'agent',
            parts: [
              {
                kind: 'data',
                data: {
                  id: 'credential-call',
                  name: 'adk_request_credential',
                  args: {clientSecret: 'secret-1'},
                },
              },
            ],
          }),
        },
      };

      const log = buildA2AResponseLog(event);

      expect(log).toContain('Result Type: TaskStatusUpdateEvent');
      expect(log).toContain('Task ID: task-1\nContext ID: context-1\n');
      expect(log).toContain('Status State: auth-required\nFinal: true\n');
      expect(log).toContain('"name": "adk_request_credential"');
      expect(log).not.toContain('secret-1');
    });

    it('prints the ids and part count of an artifact update, not its parts', () => {
      const parts: Part[] = [
        {kind: 'text', text: 'chunk-1'},
        {kind: 'text', text: 'chunk-2'},
      ];
      const event: TaskArtifactUpdateEvent = {
        kind: 'artifact-update',
        taskId: 'task-1',
        contextId: 'context-1',
        artifact: {artifactId: 'artifact-1', parts},
        append: true,
        lastChunk: false,
      };

      expect(buildA2AResponseLog(event)).toBe(`
A2A Response:
${SEPARATOR}
Result Type: TaskArtifactUpdateEvent
${SEPARATOR}
Task ID: task-1
Context ID: context-1
Artifact ID: artifact-1
Parts Count: 2
Append: true
Last Chunk: false
${SEPARATOR}
`);
    });
  });

  describe('payloads that do not match their types', () => {
    it('prints a part whose metadata is null without a metadata section', () => {
      const part: Part = fromWire({
        kind: 'text',
        text: 'Hello',
        metadata: null,
      });

      expect(buildMessagePartLog(part)).toBe('TextPart: Hello');
    });

    it.each([
      {
        name: 'a text part without text',
        part: {kind: 'text'},
        log: 'TextPart: ',
      },
      {
        name: 'a data part without data',
        part: {kind: 'data'},
        log: 'DataPart: {}',
      },
      {
        name: 'a file part without a file',
        part: {kind: 'file'},
        log: 'FilePart: {}',
      },
      {
        name: 'a text part whose text is null',
        part: {kind: 'text', text: null},
        log: 'TextPart: ',
      },
      {
        name: 'a data part whose data is null',
        part: {kind: 'data', data: null},
        log: 'DataPart: {}',
      },
      {
        name: 'a file part whose file is null',
        part: {kind: 'file', file: null},
        log: 'FilePart: {}',
      },
    ])('prints $name as empty', ({part, log}) => {
      const wirePart: Part = fromWire(part);

      expect(buildMessagePartLog(wirePart)).toBe(log);
    });

    it('prints a file part whose uri is null without a uri', () => {
      const part: Part = fromWire({
        kind: 'file',
        file: {
          name: 'report.pdf',
          mimeType: 'application/pdf',
          bytes: 'QUJD',
          uri: null,
        },
      });

      expect(buildMessagePartLog(part)).toBe(`FilePart: {
  "name": "report.pdf",
  "mimeType": "application/pdf"
}`);
    });

    it('prints a file part whose uri is undefined without a uri', () => {
      const part: Part = {
        kind: 'file',
        file: {name: 'report.pdf', bytes: 'QUJD', uri: undefined},
      };

      expect(buildMessagePartLog(part)).toBe(`FilePart: {
  "name": "report.pdf"
}`);
    });

    it('prints the other parts of a response when one part has null text', () => {
      const response: A2AEvent = fromWire({
        kind: 'message',
        messageId: 'message-1',
        role: 'agent',
        parts: [
          {kind: 'text', text: null},
          {kind: 'text', text: 'Hello'},
        ],
      });

      const log = buildA2AResponseLog(response);

      expect(log).toContain('Part 0: TextPart: \nPart 1: TextPart: Hello\n');
      expect(log).not.toContain('<log unavailable>');
    });

    it('prints a request whose metadata is null and whose message has no parts', () => {
      const params: MessageSendParams = fromWire({
        message: {
          kind: 'message',
          messageId: 'message-1',
          role: 'user',
          metadata: null,
        },
        metadata: null,
      });

      const log = buildA2ARequestLog(params);

      expect(log).toContain('  ID: message-1\n');
      expect(log).toContain('  Message Parts:\n  No parts\n');
      expect(log).toContain('Metadata:\nNo metadata\n');
    });

    it('prints a message response whose metadata and part metadata are null', () => {
      const response: A2AEvent = fromWire({
        kind: 'message',
        messageId: 'message-1',
        role: 'agent',
        parts: [{kind: 'text', text: 'Hello', metadata: null}],
        metadata: null,
      });

      const log = buildA2AResponseLog(response);

      expect(log).toContain('Result Type: Message\n');
      expect(log).toContain('Message Parts:\nPart 0: TextPart: Hello\n');
      expect(log).not.toContain('Metadata');
    });

    it('prints a status update whose status message has no parts', () => {
      const response: A2AEvent = fromWire({
        kind: 'status-update',
        taskId: 'task-1',
        contextId: 'context-1',
        final: true,
        status: {
          state: 'completed',
          message: {kind: 'message', messageId: 'message-1', role: 'agent'},
        },
      });

      const log = buildA2AResponseLog(response);

      expect(log).toContain('Status State: completed\n');
      expect(log).toContain('ID: message-1\n');
      expect(log).toContain('Message Parts:\nNo parts\n');
    });

    it('prints an artifact update whose artifact has no parts', () => {
      const response: A2AEvent = fromWire({
        kind: 'artifact-update',
        taskId: 'task-1',
        contextId: 'context-1',
        artifact: {artifactId: 'artifact-1'},
      });

      const log = buildA2AResponseLog(response);

      expect(log).toContain('Artifact ID: artifact-1\nParts Count: 0\n');
    });

    it('prints a task whose metadata is null and whose history entry has no parts', () => {
      const response: A2AEvent = fromWire({
        kind: 'task',
        id: 'task-1',
        contextId: 'context-1',
        status: {state: 'working'},
        metadata: null,
        history: [{kind: 'message', messageId: 'message-1', role: 'user'}],
      });

      const log = buildA2AResponseLog(response);

      expect(log).toContain('History Length: 1\n');
      expect(log).not.toContain('Task Metadata');
      expect(log).toContain(
        'Message 1:\n  ID: message-1\n  Role: user\n  Message Parts:\n  No parts\n',
      );
    });

    it('leaves out the ids and the timestamp that are null', () => {
      const response: A2AEvent = fromWire({
        kind: 'task',
        id: 'task-1',
        contextId: 'context-1',
        status: {
          state: 'working',
          timestamp: null,
          message: {
            kind: 'message',
            messageId: 'message-1',
            role: 'agent',
            taskId: null,
            contextId: null,
            parts: [],
          },
        },
      });

      const log = buildA2AResponseLog(response);

      expect(log).toContain('Status State: working\nHistory Length: 0\n');
      expect(log).toContain('ID: message-1\nRole: agent\nMessage Parts:\n');
      expect(log).not.toContain('null');
    });

    it('prints a placeholder for a response that cannot be formatted', () => {
      const response: A2AEvent = fromWire({
        kind: 'message',
        messageId: 'message-1',
        role: 'agent',
        parts: 'not a list',
      });

      expect(buildA2AResponseLog(response)).toBe('<log unavailable>');
    });

    it('prints a placeholder for a request that cannot be formatted', () => {
      const params: MessageSendParams = fromWire({});

      expect(buildA2ARequestLog(params)).toBe('<log unavailable>');
    });
  });
});
