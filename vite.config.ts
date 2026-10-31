import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('web/src', import.meta.url)) } },
  lint: {
    plugins: ['typescript', 'unicorn', 'import', 'promise', 'vitest', 'react'],
    jsPlugins: ['./lint/ultimate.ts'],
    categories: { correctness: 'error', suspicious: 'error' },
    rules: {
      'import/no-cycle': 'error',
      'react/no-array-index-key': 'warn',
      'react/no-children-prop': 'off',
      'typescript/no-unsafe-type-assertion': 'off',
      'promise/always-return': 'off',
      'typescript/no-floating-promises': ['error', { ignoreVoid: false }],
      'import/no-unassigned-import': ['error', { allow: ['**/*.css'] }],
      // Stylistic: asks to hoist local helpers out of the test or closure they serve; we keep them next to their use.
      'unicorn/consistent-function-scoping': 'off',
    },
    overrides: [
      {
        files: ['test/**'],
        excludeFiles: ['test/e2e/**'],
        rules: {
          'ultimate/no-test-timeout': 'error',
          'ultimate/no-real-wait-in-fast-tests': 'error',
        },
      },
      {
        files: ['test/**'],
        excludeFiles: ['test/helpers.ts'],
        rules: { 'ultimate/no-local-test-polling': 'error' },
      },
      {
        files: ['extensions/**', 'web/**'],
        rules: { 'ultimate/no-retired-ui': 'error' },
      },
      {
        files: ['**/*'],
        excludeFiles: ['test/**'],
        rules: {
          'ultimate/replay-safe-reason': 'error',
          'ultimate/no-silent-catch': 'error',
        },
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
              ],
            },
          ],
        },
      },
      {
        files: ['extensions/**'],
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
              ],
            },
          ],
          'ultimate/no-raw-services': 'error',
        },
      },
      {
        // Another extension at runtime only through its contract: api.ts from server code, ui.tsx from the browser.
        // A core-tier extension (`export const tier = 'core'` in its api.ts) imports only the core tier.
        files: ['extensions/**/*.ts', 'extensions/**/*.tsx'],
        rules: { 'ultimate/api-only-imports': 'error', 'ultimate/core-tier-deps': 'error' },
      },
      {
        files: ['extensions/*/api.ts', 'extensions/*/refs.ts', 'extensions/*/ui.tsx'],
        rules: { 'ultimate/api-file-shape': 'error', 'ultimate/api-naming': 'error' },
      },
      {
        files: ['extensions/**/*.tsx'],
        rules: { 'ultimate/no-raw-stream': 'error' },
      },
      {
        files: ['web/src/**', 'extensions/**/*.tsx', '.ultimate/extensions/**/*.tsx'],
        plugins: ['react'],
        rules: {
          'react/rules-of-hooks': 'error',
          'react/exhaustive-deps': 'error',
          'react/jsx-key': 'error',
          'react/react-in-jsx-scope': 'off',
          'react/hooks': 'off',
          'react/set-state-in-effect': 'off',
          'react/refs': 'off',
          'react/purity': 'off',
          'react/memo-dependencies': 'off',
          'react/exhaustive-effect-dependencies': 'off',
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['node:*', '**/server/**'],
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
        // Replaces the browser restriction above for web/src, so it repeats it and adds extensions.
        files: ['web/src/**'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['node:*', '**/server/**'],
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
    globalSetup: ['test/sweep-temp.ts'],
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    testTimeout: 30000,
    // A hung hook or teardown fails within seconds and names its test, instead of stalling the run.
    hookTimeout: 5000,
    teardownTimeout: 5000,
    maxWorkers: 8,
    // Under an agent (AI_AGENT, CLAUDECODE, …) Vitest picks its minimal reporter, which prints nothing for passing
    // files; the lander's stall watchdog then stops a passing run that is silent for two minutes.
    reporters: ['default'],
  },
})
