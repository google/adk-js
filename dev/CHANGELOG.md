# Changelog

## [0.2.5](https://github.com/google/adk-js/compare/v0.2.4...devtools-v0.2.5) (2026-01-28)

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^0.2.4 to ^0.2.5

### Bug Fixes

- Fix bug when ADK web server crashes on agent graph generation ([3c7f28e](https://github.com/google/adk-js/commit/3c7f28e))

### Miscellaneous Chores

- support release-please for release automation ([2c55c5d](https://github.com/google/adk-js/commit/2c55c5d09f56b18f7adea61d0106c7f77112bde1))

## [0.2.4](https://github.com/google/adk-js/compare/v0.2.3...v0.2.4) - 2026-01-16

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^0.2.3 to ^0.2.4

## [0.2.3](https://github.com/google/adk-js/compare/devtools-v0.2.2...v0.2.3) - 2026-01-15

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^0.2.2 to ^0.2.3

## [0.2.2](https://github.com/google/adk-js/compare/devtools-v0.2.1...v0.2.2) - 2026-01-08

### Features

- Support -y, --yes options in the ADK CLI create command ([6afe042](https://github.com/google/adk-js/commit/6afe042))
- Add interactive CLI command for creating new agent projects with dependency setup ([d6686e8](https://github.com/google/adk-js/commit/d6686e8))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^0.2.1 to ^0.2.2

## [0.2.1](https://github.com/google/adk-js/compare/devtools-v0.2.0...v0.2.1) - 2025-12-16

### Changed

- Simplify package READMEs ([4f2d5f4](https://github.com/google/adk-js/commit/4f2d5f4))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^0.2.0 to ^0.2.1

## [0.2.0](https://github.com/google/adk-js/compare/devtools-v0.1.3...v0.2.0) - 2025-12-15

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^0.1.3 to ^0.2.0

## [0.1.3] - 2025-11-05

### Features

- Add `adk deploy cloud_run` command to deploy agents to Cloud Run ([9593a85](https://github.com/google/adk-js/commit/9593a85))
- Allow to serve individual files ([c776f88](https://github.com/google/adk-js/commit/c776f88))
- Move devtools build logic to a dedicated build.js script ([088765b](https://github.com/google/adk-js/commit/088765b))
- Add `adk run` command ([91b181d](https://github.com/google/adk-js/commit/91b181d))
- Add `adk api_server` command ([65208d9](https://github.com/google/adk-js/commit/65208d9))
- Implement agent graph server API endpoint ([4dcbeeb](https://github.com/google/adk-js/commit/4dcbeeb))

### Bug Fixes

- Fix tests in dev ([74586cc](https://github.com/google/adk-js/commit/74586cc))
- Fix cli server build issues ([31b9568](https://github.com/google/adk-js/commit/31b9568))

### Changed

- Changes the package name from `@google/adk_cli` to `@google/adk-devtools` ([a581404](https://github.com/google/adk-js/commit/a581404))
- Refactor Agent Loading and CLI Commands ([642251d](https://github.com/google/adk-js/commit/642251d))
- Refactor ADK dev server to use `cors` and built-in Express body parsers ([f35ede9](https://github.com/google/adk-js/commit/f35ede9))
- Rename methods to remove the "Async" suffix ([df8ebab](https://github.com/google/adk-js/commit/df8ebab))
- Add skeleton nodejs/express server + cli to run it ([2de5b16](https://github.com/google/adk-js/commit/2de5b16))
