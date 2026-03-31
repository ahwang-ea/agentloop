import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { err, ok, type Result } from '../shared/result.js';
import { formatPlan, parsePlanJson } from './planner.js';
import type { PlannedTask } from './planner-types.js';
import { validatePlan } from './planner-validate.js';

const runEditor = (editor: string, path: string) => new Promise<Result<void>>(resolve => {
  const [cmd, ...args] = editor.trim().split(/\s+/);
  const child = spawn(cmd, [...args, path], { stdio: 'inherit' });
  child.on('error', () => resolve(err('CONFIG_ERROR', `Cannot launch editor ${editor}`)));
  child.on('exit', code => resolve(code === 0 ? ok(undefined) : err('CONFIG_ERROR', `${editor} exited with code ${code ?? 1}`)));
});
const issuesOf = (plan: PlannedTask[]) => validatePlan(plan);

async function editPlan(plan: PlannedTask[]): Promise<Result<PlannedTask[]>> {
  const dir = await mkdtemp(join(tmpdir(), 'agentloop-plan-')), path = join(dir, 'plan.json');
  try {
    await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, 'utf-8');
    const edited = await runEditor(process.env.EDITOR ?? 'vi', path); if (!edited.ok) return edited;
    return parsePlanJson(await readFile(path, 'utf-8'));
  } catch { return err('TRANSPORT_ERROR', `Cannot edit ${path}`); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

export async function approvePlan(plan: PlannedTask[]): Promise<Result<PlannedTask[] | null>> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return err('CONFIG_ERROR', 'Plan approval requires a TTY');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let current = plan;
  try {
    while (true) {
      console.log(formatPlan(current));
      const answer = (await rl.question('Approve this plan? (y/n/edit) ')).trim().toLowerCase();
      if (answer === 'n') return ok(null);
      if (answer === 'y') {
        const issues = issuesOf(current);
        if (issues.length === 0) return ok(current);
        console.error(`Invalid plan:\n- ${issues.join('\n- ')}`);
        continue;
      }
      if (answer !== 'edit') continue;
      const edited = await editPlan(current); if (!edited.ok) return edited;
      const issues = issuesOf(edited.value);
      current = edited.value;
      if (issues.length > 0) console.error(`Invalid plan:\n- ${issues.join('\n- ')}`);
    }
  } finally { rl.close(); }
}
