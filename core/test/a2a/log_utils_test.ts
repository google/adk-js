/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Message,
  Part,
  Role,
  SendMessageRequest,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {describe, expect, it} from 'vitest';
import {A2AEvent, createTextPart} from '../../src/a2a/a2a_event.js';
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
    messageId: 'message-1',
    role: Role.ROLE_USER,
    taskId: 'task-1',
    contextId: 'context-1',
    parts: [createTextPart('Hello')],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
    ...overrides,
  };
}

function createDataPart(
  value: unknown,
  metadata?: Record<string, unknown>,
): Part {
  return {
    content: {$case: 'data', value},
    metadata,
    filename: '',
    mediaType: '',
  };
}

function createFilePart(
  content: Part['content'],
  filename = '',
  mediaType = '',
): Part {
  return {content, metadata: undefined, filename, mediaType};
}

function createRequest(
  overrides: Partial<SendMessageRequest> = {},
): SendMessageRequest {
  return {
    tenant: '',
    message: createMessage(),
    configuration: undefined,
    metadata: undefined,
    ...overrides,
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    contextId: 'context-1',
    status: {
      state: TaskState.TASK_STATE_WORKING,
      message: undefined,
      timestamp: undefined,
    },
    artifacts: [],
    history: [],
    metadata: undefined,
    ...overrides,
  };
}

