/** Package deployment source only. Runtime data, credentials and dependencies never enter the archive. */
import { readFileSync, readdirSync, mkdirSync, lstatSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.name !== 'bottle-server-for-cortico-world' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw Error('Unexpected server manifest');
if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== 'v' + manifest.version) throw Error('Tag and package version differ');
const output = resolve(root, 'release');
mkdirSync(output, { recursive: true });
const files = [];
function collect(path) {
  const full = join(root, path), stat = lstatSync(full);
  if (stat.isSymbolicLink()) throw Error('Symlinks are not deployment source: ' + path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(full).sort()) collect(path + '/' + name);
    return;
  }
  const allowed = /^(?:server\/[a-z][a-zA-Z0-9-]*\.ts|server\/public\/index\.html|shared\/[a-z][a-zA-Z0-9-]*\.ts|deploy\/(?:README\.md|[a-z][a-z0-9-]*\.(?:sh|service|timer)))$/;
  if (!stat.isFile() || !allowed.test(path)) throw Error('Unexpected deployment file: ' + path);
  files.push(path);
}
for (const folder of ['server', 'shared', 'deploy']) collect(folder);
for (const file of ['package.json', 'README.md', 'SECURITY.md', 'LICENSE']) {
  if (!lstatSync(join(root, file)).isFile()) throw Error('Missing deployment file: ' + file);
  files.push(file);
}
files.sort();
for (const file of ['server/main.ts','server/app.ts','server/db.ts','shared/contract.ts','shared/stationery.ts','deploy/bottle-backup.sh']) {
  if (!files.includes(file)) throw Error('Missing runtime file: ' + file);
}
function tar(args) {
  const result = spawnSync('tar', args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(result.error?.message ?? result.stderr.toString());
  return result.stdout;
}
const archive = 'bottle-server-' + manifest.version + '.tgz';
const archivePath = join(output, archive);
tar(['-czf', archivePath, '--', ...files]);
const actual = tar(['-tzf', archivePath]).toString('utf8').trim().split(/\r?\n/);
if (JSON.stringify(actual) !== JSON.stringify(files)) throw Error('Archive file list differs from the inspected source');
for (const file of files) {
  if (!tar(['-xOf', archivePath, file]).equals(readFileSync(join(root, file)))) throw Error('Archived bytes differ: ' + file);
}
const bytes = readFileSync(archivePath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const report = { name: manifest.name, version: manifest.version, archive, bytes: bytes.length, sha256, files };
writeFileSync(join(output, 'package-check.json'), JSON.stringify(report, null, 2) + '\n');
writeFileSync(join(output, 'SHA256SUMS'), sha256 + '  ' + archive + '\n');
console.log(JSON.stringify({ ...report, files: files.length, output: relative(root, output) }, null, 2));
