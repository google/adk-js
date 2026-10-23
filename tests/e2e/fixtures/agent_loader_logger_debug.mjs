import {BaseAgent, getLogger} from '@google/adk';

getLogger().debug('AGENT_LOADER_DEBUG_LOG_VISIBLE');

class LoggerDebugAgent extends BaseAgent {
  constructor() {
    super({name: 'agent_loader_logger_debug'});
  }
}

export const rootAgent = new LoggerDebugAgent();
