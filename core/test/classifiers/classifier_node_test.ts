/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {isClassifierContentInput} from '../../src/classifiers/types.js';
import {
  Answer,
  BaseClassifier,
  ChoiceAnswer,
  ClassifierInput,
  ClassifierNode,
  ClassifierNodeConfig,
  ClassifierRequest,
  ClassifierResponse,
  createBinary,
  createBinaryAnswer,
  createChoice,
  createChoiceAnswer,
  createClassifierResponse,
  createEvent,
  createRefusalAnswer,
  createScore,
  createScoreAnswer,
  DEFAULT_ROUTE,
  Edge,
  getClientLabels,
  InMemoryRunner,
  isBinaryAnswer,
  isClassifierNode,
  isWorkflowDataError,
  LlmClassifier,
  LlmRequest,
  LlmResponse,
  NodeSchemaValidationError,
  Question,
  START,
  Workflow,
  WorkflowDataError,
} from '../../src/index.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import {classifierClientLabel} from '../../src/utils/client_labels.js';
import {createIc, driveWorkflow, FnNode} from '../workflow/test_helpers.js';

const TRIAGE = createChoice({
  instructions: 'Route this ticket.',
  criteria: {billing: 'Invoices or refunds', technical: 'Bugs'},
});

interface RecordedCall {
  readonly input: ClassifierInput;
  readonly questions: Readonly<Record<string, Question>>;
  readonly clientLabels: readonly string[];
}

class FixedClassifier extends BaseClassifier {
  readonly calls: RecordedCall[] = [];
  private readonly fixedAnswer?: Answer;

  constructor(answer?: Answer) {
    super({model: 'fixed'});
    this.fixedAnswer = answer;
  }

  protected override async classifyImpl({
    input,
    questions,
  }: ClassifierRequest): Promise<ClassifierResponse> {
    this.calls.push({
      input,
      questions: {...questions},
      clientLabels: getClientLabels(),
    });
    const answers: Record<string, Answer> = {};
    if (this.fixedAnswer !== undefined) {
      for (const name of Object.keys(questions)) {
        answers[name] = this.fixedAnswer;
      }
    }
    return createClassifierResponse({
      modelVersion: this.name,
      answers,
    });
  }
}

function makeChoiceAnswer(label: string): ChoiceAnswer {
  return createChoiceAnswer({
    choice: label,
    probabilities:
      label === 'billing'
        ? {billing: 0.9, technical: 0.1}
        : {billing: 0.1, technical: 0.9},
  });
}

function makeTriageNode(
  answer?: Answer,
  overrides: Partial<
    Omit<ClassifierNodeConfig, 'name' | 'classifier' | 'question'>
  > = {},
): {node: ClassifierNode; classifier: FixedClassifier} {
  const classifier = new FixedClassifier(answer);
  const node = new ClassifierNode({
    name: 'triage',
    classifier,
    question: TRIAGE,
    ...overrides,
  });
  return {node, classifier};
}

