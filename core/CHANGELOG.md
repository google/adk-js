# Changelog

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
