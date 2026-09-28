import * as core from '@actions/core';
import { errorMessage } from './errors';
import { install } from './install';
import { resolveTarget } from './platform';
import { resolveVersion } from './version';

export function checksumEnabled(input: string): boolean {
  const value = input.trim().toLowerCase();
  if (value === '' || value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`Invalid checksum input "${input}": expected true or false`);
}

export async function run(platform: string = process.platform, arch: string = process.arch): Promise<void> {
  try {
    const target = resolveTarget(platform, arch);
    const verify = checksumEnabled(core.getInput('checksum'));
    const version = await resolveVersion(core.getInput('version'), core.getInput('token'));
    const installation = await install(version, target, verify);
    core.addPath(installation.dir);
    core.setOutput('version', installation.version);
    core.setOutput('path', installation.binary);
    core.info(`Installed stackorder ${installation.version} for ${target.os}/${target.arch} at ${installation.binary}`);
  } catch (error) {
    core.setFailed(errorMessage(error));
  }
}
