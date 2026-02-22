# ADK-JS Documentation

## Overview

The **Agent Development Kit (ADK) for JavaScript/TypeScript** is a comprehensive framework for building agentic AI applications with Google's Gemini API. It provides a modular, code-first architecture that enables developers to create sophisticated multi-agent systems with fine-grained control over agent behavior, tool integration, and execution flow.

**Repository**: https://github.com/google/adk-js
**License**: Apache-2.0
**Package**: `@google/adk`
**Version**: 0.3.0

### Key Features

- **Code-First Development**: Define agent logic, tools, and orchestration directly in TypeScript for ultimate flexibility, testability, and versioning
- **Modular Multi-Agent Systems**: Design scalable applications by composing multiple specialized agents into flexible hierarchies
- **Rich Tool Ecosystem**: Utilize pre-built tools (FunctionTool, AgentTool, GoogleSearchTool), MCP protocol integration, and custom tool creation
- **Flexible Execution Patterns**: Support for sequential, parallel, and loop-based agent orchestration
- **Event Sourcing**: Track all agent interactions through an immutable event log with delta-based state updates
- **Streaming Support**: SSE (Server-Sent Events) and bidirectional streaming modes
- **GCP Integration**: First-class support for Vertex AI, Google Cloud Storage, and Google authentication

## Installation

### Using npm

```bash
npm install @google/adk
```

### Using yarn

```bash
yarn add @google/adk
```

## Environment Variables

ADK-JS supports the following environment variables for configuration:

| Variable | Description | Default |
|----------|-------------|---------|
| `GOOGLE_GENAI_API_KEY` or `GEMINI_API_KEY` | API key for Gemini API authentication | - |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID for Vertex AI mode | - |
| `GOOGLE_CLOUD_LOCATION` | GCP region for Vertex AI (e.g., 'us-central1') | - |
| `GOOGLE_GENAI_USE_VERTEXAI` | Set to 'true' or '1' to use Vertex AI instead of Gemini API | false |
| `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` | Include request/response content in OpenTelemetry traces | true |

### Authentication Methods

ADK-JS supports multiple authentication methods:

1. **API Key** (Gemini API): Set `GOOGLE_GENAI_API_KEY` or `GEMINI_API_KEY`
2. **Vertex AI Mode**: Set `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT`, and `GOOGLE_CLOUD_LOCATION`
3. **Application Default Credentials (ADC)**: Used automatically when configured for Vertex AI
4. **Service Account**: Via ADC or explicit configuration
5. **OAuth2**: Via Google authentication library

## Quick Start

### Basic Example: Hello World Agent

```typescript
import { LlmAgent, InMemoryRunner } from '@google/adk';

// Create a simple agent
const agent = new LlmAgent({
  name: 'hello_agent',
  model: 'gemini-2.5-flash',
  instruction: 'You are a helpful assistant.'
});

// Create a runner with in-memory services
const runner = new InMemoryRunner({ agent });

// Create or get a session
const session = await runner.sessionService.getOrCreateSession({
  appName: runner.appName,
  userId: 'user1',
  sessionId: 'session1'
});

// Run the agent
for await (const event of runner.runAsync({
  userId: 'user1',
  sessionId: session.id,
  newMessage: {
    role: 'user',
    parts: [{ text: 'Hello, how are you?' }]
  }
})) {
  if (event.content) {
    console.log('Agent:', event.content.parts?.[0]?.text);
  }
}
```

### Example: Agent with Tools

```typescript
import { LlmAgent, FunctionTool, InMemoryRunner, GOOGLE_SEARCH } from '@google/adk';
import { z } from 'zod';

// Create a custom function tool
const weatherTool = new FunctionTool({
  name: 'get_weather',
  description: 'Get the current weather for a location',
  parameters: z.object({
    location: z.string().describe('The city name'),
    unit: z.enum(['celsius', 'fahrenheit']).optional()
  }),
  execute: async ({ location, unit = 'celsius' }) => {
    // Your weather API logic here
    return {
      location,
      temperature: 22,
      unit,
      condition: 'sunny'
    };
  }
});

// Create agent with tools
const agent = new LlmAgent({
  name: 'search_assistant',
  description: 'An assistant that can search the web and check weather',
  model: 'gemini-2.5-flash',
  instruction: 'You are a helpful assistant. Use Google Search and weather tools when needed.',
  tools: [GOOGLE_SEARCH, weatherTool]
});

const runner = new InMemoryRunner({ agent });
const session = await runner.sessionService.getOrCreateSession({
  appName: runner.appName,
  userId: 'user1',
  sessionId: 'session1'
});

for await (const event of runner.runAsync({
  userId: 'user1',
  sessionId: session.id,
  newMessage: {
    role: 'user',
    parts: [{ text: 'What is the weather in San Francisco?' }]
  }
})) {
  console.log('Event:', event);
}
```

### Example: Multi-Agent System

