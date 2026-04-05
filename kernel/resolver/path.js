import { existsSync, mkdirSync, cpSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

const EXCLUDE = new Set(['node_modules', '.git', 'test', '.DS_Store']);

/**
 * Resolve a path: bundle source by copying bundle files to the target directory.
 * Copies all files except node_modules, .git, and test directories.
 */
export function resolvePath(source, targetDir, mountPlanDir) {
  const relativePath = source.replace(/^path:/, '');
  const absolutePath = resolve(mountPlanDir, relativePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Bundle path does not exist: ${absolutePath} (from ${source})`);
  }

  mkdirSync(targetDir, { recursive: true });

  // Copy all bundle files and directories except excluded ones
  for (const entry of readdirSync(absolutePath)) {
    if (EXCLUDE.has(entry)) continue;
    const src = join(absolutePath, entry);
    const dst = join(targetDir, entry);
    const stat = statSync(src);
    if (stat.isDirectory()) {
      cpSync(src, dst, { recursive: true });
    } else {
      cpSync(src, dst);
    }
  }

  console.log(`[resolver] Copied ${absolutePath} -> ${targetDir}`);
}
