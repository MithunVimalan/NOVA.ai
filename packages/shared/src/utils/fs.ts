import fs from 'node:fs';
import path from 'node:path';

export interface WalkFilesOptions {
  extensions?: string[];
  skipDirectories?: string[];
}

const DEFAULT_SKIPPED_DIRECTORIES = ['node_modules', '.git', 'dist'];

/**
 * Creates a directory (and parents) when it does not exist yet.
 */
export function ensureDir(dirPath: string): string {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

/**
 * Deletes a file when it exists, ignoring failures (best-effort cleanup).
 */
export function removeFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup only.
  }
}

/**
 * Reads and parses a JSON file, returning the fallback value when the file is
 * missing or cannot be parsed.
 */
export function readJsonFile<T>(filePath: string, fallback: T, logLabel: string): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    console.error(`${logLabel} Error reading ${filePath}, using defaults:`, err);
    return fallback;
  }
}

/**
 * Serializes a value to a JSON file, logging instead of throwing on failure.
 */
export function writeJsonFile(filePath: string, data: unknown, logLabel: string): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`${logLabel} Error writing ${filePath}:`, err);
  }
}

/**
 * Recursively yields file paths under a directory, skipping build/vcs folders
 * and optionally filtering by extension.
 */
export function* walkFiles(dirPath: string, options: WalkFilesOptions = {}): Generator<string> {
  const skipDirectories = options.skipDirectories ?? DEFAULT_SKIPPED_DIRECTORIES;
  if (!fs.existsSync(dirPath)) return;

  for (const item of fs.readdirSync(dirPath)) {
    const fullPath = path.join(dirPath, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (skipDirectories.includes(item)) continue;
      yield* walkFiles(fullPath, options);
    } else if (stat.isFile()) {
      const ext = path.extname(item).toLowerCase();
      if (options.extensions && !options.extensions.includes(ext)) continue;
      yield fullPath;
    }
  }
}
