import {Event, RemoteA2AAgent} from '@google/adk';
// import * as fs from 'node:fs';
import * as path from 'node:path';
import {createTestApiServer, TestAdkApiServer} from '../../test_api_server.js';
import {runTestCase} from '../../test_case_utils.js';
// import {createRunner} from '../../test_case_utils.js';
import turn1ExpectedEvents from './events_1.json' with {type: 'json'};
import turn2ExpectedEvents from './events_2.json' with {type: 'json'};

describe('A2A remote agent', () => {
  let server: TestAdkApiServer;

  beforeAll(async () => {
    server = createTestApiServer({
      agentsDir: path.join(__dirname, 'remote_a2a/'),
      a2a: true,
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test('Should connect to remote agent and run a test case', async () => {
    const remoteA2AAgent = new RemoteA2AAgent({
      name: 'remote_a2a_agent',
      description:
        'Helpful assistant that can roll dice and check if numbers are prime.',
      agentCard: `${server.url}/a2a/weather_time_agent/`,
    });

    // const runner = await createRunner(remoteA2AAgent);
    // let events = [];
    // for await (const event of runner.run(
    //   'What is the weather like in New York?',
    // )) {
    //   events.push(event);
    // }
    // fs.writeFileSync(
    //   path.join(__dirname, 'real_events_1.json'),
    //   JSON.stringify(events),
    // );
    // events = [];
    // for await (const event of runner.run('What time is it in New York?')) {
    //   events.push(event);
    // }
    // fs.writeFileSync(
    //   path.join(__dirname, 'real_events_2.json'),
    //   JSON.stringify(events),
    // );

    await runTestCase({
      agent: remoteA2AAgent,
      turns: [
        {
          userPrompt: 'What is the weather like in New York?',
          expectedEvents: turn1ExpectedEvents as Event[],
        },
        {
          userPrompt: 'What time is it in New York?',
          expectedEvents: turn2ExpectedEvents as Event[],
        },
      ],
    });
  });
});
