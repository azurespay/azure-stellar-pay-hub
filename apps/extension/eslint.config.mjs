import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// The extension has its own config (it is not part of the pnpm workspace) so it
// runs under browser + WebExtension globals: `chrome.*` comes from the
// `@types/chrome` types used by `tsc`, and the esbuild bundles are output.
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      // esbuild output (also gitignored)
      'popup.js',
      'background.js',
      'options.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // The build/packaging scripts (`build.mjs`, `package-extension.mjs`,
  // `generate-icons.mjs`) run in Node, not in the extension.
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
