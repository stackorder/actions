import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  on: { workflow_call: { inputs: Record<string, unknown>; secrets?: Record<string, { required?: boolean }> } };
  jobs: Record<string, { steps: Step[] }>;
}

interface Context {
  github: { sha: string; event: Record<string, unknown> };
  inputs?: Record<string, unknown>;
  matrix?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
}

interface StepResult {
  outputs: Record<string, string>;
  stdout: string;
}

interface StepRun {
  status: number | null;
  outputs: Record<string, string>;
  env: string;
  stdout: string;
  stderr: string;
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

function findUses(workflow: Workflow, job: string, action: string): Step {
  const step = workflow.jobs[job]?.steps.find((candidate) => candidate.uses?.startsWith(`${action}@`));
  if (step === undefined) {
    throw new Error(`job ${job} has no ${action} step`);
  }
  return step;
}

function checkedOutCommit(workflow: Workflow, job: string, context: Context): string {
  return evaluate(findUses(workflow, job, 'actions/checkout').with?.ref, context) || context.github.sha;
}

function findStep(workflow: Workflow, job: string, name: string): Step {
  const step = workflow.jobs[job]?.steps.find((candidate) => candidate.name === name);
  if (step?.run === undefined) {
    throw new Error(`job ${job} has no run step named ${name}`);
  }
  return step;
}

function execStep(workflow: Workflow, job: string, name: string, context: Context): StepRun {
  const step = findStep(workflow, job, name);
  const dir = mkdtempSync(join(tmpdir(), 'stackorder-step-'));
  try {
    const output = join(dir, 'output');
    const githubEnv = join(dir, 'env');
    writeFileSync(output, '');
    writeFileSync(githubEnv, '');
    const env = Object.fromEntries(
      Object.entries(step.env ?? {}).map(([key, value]) => [key, evaluate(value, context)]),
    );
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run ?? ''], {
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_ENV: githubEnv, ...env },
      encoding: 'utf8',
    });
    const lines = readFileSync(output, 'utf8').split('\n').filter((line) => line !== '');
    const outputs = Object.fromEntries(
      lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    return { status: result.status, outputs, env: readFileSync(githubEnv, 'utf8'), stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runStep(workflow: Workflow, job: string, name: string, context: Context): StepResult {
  const result = execStep(workflow, job, name, context);
  if (result.status !== 0) {
    throw new Error(`step ${name} exited ${String(result.status)}: ${result.stdout}${result.stderr}`);
  }
  return { outputs: result.outputs, stdout: result.stdout };
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

  it.each([
    { workflow: run, job: 'run', mode: 'apply', name: 'x' },
    { workflow: run, job: 'run', mode: 'apply', name: '/' },
    { workflow: run, job: 'run', mode: 'drift', name: JSON.stringify({ plan: 'x' }) },
    { workflow: plan, job: 'plan', mode: 'plan', name: 'x' },
  ])('fails on a one-character name for $job $mode from $name', ({ workflow, job, mode, name }) => {
    expect(() => sessionName(workflow, job, mode, name)).toThrow(/aws-role-session-name must be 2 to 64 characters/);
  });

  it('accepts a two-character name', () => {
    expect(sessionName(run, 'run', 'apply', 'xy')).toBe('xy');
  });
});

describe('AWS credentials and plugin cache steps', () => {
  const run = readWorkflow('run.yml');
  const plan = readWorkflow('plan.yml');

  it.each(['aws-actions/configure-aws-credentials', 'actions/cache'])('%s has the same inputs in run.yml and plan.yml', (action) => {
    const inRun = findUses(run, 'run', action);
    const inPlan = findUses(plan, 'plan', action);

    expect(inPlan.uses).toBe(inRun.uses);
    expect(inPlan.with).toEqual(inRun.with);
  });

  it.each([
    { workflow: run, job: 'run' },
    { workflow: plan, job: 'plan' },
  ])('$job keys the cache on the lock file under working-directory and names the role session', ({ workflow, job }) => {
    expect(findUses(workflow, job, 'actions/cache').with?.key).toContain(
      "hashFiles(format('{0}/{1}/.terraform.lock.hcl', inputs.working-directory, matrix.stack))",
    );
    expect(findUses(workflow, job, 'aws-actions/configure-aws-credentials').with?.['role-session-name']).toBe(
      '${{ steps.session.outputs.name }}',
    );
  });
});

describe('Export env', () => {
  const run = readWorkflow('run.yml');
  const plan = readWorkflow('plan.yml');
  const exportEnv = (input: string, secret = ''): StepRun =>
    execStep(run, 'run', 'Export env', {
      github: { sha: PUSH_SHA, event: {} },
      inputs: { env: input },
      secrets: { env: secret },
    });

  it('runs the same script in run.yml and plan.yml', () => {
    expect(findStep(plan, 'plan', 'Export env').run).toBe(findStep(run, 'run', 'Export env').run);
    expect(findStep(plan, 'plan', 'Export env').env).toEqual(findStep(run, 'run', 'Export env').env);
  });

  it.each([
    { workflow: run, job: 'run' },
    { workflow: plan, job: 'plan' },
  ])('runs in $job after stackorder is installed and before AWS credentials', ({ workflow, job }) => {
    const steps = workflow.jobs[job]?.steps ?? [];
    const index = steps.findIndex((step) => step.name === 'Export env');
    const setup = steps.findIndex((step) => step.uses?.startsWith('stackorder/actions/setup@'));
    const credentials = steps.findIndex((step) => step.uses?.startsWith('aws-actions/configure-aws-credentials@'));

    expect(setup).toBeGreaterThanOrEqual(0);
    expect(index).toBeGreaterThan(setup);
    expect(index).toBeLessThan(credentials);
  });

  it('is not in the resolve job', () => {
    expect(plan.jobs.resolve?.steps.some((step) => step.name === 'Export env')).toBe(false);
  });

  it.each([
    { workflow: run, name: 'run.yml' },
    { workflow: plan, name: 'plan.yml' },
  ])('declares an optional env input and env secret in $name', ({ workflow }) => {
    expect(workflow.on.workflow_call.inputs.env).toMatchObject({ type: 'string', default: '' });
    expect(workflow.on.workflow_call.secrets?.env?.required).toBe(false);
  });

  it('exports nothing when both are empty', () => {
    const result = exportEnv('');

    expect(result.status).toBe(0);
    expect(result.env).toBe('');
    expect(result.stdout).toBe('');
  });

  it('exports KEY=VALUE lines, skipping blank lines, and keeps = and << in values', () => {
    const result = exportEnv('TF_VAR_region=eu-west-1\n\n  \nTF_LOG=\nQUERY=a=b<<c\r\n');

    expect(result.status).toBe(0);
    expect(result.env).toBe('TF_VAR_region=eu-west-1\nTF_LOG=\nQUERY=a=b<<c\n');
    expect(result.stdout).toBe('');
  });

  it('exports a multi-line value with its delimiter', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQ==\n-----END PRIVATE KEY-----';
    const result = exportEnv(`TLS_KEY<<EOF\n${pem}\nEOF\nNEXT=1`);

    expect(result.status).toBe(0);
    expect(result.env).toBe(`TLS_KEY<<EOF\n${pem}\nEOF\nNEXT=1\n`);
  });

  it('keeps empty and blank lines inside a multi-line value, and accepts an empty one', () => {
    const result = exportEnv('A<<X=Y\n\nline\n\nX=Y\nB<<EOF\nEOF');

    expect(result.status).toBe(0);
    expect(result.env).toBe('A<<X=Y\n\nline\n\nX=Y\nB<<EOF\nEOF\n');
  });

  it('exports the input before the secret, so the secret wins for the same name', () => {
    const result = exportEnv('TF_VAR_token=public', 'TF_VAR_token=private');

    expect(result.env).toBe('TF_VAR_token=public\nTF_VAR_token=private\n');
  });

  it('masks every value line of the secret, escaping %, and nothing of the input', () => {
    const result = exportEnv('VISIBLE=plain', 'CLOUDFLARE_API_TOKEN=abc%0Adef\nEMPTY=\nKEY<<EOF\nline one\n\nline two\nEOF');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('::add-mask::abc%250Adef\n::add-mask::line one\n::add-mask::line two\n');
    expect(result.env).toBe('VISIBLE=plain\nCLOUDFLARE_API_TOKEN=abc%0Adef\nEMPTY=\nKEY<<EOF\nline one\n\nline two\nEOF\n');
  });

  it.each([
    'GITHUB_TOKEN',
    'github_path',
    'RUNNER_TEMP',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'STACKORDER_RUN_ID',
    'STACKORDER_TOOL',
    'stackorder_plan_dir',
    'PATH',
    'Path',
    'HOME',
    'NODE_OPTIONS',
    'BASH_ENV',
    'BASHOPTS',
    'SHELLOPTS',
    'PS4',
    'LD_PRELOAD',
    'ld_library_path',
  ])('refuses %s, naming it, and exports nothing', (name) => {
    const result = exportEnv(`TF_VAR_ok=1\n${name}=x`);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`::error::The env input sets ${name}, a reserved name`);
    expect(result.env).toBe('');
  });

  it('refuses a reserved name that starts a multi-line value in the secret, masking the value', () => {
    const result = exportEnv('', 'PATH<<EOF\n/tmp/evil\nEOF');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::add-mask::/tmp/evil\n');
    expect(result.stdout).toContain('::error::The env secret sets PATH, a reserved name');
    expect(result.env).toBe('');
  });

  it('reports every reserved name, from both sources', () => {
    const result = exportEnv('HOME=/root', 'GITHUB_TOKEN=x');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::The env input sets HOME');
    expect(result.stdout).toContain('::error::The env secret sets GITHUB_TOKEN');
  });

  it.each([
    { text: 'no separator here', error: 'Line 1 of the env secret is neither KEY=VALUE nor KEY<<DELIMITER' },
    { text: 'OK=1\n1BAD=x', error: 'Line 2 of the env secret does not start with a variable name' },
    { text: 'MY VAR=x', error: 'Line 1 of the env secret does not start with a variable name' },
    { text: '=x', error: 'Line 1 of the env secret does not start with a variable name' },
    { text: 'KEY<<', error: 'Line 1 of the env secret starts a multi-line value with no delimiter' },
    { text: 'OK=1\nKEY<<EOF\nsecret line', error: 'The multi-line value that starts on line 2 of the env secret has no closing delimiter line' },
  ])('fails on $text without echoing the line', ({ text, error }) => {
    const result = exportEnv('', text);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`::error::${error}`);
    expect(result.stdout).not.toMatch(/::error::.*(no separator|secret line|1BAD|MY VAR)/);
    expect(result.env).toBe('');
  });

  it('masks a secret value split at a carriage return, and its trimmed form', () => {
    const result = exportEnv('', 'A=abc\rdef\nB= padded \nC<<EOF\n\tindented\nEOF');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      '::add-mask::abc\n::add-mask::def\n::add-mask:: padded \n::add-mask::padded\n::add-mask::\tindented\n::add-mask::indented\n',
    );
    expect(result.env).toBe('A=abc\rdef\nB= padded \nC<<EOF\n\tindented\nEOF\n');
  });

  it('masks the lines of an unterminated multi-line secret value', () => {
    const result = exportEnv('', 'KEY<<EOF\nsecret line');

    expect(result.stdout).toContain('::add-mask::secret line\n');
  });
});
