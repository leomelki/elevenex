import type { SessionChatItem } from '@elevenex/shared';

interface ToolExample {
  readonly kind: string;
  readonly name: string;
  readonly input: unknown;
  readonly result?: unknown;
  readonly error?: boolean;
  readonly truncated?: boolean;
}

/** Bounded provider-shaped receipts for exercising the production tool presenter. */
const examples: readonly ToolExample[] = [
  {
    kind: 'bash', name: 'Bash',
    input: { command: 'pnpm test retry --runInBand', cwd: '/workspace/payments', description: 'Verify concurrent retries' },
    result: { stdout: 'PASS src/payments/retry.spec.ts\n12 tests passed.', stderr: '', exit_code: 0, duration_ms: 1842 },
  },
  {
    kind: 'read', name: 'Read',
    input: { file_path: 'src/payments/retry.ts', offset: 20, limit: 4 },
    result: '20\tconst key = request.headers["idempotency-key"];\n21\tconst claim = await retries.claim(key);\n22\tif (!claim.created) return claim.result;\n23\treturn provider.charge(request);',
  },
  {
    kind: 'edit', name: 'Edit',
    input: { file_path: 'src/payments/retry.ts', old_string: 'const claim = retries.find(key);', new_string: 'const claim = await retries.claim(key);', replace_all: false },
    result: 'Updated src/payments/retry.ts successfully.',
  },
  {
    kind: 'grep', name: 'Grep',
    input: { pattern: 'retries\\.claim', path: 'src/payments', glob: '*.ts', output_mode: 'content' },
    result: 'src/payments/retry.ts:21:const claim = await retries.claim(key);\nsrc/payments/retry.spec.ts:42:await retries.claim("duplicate");',
  },
  {
    kind: 'write', name: 'Write',
    input: { file_path: 'src/payments/claim.ts', content: 'export interface Claim {\n  created: boolean;\n  result?: Payment;\n}\n' },
    result: 'Created src/payments/claim.ts.',
  },
  {
    kind: 'glob', name: 'Glob', input: { pattern: '**/*retry*.ts', path: 'src' },
    result: ['src/payments/retry.ts', 'src/payments/retry.spec.ts', 'src/jobs/retry.ts'],
  },
  {
    kind: 'notebook_edit', name: 'Edit notebook',
    input: { notebook_path: 'analysis/retries.ipynb', cell_id: 'latency-plot', cell_type: 'code', edit_mode: 'replace', new_source: 'retries.groupby("concurrent").latency.mean()' },
    result: 'Updated cell latency-plot.',
  },
  {
    kind: 'web_search', name: 'WebSearch', input: { query: 'payment provider idempotency retention window' },
    result: { results: [{ title: 'Idempotent requests', url: 'https://docs.example.com/idempotency', snippet: 'Keys remain available for 24 hours.' }, { title: 'Retries and timeouts', url: 'https://docs.example.com/retries', snippet: 'Retry failed connections with the same key.' }] },
  },
  {
    kind: 'web_fetch', name: 'WebFetch',
    input: { url: 'https://docs.example.com/idempotency', prompt: 'Find the key retention period.' },
    result: 'Idempotency keys remain available for at least 24 hours. Reusing a key returns the original response.',
  },
  {
    kind: 'file_changes', name: 'File changes',
    input: { changes: [{ path: 'src/payments/retry.ts', kind: 'update', diff: '@@ -1 +1 @@\n-const claim = retries.find(key);\n+const claim = await retries.claim(key);' }, { path: 'src/payments/claim.ts', kind: 'add', diff: '@@ -0,0 +1 @@\n+export interface Claim { created: boolean; }' }] },
    result: 'Applied changes to 2 files.',
  },
  {
    kind: 'task_agent', name: 'Agent',
    input: { description: 'Review the concurrency boundary', subagent_type: 'reviewer', model: 'sonnet', prompt: 'Check that the atomic claim prevents two provider calls. Review cancellation and transient failures.' },
    result: 'The claim is atomic. Cancellation does not release a completed payment; transient failures remain retryable.',
  },
  {
    kind: 'todo_write', name: 'Todos', input: { todos: [{ content: 'Reproduce the race', status: 'completed' }, { content: 'Implement atomic claims', status: 'completed' }, { content: 'Verify failure recovery', status: 'in_progress' }, { content: 'Document the retention period', status: 'pending' }] },
    result: 'Updated the task plan.',
  },
  {
    kind: 'agent_collaboration', name: 'Delegate task',
    input: { task_name: 'reviewer', message: 'Review cancellation and failure recovery.', fork_turns: 'all' },
    result: { agent_id: 'reviewer-42', status: 'completed', message: 'No duplicate provider calls found.' },
  },
  {
    kind: 'ask_user_question', name: 'Question',
    input: { questions: [{ header: 'Retention', question: 'How long should a retry claim remain valid?', options: [{ label: '24 hours', description: 'Matches provider retention.' }, { label: '7 days', description: 'Keeps a longer audit window.' }] }] },
    result: { answers: { Retention: '24 hours' } },
  },
  { kind: 'enter_plan_mode', name: 'Plan mode', input: {}, result: 'Entered plan mode.' },
  { kind: 'exit_plan_mode', name: 'Plan review', input: { plan: '1. Claim the key atomically.\n2. Return the original response for duplicates.\n3. Verify cancellation and failure recovery.' }, result: 'Plan approved.' },
  { kind: 'worktree', name: 'EnterWorktree', input: { name: 'retry-safety' }, result: { path: '/workspace/retry-safety', branch: 'fix/retry-safety', status: 'ready' } },
  { kind: 'lsp', name: 'LSP', input: { operation: 'findReferences', filePath: 'src/payments/retry.ts', line: 21, character: 27 }, result: [{ file: 'src/payments/retry.spec.ts', line: 42, text: 'await retries.claim("duplicate");' }] },
  { kind: 'skill', name: 'Skill', input: { skill: 'review-payment-safety', args: 'src/payments' }, result: 'Loaded the payment safety review instructions.' },
  {
    kind: 'mcp', name: 'MCP', input: { server: 'issues', tool: 'get_issue', issue_id: 'PAY-218' },
    result: { content: [{ type: 'text', text: '{"title":"Prevent duplicate charges","status":"In progress","assignee":"Payments"}' }], structuredContent: { issue: { title: 'Prevent duplicate charges', status: 'In progress', assignee: 'Payments' } } },
  },
  {
    kind: 'unknown', name: 'Inspect deployment', input: { environment: 'staging', include_health: true, regions: ['eu-west', 'us-east'] },
    result: { status: 'healthy', checks: [{ name: 'Payments API', status: 'passed', latency_ms: 42 }, { name: 'Retry store', status: 'passed', latency_ms: 7 }], note: '<script>window.__toolExecuted = true</script>' },
  },
  {
    kind: 'bash', name: 'Bash', input: { command: 'pnpm test retry --offline', cwd: '/workspace/payments' },
    result: { stdout: '', stderr: 'Dependency cache is missing. Restore dependencies and try again.', exit_code: 1 }, error: true,
  },
  {
    kind: 'read', name: 'Read', input: { file_path: 'reports/retry-load.txt', limit: 200 },
    result: Array.from({ length: 1200 }, (_, i) => `Request ${i + 1}: shared the original payment result.`).join('\n'), truncated: true,
  },
];