```typescript
import { LlmAgent, SequentialAgent, InMemoryRunner } from '@google/adk';

// Create specialized sub-agents
const researchAgent = new LlmAgent({
  name: 'researcher',
  model: 'gemini-2.5-flash',
  instruction: 'You are a research specialist. Gather and analyze information.'
});

const writerAgent = new LlmAgent({
  name: 'writer',
  model: 'gemini-2.5-flash',
  instruction: 'You are a content writer. Create well-structured content based on research.'
});

// Compose agents sequentially
const rootAgent = new SequentialAgent({
  name: 'content_pipeline',
  description: 'Research and write content',
  subAgents: [researchAgent, writerAgent]
});

const runner = new InMemoryRunner({ agent: rootAgent });
```

## Monorepo Structure

ADK-JS is organized as an npm workspace monorepo with two main packages:

```
adk-js/
├── core/                    # @google/adk (main package)
│   ├── src/
│   │   ├── agents/         # Agent classes and orchestration
│   │   ├── tools/          # Tool implementations
│   │   ├── models/         # LLM abstractions (Gemini, Apigee)
│   │   ├── sessions/       # Session management
│   │   ├── events/         # Event system
│   │   ├── runner/         # Execution runners
│   │   ├── plugins/        # Plugin system
│   │   ├── artifacts/      # Artifact storage
│   │   ├── memory/         # Memory service
│   │   ├── auth/           # Authentication
│   │   ├── code_executors/ # Code execution
│   │   └── telemetry/      # OpenTelemetry integration
│   ├── package.json
│   └── build.js            # esbuild configuration
├── dev/                     # @google/adk-devtools
│   ├── src/
│   │   ├── cli/            # CLI commands (web, api_server, run, deploy)
│   │   ├── server/         # Express server
│   │   └── ui/             # Angular debug UI
│   └── package.json
├── package.json            # Root workspace config
└── README.md
```

### Build System

- **Bundler**: esbuild for fast builds
- **TypeScript**: Version ^5.9.2, target ES2020
- **Module Formats**: Dual ESM/CJS output, plus browser-compatible build
- **Entry Points**:
  - `index.ts` - Main entry (Node.js)
  - `index_web.ts` - Browser entry (excludes Node.js-specific features)
  - `common.ts` - Shared browser-compatible exports

### Browser Support

ADK-JS supports browser environments via the `index_web.ts` entry point. The browser build excludes Node.js-specific capabilities like:

- GcsArtifactService (Google Cloud Storage)
- MCP tools
- Telemetry exports

The browser bundle includes:
- All agent types (LlmAgent, LoopAgent, SequentialAgent, ParallelAgent)
- InMemoryRunner with in-memory services
- FunctionTool and AgentTool
- Gemini model (API key mode only)
- BasePlugin support

## Core Dependencies

### Runtime Dependencies

| Package | Purpose |
|---------|---------|
| `@google/genai` (^1.37.0) | Official Google Generative AI SDK |
| `@modelcontextprotocol/sdk` (^1.26.0) | Model Context Protocol for tool integration |
| `google-auth-library` (^10.3.0) | Google authentication for Vertex AI |
| `zod` (^4.2.1) | Schema validation |
| `lodash-es` (^4.17.23) | Utility functions (deep cloning) |
| `zod-to-json-schema` (^3.25.1) | Convert Zod schemas to JSON Schema |

### Development Tools

| Package | Purpose |
|---------|---------|
| `express` | Web server for dev UI |
| `commander` | CLI argument parsing |
| `esbuild` | Fast bundling |
| `@clack/prompts` | Interactive CLI prompts |

## Next Steps

- **[Architecture](./architecture.md)**: Learn about the modular architecture and design patterns
- **[Agents](./agents.md)**: Understand agent types and configuration options
- **[Runner](./runner.md)**: Explore execution lifecycle and runtime configuration
- **[Tools](./tools.md)**: Create custom tools and integrate existing ones
- **[Models](./models.md)**: Configure LLMs and register custom implementations
- **[Sessions](./sessions.md)**: Manage conversation state and persistence
- **[Events](./events.md)**: Work with the event sourcing system
- **[Plugins](./plugins.md)**: Extend functionality with lifecycle hooks
- **[Artifacts](./artifacts.md)**: Store and retrieve files and blobs
- **[Memory](./memory.md)**: Implement long-term memory for agents
- **[Code Execution](./code-execution.md)**: Execute code safely in agents
- **[Authentication](./auth.md)**: Handle credential requests
- **[Telemetry](./telemetry.md)**: Monitor and trace agent execution
- **[CLI](./cli.md)**: Use development tools and deployment commands

## External Resources

- **[Official Documentation](https://google.github.io/adk-docs)**: Comprehensive guides
- **[Sample Applications](https://github.com/google/adk-samples)**: Example projects
- **[Reddit Community](https://www.reddit.com/r/agentdevelopmentkit/)**: Discussion and support
