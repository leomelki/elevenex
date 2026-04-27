import * as assert from 'assert';
import { BackendGitClient } from '../../src/backendGitClient';
import { FileStatus } from '../../src/types';
import { MockGitBackend } from '../mockBackend';

suite('BackendGitClient Tests', () => {

  test('getStatus() should fetch changed files list from backend', async () => {
    // Setup: Create mock backend with sample status
    const mockBackend = new MockGitBackend();
    const worktreeId = 'test-worktree';
    const client = new BackendGitClient('http://localhost:3000/api', worktreeId);

    // Mock fetch to return status from MockGitBackend
    global.fetch = async () => {
      const status = await mockBackend.getStatus(worktreeId);
      return {
        ok: true,
        status: 200,
        json: async () => ({ files: status })
      } as Response;
    };

    // Execute: Fetch status
    const status = await client.getStatus();

    // Verify: Returns FileStatus array
    assert.strictEqual(status.length, 4);
    assert.strictEqual(status[0].path, 'src/app.ts');
    assert.strictEqual(status[0].status, 'modified');
    assert.strictEqual(status[0].staged, false);
  });

  test('getOriginalContent() should fetch file content from git history', async () => {
    // Setup: Create mock backend with sample content
    const mockBackend = new MockGitBackend();
    const worktreeId = 'test-worktree';
    const client = new BackendGitClient('http://localhost:3000/api', worktreeId);

    // Mock fetch to return content from MockGitBackend
    global.fetch = async () => {
      const content = await mockBackend.getOriginalContent(worktreeId, 'HEAD', 'src/app.ts');
      return {
        ok: true,
        status: 200,
        json: async () => ({ content })
      } as Response;
    };

    // Execute: Fetch original content
    const content = await client.getOriginalContent('HEAD', 'src/app.ts');

    // Verify: Returns file content string
    assert.strictEqual(content, 'Original app content\n');
  });

  test('getStatus() should handle network errors (fetch fails)', async () => {
    // Setup: Mock fetch to throw network error
    const worktreeId = 'test-worktree';
    const client = new BackendGitClient('http://localhost:3000/api', worktreeId);

    global.fetch = async () => {
      throw new Error('Network error: Failed to connect to backend');
    };

    // Execute & Verify: Should throw error with message
    try {
      await client.getStatus();
      assert.fail('Expected error to be thrown');
    } catch (error: any) {
      assert.ok(error.message.includes('Network error'));
    }
  });

  test('getStatus() should handle 400 HTTP errors from backend', async () => {
    // Setup: Mock fetch to return 400 error
    const worktreeId = 'test-worktree';
    const client = new BackendGitClient('http://localhost:3000/api', worktreeId);

    global.fetch = async () => {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request'
      } as Response;
    };

    // Execute & Verify: Should throw error with status code
    try {
      await client.getStatus();
      assert.fail('Expected error to be thrown');
    } catch (error: any) {
      assert.ok(error.message.includes('400'));
    }
  });

  test('getStatus() should handle 500 HTTP errors from backend', async () => {
    // Setup: Mock fetch to return 500 error
    const worktreeId = 'test-worktree';
    const client = new BackendGitClient('http://localhost:3000/api', worktreeId);

    global.fetch = async () => {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      } as Response;
    };

    // Execute & Verify: Should throw error with status code
    try {
      await client.getStatus();
      assert.fail('Expected error to be thrown');
    } catch (error: any) {
      assert.ok(error.message.includes('500'));
    }
  });
});