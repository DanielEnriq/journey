// The renderer has no bundler, so the build copies livekit-client's self-contained ESM bundle to
// dist/renderer/vendor/livekit-client.js. This re-export gives that path the package's types.
export * from 'livekit-client';
