import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import solid from '@solidjs/vite-plugin'
import solidV2Strict from 'eslint-plugin-solid/configs/v2-strict'
import { defineConfig } from 'vite-plus'
import { webAliases } from './lib/web-alias.ts'

const solidFiles = /\.solid\.tsx$/
const uiSdkSolidBuild = /\/@ui-sdk\/solid\/dist\/solid\/.*\.jsx$/
const lucideSolidSource = /\/@lucide\/solid\/dist\/source\/.*\.jsx$/
const solidPlugin = () => solid({ include: [solidFiles, uiSdkSolidBuild, lucideSolidSource] })
const alias = webAliases(fileURLToPath(new URL('.', import.meta.url)))
const excludeE2e = ['test/e2e/**', 'extensions/*/test/e2e/**']
const maxWorkers = 8
const solidRules = Object.fromEntries(
  Object.entries(solidV2Strict.rules as Record<string, number>)
    .filter(([rule, level]) => rule.startsWith('solid/') && level > 0)
    .map(([rule]) => [rule, 'error' as const]),
)
export default defineConfig({
  root: 'web',
  plugins: [solidPlugin(), tailwindcss()],
  resolve: { alias },
  lint: {
    plugins: ['typescript', 'unicorn', 'import', 'promise', 'vitest'],
    jsPlugins: ['./lint/ultimate.ts', 'eslint-plugin-solid'],
    settings: solidV2Strict.settings,
    categories: { correctness: 'error', suspicious: 'error' },
    rules: {
      'import/no-cycle': 'error',
      'typescript/no-import-type-side-effects': 'error',
      'typescript/no-unsafe-type-assertion': 'off',
      'promise/always-return': 'off',
      'typescript/no-floating-promises': ['error', { ignoreVoid: false }],
      'import/no-unassigned-import': ['error', { allow: ['**/*.css'] }],
      // Stylistic: asks to hoist local helpers out of the test or closure they serve; we keep them next to their use.
      'unicorn/consistent-function-scoping': 'off',
    },
    overrides: [
      {
        files: [
          'extensions/**',
          'server/**',
          'web/**',
          'lib/**',
          'shared/**',
          'bin/**',
          'scripts/**',
        ],
        excludeFiles: ['test/**', 'extensions/*/test/**'],
        rules: { 'typescript/switch-exhaustiveness-check': 'error' },
      },
      {
        files: ['web/public/sw.js'],
        rules: { 'unicorn/require-post-message-target-origin': 'off' },
      },
      {
        files: ['test/**', 'extensions/*/test/**'],
        excludeFiles: ['test/e2e/**', 'extensions/*/test/e2e/**'],
        rules: {
          'ultimate/no-test-timeout': 'error',
          'ultimate/no-real-wait-in-fast-tests': 'error',
        },
      },
      {
        files: ['test/**', 'extensions/*/test/**'],
        excludeFiles: ['test/helpers.ts'],
        rules: { 'ultimate/no-local-test-polling': 'error' },
      },
      {
        files: ['test/web/**', 'extensions/*/test/web/**', '**/*.test.solid.tsx'],
        rules: { 'ultimate/no-server-helpers-in-web-tests': 'error' },
      },
      {
        files: ['**/*'],
        excludeFiles: ['test/**', 'extensions/*/test/**', 'lib/errors.shared.ts'],
        rules: { 'ultimate/no-silent-catch': 'error' },
      },
      {
        files: ['**/*'],
        excludeFiles: ['test/**', 'extensions/*/test/**', 'lib/replay.ts'],
        rules: { 'ultimate/replay-safe-by-name': 'error' },
      },
      {
        files: ['server/**', 'lib/**', 'shared/**', 'extensions/**/*.ts'],
        excludeFiles: [
          'test/**',
          'extensions/*/test/**',
          'lib/errors.shared.ts',
          'extensions/**/*.web.ts',
          'lib/**/*.web.ts',
        ],
        rules: { 'ultimate/no-unowned-work': 'error' },
      },
      {
        files: [
          'bin/**',
          'extensions/**',
          '.ultimate/extensions/**',
          'lib/**',
          'scripts/**',
          'server/**',
          'shared/**',
          'web/**',
        ],
        excludeFiles: [
          'extensions/*/test/**',
          '.ultimate/extensions/*/test/**',
          'lib/timers.shared.ts',
        ],
        rules: { 'ultimate/no-raw-timer': 'error' },
      },
      {
        files: [
          'bin/**',
          'extensions/**',
          'lib/**',
          'scripts/**',
          'server/**',
          'shared/**',
          'web/**',
        ],
        excludeFiles: ['extensions/*/test/**'],
        rules: { 'ultimate/no-comments': 'error' },
      },
      {
        files: ['server/**', 'bin/**'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                { group: ['**/extensions/**'], message: 'Core knows no feature; see AGENTS.md.' },
              ],
            },
          ],
        },
      },
      {
        files: ['shared/**'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                { group: ['**/extensions/**'], message: 'Core knows no feature; see AGENTS.md.' },
                {
                  group: ['**/server/**', '**/web/**', '**/bin/**'],
                  message: 'shared/ stays standalone.',
                },
              ],
            },
          ],
        },
      },
      {
        files: ['lib/**'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['**/extensions/**', '**/web/**', '**/bin/**'],
                  message:
                    'lib/ holds pure helpers that extensions share; it imports none of them.',
                },
                {
                  group: ['**/server/**'],
                  allowTypeImports: true,
                  message:
                    'lib/ holds pure helpers; core runtime behaviour comes from host capabilities.',
                },
                {
                  group: ['**/*.web.ts', '**/*.solid.tsx'],
                  allowTypeImports: true,
                  message:
                    'Server code cannot run browser modules; move what both need into a *.shared.ts file.',
                },
              ],
            },
          ],
        },
      },
      {
        // An extension's test/ folder is not part of it: its tests set up the core and other extensions as test/ does.
        files: ['extensions/**', '.ultimate/extensions/**'],
        excludeFiles: ['extensions/*/test/**', '.ultimate/extensions/*/test/**'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['**/server/**', '**/bin/**'],
                  allowTypeImports: true,
                  message: 'Use host capabilities for core runtime behaviour.',
                },
                {
                  group: ['**/*.web.ts', '**/*.solid.tsx'],
                  allowTypeImports: true,
                  message:
                    'Server code cannot run browser modules; move what both need into a *.shared.ts file.',
                },
              ],
            },
          ],
        },
      },
      {
        // Another extension at runtime only through its contract: api.ts from server code, refs.ts or ui.solid.tsx
        // from the browser.
        // A core-tier extension (`export const tier = 'core'` in its api.ts) imports only the core tier.
        files: ['extensions/**/*.ts', 'extensions/**/*.tsx'],
        excludeFiles: ['extensions/*/test/**'],
        rules: {
          'ultimate/api-only-imports': 'error',
          'ultimate/core-tier-deps': 'error',
          'ultimate/declared-requires': 'error',
        },
      },
      {
        files: ['.ultimate/extensions/**/*.ts', '.ultimate/extensions/**/*.tsx'],
        excludeFiles: ['.ultimate/extensions/*/test/**'],
        rules: { 'ultimate/api-only-imports': 'error', 'ultimate/declared-requires': 'error' },
      },
      {
        files: [
          'extensions/*/api.ts',
          'extensions/*/refs.ts',
          'extensions/*/ui.tsx',
          'extensions/*/ui.solid.tsx',
        ],
        rules: { 'ultimate/api-file-shape': 'error', 'ultimate/api-naming': 'error' },
      },
      {
        files: [
          'extensions/**/*.ts',
          'extensions/**/*.tsx',
          '.ultimate/extensions/**/*.ts',
          '.ultimate/extensions/**/*.tsx',
        ],
        excludeFiles: [
          'extensions/*/server.ts',
          '.ultimate/extensions/*/server.ts',
          'extensions/*/test/**',
          '.ultimate/extensions/*/test/**',
        ],
        rules: { 'ultimate/no-raw-stream': 'error' },
      },
      {
        files: [
          'web/src/**',
          'lib/**/*.{web,shared}.ts',
          'extensions/**/*.{tsx,web.ts,shared.ts}',
          '.ultimate/extensions/**/*.{tsx,web.ts,shared.ts}',
        ],
        excludeFiles: ['extensions/*/test/**', '.ultimate/extensions/*/test/**'],
        rules: {
          'ultimate/browser-file-names': 'error',
          // In the page `void` marks a call not awaited on purpose: client.ts turns an unhandled action failure into a
          // notice, and nothing can take the process down.
          'typescript/no-floating-promises': ['error', { ignoreVoid: true }],
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['node:*', 'node:*/**', '**/server/**'],
                  message: 'Browser code cannot import Node or server modules.',
                },
                {
                  group: ['**/bin/**'],
                  allowTypeImports: true,
                  message: 'Use host capabilities for core runtime behaviour.',
                },
              ],
            },
          ],
        },
      },
      {
        // Replaces the browser restriction above for *.shared.ts, so it repeats it and adds browser modules.
        files: ['extensions/**/*.shared.ts', '.ultimate/extensions/**/*.shared.ts'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['node:*', 'node:*/**', '**/server/**'],
                  message: 'Browser code cannot import Node or server modules.',
                },
                {
                  group: ['**/bin/**', '**/*.web.ts', '**/*.solid.tsx'],
                  allowTypeImports: true,
                  message:
                    'The server runs a *.shared.ts file too, so it imports no browser module.',
                },
              ],
            },
          ],
        },
      },
      {
        // Replaces the browser restriction above for lib/, so it repeats it and adds what lib/ never imports.
        files: ['lib/**/*.web.ts'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['node:*', 'node:*/**', '**/server/**'],
                  message: 'Browser code cannot import Node or server modules.',
                },
                {
                  group: ['**/extensions/**', '**/web/**', '**/bin/**'],
                  message:
                    'lib/ holds pure helpers that extensions share; it imports none of them.',
                },
              ],
            },
          ],
        },
      },
      {
        files: ['lib/**/*.shared.ts'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['node:*', 'node:*/**', '**/server/**'],
                  message: 'Browser code cannot import Node or server modules.',
                },
                {
                  group: ['**/extensions/**', '**/web/**', '**/bin/**'],
                  message:
                    'lib/ holds pure helpers that extensions share; it imports none of them.',
                },
                {
                  group: ['**/*.web.ts', '**/*.solid.tsx'],
                  allowTypeImports: true,
                  message:
                    'The server runs a *.shared.ts file too, so it imports no browser module.',
                },
              ],
            },
          ],
        },
      },
      {
        files: ['**/*.solid.tsx'],
        plugins: ['jsx-a11y'],
        rules: {
          'no-unassigned-vars': 'off',
          ...solidRules,
          'ultimate/ui-kit-roles': 'error',
          'jsx-a11y/control-has-associated-label': 'error',
          'jsx-a11y/label-has-associated-control': [
            'error',
            {
              controlComponents: ['Switch', 'Checkbox', 'Slider', 'Input', 'SecretInput', 'Toggle'],
            },
          ],
          'jsx-a11y/no-static-element-interactions': 'error',
          'jsx-a11y/click-events-have-key-events': 'error',
          'jsx-a11y/interactive-supports-focus': 'error',
          'jsx-a11y/no-noninteractive-element-interactions': 'error',
          'jsx-a11y/prefer-tag-over-role': 'error',
          'jsx-a11y/no-autofocus': 'error',
        },
      },
      {
        files: ['**/*.solid.tsx'],
        rules: { 'ultimate/no-aria-pressed-button': 'error' },
      },
      {
        files: ['web/**', 'extensions/**', '.ultimate/extensions/**'],
        excludeFiles: ['extensions/*/test/**', '.ultimate/extensions/*/test/**'],
        rules: { 'ultimate/ui-framework-boundaries': 'error' },
      },
      {
        // Replaces the browser restriction above for web/src, so it repeats it and adds extensions.
        files: ['web/src/**'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['node:*', 'node:*/**', '**/server/**'],
                  message: 'Browser code cannot import Node or server modules.',
                },
                {
                  group: ['**/bin/**'],
                  allowTypeImports: true,
                  message: 'Use host capabilities for core runtime behaviour.',
                },
                { group: ['**/extensions/**'], message: 'Core knows no feature; see AGENTS.md.' },
              ],
            },
          ],
        },
      },
    ],
    options: { denyWarnings: true, typeAware: true, typeCheck: true },
  },
  fmt: { semi: false, singleQuote: true },
  test: {
    root: '.',
    environment: 'node',
    globalSetup: ['test/sweep-temp.ts', 'test/whole-suite-lock.ts'],
    setupFiles: ['test/setup.ts', 'test/no-group-signals.ts'],
    // Core and integration tests in test/, each extension's own in extensions/<name>/test/: `pnpm test extensions/<name>/`
    // runs one extension's.
    include: ['test/**/*.test.ts', 'extensions/*/test/**/*.test.ts'],
    exclude: excludeE2e,
    projects: [
      { extends: true, test: { name: 'node' } },
      {
        // Resolve Solid with jsdom's client environment, leaving the node project's server conditions intact.
        extends: false,
        plugins: [solidPlugin()],
        resolve: { alias },
        test: {
          name: 'solid-dom',
          environment: 'jsdom',
          include: [
            'test/**/*.test.solid.tsx',
            'extensions/*/test/**/*.test.solid.tsx',
            '.ultimate/extensions/*/test/**/*.test.solid.tsx',
          ],
          exclude: excludeE2e,
          setupFiles: ['test/web/solid-dom-setup.ts'],
          maxWorkers,
        },
      },
    ],
    testTimeout: 30000,
    // A hung hook or teardown fails within seconds and names its test, instead of stalling the run.
    hookTimeout: 5000,
    teardownTimeout: 5000,
    maxWorkers,
    // Under an agent (AI_AGENT, CLAUDECODE, …) Vitest picks its minimal reporter, which prints nothing for passing
    // files; the lander's stall watchdog then stops a passing run that is silent for two minutes.
    reporters: ['default'],
  },
})
