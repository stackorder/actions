import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  uses?: string;
  with?: Record<string, string>;
}

interface Workflow {
  jobs: Record<string, { steps: Step[] }>;
}

interface Context {
  github: { sha: string; event: Record<string, unknown> };
  matrix?: Record<string, unknown>;
}

const MERGE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';
const PUSH_SHA = '3333333333333333333333333333333333333333';

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
