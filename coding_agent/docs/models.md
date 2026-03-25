# Multi-Model Strategy (Parallel Executions)

The `coding_agent` uses a hybrid approach to model orchestration. Instead of using a single large model for all tasks, it splits the workload based on complexity and latency requirements.

By combining Pro models with Fast models, we obtain the benefits of high reasoning quality without sacrificing performance on utility tasks.

## Dual-Model Partition

Using parallel model instances:

### 1. **Pro Model (Gemini 3.1 Pro)**

- **Purpose**: Reasoning, long-horizon planning, complex software architecture, code generation.
- **Use Cases**:
  - Analyzing user requests and generating `implementation_plan.md`.
  - Writing complex logic or refactoring.
  - Reviewing bugs and stack traces.

### 2. **Fast Model (Gemini 3.1 Fast)**

- **Purpose**: Speed, utility prompts, context compaction, output parsing, trivial tasks.
- **Use Cases**:
  - Summarizing chat logs to keep context size manageable.
  - Running lint analysis and extracting error messages.
  - Verifying syntax before execution.
  - Formatting output.

```typescript
export interface ModelConfig {
  proModelName: string;
  fastModelName: string;
  apiKey?: string;
}

export class ModelBroker {
  async computeDenseTask(prompt: string): Promise<string> {
    // Delegates to Pro
  }

  async computeUtilityTask(prompt: string): Promise<string> {
    // Delegates to Fast
  }
}
```

---

## Short-Lived Context Compaction

To keep the Pro model's context window clean and fast, the Fast model is used to truncate and summarize the history.

- Every $N$ turns, a background job trigger compacts the history using the Fast model.
- The Pro model only sees the **Distilled Summary** + **Last Few Messages**.
