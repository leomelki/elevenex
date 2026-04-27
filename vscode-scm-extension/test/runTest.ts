import { runTests } from '@vscode/test-electron';
import * as path from 'path';

/**
 * VS Code Extension Test Runner
 *
 * Launches VS Code test instance with extension loaded
 * Runs test suite defined in ./suite/index.ts
 *
 * Usage: npm run test (after npm run build:test)
 *
 * Based on @vscode/test-electron documentation:
 * https://code.visualstudio.com/api/working-with-extensions/testing-extensions
 */
async function main() {
  try {
    // Extension development path (root of extension)
    const extensionDevelopmentPath = path.resolve(__dirname, '../');

    // Extension tests path (Mocha suite entry point)
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Launch VS Code test instance
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--disable-extensions'] // Test isolated, disable other extensions
    });
  } catch (err) {
    console.error('Failed to run tests');
    console.error(err);
    process.exit(1);
  }
}

main();