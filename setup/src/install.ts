import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import { verifyChecksum } from './checksum';
import { errorMessage } from './errors';
import { archiveName, binaryName, checksumsName, releaseAssetUrl, type Target } from './platform';

export const TOOL_NAME = 'stackorder';

export interface Installation {
  version: string;
  dir: string;
  binary: string;
}

export async function install(version: string, target: Target, verify: boolean): Promise<Installation> {
  const binary = binaryName(target);
  const found = tc.find(TOOL_NAME, version, target.arch);
  if (found !== '') {
    core.info(`Using stackorder ${version} from the tool cache at ${found}`);
    return { version, dir: found, binary: join(found, binary) };
  }

  const archive = archiveName(version, target);
  const archivePath = await download(version, target, archive);
  if (verify) {
    const checksumsPath = await download(version, target, checksumsName(version));
    await verifyChecksum(archivePath, archive, await readFile(checksumsPath, 'utf8'));
    core.info(`Verified the SHA-256 checksum of ${archive}`);
  } else {
    core.warning(`Skipping checksum verification of ${archive} because the checksum input is false`);
  }

  const extracted = target.os === 'windows' ? await tc.extractZip(archivePath) : await tc.extractTar(archivePath);
  if (!existsSync(join(extracted, binary))) {
    throw new Error(`${archive} does not contain ${binary}`);
  }
  const dir = await tc.cacheDir(extracted, TOOL_NAME, version, target.arch);
  return { version, dir, binary: join(dir, binary) };
}

async function download(version: string, target: Target, file: string): Promise<string> {
  const url = releaseAssetUrl(version, file);
  core.info(`Downloading ${url}`);
  const dest = join(process.env['RUNNER_TEMP'] || tmpdir(), randomUUID(), file);
  try {
    return await tc.downloadTool(url, dest);
  } catch (error) {
    const reason =
      error instanceof tc.HTTPError && error.httpStatusCode === 404
        ? `HTTP 404, release v${version} or its asset ${file} does not exist`
        : errorMessage(error);
    const context = `Could not download stackorder ${version} for ${target.os}/${target.arch} from ${url}`;
    throw new Error(`${context}: ${reason}`, { cause: error });
  }
}
