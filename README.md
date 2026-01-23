# Agent Development Kit (ADK) for TypeScript

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![NPM Version](https://img.shields.io/npm/v/@google/adk)](https://www.npmjs.com/package/@google/adk)
[![r/agentdevelopmentkit](https://img.shields.io/badge/Reddit-r%2Fagentdevelopmentkit-FF4500?style=flat&logo=reddit&logoColor=white)](https://www.reddit.com/r/agentdevelopmentkit/)

<html>
    <h2 align="center">
      <img src="https://raw.githubusercontent.com/google/adk-python/main/assets/agent-development-kit.png" width="256"/>
    </h2>
    <h3 align="center">
      An open-source, code-first TypeScript toolkit for building, evaluating, and deploying sophisticated AI agents with flexibility and control.
    </h3>
    <h3 align="center">
      Important Links:
      <a href="https://google.github.io/adk-docs/">Docs</a>,
      <a href="https://github.com/google/adk-samples">Samples</a>,
      <a href="https://github.com/google/adk-python">Python ADK</a>.
      <a href="https://github.com/google/adk-java">Java ADK</a>,
      <a href="https://github.com/google/adk-go">Go ADK</a> &
      <a href="https://github.com/google/adk-web">Web ADK</a>.
    </h3>
</html>

Agent Development Kit (ADK) is designed for developers seeking fine-grained
control and flexibility when building advanced AI agents that are tightly
integrated with services in Google Cloud. It allows you to define agent
behavior, orchestration, and tool use directly in code, enabling robust
debugging, versioning, and deployment anywhere – from your laptop to the cloud.

--------------------------------------------------------------------------------

## ✨ Key Features

-   **Rich Tool Ecosystem**: Utilize pre-built tools, custom functions, OpenAPI
    specs, or integrate existing tools to give agents diverse capabilities, all
    for tight integration with the Google ecosystem.

-   **Code-First Development**: Define agent logic, tools, and orchestration
    directly in TypeScript for ultimate flexibility, testability, and versioning.

-   **Modular Multi-Agent Systems**: Design scalable applications by composing
    multiple specialized agents into flexible hierarchies.

## 🚀 Installation

If you're using npm, add the following to your dependencies:

```bash
npm install @google/adk
```

Or with yarn:

```bash
yarn add @google/adk
```

## 📚 Documentation

For building, evaluating, and deploying agents by follow the TypeScript
documentation & samples:

*   **[Documentation](https://google.github.io/adk-docs)**
*   **[Samples](https://github.com/google/adk-samples)**

## 🏁 Feature Highlight

### Same Features & Familiar Interface As Other ADKs:

```typescript
import { LlmAgent, GOOGLE_SEARCH } from '@google/adk';

const rootAgent = new LlmAgent({
    name: 'search_assistant',
    description: 'An assistant that can search the web.',
    model: 'gemini-2.5-flash', // Or your preferred models
    instruction: 'You are a helpful assistant. Answer user questions using Google Search when needed.',
    tools: [GOOGLE_SEARCH],
});
```

### Development UI

Same as the Python Development UI.
A built-in development UI to help you test, evaluate, debug, and showcase your agent(s).
<img src="https://raw.githubusercontent.com/google/adk-python/main/assets/adk-web-dev-ui-function-call.png"/>

### Evaluate Agents

Coming soon...

## 🤖 A2A and ADK integration

For remote agent-to-agent communication, ADK integrates with the
[A2A protocol](https://github.com/google/A2A/).
Examples coming soon...

## 🏗️ Building the Project

This project uses `esbuild` to compile and bundle the TypeScript source code.
You can build the project using the following npm scripts:

*   `npm run build`: Compiles the TypeScript code into CommonJS, ESM, and Web formats in the `dist` directory.
*   `npm run build:bundle`: Creates bundled versions of the output for easier distribution or use in environments that don't support tree-shaking well.
*   `npm run build:watch`: Watches for changes in the source files and automatically rebuilds the project for ESM format only.

## 🤝 Contributing

We welcome contributions from the community! Whether it's bug reports, feature requests, documentation improvements, or code contributions, please see our
- [General contribution guideline and flow](https://google.github.io/adk-docs/contributing-guide/).
- Then if you want to contribute code, please read [Code Contributing Guidelines](./CONTRIBUTING.md) to get started.

## 📄 License

This project is licensed under the Apache 2.0 License - see the
[LICENSE](LICENSE) file for details.

## Preview

This feature is subject to the "Pre-GA Offerings Terms" in the General Service
Terms section of the
[Service Specific Terms](https://cloud.google.com/terms/service-terms#1). Pre-GA
features are available "as is" and might have limited support. For more
information, see the
[launch stage descriptions](https://cloud.google.com/products?hl=en#product-launch-stages).

--------------------------------------------------------------------------------

*Happy Agent Building!*
