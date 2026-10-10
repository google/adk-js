/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

exports.status = () => 'native-addon-ok';

exports.loadBinding = () => {
  return require('./binding.node');
};
