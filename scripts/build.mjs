import { build } from 'esbuild';
import { mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
await build({ entryPoints: ['src/admin-entry.ts'], bundle: true, platform: 'browser', target: 'es2022', outfile: 'dist/public/admin.js', minify: true });
await cp('migrations', 'dist/migrations', { recursive: true });
// Stable public filenames remain available, but every HTML entry uses content-addressed URLs.
// This invalidates browser/CDN module caches on deployment without weakening cache security.
for (const entry of ['index.html','admin/index.html']) {
  const filename=path.join(outputDirectory,'public',entry);
  let html=await readFile(filename,'utf8');
  for (const match of [...html.matchAll(/(?:src|href)="(\/[^"?]+\.(?:js|css))"/g)]) {
    const url=match[1],file=path.join(outputDirectory,'public',url.slice(1));
    const version=createHash('sha256').update(await readFile(file)).digest('hex').slice(0,16);
    html=html.replaceAll('"'+url+'"','"'+url+'?v='+version+'"');
  }
  await writeFile(filename,html);
}
console.log('Production server, browser assets and migrations built.');
