/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createFolder, isFolderExists, listFiles, removeFolder, saveToFile } from '../utils/file_utils';
import { isCancel, select, text } from '@clack/prompts';

const execPromise = promisify(exec);
const dirname = process.cwd();

const TS_CONFIG = `{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "rootDir": "./",
    "outDir": "dist",
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,
    "declaration": true,
    "declarationMap": true,
    "esModuleInterop": true,
    "exactOptionalPropertyTypes": true,
    "noEmitOnError": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "noUncheckedIndexedAccess": true,
    "pretty": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "strict": true
  }
}
`.trim();

const PACKAGE_JSON = (agentName: string, language: string) => `
{
  "name": "${agentName}",
  "version": "1.0.0",
  "description": "",
  "main": "agent.${language}",
  "scripts": {
    "web": "npx @google/adk-devtools web",
    "cli": "npx @google/adk-devtools run agent.${language}"
  },
  "keywords": [],
  "author": "",
  "license": "ISC"
}
`.trim()

const AGENT_TEMPLATE = (model: string) => `
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/* Mock tool implementation */
const getCurrentTime = new FunctionTool({
  name: 'get_current_time',
  description: 'Returns the current time in a specified city.',
  parameters: z.object({
    city: z.string().describe("The name of the city for which to retrieve the current time."),
  }),
  execute: ({city}) => {
    return {status: 'success', report: \`The current time in \$\{ city \} is 10: 30 AM\`};
  },
});

export const rootAgent = new LlmAgent({
  name: 'hello_time_agent',
  model: '${model}',
  description: 'Tells the current time in a specified city.',
  instruction: \`You are a helpful assistant that tells the current time in a city.
                Use the 'getCurrentTime' tool for this purpose.\`,
  tools: [getCurrentTime],
});
`.trim()

                                              interface AgentCreationOptions {
  agentName: string;
  forceYes: boolean;
  model: string;
  apiKey: string;
  project: string;
  region: string;
  language: string;
}

async function getGcpProject(): Promise<string> {
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    return process.env.GOOGLE_CLOUD_PROJECT;
  }
  try {
    const stdout = execSync('gcloud config get-value project', { encoding: 'utf-8', stdio: 'pipe' });
    return stdout.trim();
  } catch (error) {
    return '';
  }
}

async function getGcpRegion(): Promise<string> {
  if (process.env.GOOGLE_CLOUD_LOCATION) {
    return process.env.GOOGLE_CLOUD_LOCATION;
  }
  try {
    const stdout = execSync('gcloud config get-value compute/region', { encoding: 'utf-8', stdio: 'pipe' });
    return stdout.trim();
  } catch (error) {
    return '';
  }
}

async function generateAgentFolder(agentDir: string, forceYes: boolean) {
  if (!(await isFolderExists(agentDir))) {
    return await createFolder(agentDir)
  }

  const overwriteFolderResponse: symbol|boolean = forceYes ?
      true :
      await select(
          {
            message: `Folder ${
                agentDir} already exists. Would you like to overwrite existing folder?`,
            options: [
              {label: 'Yes', value: true},
              {label: 'No', value: false},
            ],
          },
      );

  if (isCancel(overwriteFolderResponse)) {
    process.exit(0);
  }

  if (!overwriteFolderResponse) {
    console.error(`Agent directory ${agentDir} already exists.`);
    process.exit(0);
  }

  await removeFolder(agentDir);
  await createFolder(agentDir);
}

function generateEnvFile(options: AgentCreationOptions): string {
  const lines = [];
  if (options.apiKey) {
    lines.push(`GOOGLE_API_KEY=${options.apiKey}`);
    lines.push(`GOOGLE_GENAI_USE_VERTEXAI=0`);
  }
  if (options.project) {
    lines.push(`GOOGLE_CLOUD_PROJECT=${options.project}`);
  }
  if (options.region) {
    lines.push(`GOOGLE_CLOUD_LOCATION=${options.region}`);
  }
  if (options.region && options.project) {
    lines.push(`GOOGLE_GENAI_USE_VERTEXAI=1`);
  }
  return lines.join('\n');
}

