import React, { useState, useEffect, useCallback, useRef, useContext, useMemo } from 'react';
import { Text, Box } from 'ink'
import Spinner from 'ink-spinner';
import { InMemoryRunner, Runner, Session, Event, getFunctionCalls, getFunctionResponses, isFinalResponse } from '@google/adk';
import { AgentLoader } from '../server/agent_loader.js';
import { KeyboardProvider, KeyboardContext, Key } from './keyboard_context.js';

export interface ApplicationProps {
  agentName: string | undefined;
  userId: string;
}
export const Application = ({ agentName, userId }: ApplicationProps) => {
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(agentName);
  const [availableAgents, setAvailableAgents] = useState<string[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [session, setSession] = useState<Session | undefined>();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [runner, setRunner] = useState<Runner | undefined>();

  const agentLoader = useRef(new AgentLoader());

  useEffect(() => {
    const initAgents = async () => {
      const availableAgents = await agentLoader.current.listAgents();
      setAvailableAgents(availableAgents);

      if (selectedAgent) {
        startNewSession(selectedAgent);
      }
    };

    initAgents();
  }, []);

  const selectAgent = useCallback((agentName: string) => {
    setSelectedAgent(agentName);
    startNewSession(agentName);
  }, []);

  const pushHistory = useCallback((item: HistoryItem) => setHistory(h => [...h, item]), []);

  const startNewSession = useCallback(async (agentName: string) => {
    const agent = await agentLoader.current.loadAgent(agentName);
    if (!agent) {
      setError(`Agent "${agentName}" not found.`);
      return;
    }

    const runner = new InMemoryRunner({
      agent: agent!,
      appName: agentName,
    });
    const session = await runner.sessionService.createSession({
      appName: agentName,
      userId,
    });

    setRunner(runner);
    setSession(session);
  }, []);

  const onUserMessage = useCallback(async (text: string) => {
    if (!runner || !session) {
      return;
    }
    
    setEvents(e => {
      if (e.length) {
        const lastEvent = e[e.length - 1];

        pushHistory({
          role: 'agent',
          authorName: selectedAgent,
          text: lastEvent.content?.parts[0].text,
          events: [...e],
        });
      }

      pushHistory({
        role: 'user',
        text,
        events: [],
      });

      return [];
    });
    setIsLoading(true);

    const runRequest = {
      userId,
      sessionId: session!.id,
      newMessage: {
        role: 'user',
        parts: [{ text }],
      },
    };
    for await (const event of runner.run(runRequest)) {
      setEvents((e) => [...e, event]);
    }

    setIsLoading(false);
  }, [runner, selectedAgent]);

  return (
    <KeyboardProvider>
      <Header/>
      <Box flexDirection="column">
        {error && <Text color="red">{error}</Text>}
        {session ?
          <AgentChat
            agentName={selectedAgent!}
            agentDescription={runner?.agent.description}
            events={events}
            history={history}
            isLoading={isLoading}
            onUserMessage={onUserMessage}
          /> :
          <AgentSelection
            agents={availableAgents}
            onSelect={selectAgent}
          />
        }
      </Box>
    </KeyboardProvider>
  );
};

interface AgentSelectionProps {
  agents: string[];
  onSelect: (agentName: string) => void;
}
const AgentSelection = ({agents, onSelect}: AgentSelectionProps) => {
  const [preselectedAgent, setPreselectedAgent] = useState<string | undefined>(agents[0]);
  const keyboardCtx = useContext(KeyboardContext);

  useEffect(() => {
    setPreselectedAgent(agents[0]);
  }, [agents]);

  useEffect(() => {
    if (!keyboardCtx) {
      return;
    }

    const handleKeypress = (key: Key) => {
      if (key.name === 'up' || key.name === 'down') {
        setPreselectedAgent((prev) => {
          if (!prev) {
            return agents[0];
          }
          const currentIndex = agents.indexOf(prev);
          let newIndex;
          if (key.name === 'up') {
            newIndex = (currentIndex - 1 + agents.length) % agents.length;
          } else {
            newIndex = (currentIndex + 1) % agents.length;
          }
          return agents[newIndex];
        });
      } else if (key.name === 'return' && preselectedAgent) {
        onSelect(preselectedAgent);
      }
    }

    keyboardCtx.subscribe(handleKeypress);

    return () => {
      keyboardCtx.unsubscribe(handleKeypress);
    }
  }, [keyboardCtx, preselectedAgent]);

  return <>
    <Text bold>Select agent to start:</Text>
    <Box flexDirection='column' borderStyle="round" borderColor="magenta">
      {agents.map(agent => (
        <Text key={agent} color={agent === preselectedAgent ? 'magenta' : 'blue'}>
          {agent === preselectedAgent ? '●' : ' '} {agent}
        </Text>
      ))}
    </Box>
  </>;
};

interface AgentChatProps {
  agentName: string;
  agentDescription?: string;
  history: HistoryItem[];
  events: Event[];
  isLoading: boolean;
  onUserMessage?: (message: string) => void;
}
const AgentChat = ({ agentName, agentDescription, events, history, isLoading, onUserMessage }: AgentChatProps) => {
  return (
    <>
      <Box flexDirection='column'>
        <Text>Agent: <Text bold>{agentName}</Text></Text>
        {agentDescription && <Text italic color="grey">{agentDescription}</Text>}
      </Box>
      <History history={history}/>
      <EventsSummary events={events} isLoading={isLoading}/>
      <PromptInput disabled={isLoading} onMessage={onUserMessage}/>
    </>
  );
}

interface HistoryItem {
  role: 'user' | 'agent';
  authorName?: string;
  text: string;
  events: Event[];
}
interface MessageHistoryProps {
  history: HistoryItem[];
}
const History = ({ history }: MessageHistoryProps) => {
  return <>
    {history.map(historyItem => {
      if (historyItem.role === 'user') {
        return (
          <Box marginTop={1} marginLeft={1} marginRight={1} flexDirection='column' borderStyle="round" borderColor="grey">
            <Text color="grey">&gt; {historyItem.text}</Text>
          </Box>
        );
      }

      return (
        <EventsSummary events={historyItem.events} history={true}/>
      );
    })}
  </>
};

interface EventsSummaryProps {
  events: Event[];
  isLoading?: boolean;
  history?: boolean;
}
const EventsSummary = ({ events, history, isLoading }: EventsSummaryProps) => {
  const summaries = useMemo(() => {
    const result = [];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const funcCalls = getFunctionCalls(e);
      const funcResponse = getFunctionResponses(e);

      if (funcCalls.length) {
        let isCallInProgress = true;
        for (let j = i + 1; j < events.length; j++) {
          const funcResponse = getFunctionResponses(events[j]);
          if (funcResponse.find((fr: {name: string}) => fr.name === funcCalls[0].name)) {
            isCallInProgress = false;
            break;
          }
        }

        result.push({
          type: 'tool_calling',
          name: funcCalls[0].name,
          isCallInProgress, 
        });
      }
      
      if (funcResponse.length) {
        result.push({
          type: 'tool_response',
          name: funcResponse[0].name,
        });
      }

      if (isFinalResponse(e) && e.content?.parts[0]?.text) {
        result.push({
          type: 'final_response',
          text: e.content.parts[0].text,
        });
      }
    }

    return result;
  }, [events]);

  if (!summaries.length && !isLoading) {
    return <></>;
  }

  return (
    <Box margin={1} marginLeft={2} marginBottom={0} flexDirection='column' borderStyle="round" borderColor={history ? "grey" : "magenta"}>
      <>
        {summaries.map((summary, index) => <Box marginTop={index > 0 ? 1 : 0}>
            {summary?.type === 'tool_calling' &&
            <Text>
              {summary.isCallInProgress ? <Text color="blue"><Spinner type="dots" />&#32;</Text> : <Text>⊷</Text>}
              <Text bold>&#32;{summary.name}:</Text>
              <Text>&#32;Calling tool</Text>
            </Text>}
            {summary?.type === 'tool_response' &&
            <>
              <Text color={history ? "grey" : "green"}>✓</Text>
              <Text bold>&#32;{summary.name}:</Text>
              <Text>&#32;Got response</Text>
            </>}
            {summary?.type === 'final_response' &&
            <>
              <Text color={history ? "grey" : "magenta"}>✦</Text>
              <Text>&#32;{summary.text}</Text>
            </>}
          </Box>)
        }
        {isLoading && <Box marginTop={summaries.length > 0 ? 1 : 0}>
          <Text color="blue"><Spinner type="dots"/>&#32;Generating</Text>
        </Box>}
      </>
    </Box>
  );
}

const CURSOR = '█';
const PLACEHOLDER = 'Type your message';
interface PromptInputProps {
  disabled: boolean;
  onMessage?: (message: string) => void;
}
const PromptInput = ({ disabled, onMessage }: PromptInputProps) => {
  const [value, setValue] = useState('');
  const keyboardCtx = useContext(KeyboardContext);

  useEffect(() => {
    if (!keyboardCtx) {
      return;
    }

    const handleKeypress = (key: Key) => {
      if (key.name === 'return' && onMessage && !disabled) {
        setValue((v) => {
          setValue('');
          onMessage(v);

          return v;
        });

        return;
      }

      if (key.name === 'backspace') {
        setValue((v) => v.slice(0, v.length - 1));

        return;
      }

      if (!key.char) {
        return;
      }

      setValue(v => v + key.char);
    };

    keyboardCtx.subscribe(handleKeypress);
    return () => {
      keyboardCtx.unsubscribe(handleKeypress);
    };
  }, [keyboardCtx, disabled, onMessage]);
 
  return (
    <Box margin={1} marginTop={2} flexDirection='column' borderStyle="round" borderColor="blue">
      { !value && <Text italic>&gt; {CURSOR} {PLACEHOLDER}</Text> }
      { value && <Text>&gt; {value}{CURSOR}</Text> }
    </Box>
  );
}

const ASCII_ART = `
                                 
   ░███     ░██████    ░███   ░██
  ░█████    ░███░░██   ░███  ░░██
 ░██░░░██   ░███░░░██   ░███ ░░██ 
 ░██  ░██   ░███░░░██   ░███ ░██
 ░███████   ░███░░░██   ░█████░  
 ░██░░░██   ░███░░░██   ░███░░██  
 ░██  ░██   ░███░░░██   ░███ ░░██ 
 ░██  ░██   ░███░░██   ░███░  ░██
 ░██  ░██   ░██████    ░███░ ░░██
 ░░░  ░░░   ░░░░░░░    ░░░░  ░░░░
`;
const Header = () => {
  return <Box marginBottom={1} flexDirection='column'>
    <Text italic bold>Welcome to ADK CLI</Text>
    {/* {ASCII_ART.split('\n').map(row => <Text color="magenta">{row}</Text>)} */}
  </Box>;
};