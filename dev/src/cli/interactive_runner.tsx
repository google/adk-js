import { render, Instance as UIInstance } from 'ink';
import { Application } from '../cli_ui/application.js';
import { randomUUID } from 'crypto';

export interface InteractiveRunnerOptions {
  agentName?: string;
}

export class InteractiveRunner {
  private agentName?: string;
  private uiInstance?: UIInstance;
  private userId: string;

  constructor(options?: InteractiveRunnerOptions) {
    this.agentName = options?.agentName;
    this.userId = randomUUID();
  }

  start() {
    this.uiInstance = render(
      <Application agentName={this.agentName} userId={this.userId}/>
    );
  }

  stop() {
    this.uiInstance?.unmount();
  }
}
