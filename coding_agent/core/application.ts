import {InMemorySessionService, Runner, Session} from '@google/adk';
import {createUserContent} from '@google/genai';
import {CODING_AGENT} from '../agents/coding_agent.js';
import {ApplicationState} from '../state/state.js';
import {ApplicationUI} from '../ui/ui.js';

enum ApplicationMode {
  CODING = 'coding',
  PLANNING = 'planning',
}

const USER_ID = 'user';

export class Application {
  private state: ApplicationState;
  private ui: ApplicationUI;
  private session?: Session;
  private sessionService = new InMemorySessionService();

  private currentMode: ApplicationMode = ApplicationMode.CODING;

  constructor(state: ApplicationState, ui: ApplicationUI) {
    this.state = state;
    this.ui = ui;

    // Wire the UI input callback
    // (We will need to expose a way for UI to report inputs, or let the UI call an event)
    if ('onUserInput' in this.ui) {
      (this.ui as any).onUserInput = this.handleUserInput.bind(this);
    }
  }

  run() {
    this.ui.render();
  }

  private async startSessionIfNeeded() {
    if (!this.session) {
      this.session = await this.sessionService.createSession({
        appName: 'coding_agent',
        userId: USER_ID,
        state: {},
        sessionId: crypto.randomUUID(),
      });
    }
  }

  private async handleUserInput(input: string) {
    this.startSessionIfNeeded();

    // 1. Push user message to state
    this.state.messages.push({
      role: 'user',
      content: input,
      timestamp: new Date(),
    });
    this.state.status = 'running';
    this.ui.update(this.state);

    try {
      // 2. Run the agent

      const runner = new Runner({
        agent: CODING_AGENT,
        appName: 'coding_agent',
        sessionService: this.sessionService,
      });
      const outputStream = runner.runAsync({
        userId: USER_ID,
        sessionId: this.session!.id,
        newMessage: createUserContent(input),
      });

      for await (const event of outputStream) {
      }
      // 3. Push agent response to state
      this.state.messages.push({
        role: 'agent',
        content: response?.message || 'Done', // Fallback or parsed response
        timestamp: new Date(),
      });
    } catch (error: any) {
      this.state.messages.push({
        role: 'system',
        content: `Error: ${error?.message || 'Unknown error'}`,
        timestamp: new Date(),
      });
    } finally {
      this.state.status = 'idle';
      this.ui.update(this.state);
    }
  }
}
