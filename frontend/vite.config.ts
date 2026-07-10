import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as fs from 'node:fs';
import * as path from 'node:path';
export default defineConfig(() => {
  return {
    plugins: [
      react(),
      {
        name: 'scribe-asset-manifest',
        writeBundle(options, bundle) {
          if (!options.dir) return;
          const assets = Object.keys(bundle)
            .filter((f) => f.startsWith('assets/'))
            .map((f) => '/' + f);
          fs.writeFileSync(
            path.join(options.dir, 'asset-manifest.json'),
            JSON.stringify(assets),
          );
        },
      },
    ],
    server: {
      port: 5173,
      proxy: {
        '/api': 'http://localhost:3030',
      },
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        output: {
          manualChunks(id) {
            const featureChunks = ['chat', 'rewrite', 'rag', 'export', 'review'];
            for (const name of featureChunks) {
              if (id.includes(`/features/${name}/`)) return name;
            }
          },
        },
      },
    },
  };
});
