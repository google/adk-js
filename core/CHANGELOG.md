# Changelog

## [2.0.0](https://github.com/google/adk-js/compare/adk-v1.6.0...adk-v2.0.0) (2026-08-20)


### ⚠ BREAKING CHANGES

* **workflow:** `LLMAgentWrapper` and `LLMAgentWrapperConfig` are removed. An agent is a workflow node as itself — pass it to an edge or `node()` directly. A non-`LlmAgent` agent used as a node no longer has the node input appended to its conversation, nor its final model text promoted to the node output.
* **workflow:** `InvocationContext.agent` is now optional. Code reading it outside an agent's own execution must handle `undefined`; inside one, prefer `requireAgent(ctx)`.
* **agents:** constructing a `SequentialAgent`, `ParallelAgent` or `LoopAgent` now logs a deprecation warning once per class per process. The classes are otherwise unchanged and keep working.
* **agents:** `BaseAgent` now extends `BaseNode`, so subclasses inherit `rerunOnResume`, `waitForOutput`, `retryConfig`, `timeout`, `inputSchema`, `outputSchema` and `stateSchema`. A subclass that declares a field of the same name now collides with the inherited one. `BaseAgent.description` is also no longer `undefined` when unset.
* **workflow:** a dynamic `ctx.runNode()` child that raises an interrupt and re-reads `ctx.resumeInputs` on re-run must now declare `rerunOnResume: true`. With the default it is completed with the raw reply as its output instead of re-running. `Workflow` is still @experimental.
* **workflow:** add engine core — execution model, graph, and node registry (Part 2) ([#588](https://github.com/google/adk-js/issues/588))
* **workflow:** event model extensions and shared node primitives (Part 1) ([#587](https://github.com/google/adk-js/issues/587))

### Features

* **agents:** deprecate SequentialAgent, ParallelAgent and LoopAgent ([#679](https://github.com/google/adk-js/issues/679)) ([63927e2](https://github.com/google/adk-js/commit/63927e23ab1c692a94f3b5d0acf159f9ec1bc825))
* **agents:** make BaseAgent a BaseNode ([#667](https://github.com/google/adk-js/issues/667)) ([4b0c605](https://github.com/google/adk-js/commit/4b0c60570e56d73890f842d01784d6bbf1f102f5))
* **core:** accept a bare Workflow as a root — runner, App and agent loader ([#680](https://github.com/google/adk-js/issues/680)) ([b3497e0](https://github.com/google/adk-js/commit/b3497e0ff2a931d954b4efa57337fc3a8b709056))
* **core:** graduate RoutedAgent and RoutedLlm out of experimental ([#783](https://github.com/google/adk-js/issues/783)) ([36e3fcb](https://github.com/google/adk-js/commit/36e3fcb2d4911dc1ca7790eecbd8d638e4465414))
* **core:** implement Runner.runLive and LlmAgent live flow ([#523](https://github.com/google/adk-js/issues/523)) ([48165a8](https://github.com/google/adk-js/commit/48165a8b74c23d02c1b57afa5a0d0681f80a0bd2))
* **dev:** render graph workflows in the dev UI agent graph ([#654](https://github.com/google/adk-js/issues/654)) ([434a43e](https://github.com/google/adk-js/commit/434a43e90fd67fb0e72e879ab992716c4a7efbe9))
* Honor GOOGLE_GENAI_USE_ENTERPRISE in getExpressModeApiKey() (adk-python parity) ([#569](https://github.com/google/adk-js/issues/569)) ([444f30b](https://github.com/google/adk-js/commit/444f30bb77e6cae3681f1f35d149b11b072543bc))
* **plugins:** add before/after node callbacks ([#659](https://github.com/google/adk-js/issues/659)) ([e03bbad](https://github.com/google/adk-js/commit/e03bbadb2120f924e4696c348efacc1720f5784a))
* Port the environment abstraction (BaseEnvironment, ExecutionResult, LocalEnvironment) from adk-python ([#582](https://github.com/google/adk-js/issues/582)) ([f7f541e](https://github.com/google/adk-js/commit/f7f541e0730de5a3f0c14b2dae40189ac461aecb))
* **tools:** FunctionTool require_confirmation — HITL approval (Part 7) ([#594](https://github.com/google/adk-js/issues/594)) ([d2ae57b](https://github.com/google/adk-js/commit/d2ae57b071ab4db7ea636b0d40e9b8ae93307222))
* **utils:** enforce schemas declared in the genai dialect, not just Zod ([#663](https://github.com/google/adk-js/issues/663)) ([392511a](https://github.com/google/adk-js/commit/392511ae92732536d6f4079e1823e52954b23a45))
* **workflow:** add engine core — execution model, graph, and node registry (Part 2) ([#588](https://github.com/google/adk-js/issues/588)) ([672dbde](https://github.com/google/adk-js/commit/672dbdeb9c2e6726f2f223e47efb2aa7e4fe0e0d))
* **workflow:** built-in Function and Tool nodes (Part 3) ([#590](https://github.com/google/adk-js/issues/590)) ([68aebdb](https://github.com/google/adk-js/commit/68aebdbfa4aa87a40fd7e49c70fc1dca05da985e))
* **workflow:** drive workflows as nodes and remove WorkflowAgent ([#688](https://github.com/google/adk-js/issues/688)) ([534546f](https://github.com/google/adk-js/commit/534546f5f847fc677bbb9e5abe11beabebf9e574))
* **workflow:** enforce a node's declared stateSchema ([#713](https://github.com/google/adk-js/issues/713)) ([379e45c](https://github.com/google/adk-js/commit/379e45c44d96784034822445822f173146d92057))
* **workflow:** event model extensions and shared node primitives (Part 1) ([#587](https://github.com/google/adk-js/issues/587)) ([3865f3c](https://github.com/google/adk-js/commit/3865f3c05984ff6406b4f52a1db6c3bec6bde574))
* **workflow:** let ctx.runNode() take what edges take ([#683](https://github.com/google/adk-js/issues/683)) ([53535d3](https://github.com/google/adk-js/commit/53535d345e3abcbc15613e4fe12dc3661fb36942))
* **workflow:** LLM-agent-as-node, task mode, and node-as-tool (Part 6) ([#593](https://github.com/google/adk-js/issues/593)) ([5334b45](https://github.com/google/adk-js/commit/5334b4502edc8e8086b11d7e679b6decee944d67))
* **workflow:** make isolationScope real by filtering LLM contents on it ([#656](https://github.com/google/adk-js/issues/656)) ([bdc9090](https://github.com/google/adk-js/commit/bdc90901edd6ce64acc97f349a11e485ede5c234))
* **workflow:** ParallelWorker and JoinNode (Part 4) ([#591](https://github.com/google/adk-js/issues/591)) ([13f9995](https://github.com/google/adk-js/commit/13f9995c275dbf9844c1108f22b613966d0d5ccb))
* **workflow:** record a failed node as a NodeErrorEvent ([#657](https://github.com/google/adk-js/issues/657)) ([e5025e9](https://github.com/google/adk-js/commit/e5025e9cbe1d8889d386efaca811963952beb064))
* **workflow:** trace workflow and node execution with OpenTelemetry ([#653](https://github.com/google/adk-js/issues/653)) ([d0f19c5](https://github.com/google/adk-js/commit/d0f19c5eb287c2318335e8f0449698395a8f6663))
* **workflow:** workflow runner and public API (Part 5) ([#592](https://github.com/google/adk-js/issues/592)) ([1b90f3b](https://github.com/google/adk-js/commit/1b90f3b35b8b4e4a9d9e902b9ab6023d05390b69))


### Bug Fixes

* **agents:** bind a human-in-the-loop confirmation to the action it approves ([#771](https://github.com/google/adk-js/issues/771)) ([2d1bb44](https://github.com/google/adk-js/commit/2d1bb449c257ed12ae91e22f36eb8d11f8955f9a))
* **agents:** keep usage metadata from content-less streaming responses ([#646](https://github.com/google/adk-js/issues/646)) ([2e58422](https://github.com/google/adk-js/commit/2e584224c715275fc8c77e53bf48046cfd2ed66d)), closes [#645](https://github.com/google/adk-js/issues/645)
* **agents:** persist processLlmRequest state changes ([#630](https://github.com/google/adk-js/issues/630)) ([9360bf2](https://github.com/google/adk-js/commit/9360bf24b8de699fedab692a826011aa119fd093))
* **agents:** stop warning about transfer config the author never set ([#746](https://github.com/google/adk-js/issues/746)) ([5860560](https://github.com/google/adk-js/commit/58605605ce16c452f99e1ad240792c585e89de21)), closes [#725](https://github.com/google/adk-js/issues/725) [#726](https://github.com/google/adk-js/issues/726)
* **auth:** bind a credential response to the request that asked for it ([#775](https://github.com/google/adk-js/issues/775)) ([10ae7bd](https://github.com/google/adk-js/commit/10ae7bdd24d0a7bdef856a15b67255c617f5ce9d))
* **cli:** keep one broken agent from killing the dev server; surface HITL prompts and errors in `adk run` ([#633](https://github.com/google/adk-js/issues/633)) ([a98d132](https://github.com/google/adk-js/commit/a98d132f7122f3cca1bce4121ce81610db5b1084))
* **dev:** stop an empty node response vanishing from the transcript ([#765](https://github.com/google/adk-js/issues/765)) ([af3a821](https://github.com/google/adk-js/commit/af3a82144261470eb59672ee535f2fa1ccf78e00)), closes [#728](https://github.com/google/adk-js/issues/728)
* encode and validate OpenAPI path parameters in RestApiTool ([#638](https://github.com/google/adk-js/issues/638)) ([cedd2a5](https://github.com/google/adk-js/commit/cedd2a5fd378ca11e0ebdd6d6689e445a7493407))
* **models:** consult GOOGLE_API_KEY on the Gemini API path ([#748](https://github.com/google/adk-js/issues/748)) ([60a3c67](https://github.com/google/adk-js/commit/60a3c6732b5100bcf67df9d806a64fdb2049bc72)), closes [#712](https://github.com/google/adk-js/issues/712)
* resolve the browser export condition in core and integrations ([#618](https://github.com/google/adk-js/issues/618)) ([0f9f73d](https://github.com/google/adk-js/commit/0f9f73d4fc0577f1ed8d474451e53d4a2ca2f720))
* **runner:** stop warning about workflow nodes when resuming ([#672](https://github.com/google/adk-js/issues/672)) ([e294c4d](https://github.com/google/adk-js/commit/e294c4d5632496b896dd7557c1ba915a1989d2c5))
* **sessions:** keep workflow event fields across the Agent Engine fallback path ([#649](https://github.com/google/adk-js/issues/649)) ([a493f74](https://github.com/google/adk-js/commit/a493f74d64dd54bb5ab179d1dddbf78bfccc9311))
* **sessions:** redact connection-URI password in unsupported-URI errors ([#602](https://github.com/google/adk-js/issues/602)) ([aee56e0](https://github.com/google/adk-js/commit/aee56e07a47df35bece844a91099c8ee760885aa))
* **sessions:** restore event round trip in VertexAiSessionService ([#565](https://github.com/google/adk-js/issues/565)) ([90b2417](https://github.com/google/adk-js/commit/90b2417a6355a05b491ab64d76b9af9b70d4781d))
* **sessions:** send the agent-transfer action under the name the API defines ([#660](https://github.com/google/adk-js/issues/660)) ([6a8224e](https://github.com/google/adk-js/commit/6a8224e997d9c4c1de4a558b5a4d46086387f982))
* **sessions:** stop a late event commit rolling a state key back ([#695](https://github.com/google/adk-js/issues/695)) ([86459dc](https://github.com/google/adk-js/commit/86459dcd24a001ad706c54b8d992dda3e11c8b4a))
* **skills:** materialize script output into a dedicated dir, not process.cwd() ([#620](https://github.com/google/adk-js/issues/620)) ([2ea08cf](https://github.com/google/adk-js/commit/2ea08cf8ba5fca65d678cdabecbf78713fee4106))
* **skills:** preserve binary skill assets as Buffer ([#644](https://github.com/google/adk-js/issues/644)) ([94cbe4a](https://github.com/google/adk-js/commit/94cbe4a5f44fb52a994a1e632d98cad64340d696))
* skip identity preamble when agent transfer is disabled ([#616](https://github.com/google/adk-js/issues/616)) ([09e2375](https://github.com/google/adk-js/commit/09e23757f0cbbd4dfbf71a4704c15ab1352d6434))
* StreamingMode.BIDI is accepted but has no effect — silently degrades to NONE with no error or warning ([#692](https://github.com/google/adk-js/issues/692)) ([8c1004f](https://github.com/google/adk-js/commit/8c1004ffbfdbe5aa5261fdec16441810f6e67e80)), closes [#676](https://github.com/google/adk-js/issues/676)
* **telemetry:** make a workflow's spans retrievable so its traces render ([#750](https://github.com/google/adk-js/issues/750)) ([63a5f43](https://github.com/google/adk-js/commit/63a5f4395e6367d5129ccd679b76104eb7e6a8d3))
* **tests:** give the local code executor tests a Windows-sized budget ([#662](https://github.com/google/adk-js/issues/662)) ([9726467](https://github.com/google/adk-js/commit/9726467f3eaa79a4f416811561371f501127431c))
* three defects found bug-bashing the graph-workflow docs samples ([#664](https://github.com/google/adk-js/issues/664)) ([e0dae58](https://github.com/google/adk-js/commit/e0dae584d43bab7ef068decb4743e6d6753d176f))
* **workflow:** apply node overrides to an already-built node ([#673](https://github.com/google/adk-js/issues/673)) ([a9dd7c6](https://github.com/google/adk-js/commit/a9dd7c6b0137417aaae5d6b0d1a33751d2566a20))
* **workflow:** check a structured HITL reply against its responseSchema ([#665](https://github.com/google/adk-js/issues/665)) ([238d600](https://github.com/google/adk-js/commit/238d600e24eb3a1c6ef0ce5e44fd951fa3d55d1e))
* **workflow:** don't replay a finished run on the next turn ([#637](https://github.com/google/adk-js/issues/637)) ([3e4f770](https://github.com/google/adk-js/commit/3e4f770333053ad32b33b3154d9ec062e1950c5a))
* **workflow:** emit the interrupt schema under the key clients read ([#686](https://github.com/google/adk-js/issues/686)) ([e84eb3f](https://github.com/google/adk-js/commit/e84eb3fa9953a5e21164adb69475e7678f4b6fbf))
* **workflow:** fail a node that reports an error instead of throwing ([#776](https://github.com/google/adk-js/issues/776)) ([8786718](https://github.com/google/adk-js/commit/87867184f71e311dea7b54ea4dd10e5a6cd90163))
* **workflow:** hand the START node the user's text, attachment or not ([#778](https://github.com/google/adk-js/issues/778)) ([7c65534](https://github.com/google/adk-js/commit/7c65534f6ef54c368eac9a7f9f560a09eedbf7d2))
* **workflow:** keep a jittered retry delay inside maxDelay ([#704](https://github.com/google/adk-js/issues/704)) ([c577510](https://github.com/google/adk-js/commit/c577510c9943ab0ae1871432d40f489b1693f019))
* **workflow:** let a child's pending interrupt hold its caller ([#759](https://github.com/google/adk-js/issues/759)) ([8b43818](https://github.com/google/adk-js/commit/8b43818548ed754fb678fd0ddc05e8fc4b28f9ce)), closes [#734](https://github.com/google/adk-js/issues/734)
* **workflow:** let a resumed graph route back through a node it already ran ([#700](https://github.com/google/adk-js/issues/700)) ([074827a](https://github.com/google/adk-js/commit/074827abdd4ac7dfb7c1b5ce743e9288c214a340))
* **workflow:** let an agent node converse and finish a confirmed tool call ([#703](https://github.com/google/adk-js/issues/703)) ([73b9443](https://github.com/google/adk-js/commit/73b9443910b0b11b9bb2f0f48c794e3d47891996))
* **workflow:** let an item that asks the user pause the whole worker ([#708](https://github.com/google/adk-js/issues/708)) ([d4a5373](https://github.com/google/adk-js/commit/d4a5373d4b8b706297a31a5f9379c75140d4db42))
* **workflow:** let two route keys share a destination node ([#763](https://github.com/google/adk-js/issues/763)) ([172ccb1](https://github.com/google/adk-js/commit/172ccb148c14990eec7435f7360f5349172369df)), closes [#740](https://github.com/google/adk-js/issues/740)
* **workflow:** match a retryable exception by its class name ([#705](https://github.com/google/adk-js/issues/705)) ([de31b04](https://github.com/google/adk-js/commit/de31b04ab518e7050039033df2a7acae4b0ace0f))
* **workflow:** record which nodes an output answers for ([#690](https://github.com/google/adk-js/issues/690)) ([6796f42](https://github.com/google/adk-js/commit/6796f422f0d153a9e289d2dcb400d473833e228c))
* **workflow:** refuse a numeric custom runId whichever call comes first ([#762](https://github.com/google/adk-js/issues/762)) ([fbff483](https://github.com/google/adk-js/commit/fbff4836763594747f6b95aad62cdb246e48aa1a))
* **workflow:** refuse a reply that answers no open interrupt ([#777](https://github.com/google/adk-js/issues/777)) ([19c50ef](https://github.com/google/adk-js/commit/19c50ef9cbae0fa548d3f763902da4b9408e073e))
* **workflow:** refuse a runId that collides with an automatic one ([#670](https://github.com/google/adk-js/issues/670)) ([aca4a32](https://github.com/google/adk-js/commit/aca4a323d697b53061818ea91ca0eb4ccd235d1d))
* **workflow:** report an aborted node as aborted, not timed out ([#706](https://github.com/google/adk-js/issues/706)) ([596f41c](https://github.com/google/adk-js/commit/596f41cf55c7e199df9222a01666c5c2bc489542))
* **workflow:** resume a waiting parent on its original input ([#760](https://github.com/google/adk-js/issues/760)) ([67d5246](https://github.com/google/adk-js/commit/67d52460d253d58e687d39847d270248fba51b0a))
* **workflow:** resume dynamic HITL children instead of livelocking ([#635](https://github.com/google/adk-js/issues/635)) ([1961d2c](https://github.com/google/adk-js/commit/1961d2c349a7a2ffdab34537ac1345eee8495c56))
* **workflow:** say which node failed, and when a route goes nowhere ([#650](https://github.com/google/adk-js/issues/650)) ([a785f3a](https://github.com/google/adk-js/commit/a785f3a9004e590868c9bc4143e2068f32a8d739))
* **workflow:** stamp the invocation id on an event a node built itself ([#747](https://github.com/google/adk-js/issues/747)) ([b339f75](https://github.com/google/adk-js/commit/b339f75a3bbd086b5d03b91e4320e5f914a1faf9)), closes [#715](https://github.com/google/adk-js/issues/715)
* **workflow:** stop delivering a workflow's output as two events ([#669](https://github.com/google/adk-js/issues/669)) ([7aa76e7](https://github.com/google/adk-js/commit/7aa76e71b8cc11457435cfd3f902d092f3b5ed7d))
* **workflow:** stop duplicating a delegated output, and parse a structured reply ([#702](https://github.com/google/adk-js/issues/702)) ([bd47431](https://github.com/google/adk-js/commit/bd4743169c4884da96477e9c7664785659f55470))
* **workflow:** stop node state writes from being rolled back mid-run ([#636](https://github.com/google/adk-js/issues/636)) ([fcc6c1e](https://github.com/google/adk-js/commit/fcc6c1e72768ad98f00ee69d2b5c696d9e4717c4))
* **workflow:** stop re-running a dynamic node that already settled ([#707](https://github.com/google/adk-js/issues/707)) ([bc4e238](https://github.com/google/adk-js/commit/bc4e23874db51c81d823ce85a5384a7fe44ed8f2))
* **workflow:** stop reinterpreting a text reply the schema asked for as text ([#761](https://github.com/google/adk-js/issues/761)) ([022fcc9](https://github.com/google/adk-js/commit/022fcc9158fc8c314cf54d2377e347771e27de94)), closes [#737](https://github.com/google/adk-js/issues/737)
* **workflow:** unwind a caller past a dynamic child that paused or failed ([#709](https://github.com/google/adk-js/issues/709)) ([5719010](https://github.com/google/adk-js/commit/571901063815da387930d335dda4f5876441cec7))


### Performance Improvements

* **core:** make situational subsystems optional peers, 591 → 172 packages on install ([#626](https://github.com/google/adk-js/issues/626)) ([a5cdc38](https://github.com/google/adk-js/commit/a5cdc38e4ef2cbcd1770a9684528f09cdffe12a8))


### Code Refactoring

* **workflow:** collapse LLMAgentWrapper into LlmAgent.runImpl ([#696](https://github.com/google/adk-js/issues/696)) ([49209ab](https://github.com/google/adk-js/commit/49209ab91bdcf4762f92d6a0b5fe9b5617a027bd))

## [1.6.0](https://github.com/google/adk-js/compare/adk-v1.5.0...adk-v1.6.0) (2026-08-05)


### Features

* Add bearerTokenUserBuilder for A2A authentication (Part 1/2) ([#562](https://github.com/google/adk-js/issues/562)) ([f077722](https://github.com/google/adk-js/commit/f077722d54528c609c95fed51019fc013093a8e5))
* CLI-level A2A authenticator for the dev server and Cloud Run deploy (Part 2/2) ([#559](https://github.com/google/adk-js/issues/559)) ([0c0bba2](https://github.com/google/adk-js/commit/0c0bba2cc4639ff89e4fa517ace25e34babb64b0))
* Support ttl and expireTime session-expiration options in VertexAiSessionService.createSession ([#561](https://github.com/google/adk-js/issues/561)) ([b390217](https://github.com/google/adk-js/commit/b390217e65dc69af85373a8eac79f0bc3baae165))
* **tools:** add getUserChoiceTool and requestInputTool for parity with adk-python ([#506](https://github.com/google/adk-js/issues/506)) ([03abf76](https://github.com/google/adk-js/commit/03abf761e97ef2c2902e776886b1a8d2a653a527))
* Validate tool callback response types and prevent state event pollution ([#505](https://github.com/google/adk-js/issues/505)) ([b99f21b](https://github.com/google/adk-js/commit/b99f21b8a549d9b4e1255ae4233d9f691eeb9fe3))


### Bug Fixes

* **a2a:** stop restoring event branch from A2A peer metadata ([#606](https://github.com/google/adk-js/issues/606)) ([0000925](https://github.com/google/adk-js/commit/00009258373f8adc213171cf664dee2a21c19417))
* accept the derived allowedTools alias in skill frontmatter validation ([#560](https://github.com/google/adk-js/issues/560)) ([fcfd043](https://github.com/google/adk-js/commit/fcfd04363ebbbea03e7a7c32d11f05358fdb4a4e))
* **artifacts:** isolate in-memory composite keys ([#576](https://github.com/google/adk-js/issues/576)) ([693a1d7](https://github.com/google/adk-js/commit/693a1d7959f68a7e578312c5c88d9ad70c283cd1))
* **core:** fall back to node:crypto so randomUUID cannot throw on Node ([#599](https://github.com/google/adk-js/issues/599)) ([3dc1b20](https://github.com/google/adk-js/commit/3dc1b2012cac86dbed249e0b3d17e16f1d0bd791))
* **core:** use a cryptographically secure source for randomUUID ([#577](https://github.com/google/adk-js/issues/577)) ([81bcc8d](https://github.com/google/adk-js/commit/81bcc8dd4784d1d94e64b599f9d092a99333539d))
* detect PowerShell 7+ (pwsh) in the UnsafeLocalCodeExecutor SHELL branch ([#568](https://github.com/google/adk-js/issues/568)) ([ce0e474](https://github.com/google/adk-js/commit/ce0e474bb5ab931894bf379588e357617ce0b5a1))
* fail fast when a Vertex AI Express Mode API key cannot be used ([#563](https://github.com/google/adk-js/issues/563)) ([e1112c6](https://github.com/google/adk-js/commit/e1112c6df905853ad99d84f6490d12e4dbbbfd22))
* gate the set_model_response workaround on canUseOutputSchemaWithTools (adk-python parity) ([#580](https://github.com/google/adk-js/issues/580)) ([5b65ee1](https://github.com/google/adk-js/commit/5b65ee109083002263f1e30593035e9778add996))
* parse JSON bodies only in the toA2a server (drop express.urlencoded) ([#558](https://github.com/google/adk-js/issues/558)) ([605b469](https://github.com/google/adk-js/commit/605b46980cabd2a8928e08d3fc3669a1de13c24c))
* pass -NoProfile to spawned PowerShell and /D to cmd.exe in UnsafeLocalCodeExecutor ([#566](https://github.com/google/adk-js/issues/566)) ([b56761b](https://github.com/google/adk-js/commit/b56761bfb0d9b0d139cc95ba1a6d1803732507dd))
* reject zip-slip entries and non-bare skill names when loading zipped skills (adk-python parity) ([#584](https://github.com/google/adk-js/issues/584)) ([4fe80b0](https://github.com/google/adk-js/commit/4fe80b0ef7e5df1803c76e8681cd9740fcf6ebf5))
* **runner:** persist events returned by onEventCallback ([#575](https://github.com/google/adk-js/issues/575)) ([c4c5582](https://github.com/google/adk-js/commit/c4c55829394cb4f15fa13f54235a9a77c5417e54))
* **security:** prevent prototype pollution via untrusted map keys ([#619](https://github.com/google/adk-js/issues/619)) ([2c07ad3](https://github.com/google/adk-js/commit/2c07ad3741cd84788d0b30a793587d5dd4b46106))
* surface root-cause MCP session errors instead of swallowing them ([#527](https://github.com/google/adk-js/issues/527)) ([13d7304](https://github.com/google/adk-js/commit/13d7304a0611fe8f1dc00a2e5de9dc3ac4d63943))
* treat @google/genai ApiError 404 as session not found in VertexAiSessionService ([#567](https://github.com/google/adk-js/issues/567)) ([5331c77](https://github.com/google/adk-js/commit/5331c771cde1c3af8ef1d87e44d41161c9919721))
* unsafe A2A peer-supplied transferToAgent metadata ([#596](https://github.com/google/adk-js/issues/596)) ([d3f250e](https://github.com/google/adk-js/commit/d3f250e876d0a76f4d09b3439e84e7dbd1fc32ec))
* **utils:** fix sibling-directory escape in materializeFiles path check ([#603](https://github.com/google/adk-js/issues/603)) ([868ca1f](https://github.com/google/adk-js/commit/868ca1f373a175c7fe2c788b167f05a58e6eed2e))
* zip-slip blacklist bypass in isDangerousZipEntryName ([#621](https://github.com/google/adk-js/issues/621)) ([7bc05f6](https://github.com/google/adk-js/commit/7bc05f6156e3e121663acee2c6476e953a626b61))

## [1.5.0](https://github.com/google/adk-js/compare/adk-v1.4.0...adk-v1.5.0) (2026-07-29)


### Features

* Add EnterpriseWebSearchTool for Gemini web grounding (adk-python parity) ([#525](https://github.com/google/adk-js/issues/525)) ([d9a9692](https://github.com/google/adk-js/commit/d9a9692dd3d00803943b08fcba934a6bff5de6d2))
* Add ExampleTool for few-shot examples (adk-python parity) ([#554](https://github.com/google/adk-js/issues/554)) ([49c34a8](https://github.com/google/adk-js/commit/49c34a8cc7ded990e152e236cf975b45ad2529ea))
* add LoadMcpResourceTool (read MCP server resources) for adk-python parity ([#542](https://github.com/google/adk-js/issues/542)) ([0bfc44a](https://github.com/google/adk-js/commit/0bfc44a8fff3a2e726a1f5e371323080e174ee08))
* Add SSRF-safe load_web_page tool (adk-python parity) ([#524](https://github.com/google/adk-js/issues/524)) ([9fa7e6e](https://github.com/google/adk-js/commit/9fa7e6e93a6816aec919ca76771a74ff2709ec35))
* **agents:** add clone() to BaseAgent ([#545](https://github.com/google/adk-js/issues/545)) ([d600e26](https://github.com/google/adk-js/commit/d600e262bb495da279c30b2a8a422fcf3b2eeb8f))
* Implement Anchored Iterative Summarization in adk-js context compactors ([#470](https://github.com/google/adk-js/issues/470)) ([85d0321](https://github.com/google/adk-js/commit/85d03217663214ec89da5ddbe71c433fcee29ac4))
* Move populateClientFunctionCallId into event.ts and update references ([#511](https://github.com/google/adk-js/issues/511)) ([a8be520](https://github.com/google/adk-js/commit/a8be520b4c5e5a5387609881a221df2375fa4a95))
* Port LoopAgent live streaming support (runLiveImpl) to TypeScript ([#504](https://github.com/google/adk-js/issues/504)) ([312b463](https://github.com/google/adk-js/commit/312b463e7861b6a353c4ad6822239e67db123334))
* scope global instructions using GlobalInstructionPlugin (parity with adk-python b/425992518) ([#507](https://github.com/google/adk-js/issues/507)) ([c9089be](https://github.com/google/adk-js/commit/c9089be394e0419112653d439841f299b7a265b4))
* support clone() for RoutedAgent (Part 2/2) ([#556](https://github.com/google/adk-js/issues/556)) ([0815a8c](https://github.com/google/adk-js/commit/0815a8c7010d6ceb4934ceaf762b95ad1d9c6941))
* Upgrade branch string matching to Trie search structure in content_processor_utils.ts ([#509](https://github.com/google/adk-js/issues/509)) ([c10ccd6](https://github.com/google/adk-js/commit/c10ccd61e67f5eb55941eace7b3a6b902dd65059))


### Bug Fixes

* **a2a:** handle contentless events ([#547](https://github.com/google/adk-js/issues/547)) ([1dad6f9](https://github.com/google/adk-js/commit/1dad6f9509501787758f839335a9cbae5c056d4e))
* **a2a:** preserve errorCode in event metadata ([#537](https://github.com/google/adk-js/issues/537)) ([72d647c](https://github.com/google/adk-js/commit/72d647c28249e1531a82d78b7ae5145f5b7d1d34))
* Artifact Saving Message Part Replacement & LLM Exposure (TODO b/425992518) ([#515](https://github.com/google/adk-js/issues/515)) ([24bb8e9](https://github.com/google/adk-js/commit/24bb8e92858a9e23d419948bca465fa24fc3328c))
* **artifacts:** return undefined for missing in-memory versions ([#538](https://github.com/google/adk-js/issues/538)) ([3157c0a](https://github.com/google/adk-js/commit/3157c0a9ca0a8dbba2daa32a5da4158ad9277032))
* **config:** validate the effective maxLlmCalls value ([#539](https://github.com/google/adk-js/issues/539)) ([13deefe](https://github.com/google/adk-js/commit/13deefe494393e002fe13a10e345d19f3b90d18a))
* **mcp:** close agent registry tool-discovery sessions ([#540](https://github.com/google/adk-js/issues/540)) ([daf636d](https://github.com/google/adk-js/commit/daf636dd7c80b4fbb66492222c860f18bc3534d5))
* **security:** require authentication when mounting A2A server ([#529](https://github.com/google/adk-js/issues/529)) ([7f39b6c](https://github.com/google/adk-js/commit/7f39b6c330bcadfedc35c29d67d103e7d0f6bb2b))
* **security:** require confirmation before executing inline skill scripts ([#528](https://github.com/google/adk-js/issues/528)) ([b6b8296](https://github.com/google/adk-js/commit/b6b82966e3b3d6c1932e24cf27322570b927cd8d))
* **tools:** use the statically configured credential in OpenAPI tools ([#536](https://github.com/google/adk-js/issues/536)) ([fe0ad34](https://github.com/google/adk-js/commit/fe0ad34d023c9dfa0367d5eb766ad59ecd4504ab))

## [1.4.0](https://github.com/google/adk-js/compare/adk-v1.3.0...adk-v1.4.0) (2026-07-20)


### Features

* add fileData support to GcsArtifactService ([#476](https://github.com/google/adk-js/issues/476)) ([4bc7086](https://github.com/google/adk-js/commit/4bc7086a372cdd7c27db426a8b8d0f96ce646b96))
* Cleanup and Generalize determineAgentForResumption for LRO Session Resumption Routing ([#490](https://github.com/google/adk-js/issues/490)) ([f72dcbc](https://github.com/google/adk-js/commit/f72dcbc38e0869911f698886330d42ffa8bc932a))
* Configurable Client Labels in adk-js ([#454](https://github.com/google/adk-js/issues/454)) ([87e15ec](https://github.com/google/adk-js/commit/87e15ec9495c3fd7136e4f82ec5c8b8d6b24089e))
* Group appName, userId, and sessionId into a unified composite session key ([#486](https://github.com/google/adk-js/issues/486)) ([f22e959](https://github.com/google/adk-js/commit/f22e9597a60f2ccc4e933ab0b445e77f3f4d44b9))
* Implement Agent-Controlled Compaction ([#477](https://github.com/google/adk-js/issues/477)) ([0aa4d82](https://github.com/google/adk-js/commit/0aa4d82ac4f8bec9520c6f55614609be444f5a60))
* Implement Gemini Interaction API in adk-js ([#364](https://github.com/google/adk-js/issues/364)) ([82ed4e1](https://github.com/google/adk-js/commit/82ed4e123ef8900f26e9a31e8d1880342c7b57fc))
* Implement Trajectory Thought Pruning in adk-js ([#451](https://github.com/google/adk-js/issues/451)) ([584ce87](https://github.com/google/adk-js/commit/584ce877318794eacbf1cee3d1b90d02edd5dc43))
* Internalize removeClientFunctionCallId into content processor in adk-js ([#481](https://github.com/google/adk-js/issues/481)) ([89012ad](https://github.com/google/adk-js/commit/89012ad9ed45ddd5ed0700616a9061560cfdf5f1))
* Refactor ForwardingArtifactService and introduce SessionArtifactService ([#455](https://github.com/google/adk-js/issues/455)) ([64b18e4](https://github.com/google/adk-js/commit/64b18e43a93cc93ba1a18b5a511751b24e4ffc66))
* Replace Promise&lt;void&gt; with proper Task type in ActiveStreamingTool Staging ([#468](https://github.com/google/adk-js/issues/468)) ([932d121](https://github.com/google/adk-js/commit/932d1214a199e0bce876198a004def6e5ed9d8b4))
* Support apps  ([#489](https://github.com/google/adk-js/issues/489)) ([fd69b69](https://github.com/google/adk-js/commit/fd69b69d7df5a2a422ce269d0f3db249288771ad))


### Bug Fixes

* **agents:** share the invocation cost manager so maxLlmCalls spans the whole run ([#484](https://github.com/google/adk-js/issues/484)) ([c46d71b](https://github.com/google/adk-js/commit/c46d71bcd14cb90a0b7befb810c45f60da8cc309))
* **auth:** apply SSRF blocklist to OAuth2 token endpoint in fetchOAuth2Tokens ([#465](https://github.com/google/adk-js/issues/465)) ([4953bc4](https://github.com/google/adk-js/commit/4953bc4db116ab904f245e21903177d4496f180c))
* **auth:** prevent SSRF credential leak via OAuth2 redirects and block IPv6 [::] ([#482](https://github.com/google/adk-js/issues/482)) ([1c405a4](https://github.com/google/adk-js/commit/1c405a4e3a1a728710f08db33286d3ff8c8bbd98))
* **core:** default newMessage role to 'user' when omitted ([#475](https://github.com/google/adk-js/issues/475)) ([#478](https://github.com/google/adk-js/issues/478)) ([e30c891](https://github.com/google/adk-js/commit/e30c891789867610618fc799348834d704579c77))
* **core:** don't emit empty-parts model content from the stream aggregator ([#485](https://github.com/google/adk-js/issues/485)) ([d1f8e98](https://github.com/google/adk-js/commit/d1f8e985484463c0badd0210c1c56f7e46dc1dfb))
* **core:** format object state and Part artifact values as JSON or text in instruction templates ([#494](https://github.com/google/adk-js/issues/494)) ([#495](https://github.com/google/adk-js/issues/495)) ([ff34add](https://github.com/google/adk-js/commit/ff34add5e4908efd1e9f7b895e7e92a493720bb2))
* gate token-based compaction on latest prompt size, not event sum ([#474](https://github.com/google/adk-js/issues/474)) ([ad84b98](https://github.com/google/adk-js/commit/ad84b98e2f9d71e669766fdd8eb05331a95b4de0)), closes [#473](https://github.com/google/adk-js/issues/473)
* gracefully handle missing function calls during context compaction ([#496](https://github.com/google/adk-js/issues/496)) ([da24221](https://github.com/google/adk-js/commit/da24221474eddb84bc09e2a202dbdc13bc79adc1))
* load SKILL.md files with tables ([#500](https://github.com/google/adk-js/issues/500)) ([3ed86d5](https://github.com/google/adk-js/commit/3ed86d5f285be9e1ba47615c4948968b1b9e1a3d))
* **sessions/vertexai:** quote userId in AIP-160 list filter ([#499](https://github.com/google/adk-js/issues/499)) ([8f9e8f2](https://github.com/google/adk-js/commit/8f9e8f20f1708effc4e6965d6141655f92c2f65b))
* **streaming:** supress empty part arrays ([#450](https://github.com/google/adk-js/issues/450)) ([2ff0643](https://github.com/google/adk-js/commit/2ff0643133455ed748f3b4085ece32cb0027c12c))
* **tools:** persist exchanged OpenAPI credentials via the State API ([#491](https://github.com/google/adk-js/issues/491)) ([bcf1e27](https://github.com/google/adk-js/commit/bcf1e27f4c43d4c81f21eb1e95dbf25374f0d711))
* **tools:** treat an empty toolFilter array as no filter in BaseToolset ([#493](https://github.com/google/adk-js/issues/493)) ([e5fe7a1](https://github.com/google/adk-js/commit/e5fe7a1c41c789a9d7f54de9b00696539d4aee76))

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