describe('ClassifierNode', () => {
  it('routes a Choice question to the chosen label and forwards input unchanged', async () => {
    const {node, classifier} = makeTriageNode(makeChoiceAnswer('technical'));
    expect(isClassifierNode(node)).toBe(true);

    const billingInputs: unknown[] = [];
    const technicalInputs: unknown[] = [];
    const billing = new FnNode('billing', (_c, input) => {
      billingInputs.push(input);
      return input;
    });
    const technical = new FnNode('technical', (_c, input) => {
      technicalInputs.push(input);
      return input;
    });

    const wf = new Workflow({
      name: 'wf',
      edges: [
        [START, node],
        [node, {billing, technical}],
      ],
    });

    const message = createUserContent('The API returns 500');
    await driveWorkflow(wf, message);

    expect(billingInputs).toEqual([]);
    expect(technicalInputs).toEqual([message]);
    expect(classifier.calls).toHaveLength(1);
    expect(classifier.calls[0].input).toEqual(message);
    expect(classifier.calls[0].questions).toEqual({route: TRIAGE});
  });

  it('supports Choice questions with numeric-looking string labels in routing maps', async () => {
    const numericQuestion = createChoice({
      instructions: 'Pick a tier.',
      criteria: {'1': 'Tier 1', '2': 'Tier 2'},
    });
    const classifier = new FixedClassifier(
      createChoiceAnswer({
        choice: '2',
        probabilities: {'1': 0.1, '2': 0.9},
      }),
    );
    const node = new ClassifierNode({
      name: 'tier_router',
      classifier,
      question: numericQuestion,
    });
    const tier1Inputs: unknown[] = [];
    const tier2Inputs: unknown[] = [];
    const tier1 = new FnNode('tier1', (_c, input) => {
      tier1Inputs.push(input);
      return input;
    });
    const tier2 = new FnNode('tier2', (_c, input) => {
      tier2Inputs.push(input);
      return input;
    });

    const wf = new Workflow({
      name: 'wf_numeric_choice',
      edges: [
        [START, node],
        [node, {'1': tier1, '2': tier2}],
      ],
    });

    await driveWorkflow(wf, 'request');

    expect(tier1Inputs).toEqual([]);
    expect(tier2Inputs).toEqual(['request']);
  });

  it.each([
    {name: 'above threshold', probability: 0.7, expected: true},
    {name: 'at threshold', probability: 0.6, expected: true},
    {name: 'below threshold', probability: 0.59, expected: false},
  ])(
    'routes a Binary question $name ($probability)',
    async ({probability, expected}) => {
      const classifier = new FixedClassifier(createBinaryAnswer({probability}));
      const gate = new ClassifierNode({
        name: 'gate',
        classifier,
        question: createBinary({instructions: 'Is this risky?'}),
        threshold: 0.6,
      });
      const yesInputs: unknown[] = [];
      const noInputs: unknown[] = [];
      const yes = new FnNode('yes', (_c, input) => {
        yesInputs.push(input);
        return input;
      });
      const no = new FnNode('no', (_c, input) => {
        noInputs.push(input);
        return input;
      });

      const wf = new Workflow({
        name: 'wf',
        edges: [
          [START, gate],
          [gate, {true: yes, false: no}],
        ],
      });

      await driveWorkflow(wf, 'payload');

      expect(yesInputs).toHaveLength(expected ? 1 : 0);
      expect(noInputs).toHaveLength(expected ? 0 : 1);
    },
  );

  it('labels classifier calls with the classifier kind', async () => {
    const {node, classifier} = makeTriageNode(makeChoiceAnswer('billing'));
    const sink = new FnNode('sink', (_c, input) => input);
    const wf = new Workflow({
      name: 'wf',
      edges: [
        [START, node],
        [node, {billing: sink, [DEFAULT_ROUTE]: sink}],
      ],
    });

    await driveWorkflow(wf, 'ticket');

    const labels = classifier.calls[0].clientLabels;
    expect(labels[labels.length - 1]).toBe(classifierClientLabel('custom'));
    expect(getClientLabels()).not.toContain(classifierClientLabel('custom'));
  });

  it('stores the serialized answer in state under answerKey and leaves state untouched when unset', async () => {
    const {node: withKey} = makeTriageNode(makeChoiceAnswer('billing'), {
      answerKey: 'triage_answer',
    });
    const sink = new FnNode('sink', (_c, input) => input);
    const wfWithKey = new Workflow({
      name: 'wf_with_key',
      edges: [
        [START, withKey],
        [withKey, {billing: sink, [DEFAULT_ROUTE]: sink}],
      ],
    });
    const icWithKey = createIc();
    await driveWorkflow(wfWithKey, 'ticket', {ic: icWithKey});
    expect(icWithKey.session.state['triage_answer']).toEqual({
      type: 'choice',
      choice: 'billing',
      probabilities: {billing: 0.9, technical: 0.1},
      confidence: null,
    });

    const {node: withoutKey} = makeTriageNode(makeChoiceAnswer('billing'));
    const wfWithoutKey = new Workflow({
      name: 'wf_without_key',
      edges: [
        [START, withoutKey],
        [withoutKey, {billing: sink, technical: sink}],
      ],
    });
    const icWithoutKey = createIc();
    await driveWorkflow(wfWithoutKey, 'ticket', {ic: icWithoutKey});
    expect(icWithoutKey.session.state).toEqual({});
  });

  it('converts objects with Date fields to JSON-safe input while forwarding the original object', async () => {
    class Ticket {
      constructor(
        readonly subject: string,
        readonly opened: Date,
      ) {}
    }
    const ticket = new Ticket('outage', new Date('2026-01-02T00:00:00.000Z'));
    const {node, classifier} = makeTriageNode(makeChoiceAnswer('billing'));
    const source = new FnNode('source', () => ticket);
    const received: unknown[] = [];
    const sink = new FnNode('sink', (_c, input) => {
      received.push(input);
      return 'done';
    });
    const wf = new Workflow({
      name: 'wf',
      edges: [
        [START, source],
        [source, node],
        [node, sink],
      ],
    });

    await driveWorkflow(wf, 'start');

    expect(classifier.calls[0].input).toEqual({
      subject: 'outage',
      opened: '2026-01-02T00:00:00.000Z',
    });
    expect(received[0]).toBe(ticket);
  });

  it.each<{
    name: string;
    value: unknown;
  }>([
    {name: 'a Map', value: new Map([['k', 'v']])},
    {name: 'a Set', value: new Set(['a', 'b'])},
    {name: 'a Uint8Array', value: new Uint8Array([1, 2, 3])},
    {name: 'an object containing a Set', value: {tags: new Set(['x'])}},
  ])(
    'throws WorkflowDataError when given non-JSON input ($name)',
    async ({value}) => {
      const {node} = makeTriageNode(makeChoiceAnswer('billing'));
      const source = new FnNode('source', () => value);
      const sink = new FnNode('sink', (_c, input) => input);
      const wf = new Workflow({
        name: 'wf',
        edges: [
          [START, source],
          [source, node],
          [node, sink],
        ],
      });

      let caught: unknown;
      try {
        await driveWorkflow(wf);
      } catch (error: unknown) {
        caught = error;
      }
      expect(isWorkflowDataError(caught)).toBe(true);
      expect(caught).toBeInstanceOf(WorkflowDataError);
    },
  );

  it.each<{
    name: string;
    answer?: Answer;
    pattern: RegExp;
  }>([
    {
      name: 'when the classifier returns no answer',
      answer: undefined,
      pattern: /returned no answer/,
    },
    {
      name: 'when the classifier chooses a label outside declared criteria',
      answer: createChoiceAnswer({
        choice: 'sales',
        probabilities: {billing: 0.9, technical: 0.1},
      }),
      pattern: /not one of its question's labels/,
    },
    {
      name: 'when the classifier returns a binary answer to a choice question',
      answer: createBinaryAnswer({probability: 0.5}),
      pattern: /binary answer to a choice question/,
    },
    {
      name: 'when the classifier returns a score answer to a choice question',
      answer: createScoreAnswer({score: 1, probabilities: {0: 0, 1: 1}}),
      pattern: /score answer to a choice question/,
    },
    {
      name: 'when the classifier declines to answer',
      answer: createRefusalAnswer(),
      pattern: /declined to answer/,
    },
  ])('throws WorkflowDataError $name', async ({answer, pattern}) => {
    const {node} = makeTriageNode(answer);
    const source = new FnNode('source', () => 'x');
    const sink = new FnNode('sink', (_c, input) => input);
    const wf = new Workflow({
      name: 'wf',
      edges: [
        [START, source],
        [source, node],
        [node, sink],
      ],
    });

    let caught: unknown;
    try {
      await driveWorkflow(wf);
    } catch (error: unknown) {
      caught = error;
    }
    expect(isWorkflowDataError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(WorkflowDataError);
    expect((caught as Error).message).toMatch(pattern);
  });

  it('recognizes NodeSchemaValidationError as a WorkflowDataError subclass', () => {
    const schemaError = new NodeSchemaValidationError({
      nodeName: 'n',
      direction: 'input',
      cause: new Error('expected string'),
    });
    expect(schemaError).toBeInstanceOf(WorkflowDataError);
    expect(isWorkflowDataError(schemaError)).toBe(true);
  });

  it('throws WorkflowDataError when the node receives no input to classify', async () => {
    const {node} = makeTriageNode(makeChoiceAnswer('billing'));
    const source = new FnNode('source', () => createEvent({route: 'go'}));
    const sink = new FnNode('sink', (_c, input) => input);
    const wf = new Workflow({
      name: 'wf',
      edges: [
        [START, source],
        [source, {go: node}],
        [node, sink],
      ],
    });

    await expect(driveWorkflow(wf)).rejects.toThrow(/received no input/);
  });

  it('validates outgoing edges during workflow construction', () => {
    const {node} = makeTriageNode(makeChoiceAnswer('billing'));
    const a = new FnNode('a', (_c, i) => i);
    const b = new FnNode('b', (_c, i) => i);

    expect(
      () =>
        new Workflow({
          name: 'wf',
          edges: [
            [START, node],
            [node, {biling: a, technical: b}],
          ],
        }),
    ).toThrow(/never emits: \["biling"\]/);

    expect(
      () =>
        new Workflow({
          name: 'wf',
          edges: [
            [START, node],
            [node, {billing: a}],
          ],
        }),
    ).toThrow(/no edge for routes \["technical"\]/);

    const gate = new ClassifierNode({
      name: 'gate',
      classifier: new FixedClassifier(createBinaryAnswer({probability: 1})),
      question: createBinary(),
    });
    expect(
      () =>
        new Workflow({
          name: 'wf',
          edges: [
            [START, gate],
            new Edge(gate, a, 'true'),
            new Edge(gate, b, 'false'),
          ],
        }),
    ).toThrow(/never emits/);

    expect(
      () =>
        new Workflow({
          name: 'wf_default',
          edges: [
            [START, node],
            [node, {billing: a, [DEFAULT_ROUTE]: b}],
          ],
        }),
    ).not.toThrow();

    expect(
      () =>
        new Workflow({
          name: 'wf_unrouted_fallback',
          edges: [
            [START, node],
            [node, {billing: a}],
            [node, b],
          ],
        }),
    ).not.toThrow();

    expect(
      () =>
        new Workflow({
          name: 'wf_unrouted_only',
          edges: [[START, node, a]],
        }),
    ).not.toThrow();
  });

  it('rejects Score questions, DEFAULT_ROUTE labels, and invalid threshold settings', () => {
    const classifier = new FixedClassifier();
    expect(
      () =>
        new ClassifierNode({
          name: 'rate',
          classifier,
          question: createScore({
            criteria: ['low', 'high'],
          }),
        }),
    ).toThrow(/cannot route on a Score question/);

    expect(() =>
      makeTriageNode(makeChoiceAnswer('billing'), {threshold: 0.8}),
    ).toThrow(/only applies to Binary/);

    expect(
      () =>
        new ClassifierNode({
          name: 'bad_label',
          classifier,
          question: createChoice({
            criteria: {[DEFAULT_ROUTE]: 'fallback', billing: 'billing'},
          }),
        }),
    ).toThrow(/reserved for DEFAULT_ROUTE/);

    expect(
      () =>
        new ClassifierNode({
          name: 'bad_threshold',
          classifier,
          question: createBinary(),
          threshold: 1.5,
        }),
    ).toThrow(/threshold in \[0, 1\]/);
  });

  it('runs chained Choice and Binary ClassifierNodes end-to-end through InMemoryRunner', async () => {
    class CannedLlm extends BaseLlm {
      constructor() {
        super({model: 'canned-llm'});
      }
      async *generateContentAsync(
        request: LlmRequest,
      ): AsyncGenerator<LlmResponse, void> {
        const sys = String(request.config?.systemInstruction ?? '');
        const isChoice = sys.includes('choose exactly one label');
        const reply = isChoice
          ? {route: {billing: 0.05, technical: 0.95}}
          : {route: {probability: 0.9}};
        yield {
          content: {
            role: 'model',
            parts: [{text: JSON.stringify(reply)}],
          },
        };
      }
      async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
        throw new Error('Not supported');
      }
    }

    const classifier = new LlmClassifier({model: new CannedLlm()});
    const triage = new ClassifierNode({
      name: 'triage',
      classifier,
      question: TRIAGE,
      answerKey: 'triage_answer',
    });
    const isUrgent = new ClassifierNode({
      name: 'is_urgent',
      classifier,
      question: createBinary({instructions: 'Is production down?'}),
      threshold: 0.7,
      answerKey: 'urgency_answer',
    });
    const pageOncall = new FnNode('page_oncall', (ctx, input) => {
      const text =
        isClassifierContentInput(input) && input.parts?.[0]?.text
          ? input.parts[0].text
          : `${input}`;
      const stored = ctx.state.get('urgency_answer');
      const urgency = isBinaryAnswer(stored) ? stored.probability : 0;
      return `Paged on-call (${urgency}): ${text}`;
    });
    const billingQueue = new FnNode('billing_queue', () => 'Billing queue');
    const engQueue = new FnNode('eng_queue', () => 'Eng queue');

    const workflow = new Workflow({
      name: 'support_triage',
      edges: [
        [START, triage],
        [triage, {billing: billingQueue, technical: isUrgent}],
        [isUrgent, {true: pageOncall, false: engQueue}],
      ],
    });

    const runner = new InMemoryRunner({
      appName: 'support_app',
      agent: workflow,
    });
    const session = await runner.sessionService.createSession({
      appName: 'support_app',
      userId: 'user-1',
    });

    const events = [];
    for await (const event of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: createUserContent('Production API returns 500'),
    })) {
      events.push(event);
    }

    const outputs = events
      .filter((e) => e.output !== undefined)
      .map((e) => e.output);
    expect(outputs[outputs.length - 1]).toBe(
      'Paged on-call (0.9): Production API returns 500',
    );
  });
});
