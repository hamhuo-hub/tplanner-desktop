// Derive the app version from git tags that have actually been PUSHED.
//
// The git tag is the single source of truth, and only a tag that exists on the remote
// counts: a tag created locally but never pushed must not produce a release-versioned
// artifact, or you end up with a build claiming to be v1.2.3 while nothing upstream has
// that tag. When the tag cannot be verified the version degrades to `-dev`, which is the
// honest answer.
//
//   HEAD exactly on a pushed desktop-v* tag -> "4.2.0"
//   HEAD after a desktop-v* tag             -> "4.2.0-dev" (+ "-dirty" when the tree is dirty)
//   tag missing upstream / no git           -> "4.0.0-dev"
//
// Release tags in this repository are namespaced `desktop-v<major>.<minor>.<patch>`.
// The namespace is required: the tags were renamed when this repository was split out of
// the monorepo, and mobile-* / server-* tags live in their own repositories now.
//
// The module only COMPUTES a version; writing it into package.json is the packaging and
// release scripts' job (scripts/package.mjs, scripts/release-bump.mjs).
//
// Usage:
//   node scripts/version.mjs            prints the version to stdout
//   import { computeVersion } from ...  returns the version string
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FALLBACK = '4.0.0';
const REMOTE = process.env.TPLANNER_RELEASE_REMOTE || 'origin';

// Every git call runs against this project, never against whatever directory the caller
// happened to be in. Without it, `node path/to/scripts/version.mjs` from another checkout
// would derive the version from THAT repository's tags — and package.mjs would then stamp
// that foreign version into package.json.
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
    try {
        // A missing exact tag is expected for development commits. Capture Git's diagnostic
        // so a successful dev build does not print "fatal".
        return execFileSync('git', args, {
            cwd: rootDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return '';
    }
}

/** True when `refs/tags/<tag>` exists on the remote. Offline or unknown remote means false. */
export function tagIsPushed(tag, remote = REMOTE) {
    if (!tag) return false;
    try {
        execFileSync('git', ['ls-remote', '--tags', '--exit-code', remote, `refs/tags/${tag}`], {
            cwd: rootDir,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Every tag name that exists on the remote, using ONE network round trip.
 * Returns an empty list when the remote is unreachable — callers must treat that as
 * "nothing is verified as released" rather than as "there are no releases".
 */
export function listPushedTags(remote = REMOTE) {
    try {
        const out = execFileSync('git', ['ls-remote', '--tags', '--refs', remote], {
            cwd: rootDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.split('\n')
            .map((line) => line.split('refs/tags/')[1])
            .filter(Boolean)
            .map((name) => name.replace(/\^\{\}$/, ''));
    } catch {
        return [];
    }
}

/** Highest `desktop-v*` version present on the remote, or null when none is reachable. */
export function latestPushedVersion(remote = REMOTE) {
    const versions = listPushedTags(remote)
        .filter((name) => /^desktop-v\d/.test(name))
        .map(parseSemver)
        .filter(Boolean);
    if (versions.length === 0) return null;
    versions.sort((a, b) => (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch));
    return versions[versions.length - 1];
}

const semverRe = /^(?:[A-Za-z]+[_-])?v?(\d+)\.(\d+)\.(\d+)/;

function parseSemver(text) {
    if (!text) return null;
    const m = semverRe.exec(text.trim());
    return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.requirePushed=true] require the exact tag to exist on the remote
 * @param {boolean} [options.quiet=false]        suppress the reason for a degraded version
 */
export function computeVersion({ requirePushed = true, quiet = false } = {}) {
    const exactTag = git(['describe', '--tags', '--match', 'desktop-v*', '--exact-match']);
    const exact = parseSemver(exactTag);
    const nearest = parseSemver(git(['describe', '--tags', '--match', 'desktop-v*', '--always']));
    const dirty = git(['status', '--porcelain']) !== '';

    const parts = exact ?? nearest ?? (() => {
        const [major, minor, patch] = FALLBACK.split('.').map(Number);
        return { major, minor, patch };
    })();

    const released = exact !== null && (!requirePushed || tagIsPushed(exactTag));
    if (!quiet) {
        if (exact !== null && !released) {
            console.warn(`version: ${exactTag} is not on ${REMOTE}; building a -dev version instead`);
        } else if (exact === null) {
            console.warn('version: HEAD is not on a release tag; building a -dev version');
        }
    }

    const text = `${parts.major}.${parts.minor}.${parts.patch}`;
    return released ? text : `${text}-dev${dirty ? '-dirty' : ''}`;
}

const isDirectRun = process.argv[1]
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
    console.log(computeVersion());
}
