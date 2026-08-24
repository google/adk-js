/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ParityCase} from '../harness/types.ts';

export const CONTEXT_CASES: ParityCase[] = [
  {
    id: 'context_history_management',
    family: 'context_management',
    pySample: 'context_management/history_management',
    tsAgent: 'context_management/history_management',
    // The message sequence from the sample's own main.py. Four turns matter:
    // the window is two user turns wide, so by turn four the first roll has
    // fallen out of the request and "What numbers did I got?" can only be
    // answered from what is left.
    queries: [
      'Hi',
      'Roll a die with 100 sides',
      'Roll a die again with 100 sides.',
      'What numbers did I got?',
    ],
    // The rolls are random on both sides, so the stored rolls never match.
    volatileStateKeys: ['rolls'],
    note:
      'The sample trims history by hand in a before_model_callback rather' +
      ' than through any framework feature, and `llmRequest.contents` is' +
      ' mutable in both runtimes, so the port is direct. adk-js additionally' +
      ' offers declarative compaction that adk-python has no counterpart' +
      ' for (`LlmAgent.contextCompactors` with TruncatingContextCompactor /' +
      ' TokenBasedContextCompactor / AnchoredContextCompactor /' +
      ' AgentControlledContextCompactor); adk-python configures compaction' +
      ' at the App level instead (`App.events_compaction_config`), which' +
      ' adk-js `AppOptions` does not have.',
  },
  {
    id: 'context_memory',
    family: 'context_management',
    pySample: 'context_management/memory',
    tsAgent: 'context_management/memory',
    // main.py builds one session of facts, saves it to memory, then opens a
    // second session to recall from it. A replay file is a single session, so
    // the recall questions are asked in the same session that stated the
    // facts: what is compared is the memory tool wiring, not recall quality.
    queries: [
      'Hi',
      'My name is Jack',
      'I like badminton.',
      'What do I like to do?',
      'When did I say that?',
    ],
    // `_time` is stamped with the wall clock in before_agent_callback.
    volatileStateKeys: ['_time'],
    note:
      'Memory itself is at parity: adk-js exports InMemoryMemoryService,' +
      ' VertexAiMemoryBankService and the same two tool singletons' +
      ' (`LOAD_MEMORY`/`PRELOAD_MEMORY` for Python\u2019s `load_memory_tool`/' +
      '`preload_memory_tool`), and both `adk run` CLIs default to an' +
      ' in-memory memory service. The gap is the ingestion side: neither CLI' +
      ' calls `add_session_to_memory`, and adk-js `Runner` has no' +
      ' `add_session_to_memory`-style hook, so a replayed run searches an' +
      ' empty store on both sides. The comparison therefore covers the' +
      ' preload injection and the load_memory declaration/empty result, not' +
      ' cross-session recall.',
  },
  {
    id: 'context_session_state_agent',
    family: 'context_management',
    pySample: 'context_management/session_state_agent',
    tsAgent: 'context_management/session_state_agent',
    // Verbatim from the sample's own input.json, which its README tells you
    // to pass to `adk run --replay`.
    state: {},
    queries: ['hello world!'],
    note:
      'The sample is an executable assertion about *when* a state delta' +
      ' reaches the session service: after before_agent_callback, with the' +
      ' LlmResponse event for before_model/after_model, and after' +
      ' after_agent_callback. Both ports assert the same thing and both' +
      ' crash the run if the ordering differs, so a one-sided failure here' +
      ' is the finding.',
  },
  {
    id: 'context_static_instruction',
    family: 'context_management',
    pySample: 'context_management/static_instruction',
    // The hunger scenarios from the sample's main.py, minus the ones that
    // need a state_delta injected between turns.
    queries: [
      'Hi Bingo! I just got you as my new digital pet!',
      'Feed Bingo',
      'How are you feeling after that meal, Bingo?',
    ],
    skip: 'unsupported-in-ts',
    note:
      'adk-js `LlmAgent` has no `staticInstruction`. `LlmAgentConfig`' +
      ' (core/src/agents/llm_agent.ts) accepts only `instruction` and' +
      ' `globalInstruction`, both `string | InstructionProvider` \u2014 there' +
      ' is no `Content`-valued instruction field anywhere in `@google/adk`,' +
      ' and `grep -rn staticInstruction core/src` returns nothing.' +
      ' Python\u2019s `static_instruction=types.Content(...)` is what makes' +
      ' the cacheable prefix (system_instruction + tools + tool_config)' +
      ' stable while the dynamic instruction is appended to user contents;' +
      ' adk-js resolves its single instruction on every turn and always puts' +
      ' it in systemInstruction, so there is no way to split cacheable from' +
      ' per-turn instruction text. The dynamic half of the sample (an' +
      ' InstructionProvider reading `last_fed_timestamp` off state) does' +
      ' port \u2014 only the static half is missing, and it is the point of' +
      ' the sample.',
  },
  {
    id: 'context_rewind_session',
    family: 'context_management',
    pySample: 'context_management/rewind_session',
    tsAgent: 'context_management/rewind_session',
    // The message sequence from the sample's own main.py, up to the point
    // where it rewinds. Every tool result is deterministic.
    queries: [
      'set state `color` to red',
      'save artifact file1 with content version1',
      'what is the value of state `color`?',
      'load artifact file1',
      'update state key color to blue',
      'save artifact file1 with content version2',
      'what is the value of state key color?',
      'load artifact file1',
    ],
    note:
      'The rewind itself has no adk-js equivalent: adk-python exposes' +
      ' `Runner.rewind_async(user_id, session_id,' +
      ' rewind_before_invocation_id=...)`, and adk-js `Runner` has no rewind' +
      ' method (`grep -rn rewind core/src` is empty) \u2014 no session service' +
      ' truncates events back to an invocation id and no artifact versions' +
      ' are rolled back. Neither `adk run --replay` rewinds, so the case' +
      ' compares the state/artifact agent the sample is built on; the' +
      ' capability gap is the missing Runner API.',
  },
  {
    id: 'context_cache_analysis',
    family: 'context_management',
    pySample: 'context_management/cache_analysis',
    tsAgent: 'context_management/cache_analysis',
    // The README's own "Sample Inputs", minus the benchmark_performance one:
    // that tool fills its response with random.uniform/randint values, so it
    // could never match across two runs. analyze_data_patterns is
    // deterministic.
    queries: [
      'Hello, what can you do for me?',
      'What is artificial intelligence and how does it work in modern applications?',
      "Call analyze_data_patterns with data='premium customer engagement and conversion events for the last 30 days', analysis_type='trends'.",
    ],
    note:
      'The agent ports verbatim (4k+ token instruction, seven tools with' +
      ' their full docstrings) but the feature it demonstrates does not:' +
      ' adk-js has no `ContextCacheConfig` and no App-level cache at all' +
      ' (`AppOptions` is {name, rootAgent, plugins, resumabilityConfig}),' +
      ' nothing sets `cachedContent` on a request, and `LlmResponse` usage' +
      ' metadata is never read for `cachedContentTokenCount`. Note the' +
      ' Python side is not caching either: the sample exports both `app`' +
      ' (with the cache config) and `root_agent`, and this case\u2019s shim' +
      ' deliberately takes `root_agent` \u2014 so both runtimes run the same' +
      ' uncached agent and the cache config is recorded here as the gap,' +
      ' rather than comparing a cached run against an uncached one.',
  },
];
