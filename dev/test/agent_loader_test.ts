import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {AgentLoader} from '../src/utils/agent_loader.js';

describe('AgentLoader __dirname replacement', () => {
  it('should replace __dirname with original directory path', async () => {
    const testDir = path.join(process.cwd(), 'test_fixtures_temp');
    await fs.mkdir(testDir, {recursive: true});

    const agentFilePath = path.join(testDir, 'dummy_agent.ts');
    await fs.writeFile(
      agentFilePath,
      `
      import { LlmAgent } from '@google/adk';
      
      export const rootAgent = new LlmAgent({
        name: 'dummy_agent',
        description: __dirname,
        model: 'gemini-2.5-flash'
      });
    `,
    );

    const loader = new AgentLoader(testDir);
    const agentFile = await loader.getAgentFile('dummy_agent');
    const agent = await agentFile.load();

    expect(agent.description).toBe(testDir);

    // Cleanup
    await agentFile.dispose();
    await fs.rm(testDir, {recursive: true, force: true});
  });
});
