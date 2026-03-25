export interface ApplicationMessage {
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: Date;
}

export interface ApplicationState {
  messages: ApplicationMessage[];
  status: 'idle' | 'running' | 'error';
}
