import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      // Root config files are outside every tsconfig project, so the
      // type-aware parser cannot analyse them.
      'vitest.config.ts',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: [
          './packages/*/tsconfig.json',
          './services/*/tsconfig.json',
          './scripts/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs['recommended-type-checked'].rules,

      // TypeScript already resolves every identifier against lib + @types/node,
      // and does it more accurately than a hand-maintained globals list.
      // Leaving both on means maintaining that list forever for no benefit.
      // This is typescript-eslint's own recommendation.
      'no-undef': 'off',

      // Same reasoning: TS has separate value and type namespaces, so the
      // `const X = {...}; type X = ...` pattern is not a redeclaration.
      'no-redeclare': 'off',
      '@typescript-eslint/no-redeclare': 'error',

      /* --- Rules that exist because this system moves money -------------- */

      // An unawaited promise in a posting path means the process can exit
      // before the write completes, or an error vanishes entirely.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',

      // `any` in a financial calculation defeats every other guarantee here.
      '@typescript-eslint/no-explicit-any': 'warn',
      // These four fire on values crossing an untyped boundary — Postgres row
      // objects and third-party JSON. Every such site is explicitly marked
      // with a `no-explicit-any` disable comment and immediately narrowed;
      // leaving the rules on would bury real findings under boundary noise.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // Money must never be compared or coerced loosely.
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['error'] }],
    },
  },
  {
    // Tests may be looser: assertions on untyped fixtures are normal.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
];
