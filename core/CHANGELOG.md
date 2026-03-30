# Changelog

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
