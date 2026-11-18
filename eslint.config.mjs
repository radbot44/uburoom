// ESLint checks defects and module boundaries. Formatting belongs to Prettier.
import globals from 'globals';

const defects = {
  'no-undef': 'error',
  // Unused parameters are often part of a callback or API signature, so only unused bindings are reported.
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
};

// The vendored bundles watch.js loads as classic scripts (hls.js, Discord SDK, OverlayScrollbars).
const vendorGlobals = { Hls: 'readonly', uburoomDiscord: 'readonly' };

// Classic scripts: they run before the page's modules (theme, saved layout) or on pages without them.
const classicWebFiles = [
  'web/auth-error.js',
  'web/demo-discord.js',
  'web/demo-plex.js',
  'web/handoff.js',
  'web/native-handoff.js',
  'web/theme.js',
  'web/watch-layout.js',
];

// Functions that scripts/ pass to a browser page (page.evaluate) run against watch.js page bindings.
const watchPageBindings = names => Object.fromEntries(names.map(name => [name, 'readonly']));

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
    files: ['server/**/*.{js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/web', '**/web/**'] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name="require"][arguments.0.value=/(^|[\\x2f\\\\])web([\\x2f\\\\]|$)/]',
          message: 'Move code used by both the server and browser to shared/.',
        },
        {
          selector: 'ImportExpression[source.value=/(^|[\\x2f\\\\])web([\\x2f\\\\]|$)/]',
          message: 'Move code used by both the server and browser to shared/.',
        },
      ],
    },
  },
  {
    // Browser ES modules. Cross-stack modules live in shared/.
    files: ['web/**/*.js'],
    ignores: classicWebFiles,
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser, ...vendorGlobals } },
    rules: defects,
  },
  {
    files: classicWebFiles,
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: { ...globals.browser } },
    rules: defects,
  },
  {
    files: ['scripts/frame-callback-probe.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['scripts/playback-baseline.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...watchPageBindings(['decodedFrames', 'expected', 'playbackError', 'playerWaiting', 'state']),
      },
    },
  },
  {
    files: ['scripts/sync-startup.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...watchPageBindings([
          'applyState',
          'playbackClock',
          'startupFixture',
          'sync',
          'transport',
          'uburoomTiming',
          'video',
          'videoFrames',
        ]),
      },
    },
  },
];
