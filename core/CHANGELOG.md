# Changelog

## [1.3.0](https://github.com/google/adk-js/compare/adk-v1.2.0...adk-v1.3.0) (2026-06-22)


### Features

* add --reload_agents flag to watch agent files for changes ([#304](https://github.com/google/adk-js/issues/304)) ([b420284](https://github.com/google/adk-js/commit/b420284079a3fd3e37f7e12ea74188a2c7b2bab4))
* **core:** Support Gemini 2.5 and 3.x Live Models in ADK JS ([#409](https://github.com/google/adk-js/issues/409)) ([92ca9d2](https://github.com/google/adk-js/commit/92ca9d292bdaff9795db63b0a540b0cc41cfc843))
* enable concurrent replacement with key deduplication ([#432](https://github.com/google/adk-js/issues/432)) ([98de23e](https://github.com/google/adk-js/commit/98de23eb377c7c54b4dee216383b46aa850d7b71))
* introduce Skills Registry Core interface, Zip Extraction, and local Toolset caching fallbacks (PR 1) ([#422](https://github.com/google/adk-js/issues/422)) ([26ba26a](https://github.com/google/adk-js/commit/26ba26a12f893835b03eda55ea042b9261e40d3d))
* **openapi:** implement rest api tool (part 3) ([#386](https://github.com/google/adk-js/issues/386)) ([02e84dc](https://github.com/google/adk-js/commit/02e84dc24cad6057f4958af86b5c386fee9e1953))
* **openapi:** implement spec operation parser and auth handler (part 2) ([#385](https://github.com/google/adk-js/issues/385)) ([8adf05e](https://github.com/google/adk-js/commit/8adf05eedc31d6a9d32b9f5c8512258794cac551))
* **skills:** Dynamic SearchSkillsTool for LLM Agents (Skills Registry Part 3) ([#424](https://github.com/google/adk-js/issues/424)) ([a41c62c](https://github.com/google/adk-js/commit/a41c62c97d40bba86237021be4a49ab453a26e8b))
* **skills:** Remote GCP Skills Registry Integration & E2E Tests (Skills Registry Part 2) ([#423](https://github.com/google/adk-js/issues/423)) ([33401e8](https://github.com/google/adk-js/commit/33401e85077bd5dc9a816f0345948394ce67e14c))
* Use AuthPreprocessor in LlmAgent ([#444](https://github.com/google/adk-js/issues/444)) ([2ccb8b0](https://github.com/google/adk-js/commit/2ccb8b07b43eeabfa7cb82edd0850a86650ee136))


### Bug Fixes

* Filter temporary state keys on session creation in TS ADK ([#406](https://github.com/google/adk-js/issues/406)) ([04968b7](https://github.com/google/adk-js/commit/04968b734e44600a847239f103864e4c404d97c3))
* Fix state mutation bad practice in content_processor_utils.ts ([#430](https://github.com/google/adk-js/issues/430)) ([7f2037e](https://github.com/google/adk-js/commit/7f2037e72d1bfb913a43879f54b21d4fbc6e878c))
* keep session event keys mysql index-safe ([#437](https://github.com/google/adk-js/issues/437)) ([7956766](https://github.com/google/adk-js/commit/7956766dcaa815977da5783f2e296a1d75164fd8))
* replace any with proper AuthConfig type in EventActions ([#405](https://github.com/google/adk-js/issues/405)) ([4172398](https://github.com/google/adk-js/commit/417239854cbae63650f63e0e3ad02fa34f433401))
* resolve infinite loop when combining outputSchema and tools also added unit tests ([#412](https://github.com/google/adk-js/issues/412)) ([deaeffe](https://github.com/google/adk-js/commit/deaeffe15619aac5e1a615c2730501a01e45f907))
* **streaming:** prevent prototype pollution via model-controlled JSON path ([#410](https://github.com/google/adk-js/issues/410)) ([9008353](https://github.com/google/adk-js/commit/9008353e6d81e086dc778df67189ee193b440ab7))
* **streaming:** suppress trailing empty STOP chunks with zero parts in SSE streaming ([#426](https://github.com/google/adk-js/issues/426)) ([c95cb9b](https://github.com/google/adk-js/commit/c95cb9b6534eb6ce606cd7a1d075ccd2a5adf391))

## [1.2.0](https://github.com/google/adk-js/compare/adk-v1.1.0...adk-v1.2.0) (2026-06-02)


### Features

* abort agent execution on HTTP connection disconnected ([#382](https://github.com/google/adk-js/issues/382)) ([e7776cc](https://github.com/google/adk-js/commit/e7776ccbfbeb7657c0f0a3411173ae9bbf2ec0dd))
* add pagination and sorting to listSessions ([#331](https://github.com/google/adk-js/issues/331)) ([ed9b72b](https://github.com/google/adk-js/commit/ed9b72bed42b2661e1f43be6aee70f65c1433520))
* add VertexRagRetrievalTool for Vertex AI RAG Engine grounding ([#277](https://github.com/google/adk-js/issues/277)) ([14f5f17](https://github.com/google/adk-js/commit/14f5f17c1572c156574b4e0deafdae932d305d63))
* Agent Engine Sandbox Code Executor ([#317](https://github.com/google/adk-js/issues/317)) ([1138e3c](https://github.com/google/adk-js/commit/1138e3cf8f9436801c82cf74e0cf928dae97ff3c))
* Google maps tool ([#321](https://github.com/google/adk-js/issues/321)) ([d2b4e91](https://github.com/google/adk-js/commit/d2b4e91ac7720f90eb41f458587ef50d60bb532a))
* Implement customMetadata support in runAsync and runEphemeral. ([#363](https://github.com/google/adk-js/issues/363)) ([faa458e](https://github.com/google/adk-js/commit/faa458e2487125d45882013ac6d4652a9f65438b))
* Implement the Agent Registry in adk-js ([#358](https://github.com/google/adk-js/issues/358)) ([27e5a92](https://github.com/google/adk-js/commit/27e5a92e6dcd86260e30119c68934ff62c3dc377))
* **memory:** implement Vertex AI Memory Bank service with tests ([#291](https://github.com/google/adk-js/issues/291)) ([3d82451](https://github.com/google/adk-js/commit/3d82451d68fdd35f2e3cc1938df06600ba5b6d95))
* **openapi:** implement auth helpers and credential exchangers (part 1) ([#384](https://github.com/google/adk-js/issues/384)) ([86f794e](https://github.com/google/adk-js/commit/86f794e986310cad433ee59a0d6b754827362528))


### Bug Fixes

* apply toolFilter in MCPToolset.getTools() ([#312](https://github.com/google/adk-js/issues/312)) ([#313](https://github.com/google/adk-js/issues/313)) ([3cdc1fb](https://github.com/google/adk-js/commit/3cdc1fbd043a1eef6faf6b2f754eb18d4176ba7b))
* **auth/oauth2:** block SSRF via IPv4-mapped IPv6 and fix dead 172.16/12 check ([#354](https://github.com/google/adk-js/issues/354)) ([57b0af7](https://github.com/google/adk-js/commit/57b0af76f8abefaaedd130a9c1c9ba3b4b625daf))
* **core:** wrap array responses in function tools to comply with Gemini API ([#347](https://github.com/google/adk-js/issues/347)) ([af115b6](https://github.com/google/adk-js/commit/af115b61ddda67b89b7268b15ac50c778c200d75))
* do not propagate skipSummarization to parent EventActions in AgentTool ([#301](https://github.com/google/adk-js/issues/301)) ([b3eb611](https://github.com/google/adk-js/commit/b3eb6112e96a0a7d55c9ff209db4769aef500c4a)), closes [#288](https://github.com/google/adk-js/issues/288)
* filter temp: keys from sub-agent state delta in AgentTool ([#271](https://github.com/google/adk-js/issues/271)) ([db1128b](https://github.com/google/adk-js/commit/db1128bc64aadb8ebdc09a7803480df76256be11))
* filter thought parts in stringifyContent and AgentTool merged text ([#323](https://github.com/google/adk-js/issues/323)) ([58dac0b](https://github.com/google/adk-js/commit/58dac0b3f2618e3fad49961464d90c7e850acf37))
* handle undefined type in toGeminiSchema for enum/const-only schemas ([#370](https://github.com/google/adk-js/issues/370)) ([69f35b4](https://github.com/google/adk-js/commit/69f35b4731f44582d7fd5f95eb7d94cf3d7cfe71))
* **mcp_toolset:** Implement close session method  ([#394](https://github.com/google/adk-js/issues/394)) ([4e3faa9](https://github.com/google/adk-js/commit/4e3faa98d77c9610caa7d12aec3a20e019b7d7f3))
* **mcp:** close MCP client session after listTools/callTool to fix Windows libuv assertion and process leak ([#333](https://github.com/google/adk-js/issues/333)) ([dd5584a](https://github.com/google/adk-js/commit/dd5584a69724dc8aeb7c600d21a71c1f8207accd))
* StreamingResponseAggregator.close() drops final event when last chunk has no candidates ([#289](https://github.com/google/adk-js/issues/289)) ([#311](https://github.com/google/adk-js/issues/311)) ([30ba5c8](https://github.com/google/adk-js/commit/30ba5c866229cca2fa69fb292f571e63c501e4c8))
* **streaming:** suppress empty STOP chunks and preserve tool calls in SSE session history ([#395](https://github.com/google/adk-js/issues/395)) ([e9e0fe6](https://github.com/google/adk-js/commit/e9e0fe62c8c75cea312612be9a8ee42289b13a36))

## [1.1.0](https://github.com/google/adk-js/compare/adk-v1.0.0...adk-v1.1.0) (2026-04-28)


### Features

* add UrlContextTool for Gemini 2+ URL context grounding ([#303](https://github.com/google/adk-js/issues/303)) ([5c37ccf](https://github.com/google/adk-js/commit/5c37ccf53499ee9130e595051f15a31cef97a32b)), closes [#282](https://github.com/google/adk-js/issues/282)
* Vertex AI Search Tool ([#296](https://github.com/google/adk-js/issues/296)) ([c06fd03](https://github.com/google/adk-js/commit/c06fd03102f01304b32b1c2aec6a550d0963e6bd))


### Bug Fixes

* fix adk web ui source code serving path ([#309](https://github.com/google/adk-js/issues/309)) ([b92c238](https://github.com/google/adk-js/commit/b92c2387622cedec880227ed6a6af4b5559d43e3))
* **mcp:** strip prefix during tool execution ([#299](https://github.com/google/adk-js/issues/299)) ([6f7146b](https://github.com/google/adk-js/commit/6f7146ba6595cd3eb69ff9cdbd04ca9b3f6c26a5))
* use getOrCreateSession in AgentTool to allow reuse within the same session ([#302](https://github.com/google/adk-js/issues/302)) ([5920ea5](https://github.com/google/adk-js/commit/5920ea59bef0b51cd13f89ea76203027e9fe4301)), closes [#294](https://github.com/google/adk-js/issues/294)

## [1.0.0](https://github.com/google/adk-js/compare/adk-v0.6.1...adk-v1.0.0) (2026-04-21)


### Features

* add Agent type alias for LlmAgent to keep parity with Python ADK. ([#242](https://github.com/google/adk-js/issues/242)) ([03da958](https://github.com/google/adk-js/commit/03da95820efb5cdbca045f0621f15c5a60efe2ea))
* add auth preprocessor and update auth handler. ([#227](https://github.com/google/adk-js/issues/227)) ([e94c181](https://github.com/google/adk-js/commit/e94c181d50760b47dde5b2302a385f7c35cbe34e))
* add auth related base classes ([#223](https://github.com/google/adk-js/issues/223)) ([a87ed8e](https://github.com/google/adk-js/commit/a87ed8e0215e4eb654d000cd2ce6b763ab9b7b6b))
* add progressive model streaming processing ([#258](https://github.com/google/adk-js/issues/258)) ([93d551b](https://github.com/google/adk-js/commit/93d551b488427e7d124636141cd012fd2ce6a8b6))
* oauth support: add oauth2 related classes ([#225](https://github.com/google/adk-js/issues/225)) ([d2b7dcb](https://github.com/google/adk-js/commit/d2b7dcb80c9c501a96630582a02191cc55aafcca))
* Plugin callbacks for context compaction and tool selection ([#250](https://github.com/google/adk-js/issues/250)) ([3deda16](https://github.com/google/adk-js/commit/3deda167a6b2e9fd465142ed718db96a0f20d446))
* RoutedAgent and RoutedLlm ([#215](https://github.com/google/adk-js/issues/215)) ([1083301](https://github.com/google/adk-js/commit/10833019afafa3e0993af3f3f9fe87c3728ac08d))
* skills: add skills toolset (part 2) ([#252](https://github.com/google/adk-js/issues/252)) ([6869e23](https://github.com/google/adk-js/commit/6869e2336db6aa80d96ac87e444e6c657480d9e7))
* skills: define skills interface ([#251](https://github.com/google/adk-js/issues/251)) ([e8b2cae](https://github.com/google/adk-js/commit/e8b2caeb219de7d84e1a9e399a52fe19cb9c70c9))
* skills: loader (part 3) ([#256](https://github.com/google/adk-js/issues/256)) ([a4d2858](https://github.com/google/adk-js/commit/a4d2858a7a8f2e87bd7e0f10d8988fc08c350824))
* skills: support script execution ([#276](https://github.com/google/adk-js/issues/276)) ([8d5cc0a](https://github.com/google/adk-js/commit/8d5cc0ac347f96a5362fcf85d445efd1c04eccae))
* support abort parameter in runner, agent, model, tool and processors ([#234](https://github.com/google/adk-js/issues/234)) ([1614f36](https://github.com/google/adk-js/commit/1614f36c77967ff064a52ff2ee89be0a5c6b5cb4))
* unsafe local code executor ([#257](https://github.com/google/adk-js/issues/257)) ([ce5bde9](https://github.com/google/adk-js/commit/ce5bde9c37635f01a67b137354d32aa5d1ea4650))


### Bug Fixes

* add client url to support custom url options for DB connection. ([#284](https://github.com/google/adk-js/issues/284)) ([bf8fade](https://github.com/google/adk-js/commit/bf8fadefb764e2ea22f9bc022b6e437ce8020873))
* add missing invocation id when creating new ADK event while merging parallel tool responses. ([#253](https://github.com/google/adk-js/issues/253)) ([7739bd8](https://github.com/google/adk-js/commit/7739bd8b79ef38fc65fb06495043318c3f287f40))
* move otel dependencies from dev deps to deps ([#243](https://github.com/google/adk-js/issues/243)) ([9622da6](https://github.com/google/adk-js/commit/9622da610f394c3cb4a93432ea1d9a9391000947))
* propagate thoughtSignature to concurrent function calls in streaming ([#268](https://github.com/google/adk-js/issues/268)) ([8cd6360](https://github.com/google/adk-js/commit/8cd6360eea2a38fd3acdcfc8b73c7491d28bc75a))
* support dynamic requre in esm builds ([#244](https://github.com/google/adk-js/issues/244)) ([fecbdd3](https://github.com/google/adk-js/commit/fecbdd351552fbacf2db1d6174920e76ddc56a53))


### Miscellaneous Chores

* release 1.0.0 ([84f886e](https://github.com/google/adk-js/commit/84f886e1ac8b3e9a7807a184257444fd0b15e1af))

## [0.6.1](https://github.com/google/adk-js/compare/adk-v0.6.0...adk-v0.6.1) (2026-03-30)


### Bug Fixes

* add support for MCP type array instead of string only in gemini_schema_util ([#199](https://github.com/google/adk-js/issues/199)) ([9cb4a33](https://github.com/google/adk-js/commit/9cb4a33b9a15718e97cbda532a04f1e91c45389e))

## [0.6.0](https://github.com/google/adk-js/compare/adk-v0.5.0...adk-v0.6.0) (2026-03-23)


### Features

* A2A integration: A2A Remote agent ([#190](https://github.com/google/adk-js/issues/190)) ([c6b75a2](https://github.com/google/adk-js/commit/c6b75a29683b0bbac98e1e17d811aa958025a11a))
* A2A integration: Add CLI option and serve ADK agents via A2A ([#188](https://github.com/google/adk-js/issues/188)) ([3897ee9](https://github.com/google/adk-js/commit/3897ee99df7122b57e4ff2c29b3f6806d6cb1ff4))
* A2A integration: add toA2a util function ([#205](https://github.com/google/adk-js/issues/205)) ([b7043ab](https://github.com/google/adk-js/commit/b7043abd2cc5193deb95bdad5cc347d04d56d87d))
* Implement LoadMemoryTool and add tests. ([#201](https://github.com/google/adk-js/issues/201)) ([eac351f](https://github.com/google/adk-js/commit/eac351ff50637505cfbb7e53fc9ecd38060984cd))
* LoadArtifactsTool ([#200](https://github.com/google/adk-js/issues/200)) ([b5eebdd](https://github.com/google/adk-js/commit/b5eebddeab086a868cadba0a8fd54459865bfbe9))
* Preload memory tool ([#203](https://github.com/google/adk-js/issues/203)) ([5e0dfa1](https://github.com/google/adk-js/commit/5e0dfa1d22a1101a38999b651482013c03e0dacd))
* token-based context compaction ([#191](https://github.com/google/adk-js/issues/191)) ([ad24580](https://github.com/google/adk-js/commit/ad24580797ddf09e90376c9f677bfd22d8a3c1cf))


### Bug Fixes

* a2a integration: use right enum values for agent card transport types. ([#212](https://github.com/google/adk-js/issues/212)) ([b00cef7](https://github.com/google/adk-js/commit/b00cef76734c9730fb186dfd8e57ca22d357411a))
* a2a support videometadata during part convertion ([#198](https://github.com/google/adk-js/issues/198)) ([7b36f48](https://github.com/google/adk-js/commit/7b36f4809fc5f46fbb1bbdf1a164eb6e6691edfd))
* persist session state correctly to not lose prev data. ([#209](https://github.com/google/adk-js/issues/209)) ([dbfa367](https://github.com/google/adk-js/commit/dbfa367fb34deaf246fdeea6ec45cd87d4adbdc4))
* prevent path traversal in FileArtifactService (CWE-22) ([#210](https://github.com/google/adk-js/issues/210)) ([8c0eaa1](https://github.com/google/adk-js/commit/8c0eaa160a43c1d791d5838a5de6ac87d905cf70))
* Print error message when port for ADK API server already in use ([#207](https://github.com/google/adk-js/issues/207)) ([8164857](https://github.com/google/adk-js/commit/816485786940daefded405731fe776170df80efb))
* stop droping all existing tables in schema during sesstion db initialisation ([#195](https://github.com/google/adk-js/issues/195)) ([40a9f14](https://github.com/google/adk-js/commit/40a9f14a660214114505da31105f432353514fa1))
* use llmAgent instruction when root agent is not llmAgent ([#208](https://github.com/google/adk-js/issues/208)) ([b3c677c](https://github.com/google/adk-js/commit/b3c677c0c946e7f0b44eb8d6c4c9a51e61649d51))

## [0.5.0](https://github.com/google/adk-js/compare/adk-v0.4.0...adk-v0.5.0) (2026-03-09)


### Features

* Add ability to prefix toolsets to avoid tool name conflicts ([#184](https://github.com/google/adk-js/issues/184)) ([95837b2](https://github.com/google/adk-js/commit/95837b2d6e89a3455f104c352c5ef7e9077b989a))
* implement ExitLoopTool similar to Python and Java ADK equivalent ([#170](https://github.com/google/adk-js/issues/170)) ([258998f](https://github.com/google/adk-js/commit/258998f7fbd086e2c6ecf894e15576f8a94481d4))
* integrate with ADK conformance tests ([#168](https://github.com/google/adk-js/issues/168)) ([3a7c012](https://github.com/google/adk-js/commit/3a7c012e035f665dbf200640c10caa6e6dd82aa3))


### Bug Fixes

* Lazy load MikroORM drivers to avoid errors when not used. ([#183](https://github.com/google/adk-js/issues/183)) ([9cb726f](https://github.com/google/adk-js/commit/9cb726ffc23d5da79f46605af11e3a4765dec3c0))

## [0.4.0](https://github.com/google/adk-js/compare/adk-v0.3.0...adk-v0.4.0) (2026-02-25)

### Features

- Add ApigeeLlm to the typescript ADK ([#125](https://github.com/google/adk-js/issues/125)) ([9e42b25](https://github.com/google/adk-js/commit/9e42b257d10117b4900374b257029ec6572eca0e))
- add database session service ([b3c38fe](https://github.com/google/adk-js/commit/b3c38feeb006cf40d0c7b71abe3afd052febb9b1))
- flip ADK CLI to be ESM native instead of CommonJS. ([#113](https://github.com/google/adk-js/issues/113)) ([1eb443e](https://github.com/google/adk-js/commit/1eb443eff054bde1aa9e85faaeb08de902620991))

### Bug Fixes

- use isBaseTool | isLlmAgent instead of instanceof keyword. ([#116](https://github.com/google/adk-js/issues/116)) ([cc4d67b](https://github.com/google/adk-js/commit/cc4d67ba2f69932030b03efea2c9186680028cb8))

## [0.3.0](https://github.com/google/adk-js/compare/adk-v0.2.5...adk-v0.3.0) (2026-01-30)

### Features

- add setLogger() for custom logger support ([#96](https://github.com/google/adk-js/issues/96)) ([7e96728](https://github.com/google/adk-js/commit/7e967282757ed66f5a9f45a6ba0b2abbed78856f))
- Add headers option for MCP Session manager and deprecate the header option. ([#98](https://github.com/google/adk-js/issues/98)) ([c28aae3](https://github.com/google/adk-js/commit/c28aae311948522cc769a8346b3e2af3653fcf46))
- support Zod v3 and v4. ([#46](https://github.com/google/adk-js/issues/46)) ([accb7ca](https://github.com/google/adk-js/commit/accb7ca3bdec1295c81a4966177a2d5ed1103313))

### Bug Fixes

- use getter for rootAgent to match Python SDK behavior ([#95](https://github.com/google/adk-js/issues/95)) ([23b1d7f](https://github.com/google/adk-js/commit/23b1d7f27ce8175ecf0ca14f2c974234fca0ae7d))

## [0.2.5](https://github.com/google/adk-js/compare/v0.2.4...adk-v0.2.5) (2026-01-28)

### Bug Fixes

- handle empty MCP schema types during Gemini conversion ([345d16b](https://github.com/google/adk-js/commit/345d16b))
- Fix bug when ADK web server crashes on agent graph generation ([3c7f28e](https://github.com/google/adk-js/commit/3c7f28e))

### Changed

- Update the test as per review to use toEqual ([5680f93](https://github.com/google/adk-js/commit/5680f93))
- Stop using `instanceof` operator and replace it with a type guard function to check for class instances ([1921e54](https://github.com/google/adk-js/commit/1921e54))

### Miscellaneous Chores

- support release-please for release automation ([2c55c5d](https://github.com/google/adk-js/commit/2c55c5d))
- Fix doctype warning during doc generation ([5bb216f](https://github.com/google/adk-js/commit/5bb216f))
- Bump lodash-es in the npm_and_yarn group ([af195be](https://github.com/google/adk-js/commit/af195be))
- Generate docs for the @google/adk-js package using TypeDoc ([3fd2f35](https://github.com/google/adk-js/commit/3fd2f35))

## [0.2.4](https://github.com/google/adk-js/compare/v0.2.3...v0.2.4) 2026-01-16

### Bug Fixes

- Fix runtime error `TypeError: (0 , import_cloneDeep.default) is not a function` for commonjs setup ([533ede7](https://github.com/google/adk-js/commit/533ede7))
- Move the assign of the built-in code executor under the supportCfc if condition ([7758d58](https://github.com/google/adk-js/commit/7758d58))

### Changed

- Bump version of google/genai dependency ([587b7f3](https://github.com/google/adk-js/commit/587b7f3))

## [0.2.3](https://github.com/google/adk-js/compare/v0.2.2...v0.2.3) - 2026-01-15

### Features

- Support Gemini 3 models for BuiltInCodeExecutor ([3bef09e](https://github.com/google/adk-js/commit/3bef09e))

## [0.2.2](https://github.com/google/adk-js/compare/v0.2.1...v0.2.2) - 2026-01-08

### Features

- Integrate code executor to LlmAgent ([9165450](https://github.com/google/adk-js/commit/9165450))
- Expose new function to identify if the given class a ADK BaseAgent instance or not ([4bded65](https://github.com/google/adk-js/commit/4bded65))
- Add a type guard for BaseLlm ([76be5ca](https://github.com/google/adk-js/commit/76be5ca))

### Bug Fixes

- Agent transfer mechanism ([5fa1877](https://github.com/google/adk-js/commit/5fa1877))
- Improve error message for missing appName in runner ([6b9a340](https://github.com/google/adk-js/commit/6b9a340))
- proper type inference to functional tool parameters to auto type inference ([0afb8f3](https://github.com/google/adk-js/commit/0afb8f3))
- StreamableHTTP header parameter passing in MCPSessionManager ([81bffbc](https://github.com/google/adk-js/commit/81bffbc))
- gracefully handle nullable or unknown types ([601f924](https://github.com/google/adk-js/commit/601f924))
- Fix CI build ([1dbca9e](https://github.com/google/adk-js/commit/1dbca9e))
- Fix CI tests ([e9e1dd2](https://github.com/google/adk-js/commit/e9e1dd2))

## [0.2.1](https://github.com/google/adk-js/compare/v0.2.0...v0.2.1) - 2025-12-16

### Changed

- Simplify package READMEs ([4f2d5f4](https://github.com/google/adk-js/commit/4f2d5f4))

## [0.2.0](https://github.com/google/adk-js/compare/v0.1.3...v0.2.0) - 2025-12-15

### Features

- Integrate OpenTelemetry (OTel) support ([9a1d9b5](https://github.com/google/adk-js/commit/9a1d9b5))

### Changed

- Move core dependencies to `dependencies` in package.json ([5338182](https://github.com/google/adk-js/commit/5338182))
- Move request labeling to base LLM and add support for agent engine telemetry ([d11fd1d](https://github.com/google/adk-js/commit/d11fd1d))

### Miscellaneous Chores

- update Gen AI SDK ([7ce74cd](https://github.com/google/adk-js/commit/7ce74cd))

## [0.1.3] - 2025-11-05

### Features

- Add GCS artifact service ([c1f901c](https://github.com/google/adk-js/commit/c1f901c))
- Export Gemini and GeminiParams ([e7d50e3](https://github.com/google/adk-js/commit/e7d50e3))
- Support long running tool ([814c654](https://github.com/google/adk-js/commit/814c654))
- Enable code execution ([cc93abc](https://github.com/google/adk-js/commit/cc93abc))
- Enable thinking_config for Gemini ([d348fd6](https://github.com/google/adk-js/commit/d348fd6))
- Add esbuild to bundle the source code for different targets ([9abc793](https://github.com/google/adk-js/commit/9abc793))

### Bug Fixes

- Update BaseLlm constructor to use a parameter object ([dee0f50](https://github.com/google/adk-js/commit/dee0f50))
- Handle error during the tool execution ([6158083](https://github.com/google/adk-js/commit/6158083))
- fix toGeminiSchema ([37d00cb](https://github.com/google/adk-js/commit/37d00cb))
- Fix error when calling `event.isFinalResponse()` ([153ad89](https://github.com/google/adk-js/commit/153ad89))

### Changed

- Make `createEventActions` part of public API ([633af65](https://github.com/google/adk-js/commit/633af65))
- Make RunConfig as interface ([0b85aba](https://github.com/google/adk-js/commit/0b85aba))
- Unify import signature as import from @google/adk ([2371b12](https://github.com/google/adk-js/commit/2371b12))
- Refactor build process using a dedicated build script ([941c0e6](https://github.com/google/adk-js/commit/941c0e6))
- Rename methods to remove the "Async" suffix ([df8ebab](https://github.com/google/adk-js/commit/df8ebab))
- Make LlmResponse as interface ([6e5f035](https://github.com/google/adk-js/commit/6e5f035))
- Split entrypoints based on targets (web, node) ([6d485fc](https://github.com/google/adk-js/commit/6d485fc))
