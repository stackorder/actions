import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  run?: string;
}

interface Workflow {
  jobs: Record<string, { steps: Step[] }>;
}

interface Context {
  github: { sha: string; event: Record<string, unknown> };
  inputs?: Record<string, unknown>;
  matrix?: Record<string, unknown>;
}

interface StepResult {
  outputs: Record<string, string>;
  stdout: string;
}

const MERGE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';
const PUSH_SHA = '3333333333333333333333333333333333333333';

const DEFAULT_ROLE = 'arn:aws:iam::123456789012:role/default';
const PLAN_ROLE = 'arn:aws:iam::123456789012:role/plan';
const PREFIX_ROLE = 'arn:aws:iam::123456789012:role/prefix';
const INSTANCE_ROLE = 'arn:aws:iam::123456789012:role/instance';
const EXACT_ROLE = 'arn:aws:iam::123456789012:role/exact';

function readWorkflow(name: string): Workflow {
  return parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')) as Workflow;
}

function lookup(context: Context, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined),
      context,
    );
}

function evaluate(template: string | undefined, context: Context): string {
  if (template === undefined) {
    return '';
  }
  const expression = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(template)?.[1];
  if (expression === undefined) {
    return template;
  }
  for (const operand of expression.split('||').map((part) => part.trim())) {
    if (!/^[\w-]+(\.[\w-]+)*$/.test(operand)) {
      throw new Error(`unsupported expression: ${template}`);
    }
    const value = lookup(context, operand);
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return '';
}

function checkedOutCommit(workflow: Workflow, job: string, context: Context): string {
  const step = workflow.jobs[job]?.steps.find((candidate) => candidate.uses?.startsWith('actions/checkout@'));
  if (step === undefined) {
    throw new Error(`job ${job} has no actions/checkout step`);
  }
  return evaluate(step.with?.ref, context) || context.github.sha;
}

function findStep(workflow: Workflow, job: string, name: string): Step {
  const step = workflow.jobs[job]?.steps.find((candidate) => candidate.name === name);
  if (step?.run === undefined) {
    throw new Error(`job ${job} has no run step named ${name}`);
  }
  return step;
}

function runStep(workflow: Workflow, job: string, name: string, context: Context): StepResult {
  const step = findStep(workflow, job, name);
  const dir = mkdtempSync(join(tmpdir(), 'stackorder-step-'));
  try {
    const output = join(dir, 'output');
    const env = Object.fromEntries(
      Object.entries(step.env ?? {}).map(([key, value]) => [key, evaluate(value, context)]),
    );
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run ?? ''], {
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...env },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`step ${name} exited ${String(result.status)}: ${result.stderr}`);
    }
    const lines = readFileSync(output, 'utf8').split('\n').filter((line) => line !== '');
    const outputs = Object.fromEntries(
      lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    return { outputs, stdout: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function applyContext(roleMap: Record<string, string>, key: string, instance = ''): Context {
  const [stack = key] = key.split(':');
  return {
    github: { sha: PUSH_SHA, event: {} },
    inputs: {
      mode: 'apply',
      'aws-role-arn-map': JSON.stringify(roleMap),
      'aws-role-arn': DEFAULT_ROLE,
      'aws-plan-role-arn': PLAN_ROLE,
    },
    matrix: { key, stack, instance, workspace: '' },
  };
}

function withInputs(context: Context, inputs: Record<string, unknown>): Context {
  return { ...context, inputs: { ...context.inputs, ...inputs } };
}

describe('plan.yml', () => {
  const workflow = readWorkflow('plan.yml');

  it('scans the pull request head in the resolve job, the commit plan jobs check out', () => {
    const context: Context = {
      github: {
        sha: MERGE_SHA,
        event: { pull_request: { head: { sha: HEAD_SHA, repo: { fork: false } } } },
      },
    };

    const scanned = checkedOutCommit(workflow, 'resolve', context);
    const planned = checkedOutCommit(workflow, 'plan', { ...context, matrix: { sha: HEAD_SHA } });

    expect(scanned).toBe(HEAD_SHA);
    expect(planned).toBe(scanned);
  });

  it("scans the event's commit in the resolve job outside pull requests", () => {
    const context: Context = { github: { sha: PUSH_SHA, event: {} } };

    expect(checkedOutCommit(workflow, 'resolve', context)).toBe(PUSH_SHA);
  });
});

describe('Select AWS role', () => {
  const run = readWorkflow('run.yml');
  const plan = readWorkflow('plan.yml');
  const selectedRole = (context: Context): string => runStep(run, 'run', 'Select AWS role', context).outputs.arn ?? '';

  it('runs the same script in run.yml and plan.yml', () => {
    expect(findStep(plan, 'plan', 'Select AWS role').run).toBe(findStep(run, 'run', 'Select AWS role').run);
  });

  it('matches a prefix on whole path segments', () => {
    expect(selectedRole(applyContext({ 'stacks/prod/': PREFIX_ROLE }, 'stacks/prod/vpc'))).toBe(PREFIX_ROLE);
    expect(selectedRole(applyContext({ 'stacks/prod': PREFIX_ROLE }, 'stacks/prod/vpc'))).toBe(PREFIX_ROLE);
    expect(selectedRole(applyContext({ 'stacks/pro': PREFIX_ROLE }, 'stacks/prod/vpc'))).toBe(DEFAULT_ROLE);
  });

  it('prefers the longest matching prefix', () => {
    const roleMap = { 'stacks/': DEFAULT_ROLE.replace('default', 'stacks'), 'stacks/prod/': PREFIX_ROLE };

    expect(selectedRole(applyContext(roleMap, 'stacks/prod/vpc'))).toBe(PREFIX_ROLE);
  });

  it('prefers an exact key, then :instance, then the longest prefix', () => {
    const roleMap = { 'infra/': PREFIX_ROLE, ':production': INSTANCE_ROLE, 'infra/kyc:production': EXACT_ROLE };

    expect(selectedRole(applyContext(roleMap, 'infra/kyc:production', 'production'))).toBe(EXACT_ROLE);
    expect(selectedRole(applyContext(roleMap, 'infra/dns:production', 'production'))).toBe(INSTANCE_ROLE);
    expect(selectedRole(applyContext(roleMap, 'infra/kyc:staging', 'staging'))).toBe(PREFIX_ROLE);
  });

  it('matches :instance in every directory', () => {
    const roleMap = { ':staging': INSTANCE_ROLE };

    expect(selectedRole(applyContext(roleMap, 'infra/kyc:staging', 'staging'))).toBe(INSTANCE_ROLE);
    expect(selectedRole(applyContext(roleMap, 'infra/dns:staging', 'staging'))).toBe(INSTANCE_ROLE);
    expect(selectedRole(applyContext(roleMap, 'infra/kyc:production', 'production'))).toBe(DEFAULT_ROLE);
  });

  it('reads the workspace as the instance of an entry without one', () => {
    const context = applyContext({ ':blue': INSTANCE_ROLE }, 'stacks/sandbox/blue:blue');

    expect(selectedRole({ ...context, matrix: { ...context.matrix, workspace: 'blue' } })).toBe(INSTANCE_ROLE);
  });

  it('falls back to aws-role-arn, then to no role, when no key matches', () => {
    const context = applyContext({ 'stacks/prod/': PREFIX_ROLE }, 'stacks/staging/vpc');
    const none = runStep(run, 'run', 'Select AWS role', withInputs(context, { 'aws-role-arn': '' }));

    expect(selectedRole(context)).toBe(DEFAULT_ROLE);
    expect(none.outputs.arn).toBe('');
    expect(none.stdout).toContain('::notice::No AWS role for stacks/staging/vpc');
  });

  it.each(['plan', 'drift'])('ignores the map for %s dispatches and assumes the plan role', (mode) => {
    const context = withInputs(applyContext({ 'infra/kyc:production': EXACT_ROLE }, 'infra/kyc:production', 'production'), { mode });

    expect(selectedRole(context)).toBe(PLAN_ROLE);
    expect(selectedRole(withInputs(context, { 'aws-plan-role-arn': '' }))).toBe(DEFAULT_ROLE);
  });

  it('uses the map for pull request plans', () => {
    const context = applyContext({ ':production': INSTANCE_ROLE }, 'infra/kyc:production', 'production');

    expect(runStep(plan, 'plan', 'Select AWS role', context).outputs.arn).toBe(INSTANCE_ROLE);
  });
});

describe('Select AWS role session name', () => {
  const run = readWorkflow('run.yml');
  const plan = readWorkflow('plan.yml');
  const sessionName = (workflow: Workflow, job: string, mode: string, name: string): string =>
    runStep(workflow, job, 'Select AWS role session name', {
      github: { sha: PUSH_SHA, event: {} },
      inputs: { mode, 'aws-role-session-name': name },
    }).outputs.name ?? '';

  it('runs the same script in run.yml and plan.yml', () => {
    expect(findStep(plan, 'plan', 'Select AWS role session name').run).toBe(
      findStep(run, 'run', 'Select AWS role session name').run,
    );
  });

  it('passes a plain name through for every mode', () => {
    for (const mode of ['plan', 'apply', 'drift']) {
      expect(sessionName(run, 'run', mode, 'stackorder-kyc')).toBe('stackorder-kyc');
    }
    expect(sessionName(plan, 'plan', '', 'stackorder-kyc')).toBe('stackorder-kyc');
  });

  it('picks the name for the mode from a JSON object, drift falling back to plan', () => {
    const names = JSON.stringify({ plan: 'kyc-plan', apply: 'kyc-apply' });

    expect(sessionName(run, 'run', 'plan', names)).toBe('kyc-plan');
    expect(sessionName(run, 'run', 'apply', names)).toBe('kyc-apply');
    expect(sessionName(run, 'run', 'drift', names)).toBe('kyc-plan');
    expect(sessionName(run, 'run', 'drift', JSON.stringify({ plan: 'kyc-plan', drift: 'kyc-drift' }))).toBe('kyc-drift');
    expect(sessionName(plan, 'plan', 'apply', names)).toBe('kyc-plan');
    expect(sessionName(run, 'run', 'apply', JSON.stringify({ plan: 'kyc-plan' }))).toBe('');
  });

  it('replaces characters outside [\\w+=,.@-] and cuts the name to 64 characters', () => {
    expect(sessionName(run, 'run', 'apply', 'stackorder infra/kyc:production')).toBe('stackorder-infra-kyc-production');
    expect(sessionName(run, 'run', 'apply', 'café')).toBe('caf--');
    expect(sessionName(run, 'run', 'apply', 'a+b=c,d.e@f_g-h')).toBe('a+b=c,d.e@f_g-h');
    expect(sessionName(run, 'run', 'apply', 'x'.repeat(100))).toBe('x'.repeat(64));
  });

  it('is empty when the input is empty, so configure-aws-credentials keeps its default', () => {
    expect(sessionName(run, 'run', 'apply', '')).toBe('');
  });
});
