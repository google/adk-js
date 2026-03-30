/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
declare module 'onnxruntime-node' {
  const nativeAddon: {
    status(): string;
  };

  export default nativeAddon;
}
