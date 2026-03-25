import {LlmAgent} from '@google/adk';
import {getSettings} from '../config/settings.js';
import {FILE_SYSTEM_TOOLS} from '../tools/file_system_tool.js';

const SYSTEM_PROMPT = `
You are a coding agent that writes code.

## Instructions

- Write code based on the user's request.
- Use the tools provided to write code.
- Follow the instructions provided by the user.

## Output Format

- Write code based on the user's request.
- Use the tools provided to write code.
- Follow the instructions provided by the user.

## Examples

- Write code based on the user's request.
- Use the tools provided to write code.
- Follow the instructions provided by the user.
`;

export const CODING_AGENT = new LlmAgent({
  model: getSettings().codingAgentModel,
  name: 'coding-agent',
  description: 'You are a coding agent that writes code',
  instruction: SYSTEM_PROMPT,
  tools: [...FILE_SYSTEM_TOOLS],
});
