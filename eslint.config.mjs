// ESLint is limited to real defects: unused bindings and undeclared globals. Formatting belongs to Prettier.
import globals from 'globals';

const defects = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true }],
};

export default [
  {
    ignores: ['node_modules/', 'web/vendor/', 'artifacts/', 'releases/', 'reference/', 'personal/', 'data/', 'certs/'],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'shared/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...globals.node } },
    rules: defects,
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules: defects,
  },
  {
    files: ['web/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: { ...globals.browser } },
    rules: defects,
  },
];
