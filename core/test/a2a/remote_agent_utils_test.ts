/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TextPart} from '@a2a-js/sdk';
import {describe, expect, it} from 'vitest';
import {
  getFunctionResponseCallId,
  getUserFunctionCallAt,
  isFunctionCallEvent,
  presentAsUserMessage,
  toMissingRemoteSessionParts,
} from '../../src/a2a/a2a_remote_agent_utils.js';
import {AdkMetadataKeys} from '../../src/a2a/metadata_converter_utils.js';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent} from '../../src/events/event.js';
import {Session} from '../../src/sessions/session.js';

describe('remote_agent_utils', () => {
  const mockAgent = {
    name: 'test-agent',
  } as unknown as BaseAgent;

  const mockCtx = {
    agent: mockAgent,
    invocationId: 'test-invocation-id',
  } as unknown as InvocationContext;

  describe('getFunctionResponseCallId', () => {
    it('should return undefined if no content', () => {
      const event = createEvent({author: 'user'});
      expect(getFunctionResponseCallId(event)).toBeUndefined();
    });

    it('should return call ID if functionResponse present', () => {
      const event = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-123',
                name: 'test_tool',
                response: {result: 'ok'},
              },
            },
          ],
        },
      });
      expect(getFunctionResponseCallId(event)).toBe('call-123');
    });
  });

  describe('isFunctionCallEvent', () => {
    it('should return false if no content', () => {
      const event = createEvent({author: 'user'});
      expect(isFunctionCallEvent(event, 'call-123')).toBe(false);
    });

    it('should return true if functionCall ID matches', () => {
      const event = createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-123',
                name: 'test_tool',
                args: {},
              },
            },
          ],
        },
      });
      expect(isFunctionCallEvent(event, 'call-123')).toBe(true);
    });

    it('should return false if functionCall ID does not match', () => {
      const event = createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-456',
                name: 'test_tool',
                args: {},
              },
            },
          ],
        },
      });
      expect(isFunctionCallEvent(event, 'call-123')).toBe(false);
    });
  });

  describe('getUserFunctionCallAt', () => {
    it('should return undefined for invalid index', () => {
      const session = {events: []} as unknown as Session;
      expect(getUserFunctionCallAt(session, 0)).toBeUndefined();
    });

    it('should return undefined if event author is not user', () => {
      const event = createEvent({author: 'agent'});
      const session = {events: [event]} as unknown as Session;
      expect(getUserFunctionCallAt(session, 0)).toBeUndefined();
    });

    it('should return undefined if no functionResponse', () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      });
      const session = {events: [event]} as unknown as Session;
      expect(getUserFunctionCallAt(session, 0)).toBeUndefined();
    });

    it('should return UserFunctionCall if request event found', () => {
      const requestEvent = createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'call-123', name: 'tool'}}],
        },
        customMetadata: {
          [AdkMetadataKeys.TASK_ID]: 'task-123',
          [AdkMetadataKeys.CONTEXT_ID]: 'ctx-123',
        },
      });

      const responseEvent = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [{functionResponse: {id: 'call-123', name: 'tool'}}],
        },
      });

      const session = {
        events: [requestEvent, responseEvent],
      } as unknown as Session;

      const result = getUserFunctionCallAt(session, 1);
      expect(result).toBeDefined();
      expect(result?.taskId).toBe('task-123');
      expect(result?.contextId).toBe('ctx-123');
      expect(result?.response).toBe(responseEvent);
    });
  });

  describe('presentAsUserMessage', () => {
    it('should handle text parts', () => {
      const agentEvent = createEvent({
        author: 'other-agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });

      const result = presentAsUserMessage(mockCtx, agentEvent);
      expect(result.author).toBe('user');
      expect(result.content?.parts![0].text).toBe('For context:');
      expect(result.content?.parts![1].text).toBe('[other-agent] said: hello');
    });

    it('should handle functionCall parts', () => {
      const agentEvent = createEvent({
        author: 'other-agent',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool', args: {x: 1}}}],
        },
      });

      const result = presentAsUserMessage(mockCtx, agentEvent);
      expect(result.content?.parts![1].text).toContain('called tool tool');
      expect(result.content?.parts![1].text).toContain('{"x":1}');
    });

    it('should handle functionResponse parts', () => {
      const agentEvent = createEvent({
        author: 'other-agent',
        content: {
          role: 'model',
          parts: [{functionResponse: {name: 'tool', response: {y: 2}}}],
        },
      });

      const result = presentAsUserMessage(mockCtx, agentEvent);
      expect(result.content?.parts![1].text).toContain('tool returned result');
      expect(result.content?.parts![1].text).toContain('{"y":2}');
    });
  });

  describe('toMissingRemoteSessionParts', () => {
    it('should return all parts if no previous remote response', () => {
      const event1 = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      });
      const session = {events: [event1]} as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      expect(result.parts.length).toBe(1);
      expect((result.parts[0] as TextPart).text).toBe('hello');
      expect(result.contextId).toBeUndefined();
    });

    it('should only return parts after last remote response', () => {
      const remoteResponse = createEvent({
        author: 'test-agent',
        content: {role: 'model', parts: [{text: 'response'}]},
        customMetadata: {
          [AdkMetadataKeys.CONTEXT_ID]: 'ctx-remote',
        },
      });
      const newUserMessage = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'new message'}]},
      });

      const session = {
        events: [remoteResponse, newUserMessage],
      } as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      expect(result.parts.length).toBe(1);
      expect((result.parts[0] as TextPart).text).toBe('new message');
      expect(result.contextId).toBe('ctx-remote');
    });

    it('should wrap other agent messages as user message', () => {
      const otherAgent = createEvent({
        author: 'other-agent',
        content: {role: 'model', parts: [{text: 'other response'}]},
      });

      const session = {events: [otherAgent]} as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      expect(result.parts.length).toBe(2); // "For context:" and "[other-agent] said: ..."
      expect((result.parts[0] as TextPart).text).toBe('For context:');
      expect((result.parts[1] as TextPart).text).toBe(
        '[other-agent] said: other response',
      );
    });

    it('drops a credential request function_call this agent raised', () => {
      // An adk_request_credential call this LOCAL agent (author != peer
      // name) raised carries a serialized AuthConfig in its arguments,
      // including rawAuthCredential -- an OAuth2 client secret or a service
      // account key. It must never reach a remote peer.
      const credentialRequest = createEvent({
        author: 'root_agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-1',
                name: 'adk_request_credential',
                args: {
                  functionCallId: 'toolFc1',
                  authConfig: {
                    authScheme: {type: 'oauth2'},
                    credentialKey: 'test-key',
                    rawAuthCredential: {
                      oauth2: {
                        clientId: 'real-client-id',
                        clientSecret: 'SUPER_SECRET_DO_NOT_LEAK',
                      },
                    },
                  },
                },
              },
            },
            {text: 'accompanying text'},
          ],
        },
      });

      const session = {events: [credentialRequest]} as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      const dumped = JSON.stringify(result.parts);

      expect(dumped).not.toContain('SUPER_SECRET_DO_NOT_LEAK');
      expect(dumped).not.toContain('adk_request_credential');
      expect(
        result.parts.some((p) =>
          (p as TextPart).text?.includes('accompanying text'),
        ),
      ).toBe(true);
    });

    it('drops a credential response this agent raised the request for', () => {
      const credentialRequest = createEvent({
        author: 'root_agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-1',
                name: 'adk_request_credential',
                args: {functionCallId: 'toolFc1', authConfig: {}},
              },
            },
          ],
        },
      });
      const credentialResponse = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'fc-1',
                name: 'adk_request_credential',
                response: {
                  authScheme: {type: 'oauth2'},
                  credentialKey: 'test-key',
                  exchangedAuthCredential: {
                    oauth2: {accessToken: 'SECRET_ACCESS_TOKEN'},
                  },
                },
              },
            },
          ],
        },
      });

      const session = {
        events: [credentialRequest, credentialResponse],
      } as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      const dumped = JSON.stringify(result.parts);

      expect(dumped).not.toContain('SECRET_ACCESS_TOKEN');
    });

    it('forwards a credential response the remote peer itself requested', () => {
      // The remote peer's OWN request for a credential arrives as an event
      // authored by the peer's own name (mockAgent.name, "test-agent") --
      // see toAdkEvent. Its answer must reach the peer, or the peer's
      // pending request is silently stranded forever.
      const peerCredentialRequest = createEvent({
        author: 'test-agent', // the peer's own name
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'peer-fc-1',
                name: 'adk_request_credential',
                args: {functionCallId: 'peerToolFc1', authConfig: {}},
              },
            },
          ],
        },
      });
      const answerToPeer = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'peer-fc-1',
                name: 'adk_request_credential',
                response: {
                  authScheme: {type: 'oauth2'},
                  credentialKey: 'peer-key',
                  exchangedAuthCredential: {
                    oauth2: {accessToken: 'ANSWER_FOR_THE_PEER'},
                  },
                },
              },
            },
          ],
        },
      });

      const session = {
        events: [peerCredentialRequest, answerToPeer],
      } as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      const dumped = JSON.stringify(result.parts);

      expect(dumped).toContain('ANSWER_FOR_THE_PEER');
    });

    it('matches a differently-named credential call in snake_case', () => {
      // generateAuthEvent, the primary in-tree producer, emits args in
      // snake_case (function_call_id/auth_config). The structural fallback
      // must still catch a credential envelope under a name other than
      // adk_request_credential once normalised.
      const credentialRequest = createEvent({
        author: 'root_agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-1',
                name: 'some_other_tool_name',
                args: {
                  function_call_id: 'toolFc1',
                  auth_config: {
                    authScheme: {type: 'oauth2'},
                    rawAuthCredential: {
                      oauth2: {clientSecret: 'SNAKE_CASE_SECRET'},
                    },
                  },
                },
              },
            },
          ],
        },
      });

      const session = {events: [credentialRequest]} as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      const dumped = JSON.stringify(result.parts);

      expect(dumped).not.toContain('SNAKE_CASE_SECRET');
    });

    it('matches a differently-named credential response in snake_case', () => {
      // Response-side counterpart to the call-side test above: the
      // structural fallback in isCredentialFunctionResponse (payloadIsAuthConfig
      // via camelCaseKeys) is what makes fix 3 work for a renamed response,
      // but nothing in this file's fixtures exercised it -- every existing
      // credential-response fixture uses the canonical
      // adk_request_credential name, which returns before this code path is
      // ever reached.
      const credentialRequest = createEvent({
        author: 'root_agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-1',
                name: 'adk_request_credential',
                args: {functionCallId: 'toolFc1', authConfig: {}},
              },
            },
          ],
        },
      });
      const renamedResponse = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'fc-1',
                name: 'some_other_tool_name',
                response: {
                  auth_scheme: {type: 'oauth2'},
                  credential_key: 'k',
                  exchanged_auth_credential: {
                    oauth2: {accessToken: 'SNAKE_CASE_RESPONSE_SECRET'},
                  },
                },
              },
            },
          ],
        },
      });

      const session = {
        events: [credentialRequest, renamedResponse],
      } as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      const dumped = JSON.stringify(result.parts);

      expect(dumped).not.toContain('SNAKE_CASE_RESPONSE_SECRET');
    });

    it('drops a credential response with no id, rather than forwarding it', () => {
      // The fail-safe for a response with no id: id is undefined, so
      // peerRequestedIds.has(id) can never be true, and the response is
      // dropped rather than forwarded. Security-relevant (an id-less
      // response must never be treated as ambiguously safe to forward), so
      // it deserves an assertion rather than being correct by accident.
      const noIdResponse = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'adk_request_credential',
                response: {
                  authScheme: {type: 'oauth2'},
                  credentialKey: 'k',
                  exchangedAuthCredential: {
                    oauth2: {accessToken: 'NO_ID_SECRET'},
                  },
                },
              },
            },
          ],
        },
      });

      const session = {events: [noIdResponse]} as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      const dumped = JSON.stringify(result.parts);

      expect(dumped).not.toContain('NO_ID_SECRET');
    });

    it('does not drop a non-credential function_call', () => {
      // The shape probe must not over-match: unrelated tool history should
      // survive forwarding intact.
      const unrelatedToolCall = createEvent({
        author: 'root_agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-1',
                name: 'get_weather',
                args: {location: 'Pimpri'},
              },
            },
          ],
        },
      });

      const session = {events: [unrelatedToolCall]} as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      const dumped = JSON.stringify(result.parts);

      expect(dumped).toContain('get_weather');
      expect(dumped).toContain('Pimpri');
    });
  });
});
