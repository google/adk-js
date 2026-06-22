# Changelog

## [1.3.0](https://github.com/google/adk-js/compare/devtools-v1.2.0...devtools-v1.3.0) (2026-06-22)


### Features

* add --reload_agents flag to watch agent files for changes ([#304](https://github.com/google/adk-js/issues/304)) ([b420284](https://github.com/google/adk-js/commit/b420284079a3fd3e37f7e12ea74188a2c7b2bab4))
* **cli:** deploy agent engine to Artifact Registry instead of GCR (Agent Engine Deployment Artifact registry fix part 2) ([#441](https://github.com/google/adk-js/issues/441)) ([92ceb87](https://github.com/google/adk-js/commit/92ceb87777647fbae2145655fa487a527fa7d5ee))
* **devtools:** add Reasoning Engine server compatibility routes and headers parser (Agent Engine Deployment Artifact registry fix part 1) ([#440](https://github.com/google/adk-js/issues/440)) ([fd94e49](https://github.com/google/adk-js/commit/fd94e49071ff41869b24bf2db92f4484ab84606d))
* download ADK Web assets dynamically and serve from shared folder ([#427](https://github.com/google/adk-js/issues/427)) ([b8ee5d8](https://github.com/google/adk-js/commit/b8ee5d81d158f6acdb8b6a343203bdf27e27ff9d))


### Bug Fixes

* update default server port from 8000 to 8080 ([#439](https://github.com/google/adk-js/issues/439)) ([9f03632](https://github.com/google/adk-js/commit/9f03632e458d51a14e44ae17031a609c5a875cc8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @google/adk bumped from ^1.2.0 to ^1.3.0

## [1.2.0](https://github.com/google/adk-js/compare/devtools-v1.1.0...devtools-v1.2.0) (2026-06-02)


### Features

* abort agent execution on HTTP connection disconnected ([#382](https://github.com/google/adk-js/issues/382)) ([e7776cc](https://github.com/google/adk-js/commit/e7776ccbfbeb7657c0f0a3411173ae9bbf2ec0dd))
* Add Agent Engine deployment support ([#335](https://github.com/google/adk-js/issues/335)) ([3e901a5](https://github.com/google/adk-js/commit/3e901a5b2d4c291628c9f88f223803a7e9269531))


### Bug Fixes

* mark lightningcss and jiti as external in agent_loader esbuild to fix adk web on missing optional deps ([#319](https://github.com/google/adk-js/issues/319)) ([ab625c9](https://github.com/google/adk-js/commit/ab625c9e29a4385f474df6bc5fd2426f96aea41e))
* remove hardcoded Access-Control-Allow-Origin wildcard from run_sse ([#360](https://github.com/google/adk-js/issues/360)) ([d2db989](https://github.com/google/adk-js/commit/d2db989334f85b5fd00039364bd0754ae1691bab))
* replace unix cp with node.js fs.cp in dev/build.js for windows compatibility ([#318](https://github.com/google/adk-js/issues/318)) ([53ee7eb](https://github.com/google/adk-js/commit/53ee7eb0f301b8bf617afb4cf7b0e9b1d7f8c9a9))
* Resolve CORS vulnerability by disabling express.urlencoded parser ([#378](https://github.com/google/adk-js/issues/378)) ([1fe631f](https://github.com/google/adk-js/commit/1fe631f55a730aee2e4141f3dd7b6e8e9f756b86))
* **server:** restrict AdkApiServer to listen on configured host ([#383](https://github.com/google/adk-js/issues/383)) ([7be8c81](https://github.com/google/adk-js/commit/7be8c8145a6ff37f5f3863b254f374b2c7072c18))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @google/adk bumped from ^1.1.0 to ^1.2.0

## [1.1.0](https://github.com/google/adk-js/compare/devtools-v1.0.0...devtools-v1.1.0) (2026-04-28)


### Bug Fixes

* fix adk web ui source code serving path ([#309](https://github.com/google/adk-js/issues/309)) ([b92c238](https://github.com/google/adk-js/commit/b92c2387622cedec880227ed6a6af4b5559d43e3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @google/adk bumped from ^1.0.0 to ^1.1.0

## [1.0.0](https://github.com/google/adk-js/compare/devtools-v0.6.1...devtools-v1.0.0) (2026-04-21)


### Features

* export AdkApiServer from @google/adk-devtools package ([#245](https://github.com/google/adk-js/issues/245)) ([0887e40](https://github.com/google/adk-js/commit/0887e4082974fb500a67411ded196f31e9d790bf))
* keep original __dirname, __filename and import.meta.url value for compiled agent files. ([#254](https://github.com/google/adk-js/issues/254)) ([db89a42](https://github.com/google/adk-js/commit/db89a4212000a450b6b197438cb798b4bf294831))


### Bug Fixes

* add client url to support custom url options for DB connection. ([#284](https://github.com/google/adk-js/issues/284)) ([bf8fade](https://github.com/google/adk-js/commit/bf8fadefb764e2ea22f9bc022b6e437ce8020873))


### Miscellaneous Chores

* release 1.0.0 ([84f886e](https://github.com/google/adk-js/commit/84f886e1ac8b3e9a7807a184257444fd0b15e1af))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @google/adk bumped from ^0.6.1 to ^1.0.0

## [0.6.1](https://github.com/google/adk-js/compare/devtools-v0.6.0...devtools-v0.6.1) (2026-03-30)


### Bug Fixes

* support native addon agent deps ([#219](https://github.com/google/adk-js/issues/219)) ([a13ee82](https://github.com/google/adk-js/commit/a13ee8244fb9d843a4123732ab5c28bbc49aeb7a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @google/adk bumped from ^0.6.0 to ^0.6.1

## [0.6.0](https://github.com/google/adk-js/compare/devtools-v0.5.0...devtools-v0.6.0) (2026-03-23)


### Features

* A2A integration: A2A Remote agent ([#190](https://github.com/google/adk-js/issues/190)) ([c6b75a2](https://github.com/google/adk-js/commit/c6b75a29683b0bbac98e1e17d811aa958025a11a))
* A2A integration: Add CLI option and serve ADK agents via A2A ([#188](https://github.com/google/adk-js/issues/188)) ([3897ee9](https://github.com/google/adk-js/commit/3897ee99df7122b57e4ff2c29b3f6806d6cb1ff4))
* A2A integration: add toA2a util function ([#205](https://github.com/google/adk-js/issues/205)) ([b7043ab](https://github.com/google/adk-js/commit/b7043abd2cc5193deb95bdad5cc347d04d56d87d))


### Bug Fixes

* Add option to start ADK API server on free random port. ([#197](https://github.com/google/adk-js/issues/197)) ([b8b92bf](https://github.com/google/adk-js/commit/b8b92bfb4344c8fd5d66556663c5b35c36511585))
* Print error message when port for ADK API server already in use ([#207](https://github.com/google/adk-js/issues/207)) ([8164857](https://github.com/google/adk-js/commit/816485786940daefded405731fe776170df80efb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @google/adk bumped from ^0.5.0 to ^0.6.0

## [0.5.0](https://github.com/google/adk-js/compare/devtools-v0.4.0...devtools-v0.5.0) (2026-03-09)


### Features

* integrate with ADK conformance tests ([#168](https://github.com/google/adk-js/issues/168)) ([3a7c012](https://github.com/google/adk-js/commit/3a7c012e035f665dbf200640c10caa6e6dd82aa3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @google/adk bumped from ^0.4.0 to ^0.5.0

## [0.4.0](https://github.com/google/adk-js/compare/devtools-v0.3.0...devtools-v0.4.0) (2026-02-25)

### Features

- Add ADK CLI version command. ([#115](https://github.com/google/adk-js/issues/115)) ([871be23](https://github.com/google/adk-js/commit/871be23acd020571b47129c96cc25730cd2d8e19))
- add database session service ([b3c38fe](https://github.com/google/adk-js/commit/b3c38feeb006cf40d0c7b71abe3afd052febb9b1))
- flip ADK CLI to be ESM native instead of CommonJS. ([#113](https://github.com/google/adk-js/issues/113)) ([1eb443e](https://github.com/google/adk-js/commit/1eb443eff054bde1aa9e85faaeb08de902620991))

### Bug Fixes

- handle state and state delta request body params in ADK API server. ([#117](https://github.com/google/adk-js/issues/117)) ([9aeb1f6](https://github.com/google/adk-js/commit/9aeb1f65c73dd122fdc1256a1fc19f74bdb2cbf3))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^0.3.0 to ^0.4.0

## [0.3.0](https://github.com/google/adk-js/compare/devtools-v0.2.5...devtools-v0.3.0) (2026-01-30)

### Features

- support Zod v3 and v4. ([#46](https://github.com/google/adk-js/issues/46)) ([accb7ca](https://github.com/google/adk-js/commit/accb7ca3bdec1295c81a4966177a2d5ed1103313))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @google/adk bumped from ^0.2.5 to ^0.3.0

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
