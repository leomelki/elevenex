import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import { fileURLToPath } from 'node:url';

const basePath = fileURLToPath(new URL('../../', import.meta.url));

export default tseslint.config(
  { basePath, ignores: ['**/node_modules/**', '**/dist/**', 'apps/desktop/renderer/**', '**/release/**', '**/.angular/**'] },
  {
    basePath,
    files: ['scripts/desktop-shell.mjs', 'scripts/desktop-capture/**/*.mjs', 'apps/desktop/test/**/*.cjs', 'apps/desktop/eslint.config.mjs'],
    extends: [eslint.configs.recommended],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', performance: 'readonly', Buffer: 'readonly' },
    },
  },
  {
    basePath,
    files: ['scripts/desktop-capture/driver.mjs', 'scripts/desktop-capture/input.mjs', 'scripts/desktop-capture/inspection.mjs', 'scripts/desktop-capture/motion.mjs', 'scripts/desktop-capture/scenarios/**/*.mjs'],
    languageOptions: {
      globals: { window: 'readonly', document: 'readonly', requestAnimationFrame: 'readonly', getComputedStyle: 'readonly', matchMedia: 'readonly', innerWidth: 'readonly', innerHeight: 'readonly', location: 'readonly', HTMLInputElement: 'readonly', HTMLTextAreaElement: 'readonly' },
    },
  },
  {
    basePath,
    files: ['apps/desktop/src/**/*.ts', 'packages/shared/src/**/*.ts', 'apps/renderer/src/**/*.ts', 'apps/renderer/capture/**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
  },
  {
    basePath,
    files: ['apps/renderer/src/**/*.ts', 'apps/renderer/capture/**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/component-selector': ['error', { type: 'element', prefix: 'ex', style: 'kebab-case' }],
    },
  },
  {
    basePath,
    files: ['apps/renderer/src/**/*.html', 'apps/renderer/capture/**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
  },
);