describe('log_utils', () => {
  describe('buildMessagePartLog', () => {
    it('prints a short text part in full', () => {
      expect(buildMessagePartLog(createTextPart('Hello, world!'))).toBe(
        'TextPart: Hello, world!',
      );
    });

    it('prints a text part of exactly 100 characters in full', () => {
      expect(buildMessagePartLog(createTextPart('x'.repeat(100)))).toBe(
        `TextPart: ${'x'.repeat(100)}`,
      );
    });

    it('cuts a long text part at 100 characters', () => {
      expect(buildMessagePartLog(createTextPart('x'.repeat(150)))).toBe(
        `TextPart: ${'x'.repeat(100)}...`,
      );
    });

    it('prints a small data part in full', () => {
      expect(
        buildMessagePartLog(createDataPart({key1: 'value1', key2: 42})),
      ).toBe('DataPart: {\n  "key1": "value1",\n  "key2": 42\n}');
    });

    it('prints a data part that is not an object', () => {
      expect(buildMessagePartLog(createDataPart([1, 2, 3]))).toBe(
        'DataPart: [\n  1,\n  2,\n  3\n]',
      );
      expect(buildMessagePartLog(createDataPart('plain'))).toBe(
        'DataPart: "plain"',
      );
    });

    it('summarizes large object and array values and keeps small ones', () => {
      const log = buildMessagePartLog(
        createDataPart({
          smallValue: 'hello',
          smallObject: {a: 1},
          largeObject: Object.fromEntries(
            Array.from({length: 50}, (_, index) => [
              `key-${index}`,
              `value-${index}`,
            ]),
          ),
          largeArray: Array.from({length: 100}, (_, index) => index),
        }),
      );

      expect(log).toContain('"smallValue": "hello"');
      expect(log).toContain('"a": 1');
      expect(log).toContain('"largeObject": "<object>"');
      expect(log).toContain('"largeArray": "<array>"');
      expect(log).not.toContain('value-49');
    });

    it.each(['args', 'response'])(
      'leaves out the %s of a credential request',
      (field) => {
        const log = buildMessagePartLog(
          createDataPart({
            id: 'credential-call',
            name: 'adk_request_credential',
            [field]: {accessToken: 'token-1'},
          }),
        );

        expect(log).toContain('"name": "adk_request_credential"');
        expect(log).toContain(`"${field}": "<redacted>"`);
        expect(log).not.toContain('token-1');
      },
    );

    it('prints the small args of an ordinary function call', () => {
      expect(
        buildMessagePartLog(
          createDataPart({id: 'call-1', name: 'lookup', args: {city: 'Paris'}}),
        ),
      ).toContain('"city": "Paris"');
    });

    it('prints a file part without its bytes', () => {
      const log = buildMessagePartLog(
        createFilePart(
          {$case: 'raw', value: Buffer.from('ABC')},
          'report.pdf',
          'application/pdf',
        ),
      );

      expect(log).toContain('FilePart: ');
      expect(log).toContain('"filename": "report.pdf"');
      expect(log).toContain('"mediaType": "application/pdf"');
      expect(log).not.toContain('QUJD');
      expect(log).not.toContain('ABC');
      expect(log).not.toContain('raw');
    });

    it('prints the url of a file part', () => {
      expect(
        buildMessagePartLog(
          createFilePart({$case: 'url', value: 'gs://bucket/report.pdf'}),
        ),
      ).toBe('FilePart: {\n  "url": "gs://bucket/report.pdf"\n}');
    });

    it('appends the part metadata', () => {
      expect(
        buildMessagePartLog(
          createTextPart('Hello', {key: 'value', nested: {id: 1}}),
        ),
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
      expect(buildMessagePartLog(createTextPart('Hello', {}))).toBe(
        'TextPart: Hello',
      );
    });

    it('prints a placeholder for part metadata that JSON cannot represent', () => {
      const circular: Record<string, unknown> = {};
      circular['parent'] = circular;

      expect(buildMessagePartLog(createTextPart('Hello', circular))).toBe(
        'TextPart: Hello\n    Part Metadata: <unserializable>',
      );
      expect(
        buildMessagePartLog(createTextPart('Hello', {count: BigInt(1)})),
      ).toBe('TextPart: Hello\n    Part Metadata: <unserializable>');
    });

    it('prints a placeholder for part metadata that serializes to nothing', () => {
      expect(
        buildMessagePartLog(createTextPart('Hello', {toJSON: () => undefined})),
      ).toBe('TextPart: Hello\n    Part Metadata: <unserializable>');
    });

    it('prints a placeholder for a part of an unknown kind', () => {
      const part: Part = JSON.parse(
        '{"content": {"$case": "video", "value": "QUJD"}}',
      );

      expect(buildMessagePartLog(part)).toBe('UnknownPart');
    });

    it('prints a placeholder for a part without content', () => {
      const part: Part = {
        content: undefined,
        metadata: undefined,
        filename: '',
        mediaType: '',
      };

      expect(buildMessagePartLog(part)).toBe('UnknownPart');
    });
  });

  describe('buildA2ARequestLog', () => {
    it('prints the message, its parts, the configuration and the request metadata', () => {
      const params = createRequest({
        message: createMessage({
          parts: [createTextPart('Hello'), createDataPart({key: 'value'})],
        }),
        configuration: {
          acceptedOutputModes: ['text'],
          returnImmediately: false,
          historyLength: 10,
          taskPushNotificationConfig: {
            tenant: '',
            id: '',
            taskId: '',
            url: 'https://example.com/notify',
            token: 'token-1',
            authentication: undefined,
          },
        },
        metadata: {tenant: 'tenant-1'},
      });

      expect(buildA2ARequestLog(params)).toBe(`
A2A Send Message Request:
${SEPARATOR}
Message:
  ID: message-1
  Role: ROLE_USER
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
  "returnImmediately": false,
  "historyLength": 10,
  "taskPushNotificationConfig": true
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
      const log = buildA2ARequestLog(
        createRequest({
          configuration: {
            acceptedOutputModes: [],
            returnImmediately: false,
            taskPushNotificationConfig: {
              tenant: '',
              id: '',
              taskId: '',
              url: 'https://example.com/notify',
              token: 'token-1',
              authentication: undefined,
            },
          },
        }),
      );

      expect(log).not.toContain('token-1');
      expect(log).not.toContain('example.com');
    });

    it('prints placeholders for a request with no parts, configuration or metadata', () => {
      const log = buildA2ARequestLog(
        createRequest({message: createMessage({parts: []})}),
      );

      expect(log).toContain('  Message Parts:\n  No parts\n');
      expect(log).toContain('Configuration:\nNo configuration\n');
      expect(log).toContain('Metadata:\nNo metadata\n');
    });

    it('prints the message metadata under the message', () => {
      const log = buildA2ARequestLog(
        createRequest({message: createMessage({metadata: {key: 'value'}})}),
      );

      expect(log).toContain(
        '  Part 0: TextPart: Hello\n  Metadata:\n  {\n    "key": "value"\n  }\n',
      );
    });

    it('leaves out the ids of a message that has none', () => {
      const log = buildA2ARequestLog(
        createRequest({message: createMessage({taskId: '', contextId: ''})}),
      );

      expect(log).toContain(
        '  ID: message-1\n  Role: ROLE_USER\n  Message Parts:',
      );
      expect(log).not.toContain('Task ID');
      expect(log).not.toContain('Context ID');
    });
  });

  describe('buildA2AResponseLog', () => {
    it('prints a task with no status message and no history', () => {
      const task = createTask({
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: '2024-01-01T00:00:00.000Z',
        },
        artifacts: [
          {
            artifactId: 'artifact-1',
            name: '',
            description: '',
            parts: [],
            metadata: undefined,
            extensions: [],
          },
        ],
        metadata: {key: 'value'},
      });

      expect(buildA2AResponseLog(task)).toBe(`
A2A Response:
${SEPARATOR}
Result Type: Task
${SEPARATOR}
Task ID: task-1
Context ID: context-1
Status State: TASK_STATE_WORKING
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
      const task = createTask({
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: createMessage({
            messageId: 'status-message-1',
            role: Role.ROLE_AGENT,
            taskId: '',
            contextId: '',
            parts: [],
          }),
          timestamp: undefined,
        },
      });

      expect(buildA2AResponseLog(task)).toBe(`
A2A Response:
${SEPARATOR}
Result Type: Task
${SEPARATOR}
Task ID: task-1
Context ID: context-1
Status State: TASK_STATE_WORKING
History Length: 0
Artifacts Count: 0
${SEPARATOR}
Status Message:
ID: status-message-1
Role: ROLE_AGENT
Message Parts:
No parts
${SEPARATOR}
History:
No history
${SEPARATOR}
`);
    });

    it('prints a placeholder for a response of an unknown kind', () => {
      const response: A2AEvent = JSON.parse('{"other": "value", "secret": 1}');

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
      const task = createTask({
        status: {
          state: TaskState.TASK_STATE_INPUT_REQUIRED,
          message: createMessage({
            messageId: 'status-message-1',
            role: Role.ROLE_AGENT,
            parts: [createTextPart('Which city?')],
          }),
          timestamp: undefined,
        },
        history: [
          createMessage({messageId: 'history-message-1'}),
          createMessage({
            messageId: 'history-message-2',
            role: Role.ROLE_AGENT,
            parts: [],
          }),
        ],
      });

      const log = buildA2AResponseLog(task);

      expect(log).toContain('Status State: TASK_STATE_INPUT_REQUIRED\n');
      expect(log).toContain('History Length: 2');
      expect(log).toContain(
        'Status Message:\nID: status-message-1\nRole: ROLE_AGENT\n',
      );
      expect(log).toContain('Part 0: TextPart: Which city?');
      expect(log).toContain(
        'Message 1:\n  ID: history-message-1\n  Role: ROLE_USER\n',
      );
      expect(log).toContain('  Message Parts:\n  Part 0: TextPart: Hello\n');
      expect(log).toContain(
        'Message 2:\n  ID: history-message-2\n  Role: ROLE_AGENT\n',
      );
      expect(log).toContain('  Message Parts:\n  No parts');
    });

    it('prints a message with its parts and metadata', () => {
      const log = buildA2AResponseLog(
        createMessage({
          role: Role.ROLE_AGENT,
          parts: [createTextPart('Response')],
          metadata: {key: 'value'},
        }),
      );

      expect(log).toBe(`
A2A Response:
${SEPARATOR}
Result Type: Message
${SEPARATOR}
ID: message-1
Role: ROLE_AGENT
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
        taskId: 'task-1',
        contextId: 'context-1',
        status: {
          state: TaskState.TASK_STATE_AUTH_REQUIRED,
          message: createMessage({
            role: Role.ROLE_AGENT,
            parts: [
              createDataPart({
                id: 'credential-call',
                name: 'adk_request_credential',
                args: {clientSecret: 'secret-1'},
              }),
            ],
          }),
          timestamp: undefined,
        },
        metadata: undefined,
      };

      const log = buildA2AResponseLog(event);

      expect(log).toContain('Result Type: TaskStatusUpdateEvent');
      expect(log).toContain('Task ID: task-1\nContext ID: context-1\n');
      expect(log).toContain(
        'Status State: TASK_STATE_AUTH_REQUIRED\n' + SEPARATOR,
      );
      expect(log).not.toContain('Final');
      expect(log).toContain('"name": "adk_request_credential"');
      expect(log).not.toContain('secret-1');
    });

    it('prints the ids and part count of an artifact update, not its parts', () => {
      const parts: Part[] = [
        createTextPart('chunk-1'),
        createTextPart('chunk-2'),
      ];
      const event: TaskArtifactUpdateEvent = {
        taskId: 'task-1',
        contextId: 'context-1',
        artifact: {
          artifactId: 'artifact-1',
          name: '',
          description: '',
          parts,
          metadata: undefined,
          extensions: [],
        },
        append: true,
        lastChunk: false,
        metadata: undefined,
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
        content: {$case: 'text', value: 'Hello'},
        metadata: null,
      });

      expect(buildMessagePartLog(part)).toBe('TextPart: Hello');
    });

    it.each([
      {
        name: 'a text part without text',
        part: {content: {$case: 'text'}},
        log: 'TextPart: ',
      },
      {
        name: 'a data part without data',
        part: {content: {$case: 'data'}},
        log: 'DataPart: {}',
      },
      {
        name: 'a file part without a url',
        part: {content: {$case: 'url'}},
        log: 'FilePart: {}',
      },
      {
        name: 'a text part whose text is null',
        part: {content: {$case: 'text', value: null}},
        log: 'TextPart: ',
      },
      {
        name: 'a data part whose data is null',
        part: {content: {$case: 'data', value: null}},
        log: 'DataPart: {}',
      },
      {
        name: 'a file part whose url is null',
        part: {content: {$case: 'url', value: null}},
        log: 'FilePart: {}',
      },
    ])('prints $name as empty', ({part, log}) => {
      const wirePart: Part = fromWire(part);

      expect(buildMessagePartLog(wirePart)).toBe(log);
    });

    it('prints a file part whose url is null without a url', () => {
      const part: Part = fromWire({
        content: {$case: 'url', value: null},
        filename: 'report.pdf',
        mediaType: 'application/pdf',
      });

      expect(buildMessagePartLog(part)).toBe(`FilePart: {
  "filename": "report.pdf",
  "mediaType": "application/pdf"
}`);
    });

    it('prints a file part whose url is undefined without a url', () => {
      const part: Part = createFilePart(
        {$case: 'url', value: undefined as unknown as string},
        'report.pdf',
      );

      expect(buildMessagePartLog(part)).toBe(`FilePart: {
  "filename": "report.pdf"
}`);
    });

    it('prints the other parts of a response when one part has null text', () => {
      const response: A2AEvent = fromWire({
        messageId: 'message-1',
        role: Role.ROLE_AGENT,
        parts: [
          {content: {$case: 'text', value: null}},
          {content: {$case: 'text', value: 'Hello'}},
        ],
      });

      const log = buildA2AResponseLog(response);

      expect(log).toContain('Part 0: TextPart: \nPart 1: TextPart: Hello\n');
      expect(log).not.toContain('<log unavailable>');
    });

    it('prints a request whose metadata is null and whose message has no parts', () => {
      const params: SendMessageRequest = fromWire({
        message: {
          messageId: 'message-1',
          role: Role.ROLE_USER,
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
        messageId: 'message-1',
        role: Role.ROLE_AGENT,
        parts: [{content: {$case: 'text', value: 'Hello'}, metadata: null}],
        metadata: null,
      });

      const log = buildA2AResponseLog(response);

      expect(log).toContain('Result Type: Message\n');
      expect(log).toContain('Message Parts:\nPart 0: TextPart: Hello\n');
      expect(log).not.toContain('Metadata');
    });

    it('prints a status update whose status message has no parts', () => {
      const response: A2AEvent = fromWire({
        taskId: 'task-1',
        contextId: 'context-1',
        status: {
          state: TaskState.TASK_STATE_COMPLETED,
          message: {messageId: 'message-1', role: Role.ROLE_AGENT},
        },
      });

      const log = buildA2AResponseLog(response);

      expect(log).toContain('Status State: TASK_STATE_COMPLETED\n');
      expect(log).toContain('ID: message-1\n');
      expect(log).toContain('Message Parts:\nNo parts\n');
    });

    it('prints an artifact update whose artifact has no parts', () => {
      const response: A2AEvent = fromWire({
        taskId: 'task-1',
        contextId: 'context-1',
        artifact: {artifactId: 'artifact-1'},
      });

      const log = buildA2AResponseLog(response);

      expect(log).toContain('Artifact ID: artifact-1\nParts Count: 0\n');
    });

    it('prints a task whose metadata is null and whose history entry has no parts', () => {
      const response: A2AEvent = fromWire({
        id: 'task-1',
        contextId: 'context-1',
        status: {state: TaskState.TASK_STATE_WORKING},
        metadata: null,
        history: [
          {
            messageId: 'message-1',
            role: Role.ROLE_USER,
            taskId: '',
            contextId: '',
          },
        ],
      });

      const log = buildA2AResponseLog(response);

      expect(log).toContain('History Length: 1\n');
      expect(log).not.toContain('Task Metadata');
      expect(log).toContain(
        'Message 1:\n  ID: message-1\n  Role: ROLE_USER\n  Message Parts:\n  No parts\n',
      );
    });

    it('leaves out the ids and the timestamp that are null', () => {
      const response: A2AEvent = fromWire({
        id: 'task-1',
        contextId: 'context-1',
        status: {
          state: TaskState.TASK_STATE_WORKING,
          timestamp: null,
          message: {
            messageId: 'message-1',
            role: Role.ROLE_AGENT,
            taskId: null,
            contextId: null,
            parts: [],
          },
        },
      });

      const log = buildA2AResponseLog(response);

      expect(log).toContain(
        'Status State: TASK_STATE_WORKING\nHistory Length: 0\n',
      );
      expect(log).toContain(
        'ID: message-1\nRole: ROLE_AGENT\nMessage Parts:\n',
      );
      expect(log).not.toContain('null');
    });

    it('prints a placeholder for a response that cannot be formatted', () => {
      const response: A2AEvent = fromWire({
        messageId: 'message-1',
        role: Role.ROLE_AGENT,
        parts: 'not a list',
      });

      expect(buildA2AResponseLog(response)).toBe('<log unavailable>');
    });

    it('prints a placeholder for a request that cannot be formatted', () => {
      const params: SendMessageRequest = fromWire({
        message: {
          messageId: 'message-1',
          role: Role.ROLE_USER,
          parts: 'not a list',
        },
      });

      expect(buildA2ARequestLog(params)).toBe('<log unavailable>');
    });

    it('prints a placeholder for a request without a message', () => {
      const params: SendMessageRequest = fromWire({});

      const log = buildA2ARequestLog(params);

      expect(log).toContain('Message:\n  No message\n');
      expect(log).toContain('Configuration:\nNo configuration\n');
    });
  });
});
