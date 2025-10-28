// vite.config.ts
// Summary: Vite configuration for the Tanks for Nothing browser client. Serves the public HTML
//          pages in multi-page mode, bundles the Three.js game entry point and provides predictable
//          hashed asset output consumed by the Express server.
// Structure: load environment -> derive server/preview settings -> declare rollup inputs/output
//            -> expose root/public/build/alias/server/preview configuration.
// Usage: Invoked via the workspace npm scripts (dev/build/preview). Environment variables such as
//        CLIENT_PORT, CLIENT_HOST and CLIENT_PREVIEW_PORT customise runtime ports; CLIENT_OPEN_BROWSER
//        toggles automatic browser launching during development.
// ---------------------------------------------------------------------------
import { defineConfig, loadEnv } from 'vite';
import { basename, extname, resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const rootDir = resolve(__dirname, 'public');
  const srcDir = resolve(__dirname, 'src');
  const host = env.CLIENT_HOST ?? '0.0.0.0';
  const port = Number(env.CLIENT_PORT ?? env.PORT ?? '5173');
  const previewPort = Number(env.CLIENT_PREVIEW_PORT ?? env.PREVIEW_PORT ?? '4173');
  const sharedSrcDir = resolve(__dirname, '../shared/src');
  const sharedEntry = resolve(sharedSrcDir, 'index.ts');

  return {
    root: rootDir,
    publicDir: false,
    appType: 'mpa',
    build: {
      outDir: resolve(__dirname, 'dist'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: resolve(rootDir, 'index.html'),
          login: resolve(rootDir, 'login.html'),
          signup: resolve(rootDir, 'signup.html')
        },
        output: {
          entryFileNames: 'js/[name]-[hash].js',
          chunkFileNames: 'js/[name]-[hash].js',
          assetFileNames: (assetInfo) => {
            const fileExt = extname(assetInfo.name ?? '');
            const baseName = basename(assetInfo.name ?? 'asset', fileExt || undefined);
            if (fileExt === '.css') {
              return `css/${baseName}-[hash]${fileExt}`;
            }
            return `assets/${baseName}-[hash]${fileExt}`;
          }
        }
      }
    },
    resolve: {
      alias: {
        '/src': srcDir,
        '@tanksfornothing/shared': sharedEntry
      }
    },
    server: {
      host,
      port,
      strictPort: false,
      open: env.CLIENT_OPEN_BROWSER === 'true',
      fs: {
        allow: [srcDir, sharedSrcDir, resolve(__dirname)]
      }
    },
    preview: {
      host,
      port: previewPort,
      strictPort: false
    }
  };
});