export function sessionToolItems(running = false): SessionChatItem[] {
  const base = (id: string, kind: SessionChatItem['kind'], text: string, extra: Partial<SessionChatItem> = {}): SessionChatItem => ({
    id, kind, text, timestamp: '2026-10-28T10:20:00.000Z', toolId: null, toolName: null,
    toolKind: null, input: '', error: false, truncated: false, ...extra,
  });
  const items = [base('tools-prompt', 'user', 'Review the retry implementation, make it safe, and show the evidence for each step.')];
  examples.forEach((example, index) => {
    const id = `example-${index}`;
    items.push(base(id, 'tool_use', '', { toolId: id, toolName: example.name, toolKind: example.kind, input: JSON.stringify(example.input) }));
    if (example.result !== undefined)
      items.push(base(id + '-result', 'tool_result', typeof example.result === 'string' ? example.result : JSON.stringify(example.result), {
        toolId: id, toolName: example.name, toolKind: example.kind, error: example.error ?? false, truncated: example.truncated ?? false,
      }));
  });
  if (running)
    items.push(base('example-live', 'tool_use', '', { toolId: 'example-live', toolName: 'Bash', toolKind: 'bash', input: JSON.stringify({ command: 'pnpm test retry --watch', cwd: '/workspace/payments', description: 'Wait for the next regression result' }) }));
  items.push(base('tools-answer', 'assistant', running ? 'The focused regression is still running.' : 'The retry claim is now atomic. **12 tests passed**; the offline run needs its dependency cache restored.'));
  return items;
}
