import { HttpClient } from '@actions/http-client';
import { errorMessage } from './errors';

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/stackorder/stackorder/releases/latest';

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function isLatest(input: string): boolean {
  const value = input.trim().toLowerCase();
  return value === '' || value === 'latest';
}

export function normalizeVersion(input: string): string {
  const bare = input.trim().replace(/^v/, '');
  if (!semver.test(bare)) {
    throw new Error(`Invalid stackorder version "${input}": expected latest, 1.2.3 or v1.2.3`);
  }
  return bare;
}

export async function resolveVersion(input: string, token: string): Promise<string> {
  return isLatest(input) ? resolveLatestVersion(token) : normalizeVersion(input);
}

export async function resolveLatestVersion(token: string): Promise<string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (token !== '') {
    headers.authorization = `Bearer ${token}`;
  }

  const client = new HttpClient('stackorder-setup');
  let status: number;
  let body: string;
  try {
    const response = await client.get(LATEST_RELEASE_URL, headers);
    status = response.message.statusCode ?? 0;
    body = await response.readBody();
  } catch (error) {
    const context = `Could not reach ${LATEST_RELEASE_URL} to resolve the latest stackorder release`;
    throw new Error(`${context}: ${errorMessage(error)}`, { cause: error });
  } finally {
    client.dispose();
  }

  if (status !== 200) {
    throw new Error(latestReleaseError(status, field(body, 'message') ?? ''));
  }

  const tag = field(body, 'tag_name');
  if (tag === undefined) {
    throw new Error(`GET ${LATEST_RELEASE_URL} returned no tag_name; pin a version with the version input`);
  }
  return normalizeVersion(tag);
}

function latestReleaseError(status: number, message: string): string {
  const detail = message === '' ? '' : `: ${message}`;
  switch (status) {
    case 404:
      return `No stackorder release found: GET ${LATEST_RELEASE_URL} returned 404${detail}`;
    case 401:
      return `GitHub rejected the token while resolving the latest stackorder release (401${detail}); on GitHub Enterprise Server pass a github.com token in the token input or pin a version`;
    case 403:
    case 429:
      return `GitHub refused to resolve the latest stackorder release (${status}${detail}); pass a token in the token input or pin a version`;
    default:
      return `Could not resolve the latest stackorder release: GET ${LATEST_RELEASE_URL} returned ${status}${detail}`;
  }
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function field(body: string, name: string): string | undefined {
  const value: unknown = parse(body);
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const entry: unknown = (value as Record<string, unknown>)[name];
  return typeof entry === 'string' && entry !== '' ? entry : undefined;
}
