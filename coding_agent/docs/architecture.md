# Architecture Overview

The `coding_agent` uses a modular design to support multiple AI models and different user interfaces (TUI, Web, VS Code).

## Core Components

The agent consists of the following key layers:

### 1. **User Interface (UI) Layer**
The UI layer is decoupled from the agent logic. It defines an interface `UIManager` that can be implemented for different environments:
-   **Terminal (Default)**: Uses `ink` (React for CLI).
-   **Web View (Staging)**: Browser-based rendering.
-   **VS Code (Extension)**: Interacting with the IDE API.

```typescript
export interface UIManager {
  render(state: AgentState): void;
  promptUser(question: string): Promise<string>;
  showMessage(message: string, type: 'info' | 'warning' | 'error'): void;
}
```

### 2. **Model Symphony Layer**
The orchestration of different models. Instead of single text-generation, it manages context splitting and parallel execution:
-   **Pro Models**: Best for reasoning, code analysis, and complex plan generation.
-   **Flash / Fast Models**: Best for summarizing conversations, context compaction, and simple utility tasks (like linting analysis).

```typescript
export interface ModelManager {
  askPro(prompt: string): Promise<string>;
  askFast(prompt: string): Promise<string>;
}
```

### 3. **Execution Mode (State Machine)**
The agent runs in distinct phases:
-   `PLANNING`: Generates tasks, outlines architectural changes, and writes `implementation_plan.md`. No file changes happen here without user approval.
-   `CODING`: Executes actions like file modification, shell commands, and automated testing.

---

## Directory Structure Idea

```text
coding_agent/
├── package.json
├── tsconfig.json
├── docs/
│   ├── README.md
│   ├── architecture.md
│   ├── models.md
│   ├── ui_tui_ink.md
│   ├── modes.md
│   └── tools_git_file_sh.md
├── src/
│   ├── index.ts
│   ├── ui/
│   │   ├── tui/
│   │   └── web/
│   ├── models/
│   ├── modes/
│   └── tools/
└── tests/
```
