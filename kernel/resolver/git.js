import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Validate a git ref to prevent injection via crafted ref strings.
 * Allows alphanumeric characters plus . _ - /
 */
function validateRef(ref) {
  if (!/^[a-zA-Z0-9._\-\/]+$/.test(ref)) {
    throw new Error(`Invalid git ref: '${ref}' — contains illegal characters`);
  }
}

/**
 * Resolve a git+https:// or git+ssh:// bundle source to a local directory.
 * Clones on first fetch, does git fetch + checkout on subsequent runs.
 */
export function resolveGit(source, targetDir) {
  const parsed = parseGitSource(source);
  if (!parsed) throw new Error(`Invalid git source: ${source}`);

  const { repoUrl, ref } = parsed;
  validateRef(ref);

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
    console.log(`[resolver] Cloning ${repoUrl} ...`);
    execFileSync('git', ['clone', '--quiet', repoUrl, targetDir], { stdio: 'pipe' });
  } else {
    console.log(`[resolver] Fetching ${repoUrl} ...`);
    execFileSync('git', ['-C', targetDir, 'fetch', '--quiet', '--all'], { stdio: 'pipe' });
  }

  // Checkout the requested ref
  try {
    execFileSync('git', ['-C', targetDir, 'checkout', '--quiet', ref], { stdio: 'pipe' });
  } catch {
    // If ref is a remote branch, try origin/<ref>
    execFileSync('git', ['-C', targetDir, 'checkout', '--quiet', `origin/${ref}`], { stdio: 'pipe' });
  }

  // Get the resolved commit SHA
  const commit = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { commit, ref };
}

/**
 * Update a previously resolved git bundle (ignore cache, re-fetch).
 */
export function updateGit(source, targetDir) {
  const parsed = parseGitSource(source);
  if (!parsed) throw new Error(`Invalid git source: ${source}`);

  validateRef(parsed.ref);

  if (existsSync(targetDir)) {
    execFileSync('git', ['-C', targetDir, 'fetch', '--quiet', '--all'], { stdio: 'pipe' });
  } else {
    return resolveGit(source, targetDir);
  }

  try {
    execFileSync('git', ['-C', targetDir, 'checkout', '--quiet', parsed.ref], { stdio: 'pipe' });
  } catch {
    execFileSync('git', ['-C', targetDir, 'checkout', '--quiet', `origin/${parsed.ref}`], { stdio: 'pipe' });
  }

  // For branches, pull to latest
  try {
    execFileSync('git', ['-C', targetDir, 'pull', '--quiet', '--ff-only'], { stdio: 'pipe' });
  } catch {
    // Not on a branch (detached HEAD from tag/SHA) — that's fine
  }

  const commit = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { commit, ref: parsed.ref };
}

function parseGitSource(source) {
  // git+https://github.com/org/repo.git@ref
  // git+ssh://git@github.com:org/repo.git@ref
  const match = source.match(/^git\+(.+?)@([^@]+)$/);
  if (!match) return null;
  return { repoUrl: match[1], ref: match[2] };
}
