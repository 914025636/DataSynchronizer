import { promises as fsp } from 'fs';

// Antivirus and indexing services briefly lock fresh files on Windows, failing replace-renames
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export async function renameWithRetry(from: string, to: string, attempts = 10, delayMs = 50): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code || '';
      if (attempt >= attempts || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * delayMs));
    }
  }
}
