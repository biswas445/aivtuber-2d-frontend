/**
 * ESLint flat config (ESLint 10).
 *
 * The intent is a LOSSLESS GUARDRAIL, not a reformatting campaign: catch the
 * classes of bug this project actually shipped (operator-precedence mistakes,
 * dead/misnamed state, stray globals) without forcing a huge refactor. Two
 * project-specific rule groups are disabled below where `recommended` is too
 * noisy/redundant for this legacy, never-before-linted codebase:
 *   - no-unused-expressions: purposefully suppressed for statement-style
 *     method calls that read as expressions.
 *   - no-constant-condition / no-empty / etc.: kept on—a green run is the
 *     deliverable; see the fix history in docs.
 */
import js from '@eslint/js';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

const sharedRules = {
  // The real bug classes this project has historically shipped:
  'no-constant-binary-expression': 'error', // e.g. `a * b ?? 0` precedence confusion
  eqeqeq: ['error', 'smart'],
  'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  // Corpus-wide nudges (behavior-preserving):
  'no-var': 'error',
  'prefer-const': 'error',
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '**/character_models/**'],
  },

  // Renderer bundle source (ESM, browser environment, bundled by Vite).
  {
    files: ['src/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: { ...js.configs.recommended.rules, ...sharedRules },
  },

  // Electron main/preload (CommonJS, Node environment; preload also sees the
  // DOM, hence browser globals too).
  {
    files: ['electron/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { ...js.configs.recommended.rules, ...sharedRules },
  },

  eslintConfigPrettier,
];
