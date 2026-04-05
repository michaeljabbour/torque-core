import { existsSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const CACHE_DIR = '.bundles';

export function ensureCacheDir() {
  mkdirSync(CACHE_DIR, { recursive: true });
}

export function cachePath(bundleName) {
  return join(CACHE_DIR, bundleName);
}

export function isCached(bundleName) {
  return existsSync(cachePath(bundleName));
}

export function isCacheFresh(bundleName, lockEntry) {
  const dir = cachePath(bundleName);
  if (!existsSync(dir)) return false;
  if (!lockEntry?.commit) return false;

  try {
    const currentCommit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    return currentCommit === lockEntry.commit;
  } catch {
    return false;
  }
}

export function clearCache(bundleName) {
  const dir = cachePath(bundleName);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function listCached() {
  ensureCacheDir();
  return readdirSync(CACHE_DIR).filter(f => !f.startsWith('.'));
}
