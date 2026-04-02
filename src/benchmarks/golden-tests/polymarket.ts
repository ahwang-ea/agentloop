export const polymarketGoldenTest: string = `
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

jest.setTimeout(30000);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const srcDir = join(root, 'src');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [join(dir, entry.name)] : []);
const files = walk(srcDir).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
const specifier = (path: string) => { const rel = relative(here, path).replace(/\\/g, '/').replace(/\.ts$/, '.js'); return rel.startsWith('.') ? rel : './' + rel; };
const load = (path: string) => import(specifier(path));
const structured = (value: unknown) => Array.isArray(value) ? value.length === 0 || value.some((item) => !!item && typeof item === 'object' && Object.keys(item as object).length > 0) : !!value && typeof value === 'object' && Object.keys(value as object).length > 0;
const scalar = (value: unknown) => typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
const profitOf = (value: unknown): number | null => {
  const hit = scalar(value);
  if (hit !== null) return hit;
  if (Array.isArray(value)) {
    const values = value.map(profitOf).filter((item): item is number => item !== null);
    return values.length ? Math.max(...values) : null;
  }
  if (typeof value === 'string') {
    const values = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    return values.length ? Math.max(...values) : null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['profit', 'margin', 'spread', 'edge', 'guaranteedProfit', 'netProfit']) {
    const next = profitOf(record[key]);
    if (next !== null) return next;
  }
  const nested = Object.values(record).filter((item) => Array.isArray(item) || (!!item && typeof item === 'object')).map(profitOf).filter((item): item is number => item !== null);
  return nested.length ? Math.max(...nested) : null;
};
const call = async (fn: (...args: unknown[]) => unknown, markets: readonly [{ yes: number; no: number }, { yes: number; no: number }]) => {
  let lastError = 'no compatible call signature';
  for (const args of [[markets[0], markets[1]], [markets], [{ marketA: markets[0], marketB: markets[1] }], [markets[0].yes, markets[0].no, markets[1].yes, markets[1].no], [markets[0].yes, markets[1].no, markets[1].yes, markets[0].no]]) {
    try { const value = await fn(...args); if (value !== undefined) return value; }
    catch (error) { lastError = String(error); }
  }
  throw new Error(lastError);
};
const help = () => new Promise<string>((resolve) => execFile('node', ['dist/index.js', '--help'], { cwd: root, timeout: 10000, maxBuffer: 1024 * 1024 }, (_error, stdout, stderr) => resolve(String(stdout ?? '') + String(stderr ?? ''))));

describe('golden: polymarket cli', () => {
  test('finds a runnable cli entry dynamically', async () => {
    const entries = files.filter((file) => /process\.argv|program\.parse|commander/.test(file.text));
    expect(entries.length).toBeGreaterThan(0);
    const argv = [...process.argv];
    const failures: string[] = [];
    let imported = false;
    for (const entry of entries) {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error('exit:' + (code ?? 0)); }) as never);
      process.argv = ['node', entry.path, '--help'];
      try { await load(entry.path); imported = true; break; }
      catch (error) { const text = String(error); imported = /^Error: exit:[01]$/.test(text); if (imported) break; failures.push(entry.path + ': ' + text); }
      finally { process.argv = argv; exitSpy.mockRestore(); }
    }
    if (!imported) {
      expect(existsSync(join(root, 'dist', 'index.js'))).toBe(true);
      const output = await help();
      if (!/usage|help|options|arbitrage|market/i.test(output)) throw new Error(failures.concat(output).join('\n'));
      expect(output).toMatch(/usage|help|options|arbitrage|market/i);
    }
  });
});

describe('golden: adapter behavior', () => {
  test('imports adapter modules with callable exports and typed returns', async () => {
    const adapters = files.filter((file) => /adapter/i.test(file.path) || /interface\s+\w+Adapter/.test(file.text));
    expect(adapters.length).toBeGreaterThanOrEqual(2);
    const failures: string[] = [];
    const loaded: { file: { path: string; text: string }; mod: Record<string, unknown> }[] = [];
    for (const file of adapters) {
      try { loaded.push({ file, mod: await load(file.path) as Record<string, unknown> }); }
      catch (error) { failures.push(file.path + ': ' + String(error)); }
    }
    if (loaded.length < 2 && failures.length) throw new Error(failures.join('\n'));
    expect(loaded.length).toBeGreaterThanOrEqual(2);
    const callables = loaded.flatMap(({ mod }) => Object.entries(mod).filter(([, value]) => typeof value === 'function'));
    expect(callables.length).toBeGreaterThanOrEqual(2);
    const typed = loaded.some(({ file }) => /export\s+(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*:\s*(?!void\b)[^\n{]+|export\s+const\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*:\s*(?!void\b)[^=]+=>/.test(file.text));
    let returned = false;
    for (const [name, fn] of callables.filter(([name, fn]) => /adapter|mock|sample|fixture|stub|create/i.test(name) && (fn as Function).length === 0)) {
      try { returned = structured(await (fn as () => unknown)()); if (returned) break; }
      catch (error) { failures.push(name + ': ' + String(error)); }
    }
    expect(returned || typed).toBe(true);
  });
});

describe('golden: arbitrage math', () => {
  test('validates exported profit logic when available', async () => {
    const modules = files.filter((file) => /arbitrage|profit|spread|opportunit/i.test(file.path) || /arbitrage|profit|spread|guarantee/i.test(file.text));
    expect(modules.length).toBeGreaterThan(0);
    const failures: string[] = [];
    let calc: ((...args: unknown[]) => unknown) | undefined;
    for (const file of modules) {
      try {
        const mod = await load(file.path) as Record<string, unknown>;
        calc = Object.entries(mod).find(([name, value]) => typeof value === 'function' && /arbitrage|profit|spread|opportunit|calculate/i.test(name))?.[1] as ((...args: unknown[]) => unknown) | undefined;
        if (calc) break;
      } catch (error) { failures.push(file.path + ': ' + String(error)); }
    }
    if (!calc) { if (failures.length === modules.length) throw new Error(failures.join('\n')); return; }
    const first = profitOf(await call(calc, [{ yes: 0.6, no: 0.4 }, { yes: 0.35, no: 0.65 }] as const));
    const second = profitOf(await call(calc, [{ yes: 0.4, no: 0.6 }, { yes: 0.3, no: 0.7 }] as const));
    expect(first ?? 0).toBeLessThanOrEqual(0.0001);
    expect(second ?? 0).toBeGreaterThan(0.09);
    expect(second ?? 0).toBeLessThan(0.11);
  });
});
`;
