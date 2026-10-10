/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Strict Content-Security-Policy, injected at build time only (the Vite dev
 * server needs inline styles for hot reload). Pages cannot set HTTP headers, so
 * a meta tag is the only option; frame-ancestors is not honoured in meta.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self' https://api.anthropic.com",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'kassa-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<!-- CSP -->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

/**
 * Generate sw.js with the list of built files so the whole app shell is
 * precached and works offline. Cache name changes with every build.
 */
function serviceWorker(): Plugin {
  return {
    name: 'kassa-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = ['./', './index.html', ...Object.keys(bundle).map((f) => `./${f}`)];
      const extra = ['./manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];
      const version = Date.now().toString(36);
      const source = `// Generated at build time. Precaches the app shell; never caches API calls.
const CACHE = 'kassa-${version}';
const ASSETS = ${JSON.stringify([...new Set([...files, ...extra])])};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).catch(() => caches.match('./index.html'))),
  );
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), csp(), serviceWorker()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0, // no data: URIs, which the CSP forbids
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
