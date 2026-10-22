import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import { fileURLToPath } from 'node:url';

const basePath = fileURLToPath(new URL('../../', import.meta.url));

export default tseslint.config(
  { basePath, ignores: ['**/node_modules/**', '**/dist/**', 'apps/desktop/renderer/**', '**/release/**', '**/.angular/**'] },
  {
    basePath,
    files: ['scripts/desktop-shell.mjs', 'apps/desktop/test/**/*.cjs', 'apps/desktop/eslint.config.mjs'],
    extends: [eslint.configs.recommended],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' },
    },
  },
  {
    basePath,
    files: ['apps/desktop/src/**/*.ts', 'packages/shared/src/**/*.ts', 'apps/renderer/src/**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
  },
  {
    basePath,
    files: ['apps/renderer/src/**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/component-selector': ['error', { type: 'element', prefix: 'ex', style: 'kebab-case' }],
    },
  },
  {
    basePath,
    files: ['apps/renderer/src/**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
  },
);
