/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fg from 'fast-glob';
import * as fs from 'node:fs/promises';
import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {batchLoadYamlAgentConfig} from '../../src/conformance/yaml_agent_loader.js';

// Mock fast-glob
vi.mock('fast-glob', () => ({
  default: {
    stream: vi.fn(),
  },
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

const AGENT_ONE_YAML = `
name: agent_one
model: gemini-pro
description: The first agent
instruction: You are agent one.
`;

const AGENT_TWO_YAML = `
name: agent_two
model: gemini-flash
description: The second agent
instruction: You are agent two.
disallow_transfer_to_parent: "true"
`;

const AGENT_THREE_YAML = `
agent_class: LlmAgent
name: agent_three
model: gemini-1.5-pro
description: The third agent
instruction: You are agent three.
max_iterations: "10"
disallow_transfer_to_parent: "false"
disallow_transfer_to_peers: "true"
generate_content_config:
  temperature: 0.9
before_agent_callbacks:
  - name: beforeCallback
after_agent_callbacks:
  - name: afterCallback
sub_agents:
  - config_path: path/to/subagent.yaml
tools:
  - name: mcp_tool
    args:
      stdio_connection_params:
        timeout: 3000
      server_params:
        command: npx
        args:
          - server
      tool_filter:
        - toolA
`;

describe('batchLoadYamlAgentConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load and parse yaml files recursively', async () => {
    const mockFiles = [
      '/root/dir/agent1.yaml',
      '/root/dir/subdir/agent2.yml',
      '/root/dir/agent3.yaml',
    ];

    // Mock fg.stream to return the file list.
    // Since the implementation uses `for await`, a simple array works as it is iterable.
    (fg.stream as unknown as Mock).mockReturnValue(mockFiles);

    // Mock fs.readFile to return YAML content based on filename
    (fs.readFile as Mock).mockImplementation(async (filePath: string) => {
      if (filePath === '/root/dir/agent1.yaml') {
        return AGENT_ONE_YAML;
      }
      if (filePath === '/root/dir/subdir/agent2.yml') {
        return AGENT_TWO_YAML;
      }
      if (filePath === '/root/dir/agent3.yaml') {
        return AGENT_THREE_YAML;
      }
      throw new Error(`File not found: ${filePath}`);
    });

    const agents = await batchLoadYamlAgentConfig('/root/dir');

    expect(fg.stream).toHaveBeenCalledWith('**/*.{yaml,yml}', {
      cwd: '/root/dir',
      absolute: true,
    });

    expect(agents.size).toBe(3);

    expect(agents.get('agent1')).toMatchObject({
      name: 'agent_one',
      model: 'gemini-pro',
      description: 'The first agent',
      instruction: 'You are agent one.',
    });

    expect(agents.get('subdir/agent2')).toMatchObject({
      name: 'agent_two',
      model: 'gemini-flash',
      description: 'The second agent',
      instruction: 'You are agent two.',
      disallowTransferToParent: 'true', // Verified camelCase conversion
    });

    expect(agents.get('agent3')).toMatchObject({
      agentClass: 'LlmAgent',
      name: 'agent_three',
      model: 'gemini-1.5-pro',
      description: 'The third agent',
      instruction: 'You are agent three.',
      maxIterations: '10',
      disallowTransferToParent: 'false',
      disallowTransferToPeers: 'true',
      generateContentConfig: {
        temperature: 0.9,
      },
      beforeAgentCallbacks: [{name: 'beforeCallback'}],
      afterAgentCallbacks: [{name: 'afterCallback'}],
      subAgents: [
        {
          configPath: 'path/to/subagent',
        },
      ],
      tools: [
        {
          name: 'mcp_tool',
          args: {
            stdioConnectionParams: {
              timeout: 3000,
            },
            serverParams: {
              command: 'npx',
              args: ['server'],
            },
            toolFilter: ['toolA'],
          },
        },
      ],
    });
  });

  it('should load and parse yaml files with Windows-style paths', async () => {
    const rootDir = 'C:\\root\\dir';
    const mockFiles = [
      'C:\\root\\dir\\agent1.yaml',
      'C:\\root\\dir\\subdir\\agent2.yml',
    ];

    (fg.stream as unknown as Mock).mockReturnValue(mockFiles);

    (fs.readFile as Mock).mockImplementation(async (filePath: string) => {
      if (filePath.includes('agent1.yaml')) return AGENT_ONE_YAML;
      if (filePath.includes('agent2.yml')) return AGENT_TWO_YAML;
      throw new Error(`File not found: ${filePath}`);
    });

    const agents = await batchLoadYamlAgentConfig(rootDir);

    expect(fg.stream).toHaveBeenCalledWith('**/*.{yaml,yml}', {
      cwd: rootDir,
      absolute: true,
    });

    expect(agents.size).toBe(2);

    expect(agents.get('agent1')).toMatchObject({
      name: 'agent_one',
      model: 'gemini-pro',
    });

    const agent2Key = 'subdir/agent2';
    expect(agents.get(agent2Key)).toMatchObject({
      name: 'agent_two',
      model: 'gemini-flash',
    });
  });

  it('should support all AgentClass enum values', async () => {
    const validClasses = [
      'LlmAgent',
      'LoopAgent',
      'ParallelAgent',
      'SequentialAgent',
    ];
    const mockFiles = validClasses.map((cls) => `/root/dir/${cls}.yaml`);

    (fg.stream as unknown as Mock).mockReturnValue(mockFiles);

    (fs.readFile as Mock).mockImplementation(async (filePath: string) => {
      const cls = filePath.split('/').pop()?.replace('.yaml', '') || '';
      return `
name: agent_${cls}
agent_class: ${cls}
model: model
description: desc
instruction: instr
`;
    });

    const agents = await batchLoadYamlAgentConfig('/root/dir');

    expect(agents.size).toBe(4);
    validClasses.forEach((cls) => {
      expect(agents.get(cls)?.agentClass).toBe(cls);
    });
  });

  it('should allow invalid AgentClass values as strings', async () => {
    const mockFiles = ['/root/dir/invalid.yaml'];
    (fg.stream as unknown as Mock).mockReturnValue(mockFiles);

    (fs.readFile as Mock).mockImplementation(
      async () => `
name: agent_invalid
agent_class: InvalidClass
model: model
description: desc
instruction: instr
`,
    );

    const agents = await batchLoadYamlAgentConfig('/root/dir');

    expect(agents.size).toBe(1);
    expect(agents.get('invalid')?.agentClass).toBe('InvalidClass');
  });

  it('should support all ToolsConfiguration args types', async () => {
    const mockFiles = ['/root/dir/agent_tools.yaml'];
    (fg.stream as unknown as Mock).mockReturnValue(mockFiles);

    const AGENT_WITH_TOOLS_YAML = `
name: agent_tools
model: model
description: desc
instruction: instr
tools:
  - name: agent_ref_tool
    args:
      config_path: /path/to/ref.yaml
  - name: mcp_tool
    args:
      stdio_connection_params:
        timeout: 5000
      server_params:
        command: python
        args:
          - -m
          - server
      tool_filter:
        - filter1
  - name: example_tool
    args:
      examples:
        - examples:
            - input:
                role: user
                parts:
                  - text: "hello"
              output:
                role: model
                parts:
                  - text: "world"
  - name: lro_tool
    args:
      func:
        type: "some_type"
        description: "some description"
`;

    (fs.readFile as Mock).mockImplementation(async () => AGENT_WITH_TOOLS_YAML);

    const agents = await batchLoadYamlAgentConfig('/root/dir');

    expect(agents.size).toBe(1);
    const tools = agents.get('agent_tools')?.tools;
    expect(tools).toHaveLength(4);

    expect(tools![0]).toMatchObject({
      name: 'agent_ref_tool',
      args: {
        configPath: '/path/to/ref.yaml',
      },
    });

    expect(tools![1]).toMatchObject({
      name: 'mcp_tool',
      args: {
        stdioConnectionParams: {
          timeout: 5000,
        },
        serverParams: {
          command: 'python',
          args: ['-m', 'server'],
        },
        toolFilter: ['filter1'],
      },
    });

    expect(tools![2]).toMatchObject({
      name: 'example_tool',
      args: {
        examples: [
          {
            examples: [
              {
                input: {
                  role: 'user',
                  parts: [{text: 'hello'}],
                },
                output: {
                  role: 'model',
                  parts: [{text: 'world'}],
                },
              },
            ],
          },
        ],
      },
    });

    expect(tools![3]).toMatchObject({
      name: 'lro_tool',
      args: {
        func: {
          type: 'some_type',
          description: 'some description',
        },
      },
    });
  });

  it('should handle extra fields gracefully (forward compatibility)', async () => {
    const mockFiles = ['/root/dir/agent_extra.yaml'];
    (fg.stream as unknown as Mock).mockReturnValue(mockFiles);

    const AGENT_WITH_EXTRA_FIELDS = `
name: agent_extra
model: model
description: desc
instruction: instr
extra_field: extra_value
nested_extra:
  some_key: some_value
`;

    (fs.readFile as Mock).mockImplementation(
      async () => AGENT_WITH_EXTRA_FIELDS,
    );

    const agents = await batchLoadYamlAgentConfig('/root/dir');

    expect(agents.size).toBe(1);
    const agent = agents.get('agent_extra');
    expect(agent).toMatchObject({
      name: 'agent_extra',
      model: 'model',
      description: 'desc',
      instruction: 'instr',
    });
    // Verify extra fields are present and camelCased
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any).extraField).toBe('extra_value');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((agent as any).nestedExtra).toEqual({someKey: 'some_value'});
  });
});
