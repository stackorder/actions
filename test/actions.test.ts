import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface ActionMetadata {
  name?: string;
  description?: string;
  author?: string;
  branding?: {
    icon?: string;
    color?: string;
  };
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  runs?: {
    using?: string;
    main?: string;
  };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readAction(relativePath: string): ActionMetadata {
  return parse(readFileSync(resolve(repoRoot, relativePath), 'utf8')) as ActionMetadata;
}

describe('root action.yml', () => {
  const rootAction = readAction('action.yml');
  const setupAction = readAction('setup/action.yml');

  it('has valid GitHub Marketplace metadata', () => {
    expect(rootAction.name).toBe('Set up Stackorder');
    expect(rootAction.description).toBeTruthy();
    expect(rootAction.description?.length).toBeLessThanOrEqual(125);
    expect(rootAction.author).toBe('Stackorder');
    expect(rootAction.branding).toEqual(setupAction.branding);
    expect(rootAction.branding).toEqual({ icon: 'layers', color: 'orange' });
  });

  it('matches setup/action.yml inputs, outputs and runtime', () => {
    expect(rootAction.inputs).toEqual(setupAction.inputs);
    expect(rootAction.outputs).toEqual(setupAction.outputs);
    expect(rootAction.runs?.using).toBe(setupAction.runs?.using);
  });

  it('resolves to the same built entrypoint as setup/action.yml', () => {
    const rootMain = resolve(repoRoot, rootAction.runs?.main ?? '');
    const setupMain = resolve(repoRoot, 'setup', setupAction.runs?.main ?? '');

    expect(rootMain).toBe(setupMain);
    expect(existsSync(rootMain)).toBe(true);
  });
});
