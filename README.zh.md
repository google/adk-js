# Agent Development Kit (ADK) for TypeScript

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![NPM Version](https://img.shields.io/npm/v/@google/adk)](https://www.npmjs.com/package/@google/adk)
[![r/agentdevelopmentkit](https://img.shields.io/badge/Reddit-r%2Fagentdevelopmentkit-FF4500?style=flat&logo=reddit&logoColor=white)](https://www.reddit.com/r/agentdevelopmentkit/)

[ [English](https://github.com/google/adk-js/blob/main/README.md) | 简体中文 ]

<html>
    <h2 align="center">
      <img src="https://raw.githubusercontent.com/google/adk-python/main/assets/agent-development-kit.png" width="256"/>
    </h2>
    <h3 align="center">
      开源、代码优先的 TypeScript 工具包，助您灵活自如地构建、评估与部署前沿 AI 智能体。
    </h3>
    <h3 align="center">
      重要链接：<a href="https://adk.dev">官方文档</a>, <a
      href="https://github.com/google/adk-samples">示例集</a> & <a
      href="https://github.com/google/adk-web">ADK Web</a>.
    </h3>
</html>

---

智能体开发套件（Agent Development Kit，简称 ADK）是一个灵活且模块化的框架，用于构建、部署和编排 AI 智能体工作流 —— 涵盖从简单任务处理到复杂的多智能体协同系统。您可以直接在代码中定义智能体行为、编排逻辑与工具调用，从而在任意运行环境实现强大的调试、版本控制与部署能力。

ADK 的 TypeScript 版本专为 Node.js 与浏览器生态体系打造，具备完备的类型安全保证、Zod Schema 校验，并全面支持 ESM、CommonJS 以及 Web 运行时。

## ✨ 核心特性

- **代码优先的 TypeScript 开发**：以完备的类型安全性定义智能体业务逻辑、工具与工作流编排。工具参数全面支持 Zod v3 与 v4 schema，提供编译期类型推断。

- **兼顾浏览器与服务端**：提供 ESM、CommonJS 与 Web bundle 打包产物。既可在 Node.js 中运行智能体，也可直接在浏览器端执行。

- **丰富的工具生态**：内置 Google Search、Google Maps、Vertex AI Search 与 URL 上下文工具。支持连接 MCP（Model Context Protocol）服务器，将任意函数封装为工具，或加入代码执行能力。

- **多智能体编排**：将智能体组合为顺序执行、并行处理、循环迭代以及条件路由等工作流。支持通过 A2A 协议委派给远程智能体。

- **开发工具与 CLI**：交互式开发控制台（Dev UI）助您轻松测试与调试。提供用于项目脚手架生成（`adk create`）、本地测试（`adk run`、`adk web`）以及云端部署（`adk deploy cloud_run`）的 CLI 命令行。

## 🚀 安装

> **前置要求：** ADK for TypeScript 要求 Node.js 20.19 或更高版本。

```bash
npm install @google/adk
npm install -D @google/adk-devtools
```

或使用 yarn：

```bash
yarn add @google/adk
yarn add -D @google/adk-devtools
```

这将安装核心 SDK，并将开发工具（CLI 与开发控制台 UI）作为开发依赖安装。

## 快速上手 (Quick Start)

配置身份验证。从 [Google AI Studio](https://aistudio.google.com/app/apikey) 获取 API 密钥，并在您的智能体代码同级目录下创建 `.env` 文件：

```bash
echo "GOOGLE_GENAI_API_KEY=your-api-key-here" > .env
```

> 改用 Vertex AI？请设置 `GOOGLE_GENAI_USE_VERTEXAI=1`、`GOOGLE_CLOUD_PROJECT` 和 `GOOGLE_CLOUD_LOCATION` 替代 API 密钥，并通过 `gcloud auth application-default login` 完成身份验证。

在 `agent.ts` 中定义一个智能体：

```typescript
import {LlmAgent, GOOGLE_SEARCH} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'search_assistant',
  description: 'An assistant that can search the web.',
  model: 'gemini-flash-latest',
  instruction:
    'You are a helpful assistant. Answer user questions using Google Search when needed.',
  tools: [GOOGLE_SEARCH],
});
```

在您的智能体项目目录下运行：

```bash
# 交互式命令行
npx @google/adk-devtools run agent.ts

# Web 开发控制台
npx @google/adk-devtools web
```

> 请务必指明完整的包名。若未安装 `@google/adk-devtools`，直接执行 `npx adk` 将会静默下载并运行公共 npm 仓库中一个无关的 `adk` 包。

`adk web` 命令会启动一个用于测试和调试智能体的可视化开发界面：

<img src="https://raw.githubusercontent.com/google/adk-python/main/assets/adk-web-dev-ui-function-call.png"/>

## 📚 官方文档

- **快速入门 (Getting Started)**：https://adk.dev/get-started/typescript
- **代码示例 (Samples)**：https://github.com/google/adk-samples
- **开发者指南 (Developer guides)**：[docs/guides/README.md](./docs/guides/README.md)
- **本仓库内嵌示例**：
  [图工作流 (graph workflows)](./samples/workflows/README.md)、
  [工具集成 (tools)](./samples/tools/README.md)、
  [代码执行 (code execution)](./samples/code_execution/README.md)

## 🤝 贡献指南

我们热烈欢迎来自社区的贡献！无论是 Bug 报告、功能建议、文档改进还是代码贡献，都请先参阅[贡献指南 (contributing guide)](https://adk.dev/community/contributing-guide/) 与 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解如何开始。

## 📄 许可证

本项目基于 Apache 2.0 许可证开源 —— 详情请参阅 [LICENSE](LICENSE) 文件。

---

> **翻译说明（Translation Disclaimer）**
> 本文档由社区志愿者（[@JasonYeYuhe](https://github.com/JasonYeYuhe)）人工翻译并维护，旨在降低中文开发者的阅读门槛。最后同步日期：2026年11月14日。若译文与英文原版存在任何出入或滞后，请以 [英文原版 (README.md)](https://github.com/google/adk-js/blob/main/README.md) 为准。欢迎通过 PR 协助改进译文！
