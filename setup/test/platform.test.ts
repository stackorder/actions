import { describe, expect, it } from 'vitest';
import { archiveName, binaryName, checksumsName, releaseAssetUrl, resolveTarget, type Target } from '../src/platform';

describe('resolveTarget', () => {
  it.each([
    ['linux', 'x64', { os: 'linux', arch: 'amd64' }],
    ['linux', 'arm64', { os: 'linux', arch: 'arm64' }],
    ['darwin', 'x64', { os: 'darwin', arch: 'amd64' }],
    ['darwin', 'arm64', { os: 'darwin', arch: 'arm64' }],
    ['win32', 'x64', { os: 'windows', arch: 'amd64' }],
    ['win32', 'arm64', { os: 'windows', arch: 'arm64' }],
  ])('maps %s/%s', (platform, arch, expected) => {
    expect(resolveTarget(platform, arch)).toEqual(expected);
  });

  it.each(['freebsd', 'aix', 'sunos', 'android'])('rejects platform %s', (platform) => {
    expect(() => resolveTarget(platform, 'x64')).toThrow(`Unsupported runner platform "${platform}"`);
  });

  it.each(['ia32', 'arm', 's390x', 'ppc64', 'riscv64'])('rejects architecture %s', (arch) => {
    expect(() => resolveTarget('linux', arch)).toThrow(`Unsupported runner architecture "${arch}"`);
  });
});

describe('release asset names', () => {
  it.each<[Target, string, string]>([
    [{ os: 'linux', arch: 'amd64' }, 'stackorder_1.2.3_linux_amd64.tar.gz', 'stackorder'],
    [{ os: 'linux', arch: 'arm64' }, 'stackorder_1.2.3_linux_arm64.tar.gz', 'stackorder'],
    [{ os: 'darwin', arch: 'arm64' }, 'stackorder_1.2.3_darwin_arm64.tar.gz', 'stackorder'],
    [{ os: 'windows', arch: 'amd64' }, 'stackorder_1.2.3_windows_amd64.zip', 'stackorder.exe'],
    [{ os: 'windows', arch: 'arm64' }, 'stackorder_1.2.3_windows_arm64.zip', 'stackorder.exe'],
  ])('names the archive and binary for %o', (target, archive, binary) => {
    expect(archiveName('1.2.3', target)).toBe(archive);
    expect(binaryName(target)).toBe(binary);
  });

  it('names the checksums file', () => {
    expect(checksumsName('1.2.3-rc.1')).toBe('stackorder_1.2.3-rc.1_checksums.txt');
  });

  it('builds download URLs under the v-prefixed tag', () => {
    expect(releaseAssetUrl('1.2.3', 'stackorder_1.2.3_checksums.txt')).toBe(
      'https://github.com/stackorder/stackorder/releases/download/v1.2.3/stackorder_1.2.3_checksums.txt',
    );
  });
});
