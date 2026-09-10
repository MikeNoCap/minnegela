// MapLibre GL ≥ 6 runs its tile work in a module worker that it loads by URL, relative to the script that imported
// the library. Bundled by Next that URL points nowhere (and the copied asset imports an unhashed sibling), so the
// map stays blank. We serve the worker and its shared module from /maplibre/ instead; MapExplorer sets the URL.
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(require.resolve('maplibre-gl/package.json')), 'dist');
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'maplibre');
mkdirSync(out, { recursive: true });
for (const f of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) copyFileSync(path.join(dist, f), path.join(out, f));
