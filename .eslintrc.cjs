module.exports = {
  root: true,
  env: { es2022: true, node: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { sourceType: 'module' },
  ignorePatterns: ['dist/**'],
  extends: ['eslint:recommended'],
  rules: {
    'no-unused-vars': 'off',
    'no-empty': 'off',
    'no-undef': 'off',
    'no-constant-condition': 'off',
  },
};
