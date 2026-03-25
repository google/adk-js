# System Tools (Git, File, Shell)

The `coding_agent` requires a set of capabilities to interact with the repository. These capabilities are encapsulated into isolated tools.

## Supported Tools

### 1. **Git Integration**

The agent should know how to work with Git to manage its workspace, check for changes, and create commits/branches.

-   `gitStatus()`: Run `git status` locally.
-   `gitDiff()`: Show active differences.
-   `gitCommit(msg: string)`: Create a commit after a successful execution phase.
-   `gitCheckout(branch: string)`: Switch branches.

```typescript
export class GitTool {
  async execute(action: 'status' | 'commit' | 'diff', args: string[]) {
    // Wrapper around child_process.spawn('git', [...])
  }
}
```

### 2. **File Manipulation Tool**

The agent needs the Ability to Create, Read, and Update files.

-   `createFile(path: string, content: string)`: Writes a new file.
-   `readFile(path: string)`: Read standard text files.
-   `modifyFile(path: string, targetContent: string, replacement: string)`: Edit a file.
-   `deleteFile(path: string)`: Remove files.

### 3. **Shell Execution Tool (Command Runner)**

The agent can propose shell commands to execute locally inside its workspace.

-   `runCommand(command: string)`: Executes a shell command and yields the standard output.
-   `isLongRunning()`: If a command runs in the background (like holding a dev server alive), it spawns it into a background thread using ADK's `BackgroundTool` or similar.

---

## Tool Constraints

To prevent accidental destruction:
-   Commands cannot `rm -rf /` or similar dangerous system paths.
-   Commands should be scope-limited to the workspace.
-   Short-lived results (like lint reports or temporary build outputs) are written to the temp folder, not to git-tracked directories.
