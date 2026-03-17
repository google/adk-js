/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RemoteA2AAgent} from '@google/adk';

const port = process.env.TEST_API_SERVER_PORT || '40000';

export const rootAgent = new RemoteA2AAgent({
  name: 'multi_hop',
  agentCard: `http://localhost:${port}/a2a/multi_hop/`,
});
