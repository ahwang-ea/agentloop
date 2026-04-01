import { checkScope } from '../scope.js';

const scope = { editableFiles: ['src/**/*.ts', 'README.md'], readOnlyContext: [], forbiddenFiles: ['src/secret.ts'] };
const sharedFiles = 'package.json\ntsconfig.json\ntsconfig.build.json\n.gitignore';

test('allows files inside editable scope', () => {
  const result = checkScope('src/api/user.ts\nREADME.md', scope);
  expect(result.ok ? result.value : ['bad']).toEqual([]);
});

test('flags forbidden files even when they match editable patterns', () => {
  const result = checkScope('src/secret.ts', scope);
  expect(result.ok ? result.value : ['bad']).toEqual(['src/secret.ts']);
});

test('parses unified diff headers', () => {
  const diff = ['diff --git a/src/api/user.ts b/src/api/user.ts', '+++ b/src/api/user.ts', '+++ b/src/secret.ts'].join('\n');
  const result = checkScope(diff, scope);
  expect(result.ok ? result.value : ['bad']).toEqual(['src/secret.ts']);
});

test('blocks shared config files unless editable', () => {
  const result = checkScope(sharedFiles, scope);
  expect(result.ok ? result.value : ['bad']).toEqual(['.gitignore', 'package.json', 'tsconfig.build.json', 'tsconfig.json']);
});

test('allows shared config files when explicitly editable', () => {
  const result = checkScope(sharedFiles, {
    ...scope,
    editableFiles: [...scope.editableFiles, 'package.json', 'tsconfig*.json', '.gitignore'],
  });
  expect(result.ok ? result.value : ['bad']).toEqual([]);
});

test('still blocks read-only shared files', () => {
  const result = checkScope('package.json', { ...scope, readOnlyContext: ['package.json'] });
  expect(result.ok ? result.value : ['bad']).toEqual(['package.json']);
});
