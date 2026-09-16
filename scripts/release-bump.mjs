// Tag-driven release helper (npm run release -- <patch|minor|major|x.y.z>).
//
//   npm run release -- patch
//   npm run release -- 4.3.0
//
// The release tag is the version's source of truth and only a PUSHED tag counts, so the
// workflow ends with a push:
//
//   1. commit the version into package.json  — the repository records what was released
//   2. create the annotated tag              — the build derives its version from this
//   3. push both                             — until the tag is on the remote, a build at
//                                              this commit produces `X.Y.Z-dev`
//
// The baseline comes from the tags already on the remote (scripts/version.mjs), never from
// package.json, so a stray local edit cannot invent a version.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestPushedVersion } from './version.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE = process.env.TPLANNER_RELEASE_REMOTE || 'origin';

function git(args) {
  try {
    return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function gitOrFail(args, what) {
  try {
    execFileSync('git', args, { cwd: rootDir, stdio: 'inherit' });
  } catch {
    console.error(`error: ${what} failed: git ${args.join(' ')}`);
    process.exit(1);
  }
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const arg = process.argv[2] ?? 'patch';

// 1. The tree must be clean, or the release commit would sweep in unrelated work.
const status = git(['status', '--porcelain']);
if (status) fail(`working tree is dirty; commit or discard changes first:\n${status}`);

// 2. Baseline = highest v* tag already on the remote.
const cur = latestPushedVersion(REMOTE);
console.log(cur
  ? `current released version: ${cur.major}.${cur.minor}.${cur.patch} (from ${REMOTE})`
  : `no v* tag found on ${REMOTE}; pass an explicit version`);

// 3. Next version.
let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg.split('.').map(Number);
} else if (cur) {
  next = [cur.major, cur.minor, cur.patch];
  if (arg === 'patch') next[2] += 1;
  else if (arg === 'minor') { next[1] += 1; next[2] = 0; }
  else if (arg === 'major') { next[0] += 1; next[1] = 0; next[2] = 0; }
  else fail('usage: npm run release -- patch | minor | major | x.y.z');
} else {
  fail(`pass an explicit version, e.g. npm run release -- 8.2.0`);
}

const version = next.join('.');
const current = cur ? `${cur.major}.${cur.minor}.${cur.patch}` : null;
if (current && version === current) fail(`next version ${version} equals the current release`);
if (current) {
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  if (cmp(next, [cur.major, cur.minor, cur.patch]) <= 0) {
    fail(`next version ${version} is not higher than current ${current}`);
  }
}

const tag = `v${version}`;
if (git(['tag', '-l', tag])) fail(`tag ${tag} already exists locally`);

// 4. Record the version in package.json, so the repository says what was released.
const pkgPath = join(rootDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const previous = pkg.version;
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`package.json: ${previous} -> ${version}`);

// 5. Announce the branch (releases are usually tagged on master, but this is not enforced).
const branch = git(['branch', '--show-current']);
if (branch !== 'master') console.warn(`warning: current branch is ${branch} (usually master)`);

// 6. Commit the version, then create the annotated tag on that commit.
gitOrFail(['add', 'package.json'], 'staging package.json');
gitOrFail(['commit', '-m', `release: ${tag}`], 'committing the version');
gitOrFail(['tag', '-a', tag, '-m', `Release ${tag}`], 'creating the tag');

console.log('');
console.log(`released ${tag} locally (package.json committed, annotated tag created).`);
console.log('until the tag is pushed, any build here reports a -dev version. Push both:');
console.log(`  git push ${REMOTE} ${branch} ${tag}`);
