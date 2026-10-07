import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const API = process.env.SPINROOM_API_URL ?? 'http://127.0.0.1:8080';

/**
 * Strict CSP for production builds: only our origin plus the Spotify SDK and image domains.
 * (Dev mode needs Vite's inline preamble, so the policy is added at build time only.)
 */
function csp(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self' https://sdk.scdn.co",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://i.scdn.co https://*.scdn.co https://*.spotifycdn.com https://mosaic.scdn.co",
    "font-src 'self'",
    "connect-src 'self' ws: wss: https://api.spotify.com https://*.spotify.com",
    'frame-src https://sdk.scdn.co',
    "media-src 'self' blob: https://*.scdn.co",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    name: 'spinroom-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

export default defineConfig({
  plugins: [react(), csp()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/v1': { target: API, ws: true, changeOrigin: false, xfwd: true } },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: { '/v1': { target: API, ws: true, changeOrigin: false, xfwd: true } },
  },
  build: { target: 'es2022', sourcemap: true, assetsInlineLimit: 2048 },
});
