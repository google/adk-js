/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  isClassifierContentInput,
  MAX_JSON_CONTENT_DEPTH,
  validateAnswer,
  validateClassifierInput,
  validateJSONContent,
  validateQuestion,
} from '../../src/classifiers/types.js';
import {
  createBinary,
  createBinaryAnswer,
  createChoice,
  createChoiceAnswer,
  createClassifierResponse,
  createRefusalAnswer,
  createScore,
  createScoreAnswer,
  isAnswer,
  isBinary,
  isBinaryAnswer,
  isChoice,
  isChoiceAnswer,
  isClassifierResponse,
  isQuestion,
  isRefusalAnswer,
  isScore,
  isScoreAnswer,
  parseAnswerJson,
  parseClassifierResponseJson,
  parseQuestionJson,
  serializeAnswer,
  serializeClassifierResponse,
  serializeQuestion,
} from '../../src/index.js';

describe('classifier types and validation', () => {
  it('requires at least two labels in a Choice question', () => {
    expect(() => createChoice({criteria: {only: null}})).toThrow(
      /at least 2 criteria labels/,
    );
  });

  it('requires at least two levels in a Score question', () => {
    expect(() => createScore({criteria: ['low']})).toThrow(
      /at least 2 criteria levels/,
    );
  });

  it('rejects null or undefined levels in a Score question', () => {
    expect(() =>
      createScore({criteria: ['low', null as unknown as string]}),
    ).toThrow(/must not be null or undefined/);
  });

  it('stores optional Binary criteria describing what counts as true', () => {
    const question = createBinary({
      instructions: 'Is this risky?',
      criteria: 'The action deletes user data.',
    });
    expect(isBinary(question)).toBe(true);
    expect(isQuestion(question)).toBe(true);
    expect(question.criteria).toBe('The action deletes user data.');
  });

  it('accepts structured JSON instructions and criteria in questions', () => {
    const question = createChoice({
      instructions: {task: 'route', context: ['ticket']},
      criteria: {a: {examples: ['x']}, b: null, c: undefined},
    });
    expect(isChoice(question)).toBe(true);
    expect(question.instructions).toEqual({task: 'route', context: ['ticket']});
    expect(question.criteria).toEqual({a: {examples: ['x']}, b: null, c: null});
  });

  it('distinguishes Question and Answer objects in type guards', () => {
    const choiceQ = createChoice({criteria: {a: null, b: null}});
    const binaryQ = createBinary();
    const scoreQ = createScore({criteria: ['low', 'high']});

    const choiceA = createChoiceAnswer({choice: 'a', probabilities: {a: 1}});
    const binaryA = createBinaryAnswer({probability: 0.5});
    const scoreA = createScoreAnswer({score: 0, probabilities: {0: 1}});
    const refusalA = createRefusalAnswer();

    expect(isChoice(choiceQ)).toBe(true);
    expect(isChoice(choiceA)).toBe(false);
    expect(isChoiceAnswer(choiceA)).toBe(true);
    expect(isChoiceAnswer(choiceQ)).toBe(false);

    expect(isBinary(binaryQ)).toBe(true);
    expect(isBinary(binaryA)).toBe(false);
    expect(isBinaryAnswer(binaryA)).toBe(true);
    expect(isBinaryAnswer(binaryQ)).toBe(false);

    expect(isScore(scoreQ)).toBe(true);
    expect(isScore(scoreA)).toBe(false);
    expect(isScoreAnswer(scoreA)).toBe(true);
    expect(isScoreAnswer(scoreQ)).toBe(false);

    expect(isQuestion(choiceA)).toBe(false);
    expect(isQuestion(binaryA)).toBe(false);
    expect(isQuestion(scoreA)).toBe(false);
    expect(isQuestion(refusalA)).toBe(false);
    expect(isAnswer(choiceQ)).toBe(false);
    expect(isAnswer(binaryQ)).toBe(false);
    expect(isAnswer(scoreQ)).toBe(false);
  });

  it('preserves __proto__ keys as own properties without mutating prototypes', () => {
    const criteriaWithProto = JSON.parse(
      '{"__proto__": "prototype label", "other": null}',
    ) as Record<string, string | null>;
    const choiceQ = createChoice({criteria: criteriaWithProto});
    expect(Object.hasOwn(choiceQ.criteria, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(choiceQ.criteria)).toBe(Object.prototype);
    expect(choiceQ.criteria['__proto__']).toBe('prototype label');

    const serializedQ = serializeQuestion(choiceQ);
    const parsedQ = parseQuestionJson(JSON.stringify(serializedQ));
    expect(isChoice(parsedQ)).toBe(true);
    if (isChoice(parsedQ)) {
      expect(Object.hasOwn(parsedQ.criteria, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(parsedQ.criteria)).toBe(Object.prototype);
      expect(parsedQ.criteria['__proto__']).toBe('prototype label');
    }

    const probsWithProto = JSON.parse(
      '{"__proto__": 0.8, "other": 0.2}',
    ) as Record<string, number>;
    const choiceA = createChoiceAnswer({
      choice: '__proto__',
      probabilities: probsWithProto,
    });
    expect(Object.hasOwn(choiceA.probabilities, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(choiceA.probabilities)).toBe(Object.prototype);
    expect(choiceA.probabilities['__proto__']).toBe(0.8);

    const response = createClassifierResponse({
      answers: JSON.parse(
        `{"__proto__": ${JSON.stringify(serializeAnswer(choiceA))}}`,
      ) as Record<string, typeof choiceA>,
    });
    const roundTripped = parseClassifierResponseJson(
      JSON.stringify(serializeClassifierResponse(response)),
    );
    expect(Object.hasOwn(roundTripped.answers, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(roundTripped.answers)).toBe(Object.prototype);
  });

  it('rejects non-JSON values in question instructions and criteria', () => {
    expect(() =>
      createChoice({
        instructions: {tags: new Set([1, 2]) as unknown as string},
        criteria: {a: null, b: null},
      }),
    ).toThrow(/not valid JSON content/);

    expect(() =>
      createChoice({
        instructions: {count: Number.NaN},
        criteria: {a: null, b: null},
      }),
    ).toThrow(/numbers must be finite/);
  });

  it('rejects JSON content nested deeper than MAX_JSON_CONTENT_DEPTH', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i <= MAX_JSON_CONTENT_DEPTH; i++) {
      deep = [deep];
    }
    expect(() => validateJSONContent(deep)).toThrow(
      /exceeds maximum nesting depth/,
    );
  });

  it('rejects circular references in JSON content', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => validateJSONContent(cyclic)).toThrow(/circular references/);
  });

  it('distinguishes top-level Content from JSON objects with role and parts fields', () => {
    const content = {role: 'user', parts: [{text: 'hello'}]};
    expect(isClassifierContentInput(content)).toBe(true);
    expect(validateClassifierInput(content)).toBe(content);

    const inventoryJson = {parts: ['bolt', 'nut']};
    expect(isClassifierContentInput(inventoryJson)).toBe(false);
    expect(validateClassifierInput(inventoryJson)).toEqual(inventoryJson);

    const roleAndPartsStrings = {role: 'admin', parts: ['bolt', 'nut']};
    expect(isClassifierContentInput(roleAndPartsStrings)).toBe(false);
    expect(validateClassifierInput(roleAndPartsStrings)).toEqual(
      roleAndPartsStrings,
    );

    const roleWithNonPartObjects = {role: 'admin', parts: [{id: 1}]};
    expect(isClassifierContentInput(roleWithNonPartObjects)).toBe(false);
    expect(validateClassifierInput(roleWithNonPartObjects)).toEqual(
      roleWithNonPartObjects,
    );
  });

  it('rejects GenAI Content or Part objects nested inside JSON input', () => {
    const history = [{role: 'user', parts: [{text: 'hello'}]}];
    expect(() => validateClassifierInput(history)).toThrow(
      /GenAI Content and Part objects are not valid inside JSON content/,
    );

    const barePart = {
      inlineData: {data: 'cG5n', mimeType: 'image/png'},
    };
    expect(() => validateClassifierInput(barePart)).toThrow(
      /GenAI Part objects are not valid JSON content/,
    );
  });

  it('rejects unknown fields on questions, answers, and responses in validation and JSON parsing', () => {
    expect(() =>
      validateQuestion({
        type: 'choice',
        criteria: {a: null, b: null},
        instruction: 'typo',
      }),
    ).toThrow(/Unknown field/);

    expect(() =>
      validateAnswer({
        type: 'binary',
        probability: 0.5,
        extra: 1,
      }),
    ).toThrow(/Unknown field/);

    expect(() =>
      parseClassifierResponseJson({
        answers: {},
        extra: 1,
      }),
    ).toThrow(/Unknown field/);
  });

  it('rejects non-canonical integer keys in ScoreAnswer probabilities', () => {
    expect(() =>
      parseAnswerJson({
        type: 'score',
        score: 0,
        probabilities: {'01': 1},
      }),
    ).toThrow(/non-negative integers/);
  });

  it.each([-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects out-of-range or non-finite probability %s across answer types',
    (probability) => {
      expect(() => createBinaryAnswer({probability})).toThrow(
        /finite number in \[0, 1\]/,
      );
      expect(() =>
        createBinaryAnswer({probability: 0.5, confidence: probability}),
      ).toThrow(/finite number in \[0, 1\]/);
      expect(() =>
        createChoiceAnswer({choice: 'a', probabilities: {a: probability}}),
      ).toThrow(/finite number in \[0, 1\]/);
      expect(() =>
        createChoiceAnswer({
          choice: 'a',
          probabilities: {a: 1},
          confidence: probability,
        }),
      ).toThrow(/finite number in \[0, 1\]/);
      expect(() =>
        createScoreAnswer({score: 0, probabilities: {0: probability}}),
      ).toThrow(/finite number in \[0, 1\]/);
      expect(() =>
        createScoreAnswer({
          score: 0,
          probabilities: {0: 1},
          confidence: probability,
        }),
      ).toThrow(/finite number in \[0, 1\]/);
    },
  );

  it('rejects empty probability maps and negative scores', () => {
    expect(() => createChoiceAnswer({choice: 'a', probabilities: {}})).toThrow(
      /must not be empty/,
    );
    expect(() => createScoreAnswer({score: 0, probabilities: {}})).toThrow(
      /must not be empty/,
    );
    expect(() => createScoreAnswer({score: -1, probabilities: {0: 1}})).toThrow(
      /finite non-negative number/,
    );
  });

  it('round-trips questions, answers, and responses through JSON', () => {
    const choiceQ = parseQuestionJson(
      JSON.stringify(
        serializeQuestion(
          createChoice({
            instructions: 'Pick one',
            criteria: {a: 'First', b: null},
          }),
        ),
      ),
    );
    expect(isChoice(choiceQ)).toBe(true);

    const scoreQ = parseQuestionJson({
      type: 'score',
      criteria: ['low', 'high'],
    });
    expect(isScore(scoreQ)).toBe(true);

    const response = createClassifierResponse({
      modelVersion: 'gemini-decision-1',
      answers: {
        route: createChoiceAnswer({
          choice: 'a',
          probabilities: {a: 0.9, b: 0.1},
        }),
        risky: createBinaryAnswer({probability: 0.2, confidence: 0.9}),
        urgency: createScoreAnswer({
          score: 0.75,
          probabilities: {0: 0.25, 1: 0.75},
          confidence: 0.5,
        }),
        refused: createRefusalAnswer(),
      },
    });
    expect(isClassifierResponse(response)).toBe(true);
    expect(isChoiceAnswer(response.answers['route'])).toBe(true);
    expect(isBinaryAnswer(response.answers['risky'])).toBe(true);
    expect(isScoreAnswer(response.answers['urgency'])).toBe(true);
    expect(isRefusalAnswer(response.answers['refused'])).toBe(true);
    expect(isAnswer(response.answers['refused'])).toBe(true);

    const serialized = serializeClassifierResponse(response);
    expect(serialized['model_version']).toBe('gemini-decision-1');
    const restored = parseClassifierResponseJson(JSON.stringify(serialized));
    expect(restored).toEqual(response);

    const singleAnswer = parseAnswerJson(
      JSON.stringify(serializeAnswer(response.answers['urgency'])),
    );
    expect(singleAnswer).toEqual(response.answers['urgency']);
  });

  it('rejects stringified numbers in JSON answer decoding', () => {
    expect(() =>
      parseAnswerJson('{"type":"binary","probability":"0.5"}'),
    ).toThrow(/finite number/);
  });
});
