import {render, Box, Text, useInput} from 'ink';
import * as React from 'react';
import {ApplicationUI} from './ui.js';
import {ApplicationState, ApplicationMessage} from '../state/state.js';

export class TUI implements ApplicationUI {
  private state: ApplicationState;
  private instance: any;

  constructor(initialState: ApplicationState) {
    this.state = initialState;
  }

  update(state: ApplicationState): void {
    this.state = state;
    // Ink will re-render if we use a controlled state internally, 
    // but since we are wrapping it, we might need to recreate the instance if we don't use React state.
    // However, the standard Ink way is to run a long-running app component and let it handle UI.
    // For simplicity, we create a single long-running App component and push state to it.
    if (this.instance) {
      this.instance.rerender(<App state={this.state} onUserInput={this.onUserInput} />);
    }
  }

  render(): void {
    this.instance = render(<App state={this.state} onUserInput={this.onUserInput} />);
  }

  private onUserInput = (input: string) => {
    // This will be connected to the app core to push to agent
    console.log(`User typed: ${input}`);
  };
}

interface AppProps {
  state: ApplicationState;
  onUserInput: (input: string) => void;
}

const App: React.FC<AppProps> = ({state, onUserInput}) => {
  const [currentInput, setCurrentInput] = React.useState('');

  useInput((input, key) => {
    if (key.return) {
      if (currentInput.trim()) {
        onUserInput(currentInput.trim());
        setCurrentInput('');
      }
    } else if (key.backspace || key.delete) {
      setCurrentInput((prev) => prev.slice(0, -1));
    } else if (!key.ctrl && !key.meta && input) {
      setCurrentInput((prev) => prev + input);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        [Coding Agent TUI]
      </Text>
      
      <Box flexDirection="column" marginTop={1} minHeight={10}>
        {state.messages.map((msg, i) => (
          <Box key={i} flexDirection="row">
            <Text color={msg.role === 'user' ? 'blue' : 'green'}>{msg.role === 'user' ? 'You' : 'Agent'}: </Text>
            <Text>{msg.content}</Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="row" marginTop={1}>
        <Text bold color="yellow">
          Prompt >{' '}
        </Text>
        <Text>{currentInput}</Text>
      </Box>
    </Box>
  );
};
