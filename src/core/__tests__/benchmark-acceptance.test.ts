import { runAcceptanceTests } from '../benchmark-acceptance.js';

test('runAcceptanceTests handles missing directories without throwing', async () => {
  const result = await runAcceptanceTests(process.cwd(), [
    { type: 'file-contains-substring', name: 'missing dir', dir: 'definitely-missing-dir', extensions: ['.ts'], substring: 'x' },
    { type: 'min-file-count', name: 'missing count', dir: 'definitely-missing-dir', extension: '.ts', min: 1 },
  ]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toEqual([
    { name: 'missing dir', passed: false, output: 'No files found in definitely-missing-dir' },
    { name: 'missing count', passed: false, output: '0/1' },
  ]);
});
