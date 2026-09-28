import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checksumEnabled, run } from '../src/main';
import { LATEST_RELEASE_URL } from '../src/version';

const http = vi.hoisted(() => ({ get: vi.fn(), dispose: vi.fn() }));
const inputs = vi.hoisted(() => new Map<string, string>());

vi.mock('@actions/core', () => ({
  getInput: vi.fn((name: string) => inputs.get(name) ?? ''),
  setOutput: vi.fn(),
  addPath: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@actions/tool-cache', () => {
  class HTTPError extends Error {
    constructor(readonly httpStatusCode: number | undefined) {
      super(`Unexpected HTTP response: ${String(httpStatusCode)}`);
    }
  }
  return {
    HTTPError,
    find: vi.fn(),
    downloadTool: vi.fn(),
    extractTar: vi.fn(),
    extractZip: vi.fn(),
    cacheDir: vi.fn(),
  };
});

vi.mock('@actions/http-client', () => ({
  HttpClient: vi.fn(function HttpClient() {
    return http;
  }),
}));

const releaseBase = 'https://github.com/stackorder/stackorder/releases/download';
const toolCache = '/opt/hostedtoolcache/stackorder';
const archiveBytes = 'stackorder archive bytes';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let dir: string;
let assets: Map<string, string>;

async function extractedDir(binary: string | undefined): Promise<string> {
  const target = join(dir, 'extracted');
  await mkdir(target, { recursive: true });
  if (binary !== undefined) {
    await writeFile(join(target, binary), '#!/bin/sh\n');
  }
  return target;
}

function publish(version: string, archive: string, checksum = sha256(archiveBytes)): void {
  assets.set(`${releaseBase}/v${version}/${archive}`, archiveBytes);
  assets.set(
    `${releaseBase}/v${version}/stackorder_${version}_checksums.txt`,
    `${'0'.repeat(64)}  stackorder_${version}_other_arch.tar.gz\n${checksum}  ${archive}\n`,
  );
}

function downloadedUrls(): string[] {
  return vi.mocked(tc.downloadTool).mock.calls.map(([url]) => url);
}

function downloadedPaths(): string[] {
  return vi.mocked(tc.downloadTool).mock.calls.map(([, dest]) => dest ?? '');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stackorder-setup-'));
  http.get.mockReset();
  assets = new Map();
  inputs.clear();
  inputs.set('version', '1.2.3');
  inputs.set('token', 'ghs_token');
  inputs.set('checksum', 'true');
  vi.stubEnv('RUNNER_TEMP', dir);

  vi.mocked(tc.find).mockReturnValue('');
  vi.mocked(tc.downloadTool).mockImplementation(async (url: string, dest?: string) => {
    const body = assets.get(url);
    if (body === undefined) {
      throw new tc.HTTPError(404);
    }
    if (dest === undefined) {
      throw new Error(`downloadTool called without a destination for ${url}`);
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, body);
    return dest;
  });
  vi.mocked(tc.extractTar).mockImplementation(() => extractedDir('stackorder'));
  vi.mocked(tc.extractZip).mockImplementation(() => extractedDir('stackorder.exe'));
  vi.mocked(tc.cacheDir).mockImplementation((_source, tool, version, arch) =>
    Promise.resolve(join('/opt/hostedtoolcache', tool, version, arch ?? '')),
  );
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('run', () => {
  it('installs a pinned version, verifies it and exposes version and path', async () => {
    inputs.set('version', 'v1.2.3');
    publish('1.2.3', 'stackorder_1.2.3_linux_amd64.tar.gz');

    await run('linux', 'x64');

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(http.get).not.toHaveBeenCalled();
    expect(downloadedUrls()).toEqual([
      `${releaseBase}/v1.2.3/stackorder_1.2.3_linux_amd64.tar.gz`,
      `${releaseBase}/v1.2.3/stackorder_1.2.3_checksums.txt`,
    ]);
    expect(tc.extractTar).toHaveBeenCalledWith(downloadedPaths()[0]);
    expect(tc.cacheDir).toHaveBeenCalledWith(join(dir, 'extracted'), 'stackorder', '1.2.3', 'amd64');
    expect(core.addPath).toHaveBeenCalledWith(`${toolCache}/1.2.3/amd64`);
    expect(core.setOutput).toHaveBeenCalledWith('version', '1.2.3');
    expect(core.setOutput).toHaveBeenCalledWith('path', `${toolCache}/1.2.3/amd64/stackorder`);
  });

  it('resolves latest through the releases API before downloading', async () => {
    inputs.set('version', 'latest');
    http.get.mockResolvedValue({
      message: { statusCode: 200 },
      readBody: () => Promise.resolve(JSON.stringify({ tag_name: 'v2.0.1' })),
    });
    publish('2.0.1', 'stackorder_2.0.1_darwin_arm64.tar.gz');

    await run('darwin', 'arm64');

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(http.get).toHaveBeenCalledWith(
      LATEST_RELEASE_URL,
      expect.objectContaining({ authorization: 'Bearer ghs_token' }),
    );
    expect(downloadedUrls()[0]).toBe(`${releaseBase}/v2.0.1/stackorder_2.0.1_darwin_arm64.tar.gz`);
    expect(core.setOutput).toHaveBeenCalledWith('version', '2.0.1');
    expect(core.setOutput).toHaveBeenCalledWith('path', `${toolCache}/2.0.1/arm64/stackorder`);
  });

  it('fails without installing when the checksum does not match', async () => {
    publish('1.2.3', 'stackorder_1.2.3_linux_amd64.tar.gz', 'f'.repeat(64));

    await run('linux', 'x64');

    expect(core.setFailed).toHaveBeenCalledWith(
      `Checksum mismatch for stackorder_1.2.3_linux_amd64.tar.gz: expected ${'f'.repeat(64)}, got ${sha256(archiveBytes)}; the download is corrupt or has been tampered with`,
    );
    expect(tc.extractTar).not.toHaveBeenCalled();
    expect(tc.cacheDir).not.toHaveBeenCalled();
    expect(core.addPath).not.toHaveBeenCalled();
    expect(core.setOutput).not.toHaveBeenCalled();
  });

  it('fails when the checksums file does not list the archive', async () => {
    publish('1.2.3', 'stackorder_1.2.3_linux_amd64.tar.gz');
    assets.set(`${releaseBase}/v1.2.3/stackorder_1.2.3_checksums.txt`, '');

    await run('linux', 'x64');

    expect(core.setFailed).toHaveBeenCalledWith(
      'The release checksums file has no SHA-256 entry for stackorder_1.2.3_linux_amd64.tar.gz',
    );
    expect(core.addPath).not.toHaveBeenCalled();
  });

  it('skips the checksums file when checksum is false', async () => {
    inputs.set('checksum', 'false');
    assets.set(`${releaseBase}/v1.2.3/stackorder_1.2.3_linux_arm64.tar.gz`, archiveBytes);

    await run('linux', 'arm64');

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(downloadedUrls()).toEqual([`${releaseBase}/v1.2.3/stackorder_1.2.3_linux_arm64.tar.gz`]);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Skipping checksum verification'));
    expect(core.setOutput).toHaveBeenCalledWith('path', `${toolCache}/1.2.3/arm64/stackorder`);
  });

  it('downloads each asset under its own name in a fresh directory of RUNNER_TEMP', async () => {
    publish('1.2.3', 'stackorder_1.2.3_linux_amd64.tar.gz');

    await run('linux', 'x64');

    const paths = downloadedPaths();
    expect(paths.map((path) => basename(path))).toEqual([
      'stackorder_1.2.3_linux_amd64.tar.gz',
      'stackorder_1.2.3_checksums.txt',
    ]);
    expect(paths.map((path) => dirname(dirname(path)))).toEqual([dir, dir]);
    expect(new Set(paths.map((path) => dirname(path))).size).toBe(2);
  });

  it('downloads and extracts the zip archive on windows', async () => {
    publish('1.2.3', 'stackorder_1.2.3_windows_amd64.zip');

    await run('win32', 'x64');

    expect(core.setFailed).not.toHaveBeenCalled();
    const [archivePath = ''] = downloadedPaths();
    expect(basename(archivePath)).toBe('stackorder_1.2.3_windows_amd64.zip');
    expect(tc.extractZip).toHaveBeenCalledWith(archivePath);
    expect(tc.extractTar).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('path', join(`${toolCache}/1.2.3/amd64`, 'stackorder.exe'));
  });

  it('reuses a cached installation without downloading', async () => {
    vi.mocked(tc.find).mockReturnValue(`${toolCache}/1.2.3/amd64`);

    await run('linux', 'x64');

    expect(tc.find).toHaveBeenCalledWith('stackorder', '1.2.3', 'amd64');
    expect(tc.downloadTool).not.toHaveBeenCalled();
    expect(core.addPath).toHaveBeenCalledWith(`${toolCache}/1.2.3/amd64`);
    expect(core.setOutput).toHaveBeenCalledWith('path', `${toolCache}/1.2.3/amd64/stackorder`);
  });

  it('fails with the asset URL when the release does not exist', async () => {
    inputs.set('version', '0.0.0-none');

    await run('linux', 'x64');

    expect(core.setFailed).toHaveBeenCalledWith(
      `Could not download stackorder 0.0.0-none for linux/amd64 from ${releaseBase}/v0.0.0-none/stackorder_0.0.0-none_linux_amd64.tar.gz: HTTP 404, release v0.0.0-none or its asset stackorder_0.0.0-none_linux_amd64.tar.gz does not exist`,
    );
    expect(core.setOutput).not.toHaveBeenCalled();
  });

  it('reports other download errors verbatim', async () => {
    vi.mocked(tc.downloadTool).mockRejectedValue(new Error('socket hang up'));

    await run('linux', 'x64');

    expect(core.setFailed).toHaveBeenCalledWith(
      `Could not download stackorder 1.2.3 for linux/amd64 from ${releaseBase}/v1.2.3/stackorder_1.2.3_linux_amd64.tar.gz: socket hang up`,
    );
  });

  it('fails when the archive does not contain the binary', async () => {
    publish('1.2.3', 'stackorder_1.2.3_linux_amd64.tar.gz');
    vi.mocked(tc.extractTar).mockImplementation(() => extractedDir(undefined));

    await run('linux', 'x64');

    expect(core.setFailed).toHaveBeenCalledWith('stackorder_1.2.3_linux_amd64.tar.gz does not contain stackorder');
    expect(tc.cacheDir).not.toHaveBeenCalled();
  });

  it('fails on an unsupported runner before any network call', async () => {
    await run('linux', 'ia32');

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Unsupported runner architecture "ia32"'));
    expect(tc.downloadTool).not.toHaveBeenCalled();
  });

  it('fails on an invalid version input', async () => {
    inputs.set('version', 'main');

    await run('linux', 'x64');

    expect(core.setFailed).toHaveBeenCalledWith('Invalid stackorder version "main": expected latest, 1.2.3 or v1.2.3');
  });
});

describe('checksumEnabled', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['', true],
    ['false', false],
    [' False ', false],
  ])('parses %j as %s', (input, expected) => {
    expect(checksumEnabled(input)).toBe(expected);
  });

  it('rejects anything else', () => {
    expect(() => checksumEnabled('no')).toThrow('Invalid checksum input "no": expected true or false');
  });
});