async function generateFiles(options: AgentCreationOptions) {
  const agentDir = path.join(dirname, options.agentName);

  await saveToFile(path.join(agentDir, `agent.${options.language}`), AGENT_TEMPLATE(options.model || 'gemini-2.5-flash'));
  await saveToFile(path.join(agentDir, '.env'), generateEnvFile(options));
  await saveToFile(path.join(agentDir, 'package.json'), PACKAGE_JSON(options.agentName, options.language));
  if (options.language === 'ts') {
    await saveToFile(path.join(agentDir, 'tsconfig.json'), TS_CONFIG);
  }
}

export async function createAgent(options: AgentCreationOptions) {
  const agentDir = path.join(dirname, options.agentName);
  await generateAgentFolder(agentDir, options.forceYes);

  if (!options.model) {
    const model: symbol|string = options.forceYes ?
        'gemini-2.5-flash' :
        (await select(
            {
              message: 'Choose a model for the root agent',
              options: [
                {label: 'gemini-2.5-flash', value: 'gemini-2.5-flash'},
                {label: 'gemini-2.5-pro', value: 'gemini-2.5-pro'},
                {
                  label: 'gemini-3-flash-preview',
                  value: 'gemini-3-flash-preview'
                },
                {label: 'gemini-3-pro-preview', value: 'gemini-3-pro-preview'},
              ],
            },
            ));

    if (isCancel(model)) {
      process.exit(0);
    }
    options.model = model;
  }

  if (options.language !== "js" && options.language !== "ts") {
    const language = options.forceYes ?
        'ts' :
        (await select(
            {
              message: 'Choose a language for the agent',
              options: [
                {label: 'TypeScript', value: 'ts'},
                {label: 'JavaScript', value: 'js'},
              ],
            },
            ));

    if (isCancel(language)) {
      process.exit(0);
    }
    options.language = language;
  }

  if (!options.apiKey && !options.project) {
    const backend: symbol|string = options.forceYes ?
        'googleai' :
        (await select(
            {
              message: 'Choose a backend',
              options: [
                {label: 'Google AI', value: 'googleai'},
                {label: 'Vertex AI', value: 'vertex'},
              ],
            },
            ));

    if (isCancel(backend)) {
      process.exit(0);
    }

    if (backend === 'vertex') {
      const defaultProject = await getGcpProject();
      const defaultRegion = await getGcpRegion();

      const projectResponse: string = options.forceYes ?
          defaultProject :
          (await text(
               {
                 message: 'Enter the Google Cloud Project ID',
                 initialValue: defaultProject,
               },
               ))
              .toString();

      if (isCancel(projectResponse)) {
        process.exit(0);
      }
      options.project = projectResponse;

      const regionResponse: symbol|string =
          options.forceYes ? defaultRegion : (await text({
            message: 'Enter the Google Cloud Region',
            initialValue: defaultRegion,
          }));

      if (isCancel(regionResponse)) {
        process.exit(0);
      }
      options.region = regionResponse;
    } else {
      const apiKeyResponse: symbol|string = options.forceYes ?
          '' :
          (await text(
              {
                message: 'Enter the Google API Key',
              },
              ));

      if (isCancel(apiKeyResponse)) {
        process.exit(0);
      }
      options.apiKey = apiKeyResponse;
    }
  }

  await generateFiles(options);
  if (options.language === "ts") {
    await execPromise(`npm install typescript --save-dev`, { cwd: agentDir });
  }
  await execPromise(
      `npm install @google/adk @google/adk-devtools zod@3.25.76 dotenv`,
      {cwd: agentDir});

  const files = await listFiles(agentDir);

  console.log(`\nCreated the following files in ${agentDir}:`);
  files.forEach(file => {
    console.log(`  - ${file}`);
  });
  console.log(`Run 'cd ${options.agentName} && npm run web' to start the agent in a web interface`);
}
