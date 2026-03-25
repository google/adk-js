# Operational Modes (Planning & Coding)

The `coding_agent` operates in distinct modes to ensure structural integrity and reduce unauthorized modification of source code.

## State Machine & Transitions

The agent moves between the `PLANNING` phase and the `CODING` phase based on user confirmation.

### 1. **Planning Mode (The Thinker)**

In this mode, the agent is **read-only** for project source files. It can read local files, search the web, and run tests, but it cannot modify code.

-   **Goal**: Define *what* needs to be done.
-   **Output**: `implementation_plan.md` showing file diffs (conceptually) or steps.
-   **User Action Required**: Approve the plan to transition to the coding mode.

```typescript
export class PlanningModeHandler {
  async runPlan(userRequest: string) {
    const research = await this.researchCodebase(userRequest);
    const plan = await this.proModel.generatePlan(research);
    await this.fileManager.writeArtifact('implementation_plan.md', plan);
    await this.ui.promptUser('Plan generated. Approve?');
  }
}
```

### 2. **Coding Mode (The Doer)**

Once the plan is approved, the agent transitions to `CODING` mode. It uses write-enabled tools to execute the plan.

-   **Goal**: Apply code modifications, run build steps, and verify results.
-   **Output**: Modified source files, execution logs, and `walkthrough.md`.
-   **Fail-Safe**: If tests fail heavily or the agent gets stuck, it should fall back to `PLANNING` mode to reset context and re-evaluate.

---

## Short-Lived Artifacts & Scratch files

During execution, the agent creates short-lived artifacts (like scratch files, scripts, or diff previews) in a dedicated local temp folder `/tmp` or `os.tmpdir()`. These are not committed to git and are cleaned up at closing.
