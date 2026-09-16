import type { NextConfig } from 'next';

const config: NextConfig = {
  // The whole product is authenticated, tenant-scoped data. Nothing here should
  // ever be prerendered at build time or cached at the edge.
  reactStrictMode: true,

  // postgres.js and node:crypto must stay on the server. Marking them external
  // keeps the bundler from attempting a browser shim, which would fail loudly
  // at build — better than succeeding and shipping a broken polyfill.
  serverExternalPackages: ['postgres'],

  // Emit .next/standalone so the container image carries a traced server and
  // its runtime dependencies instead of the whole node_modules tree. On a
  // product that holds decrypted client credentials, the build toolchain,
  // test runner and type definitions have no business being in the image that
  // runs in production.
  output: 'standalone',

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // A credential vault must never be framed: clickjacking a reveal
          // button is a realistic attack on this product specifically.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // Revealed secrets must not reach a browser or proxy cache.
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default config;
