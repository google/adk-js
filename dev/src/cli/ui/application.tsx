import React, { useState, useEffect, useCallback, useRef, useContext, use } from 'react';
import { useStdin, Text } from 'ink'
import Spinner from 'ink-spinner';
import { InMemoryRunner, Runner, Session } from '@google/adk';
import { AgentLoader } from '../../server/agent_loader.js';
import { KeyboardProvider, KeyboardContext } from './keyboard_context.js';

export interface ApplicationProps {
  agentName: string | undefined;
  userId: string;
}
export const Application = ({ agentName, userId }: ApplicationProps) => {
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(agentName);
  const [availableAgents, setAvailableAgents] = useState<string[]>([]);
  const [agentMesssages, setAgentMessages] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [session, setSession] = useState<Session | undefined>();
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

  const onUserMessage = useCallback(async (message: string) => {
    if (!runner || !session) {
      return;
    }
    
    setAgentMessages([]);
    setIsLoading(true);

    const runRequest = {
      userId,
      sessionId: session!.id,
      newMessage: {
        role: 'user',
        parts: [{ text: message }],
      },
    };
    for await (const event of runner.run(runRequest)) {
      const text = event.content?.parts?.[0]?.text;

      if (text) {
        setAgentMessages((msgs) => [...msgs, text]);
      }
    }

    setIsLoading(false);
  }, [runner]);

  return (
    <KeyboardProvider>
      {error && <Text color="red">{error}</Text>}
      {session ?
        <AgentChat
          agentName={selectedAgent!}
          session={session}
          agentMesssages={agentMesssages}
          isLoading={isLoading}
          onUserMessage={onUserMessage}
        /> :
        <AgentSelection
          agents={availableAgents}
          onSelect={setSelectedAgent}
        />
      }
    </KeyboardProvider>
  );
};

interface AgentSelectionProps {
  agents: string[];
  onSelect: (agentName: string) => void;
}
const AgentSelection = (props: AgentSelectionProps) => {
  const [preselectedAgent, setPreselectedAgent] = useState<string | null>(null);
  const keyboardCtx = useContext(KeyboardContext);

  useEffect(() => {
    if (!keyboardCtx) {
      return;
    }

    const handleKeypress = (key: { name: string }) => {
      if (key.name === 'up' || key.name === 'down') {
        setPreselectedAgent((prev) => {
          if (!prev) {
            return props.agents[0];
          }
          const currentIndex = props.agents.indexOf(prev);
          let newIndex;
          if (key.name === 'up') {
            newIndex = (currentIndex - 1 + props.agents.length) % props.agents.length;
          } else {
            newIndex = (currentIndex + 1) % props.agents.length;
          }
          return props.agents[newIndex];
        });
      } else if (key.name === 'return' && preselectedAgent) {
        props.onSelect(preselectedAgent);
      }
    }

    keyboardCtx.subscribe(handleKeypress);

    return () => {
      keyboardCtx.unsubscribe(handleKeypress);
    }
  }, [keyboardCtx]);

  return props.agents.map(agent => (
    <Text key={agent} color="green" backgroundColor={agent === preselectedAgent ? 'blue' : undefined}>
      {agent}
    </Text>
  ));
};

interface AgentChatProps {
  agentName: string;
  session: Session;
  agentMesssages: string[];
  isLoading: boolean;
  onUserMessage?: (message: string) => void;
}
const AgentChat = ({ agentName, agentMesssages, isLoading, onUserMessage }: AgentChatProps) => {
  return (
    <>
      <Text>
        <Text color="green">
          <Spinner type="dots" />
        </Text>
        {agentName}
      </Text>
      {agentMesssages.map((msg, idx) => (
        <Text key={idx}>{msg}</Text>
      ))}

      <PromptInput disabled={isLoading} onMessage={onUserMessage}/>
    </>
  );
}

interface PromptInputProps {
  disabled: boolean;
  onMessage?: (message: string) => void;
}
const PromptInput = ({ disabled, onMessage }: PromptInputProps) => {
  return (
    <Text>&gt; </Text>
  );
}