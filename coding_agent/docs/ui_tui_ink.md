# TUI Implementation (using Ink)

The interactive Terminal User Interface is built using the `ink` library. This allows component-based layout design using React concepts (re-renders on state changes).

## Component Breakdown

The `App` is the root component:

```tsx
import {render, Box, Text} from 'ink';

export const App = ({agentState}) => {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        [Coding Agent]
      </Text>
      <StatusPanel state={agentState} />
      <LogPanel logs={agentState.logs} />
      <InputPrompt promptReady={agentState.awaitingInput} />
    </Box>
  );
};
```

### 1. Panel Layouts

- **`StatusPanel`**: Shows the current mode (Planning vs Coding), the active task, and the file being edited.
- **`LogPanel`**: Displays the active stream of thoughts, tool executions, and terminal output.
- **`InputPrompt`**: Prompts the user for confirmation or text input.

### 2. Live Re-renders

The TUI shouldn't freeze during long operations.

- Running tasks use `setInterval` or events to push to `state.logs`.
- `ink` automatically updates the screen as standard output changes.

---

## State Updates

Coding Agent triggers events (e.g., `ToolCall`, `AgentResponse`, `UserPrompt`). The TUI can subscribe to these events and update the internal React state.

```typescript
codingAgent.on('event', (evt) => {
  setAgentState((prev) => ({
    ...prev,
    logs: [...prev.logs, evt.message],
  }));
});
```
