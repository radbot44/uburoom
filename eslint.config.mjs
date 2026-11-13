// ESLint is limited to real defects: unused bindings and undeclared globals. Formatting belongs to Prettier.
import globals from 'globals';

const defects = {
  'no-undef': 'error',
  // Unused parameters are often part of a callback or API signature, so only unused bindings are reported.
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
};

// Window properties that the classic scripts in web/ publish for one another (`root.uburoomX = api`),
// plus the vendored bundles watch.js loads (hls.js, Discord SDK) and shared/*.js (`uburoom`).
const pageGlobals = Object.fromEntries(
  [
    'Hls',
    'uburoom',
    'uburoomAV1',
    'uburoomControls',
    'uburoomDiagnostics',
    'uburoomDialogs',
    'uburoomDiscord',
    'uburoomEvents',
    'uburoomFallback',
    'uburoomIcons',
    'uburoomLibrary',
    'uburoomLobbyEvents',
    'uburoomPlayback',
    'uburoomPlayerUI',
    'uburoomPopover',
    'uburoomQueueUI',
    'uburoomRoomUI',
    'uburoomServerSettings',
    'uburoomShare',
    'uburoomStreams',
    'uburoomSubtitles',
    'uburoomSyncQuality',
    'uburoomTiming',
    'uburoomToasts',
    'uburoomUbumfa',
    'uburoomWatchFeedback',
    'uburoomWatchTransport',
    'uburoomWire',
  ].map(name => [name, 'readonly']),
);

// Top-level bindings of web/watch.js that web/account.js (loaded later on the same page) uses, and back.
const watchScriptGlobals = {
  $: 'readonly',
  activity: 'readonly',
  api: 'readonly',
  call: 'readonly',
  clearPlayer: 'readonly',
  config: 'writable',
  me: 'writable',
  openInBrowser: 'readonly',
  pending: 'writable',
  renderAccount: 'readonly',
  stopBrowserHandoff: 'readonly',
  token: 'writable',
};
const accountScriptGlobals = { showAccount: 'readonly', updateAccountButton: 'readonly' };

const nodeOnlyWebFiles = ['web/playback-timing.js', 'web/sync-quality.js'];
const universalWebFiles = [
  'web/icons.js',
  'web/playback-diagnostics.js',
  'web/playback-policy.js',
  'web/ubumfa.js',
  'web/watch-library.js',
  'web/watch-player-ui.js',
  'web/watch-rooms-ui.js',
  'web/watch-subtitles.js',
  'web/watch-toasts.js',
  'web/watch-transport.js',
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
    // Classic browser scripts sharing one page scope.
    files: ['web/**/*.js'],
    ignores: nodeOnlyWebFiles,
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: { ...globals.browser, ...pageGlobals } },
    rules: defects,
  },
  {
    // Browser scripts that Node also requires behind `typeof module` guards.
    files: universalWebFiles,
    languageOptions: { globals: { module: 'readonly', require: 'readonly' } },
  },
  {
    // Node re-exports; server/app.js serves the browser wrapper for these routes.
    files: nodeOnlyWebFiles,
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...globals.node } },
    rules: defects,
  },
  {
    files: ['web/account.js'],
    languageOptions: { globals: watchScriptGlobals },
    rules: {
      'no-unused-vars': [
        'error',
        {
          args: 'none',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
          varsIgnorePattern: `^(${Object.keys(accountScriptGlobals).join('|')})$`,
        },
      ],
    },
  },
  {
    files: ['web/watch.js'],
    languageOptions: { globals: accountScriptGlobals },
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
