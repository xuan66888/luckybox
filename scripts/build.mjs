import { build } from 'esbuild';
import { mkdir, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = path.resolve(projectRoot, 'dist');
if (path.resolve(process.cwd()) !== projectRoot || path.dirname(outputDirectory) !== projectRoot || path.basename(outputDirectory) !== 'dist') throw new Error('Build must run from the project root and target its generated dist directory.');
// Clear only the verified generated output, including assets from older editions.
await rm(outputDirectory, { recursive: true, force: true });
await mkdir('dist/public', { recursive: true });
await build({ entryPoints: ['src/server.ts', 'src/cli.ts'], bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', outdir: 'dist', sourcemap: true });
await cp('public', 'dist/public', { recursive: true });
await build({ entryPoints: ['src/client.ts'], bundle: true, platform: 'browser', target: 'es2022', outfile: 'dist/public/app.js', minify: true });
await cp('migrations', 'dist/migrations', { recursive: true });
console.log('Production server, browser assets and migrations built.');
