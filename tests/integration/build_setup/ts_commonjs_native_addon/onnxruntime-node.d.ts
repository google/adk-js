declare module 'onnxruntime-node' {
  const nativeAddon: {
    status(): string;
  };

  export default nativeAddon;
}
