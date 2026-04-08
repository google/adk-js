/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

function getHumidity(location: string): string {
  console.log(`Fetching live humidity for ${location}...`);
  return '45% (Simulated)';
}

const location = process.argv[2] ?? 'Mountain View';

console.log(getHumidity(location));
