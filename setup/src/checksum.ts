import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const line = /^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/;

export function expectedChecksum(checksums: string, file: string): string {
  for (const entry of checksums.split(/\r?\n/)) {
    const match = line.exec(entry.trim());
    if (match?.[1] !== undefined && match[2] === file) {
      return match[1].toLowerCase();
    }
  }
  throw new Error(`The release checksums file has no SHA-256 entry for ${file}`);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export async function verifyChecksum(path: string, file: string, checksums: string): Promise<void> {
  const expected = expectedChecksum(checksums, file);
  const actual = await sha256File(path);
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${file}: expected ${expected}, got ${actual}; the download is corrupt or has been tampered with`,
    );
  }
}
