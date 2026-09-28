export type Os = 'linux' | 'darwin' | 'windows';
export type Arch = 'amd64' | 'arm64';

export interface Target {
  os: Os;
  arch: Arch;
}

const operatingSystems: Partial<Record<string, Os>> = {
  linux: 'linux',
  darwin: 'darwin',
  win32: 'windows',
};

const architectures: Partial<Record<string, Arch>> = {
  x64: 'amd64',
  arm64: 'arm64',
};

export const RELEASE_DOWNLOAD_URL = 'https://github.com/stackorder/stackorder/releases/download';

export function resolveTarget(platform: string, arch: string): Target {
  const os = operatingSystems[platform];
  if (!os) {
    throw new Error(
      `Unsupported runner platform "${platform}": stackorder publishes binaries for linux, darwin and windows`,
    );
  }
  const goArch = architectures[arch];
  if (!goArch) {
    throw new Error(
      `Unsupported runner architecture "${arch}": stackorder publishes binaries for x64 (amd64) and arm64`,
    );
  }
  return { os, arch: goArch };
}

export function archiveName(version: string, target: Target): string {
  const extension = target.os === 'windows' ? 'zip' : 'tar.gz';
  return `stackorder_${version}_${target.os}_${target.arch}.${extension}`;
}

export function checksumsName(version: string): string {
  return `stackorder_${version}_checksums.txt`;
}

export function binaryName(target: Target): string {
  return target.os === 'windows' ? 'stackorder.exe' : 'stackorder';
}

export function releaseAssetUrl(version: string, file: string): string {
  return `${RELEASE_DOWNLOAD_URL}/v${version}/${file}`;
}
