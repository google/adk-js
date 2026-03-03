/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {registerConformanceIntegrations} from '../conformance/conformance_integrations.js';
import {batchLoadYamlAgentConfig} from '../conformance/yaml_agent_loader.js';
import {batchLoadYamlTestDefs} from '../conformance/yaml_test_loader.js';
import {AgentRegistry} from './agent_registry.js';
import {IntegrationRegistry} from './integration_registry.js';
import {TestRunner} from './test_runner.js';

export async function runIntegrationTests({
  agentsDir,
  testsDir,
  forceRunAll,
}: {
  agentsDir: string;
  testsDir: string;
  forceRunAll: boolean;
}) {
  console.log(`Loading agents from ${agentsDir}`);
  const agentConfigs = await batchLoadYamlAgentConfig(agentsDir);
  console.log(agentConfigs.size, 'agents found');

  console.log('Registering conformance integrations.');
  const registry = new IntegrationRegistry();
  registerConformanceIntegrations(registry);
  console.log(registry.summary());

  console.log('Registering agents.');
  const agentRegistry = new AgentRegistry(registry);
  for (const [name, agentConfig] of agentConfigs) {
    agentRegistry.registerAgentConfig(name, agentConfig);
  }
  console.log(agentRegistry.summary());

  console.log(`Loading tests from ${testsDir}`);
  const testSpecs = await batchLoadYamlTestDefs(testsDir);
  console.log(testSpecs.size, 'tests found.');

  console.log('Running tests.');
  const successfulTests = [];
  const skippedTests = [];
  const failedTests = [];
  const testRunner = new TestRunner(agentRegistry);

  for (const [name, testInfo] of testSpecs) {
    console.log('\x1b[33mRunning test', name, '\x1b[0m\n');
    try {
      const skipped = await testRunner.run(testInfo, forceRunAll);

      if (skipped) {
        skippedTests.push(name);
        console.log('\n\x1b[33mTest skipped.\x1b[0m\n');
        continue;
      }

      successfulTests.push(name);
      console.log('\n\x1b[32mTest passed.\x1b[0m\n');
    } catch (_: unknown) {
      failedTests.push(name);
      console.error('\n\x1b[31mTest failed.\x1b[0m\n');
    }
  }

  console.log(
    `\n\n${successfulTests.length} tests passed, ` +
      `${skippedTests.length} tests skipped, ` +
      `${failedTests.length} tests failed.`,
  );

  console.log('Successfull tests:', successfulTests.join(', '));
  console.log('Skipped tests:', skippedTests.join(', '));
  console.log('Failed tests:', failedTests.join(', '));
  console.log('\n');
}
