import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isLatest, LATEST_RELEASE_URL, normalizeVersion, resolveVersion } from '../src/version';

const http = vi.hoisted(() => ({ get: vi.fn(), dispose: vi.fn() }));

vi.mock('@actions/http-client', () => ({
  HttpClient: vi.fn(function HttpClient() {
    return http;
  }),
}));

function respond(statusCode: number, body: unknown): void {
  http.get.mockResolvedValue({
    message: { statusCode },
    readBody: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

beforeEach(() => {
  http.get.mockReset();
  http.dispose.mockReset();
});

describe('normalizeVersion', () => {
  it.each([
    ['1.2.3', '1.2.3'],
    ['v1.2.3', '1.2.3'],
    ['  v1.2.3\n', '1.2.3'],
    ['0.10.0', '0.10.0'],
    ['1.2.3-rc.1', '1.2.3-rc.1'],
    ['v0.0.0-none', '0.0.0-none'],
    ['1.2.3+build.5', '1.2.3+build.5'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeVersion(input)).toBe(expected);
  });

  it.each(['1.2', 'v', 'vv1.2.3', '1.2.3.4', '01.2.3', 'latest', 'main', 'V1.2.3', '1.2.3-', ''])(
    'rejects %j',
    (input) => {
      expect(() => normalizeVersion(input)).toThrow(`Invalid stackorder version "${input}"`);
    },
  );
});

describe('isLatest', () => {
  it.each([
    ['latest', true],
    ['LATEST', true],
    [' latest ', true],
    ['', true],
    ['1.2.3', false],
    ['v1.2.3', false],
  ])('%j is latest: %s', (input, expected) => {
    expect(isLatest(input)).toBe(expected);
  });
});

describe('resolveVersion', () => {
  it('returns a pinned version without calling the API', async () => {
    await expect(resolveVersion('v1.2.3', 'token')).resolves.toBe('1.2.3');
    expect(http.get).not.toHaveBeenCalled();
  });

  it('resolves latest from the releases API with the token', async () => {
    respond(200, { tag_name: 'v2.0.1', name: 'v2.0.1' });
    await expect(resolveVersion('latest', 'ghs_token')).resolves.toBe('2.0.1');
    expect(http.get).toHaveBeenCalledWith(
      LATEST_RELEASE_URL,
      expect.objectContaining({ authorization: 'Bearer ghs_token', accept: 'application/vnd.github+json' }),
    );
    expect(http.dispose).toHaveBeenCalled();
  });

  it('omits the authorization header when no token is given', async () => {
    respond(200, { tag_name: 'v2.0.1' });
    await resolveVersion('', '');
    const headers = http.get.mock.calls[0]?.[1] as Record<string, string>;
    expect(headers).not.toHaveProperty('authorization');
  });

  it.each([
    [404, { message: 'Not Found' }, 'No stackorder release found: GET https://api.github.com/repos/stackorder/stackorder/releases/latest returned 404: Not Found'],
    [401, { message: 'Bad credentials' }, 'GitHub rejected the token while resolving the latest stackorder release (401: Bad credentials)'],
    [403, { message: 'API rate limit exceeded' }, 'GitHub refused to resolve the latest stackorder release (403: API rate limit exceeded)'],
    [502, '<html>bad gateway</html>', 'Could not resolve the latest stackorder release: GET https://api.github.com/repos/stackorder/stackorder/releases/latest returned 502'],
  ])('fails clearly on HTTP %i', async (status, body, message) => {
    respond(status, body);
    await expect(resolveVersion('latest', 'token')).rejects.toThrow(message);
  });

  it('fails when the release has no tag_name', async () => {
    respond(200, { name: 'untagged' });
    await expect(resolveVersion('latest', 'token')).rejects.toThrow('returned no tag_name');
  });

  it('fails when the release tag is not a version', async () => {
    respond(200, { tag_name: 'nightly' });
    await expect(resolveVersion('latest', 'token')).rejects.toThrow('Invalid stackorder version "nightly"');
  });

  it('fails clearly when the API is unreachable', async () => {
    http.get.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));
    await expect(resolveVersion('latest', 'token')).rejects.toThrow(
      `Could not reach ${LATEST_RELEASE_URL} to resolve the latest stackorder release: getaddrinfo ENOTFOUND api.github.com`,
    );
  });
});
