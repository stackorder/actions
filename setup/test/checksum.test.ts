import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectedChecksum, sha256File, verifyChecksum } from '../src/checksum';

const helloSha = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';
const otherSha = 'a'.repeat(64);

describe('expectedChecksum', () => {
  const checksums = [
    `${otherSha}  stackorder_1.2.3_darwin_arm64.tar.gz`,
    `${helloSha}  stackorder_1.2.3_linux_amd64.tar.gz`,
    `${'B'.repeat(64)} *stackorder_1.2.3_windows_amd64.zip`,
    `${'c'.repeat(64)}  stackorder_1.2.3_linux_amd64.tar.gz.sbom.json`,
    '',
  ].join('\r\n');

  it.each([
    ['stackorder_1.2.3_linux_amd64.tar.gz', helloSha],
    ['stackorder_1.2.3_darwin_arm64.tar.gz', otherSha],
    ['stackorder_1.2.3_windows_amd64.zip', 'b'.repeat(64)],
  ])('finds the entry for %s', (file, expected) => {
    expect(expectedChecksum(checksums, file)).toBe(expected);
  });

  it('fails when the file is not listed', () => {
    expect(() => expectedChecksum(checksums, 'stackorder_1.2.3_linux_arm64.tar.gz')).toThrow(
      'The release checksums file has no SHA-256 entry for stackorder_1.2.3_linux_arm64.tar.gz',
    );
  });

  it('ignores malformed lines', () => {
    expect(() => expectedChecksum('deadbeef  stackorder.tar.gz\n', 'stackorder.tar.gz')).toThrow('no SHA-256 entry');
  });
});

describe('file hashing', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stackorder-checksum-'));
    file = join(dir, 'archive.tar.gz');
    await writeFile(file, 'hello\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('computes the SHA-256 of a file', async () => {
    await expect(sha256File(file)).resolves.toBe(helloSha);
  });

  it('accepts a matching checksum', async () => {
    await expect(verifyChecksum(file, 'archive.tar.gz', `${helloSha}  archive.tar.gz\n`)).resolves.toBeUndefined();
  });

  it('rejects a mismatching checksum', async () => {
    await expect(verifyChecksum(file, 'archive.tar.gz', `${otherSha}  archive.tar.gz\n`)).rejects.toThrow(
      `Checksum mismatch for archive.tar.gz: expected ${otherSha}, got ${helloSha}`,
    );
  });
});
