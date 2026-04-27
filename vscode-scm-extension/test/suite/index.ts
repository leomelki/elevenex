import * as path from 'path';
import Mocha from 'mocha';

/**
 * Mocha Test Suite Entry Point
 *
 * Configures Mocha test framework for VS Code extension tests
 * Loads all test files from ./suite directory
 *
 * Tests run in VS Code test instance (not Node.js directly)
 * Each test file uses VS Code extension API (workspace, window, etc.)
 */
export function run(): Promise<void> {
  // Create Mocha instance with timeout and color
  const mocha = new Mocha({
    ui: 'tdd', // Use TDD interface (suite/test)
    timeout: 30000, // 30 second timeout for each test
    color: true // Use color in output
  });

  // Add test files (compiled .js files)
  const testRoot = path.resolve(__dirname);

  // Add extension activation test (created in Task 3)
  mocha.addFile(path.resolve(testRoot, 'extension.test.js'));

  // Add BackendGitClient tests (created in Task 2)
  mocha.addFile(path.resolve(testRoot, 'backendGitClient.test.js'));

  // Add GitScmProvider tests (created in Task 3)
  mocha.addFile(path.resolve(testRoot, 'scmProvider.test.js'));

  // Add QuickDiffProvider tests (created in Plan 03)
  mocha.addFile(path.resolve(testRoot, 'quickDiffProvider.test.js'));

  // Add GitContentProvider tests (created in Plan 03)
  mocha.addFile(path.resolve(testRoot, 'gitContentProvider.test.js'));

  // Add openDiff command tests (created in Plan 03)
  mocha.addFile(path.resolve(testRoot, 'openDiff.test.js'));

  // Run tests
  return new Promise((resolve, reject) => {
    try {
      // Run Mocha suite
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });
}