/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseCodeExecutor,
  type CodeExecutionResult,
  type ExecuteCodeParams,
  type Frontmatter,
  LlmAgent,
  type Skill,
  type SkillRegistry,
  SkillToolset,
} from '@google/adk';
import {type Part} from '@google/genai';
import {vi} from 'vitest';

import {
  AGENT_DESCRIPTION,
  AGENT_NAME,
  BASE_INSTRUCTION,
  FINAL_TEXT,
  FIRST_TURN_USAGE,
  makePartResponse,
  ScriptedModel,
  type ScriptedTurn,
  SECOND_TURN_USAGE,
  type TelemetryTestCase,
} from '../telemetry_test_utils.js';

export type SkillType = 'local' | 'registry' | 'nonexistent';

export type SkillResourceType =
  'references' | 'assets' | 'scripts' | 'wrong_type' | 'wrong_name';

export const REGISTRY_SKILL_NAME = 'registry-skill';
export const LOCAL_SKILL_NAME = 'local-skill';
export const NONEXISTENT_SKILL_NAME = 'nonexistent-skill';
export const SKILL_DESCRIPTION = 'A sample skill.';
export const SKILL_SCRIPT_OUTPUT_DIR = '/tmp/adk_skill_script_test';

/**
 * Extended test case for the skill scenario.
 */
export interface SkillTelemetryTestCase extends TelemetryTestCase {
  readonly loadedSkills?: readonly SkillType[];
  readonly loadedResources?: readonly SkillResourceType[];
  readonly scriptReturnExitCodes?: readonly number[];
}

export const SKILL_TEST_CASES: readonly SkillTelemetryTestCase[] = [
  {
    testId: 'skill-telemetry-disabled',
    captureContent: 'false',
    experimentalTelemetry: false,
    loadedSkills: ['local', 'registry'],
  },
  {
    testId: 'skill-telemetry',
    captureContent: 'false',
    experimentalTelemetry: true,
    loadedSkills: ['local'],
  },
  {
    testId: 'invalid-skill',
    captureContent: 'false',
    experimentalTelemetry: true,
    loadedSkills: ['nonexistent'],
  },
  {
    testId: 'skill-resource-telemetry',
    captureContent: 'false',
    experimentalTelemetry: true,
    loadedResources: ['references', 'assets', 'scripts'],
  },
  {
    testId: 'invalid-skill-resource',
    captureContent: 'false',
    experimentalTelemetry: true,
    loadedResources: ['wrong_type', 'wrong_name'],
  },
  {
    testId: 'skill-script-telemetry',
    captureContent: 'false',
    experimentalTelemetry: true,
    scriptReturnExitCodes: [0, 1, 10, 20],
  },
];

function makeSkill(options?: {
  name?: string;
  additionalTools?: readonly string[];
}): Skill {
  const name = options?.name ?? LOCAL_SKILL_NAME;
  const additionalTools = options?.additionalTools ?? [];
  return {
    frontmatter: {
      name,
      description: SKILL_DESCRIPTION,
      metadata: {
        adk_additional_tools: [...additionalTools],
      },
    },
    instructions: 'skill instructions',
    resources: {
      references: {ref1: 'ref1_content'},
      assets: {'deeply/hidden/asset1': 'asset1_content'},
      scripts: {
        script1: {src: 'script1_content'},
        'ec_0.py': {src: "print(':D')"},
        'ec_1.py': {src: 'foo = 1/0'},
        'ec_10.py': {src: 'import sys; sys.exit(10)'},
      },
    },
  };
}

class FakeSkillRegistry implements SkillRegistry {
  constructor(private readonly skill: Skill) {}

  async getSkill(name: string): Promise<Skill> {
    if (name === this.skill.frontmatter.name) {
      return structuredClone(this.skill);
    }
    throw new Error(`Skill ${name} not found`);
  }

  async searchSkills(_query: string): Promise<Frontmatter[]> {
    return [];
  }
}

class FakeSkillCodeExecutor extends BaseCodeExecutor {
  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const code = params.codeExecutionInput.code;
    if (code.includes('ec_0.py')) {
      return {
        stdout: ':D\n',
        stderr: '',
        outputFiles: [],
      };
    }
    if (code.includes('ec_1.py')) {
      return {
        stdout: '',
        stderr: 'ZeroDivisionError: division by zero\n',
        outputFiles: [],
      };
    }
    return {
      stdout: '',
      stderr: '',
      outputFiles: [],
    };
  }
}

function buildSkillCallPart(skill: SkillType): Part {
  const skillNameByType: Record<SkillType, string> = {
    local: LOCAL_SKILL_NAME,
    registry: REGISTRY_SKILL_NAME,
    nonexistent: NONEXISTENT_SKILL_NAME,
  };
  return {
    functionCall: {
      name: 'load_skill',
      args: {name: skillNameByType[skill]},
    },
  };
}

function buildSkillResourceCallPart(resource: SkillResourceType): Part {
  const pathByType: Record<SkillResourceType, string> = {
    references: 'references/ref1',
    assets: 'assets/deeply/hidden/asset1',
    scripts: 'scripts/script1',
    wrong_type: 'fake/file/not/existing',
    wrong_name: 'references/nope/never',
  };
  return {
    functionCall: {
      name: 'load_skill_resource',
      args: {
        skill_name: REGISTRY_SKILL_NAME,
        path: pathByType[resource],
      },
    },
  };
}

function buildRunScriptCallPart(exitCode: number): Part {
  return {
    functionCall: {
      name: 'run_skill_script',
      args: {
        skill_name: REGISTRY_SKILL_NAME,
        script_path: `scripts/ec_${exitCode}.py`,
      },
    },
  };
}

function buildSkillTurns(tc: SkillTelemetryTestCase): ScriptedTurn[] {
  const turns: ScriptedTurn[] = [];
  for (const skill of tc.loadedSkills ?? []) {
    turns.push(
      makePartResponse({
        part: buildSkillCallPart(skill),
        usageMetadata: FIRST_TURN_USAGE,
      }),
    );
  }
  for (const resource of tc.loadedResources ?? []) {
    turns.push(
      makePartResponse({
        part: buildSkillResourceCallPart(resource),
        usageMetadata: FIRST_TURN_USAGE,
      }),
    );
  }
  for (const exitCode of tc.scriptReturnExitCodes ?? []) {
    turns.push(
      makePartResponse({
        part: buildRunScriptCallPart(exitCode),
        usageMetadata: FIRST_TURN_USAGE,
      }),
    );
  }
  turns.push(
    makePartResponse({
      part: {text: FINAL_TEXT},
      usageMetadata: SECOND_TURN_USAGE,
    }),
  );
  return turns;
}

/**
 * Builds `some_root_agent` equipped with a {@link SkillToolset} for `tc`.
 */
export function createSkillAgent(tc: SkillTelemetryTestCase): LlmAgent {
  const model = new ScriptedModel(buildSkillTurns(tc));
  const registry = new FakeSkillRegistry(
    makeSkill({name: REGISTRY_SKILL_NAME}),
  );
  const toolset = new SkillToolset(
    [makeSkill({additionalTools: ['foo', 'bar']})],
    {
      registry,
      codeExecutor: new FakeSkillCodeExecutor(),
      scriptOutputDir: SKILL_SCRIPT_OUTPUT_DIR,
    },
  );
  vi.spyOn(toolset, 'getScriptOutputDir').mockResolvedValue(
    SKILL_SCRIPT_OUTPUT_DIR,
  );
  return new LlmAgent({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    tools: [toolset],
  });
}
