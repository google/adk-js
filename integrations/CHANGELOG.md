# Changelog

## [2.6.0](https://github.com/google/adk-js/compare/integrations-v2.5.0...integrations-v2.6.0) (2026-11-14)


### Features

* **integrations:** add WriteMode.PROTECTED to BigQuery execute_sql ([#1318](https://github.com/google/adk-js/issues/1318)) ([5389c26](https://github.com/google/adk-js/commit/5389c26dfdc8bda1f2866410fa2cc9217a041e03))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @google/adk bumped from ^2.5.0 to ^2.6.0

## [2.5.0](https://github.com/google/adk-js/compare/integrations-v2.4.0...integrations-v2.5.0) (2026-11-12)


### Features

* **integrations:** add AnthropicLlm for the Anthropic API and make Claude extend it ([#1140](https://github.com/google/adk-js/issues/1140)) ([53c6ba6](https://github.com/google/adk-js/commit/53c6ba6b767c7917365658f091756ffced0ea866))
* **integrations:** add BigQuery agent analytics plugin ([#1134](https://github.com/google/adk-js/issues/1134)) ([46d51d3](https://github.com/google/adk-js/commit/46d51d3f1414d37e38c98924879db9bea20a17e7))
* **integrations:** add BigQuery toolset to @google/adk-integrations ([#1193](https://github.com/google/adk-js/issues/1193)) ([d1afe11](https://github.com/google/adk-js/commit/d1afe11605eea1d6a03339f0609a4f50ef564381))
* **integrations:** add WriteMode and BigQueryToolConfig for BigQuery tools ([#1292](https://github.com/google/adk-js/issues/1292)) ([390b010](https://github.com/google/adk-js/commit/390b010b65c076c76b7f0e99832aa7633c97a184))
* **integrations:** support extended thinking on Claude and skip thought and empty parts ([#1160](https://github.com/google/adk-js/issues/1160)) ([fb66257](https://github.com/google/adk-js/commit/fb66257a976959ec14792989d42a4bceee81a5fe))
* port adk-python v1.1.1 changes to agents, auth, code_executors (+12 more) ([#1190](https://github.com/google/adk-js/issues/1190)) ([d22e6de](https://github.com/google/adk-js/commit/d22e6de31b4b2e7ec34cd77402b2e751e89b6fb1))
* port adk-python v1.2.1 changes to models and sessions ([#1196](https://github.com/google/adk-js/issues/1196)) ([5678529](https://github.com/google/adk-js/commit/5678529664a5793b122831f031889525822c3398))


### Bug Fixes

* **core:** invoke plugin beforeAgentCallback and afterAgentCallback ([#1137](https://github.com/google/adk-js/issues/1137)) ([2fea9df](https://github.com/google/adk-js/commit/2fea9dfd26b96e05292d4c6e228731cd67b11831))
* **integrations:** fix LangchainTool and CrewaiTool type compatibility and schema handling ([#1273](https://github.com/google/adk-js/issues/1273)) ([263cc0e](https://github.com/google/adk-js/commit/263cc0e2dc0d2f12be9964f6ec143ab2b5a0c72b))
* **integrations:** order browser export condition and types in package.json ([#1265](https://github.com/google/adk-js/issues/1265)) ([059a9f3](https://github.com/google/adk-js/commit/059a9f3f83c98d92497730ef65dee099a38305c8))
* **workflow:** wait for the runner to store node events (adk-python parity) ([#978](https://github.com/google/adk-js/issues/978)) ([a25cd30](https://github.com/google/adk-js/commit/a25cd300fd85b59ee02be0515ea8ef888f8cdebc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @google/adk bumped from ^2.4.0 to ^2.5.0

## [2.4.0](https://github.com/google/adk-js/compare/integrations-v2.3.0...integrations-v2.4.0) (2026-10-28)

### Features

- **integrations:** add the Claude model on Vertex AI ([#1125](https://github.com/google/adk-js/issues/1125)) ([f882b34](https://github.com/google/adk-js/commit/f882b34ad57d24e911324dcda124499cfb726381))

### Bug Fixes

- **integrations:** honor maxOutputTokens, set finishReason and sanitize tool ids on Claude ([#1139](https://github.com/google/adk-js/issues/1139)) ([cfb4764](https://github.com/google/adk-js/commit/cfb4764c1b51536ea39577abfe7dfd2e8df15a79))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^2.3.0 to ^2.4.0

## [2.3.0](https://github.com/google/adk-js/compare/integrations-v2.2.0...integrations-v2.3.0) (2026-10-13)

### Miscellaneous Chores

- **integrations:** Synchronize adk versions

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^2.2.0 to ^2.3.0

## [2.2.0](https://github.com/google/adk-js/compare/integrations-v2.1.0...integrations-v2.2.0) (2026-09-30)

### Miscellaneous Chores

- **integrations:** Synchronize adk versions

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^2.1.0 to ^2.2.0

## [2.1.0](https://github.com/google/adk-js/compare/integrations-v2.0.0...integrations-v2.1.0) (2026-09-14)

### Miscellaneous Chores

- **integrations:** Synchronize adk versions

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^2.0.0 to ^2.1.0

## [2.0.0](https://github.com/google/adk-js/compare/integrations-v1.6.0...integrations-v2.0.0) (2026-08-20)

### Bug Fixes

- resolve the browser export condition in core and integrations ([#618](https://github.com/google/adk-js/issues/618)) ([0f9f73d](https://github.com/google/adk-js/commit/0f9f73d4fc0577f1ed8d474451e53d4a2ca2f720))
- **skills:** materialize script output into a dedicated dir, not process.cwd() ([#620](https://github.com/google/adk-js/issues/620)) ([2ea08cf](https://github.com/google/adk-js/commit/2ea08cf8ba5fca65d678cdabecbf78713fee4106))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^1.6.0 to ^2.0.0

## [1.6.0](https://github.com/google/adk-js/compare/integrations-v1.5.0...integrations-v1.6.0) (2026-08-05)

### Miscellaneous Chores

- **integrations:** Synchronize adk versions

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^1.5.0 to ^1.6.0

## [1.5.0](https://github.com/google/adk-js/compare/integrations-v1.4.0...integrations-v1.5.0) (2026-07-29)

### Miscellaneous Chores

- **integrations:** Synchronize adk versions

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^1.4.0 to ^1.5.0

## [1.4.0](https://github.com/google/adk-js/compare/integrations-v1.3.0...integrations-v1.4.0) (2026-07-20)

### Features

- **integrations:** create new top-level integrations package ([#449](https://github.com/google/adk-js/issues/449)) ([a65d05f](https://github.com/google/adk-js/commit/a65d05fff901565b981f4f38d58b64fb1750812d))

### Miscellaneous Chores

- release 1.0.0 ([84f886e](https://github.com/google/adk-js/commit/84f886e1ac8b3e9a7807a184257444fd0b15e1af))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^1.3.0 to ^1.4.0
