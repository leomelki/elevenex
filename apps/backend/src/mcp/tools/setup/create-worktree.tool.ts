import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import {
  defaultWorktreePath,
  isInUse,
  lastActivityAt,
  poolItemHandle,
  resolveRepo,
} from './worktree.util.js';
import type { WorktreePoolItem } from '../../../worktrees/worktree-pool.service.js';
import type { BranchSnapshot } from '../../../worktrees/worktrees.service.js';

/** Worktrees unused for longer than this are candidates to steal/reuse. */
const STALE_THRESHOLD_MS = 72 * 60 * 60 * 1000; // 72 hours

/** How many reclaimable candidates to surface (the ranked best ones). */
const MAX_CANDIDATES = 5;

/**
 * The only reasons a new worktree is warranted while reclaimable ones exist.
 * Deliberately an enum, not free text: the common failure mode is an agent
 * rationalising a fresh worktree because the candidates "look unrelated" — hold
 * another branch, carry another task's name, or were made for something else.
 * None of that matters for a clean, session-free worktree, so the enum gives
 * that rationale no slot to live in.
 */
const FORCE_REASONS = [
  'user_confirmed',
  'candidates_unusable',
  'concurrent_worktrees_needed',
] as const;

type ReclaimAction = 'link_worktree' | 'steal_worktree';

/**
 * Why a pool worktree cannot be reclaimed right now — every one of these is a
 * *physical* obstacle (work would be lost, or a live session's files would move
 * under it), never a judgement about what the worktree was previously for.
 */
function blockedReason(item: WorktreePoolItem, now: number): string | null {
  if (item.isMissing) return 'missing_on_disk';
  if (item.isLocked) return 'locked';
  if (item.hasConflicts) return 'unresolved_conflicts';
  if (item.isDirty) return 'uncommitted_changes';
  if (isInUse(item)) return 'sessions_still_attached';
  if (!item.owner) return null;

  // Owned and session-free: reclaimable once it has gone quiet. "In use" is
  // decided by attached sessions above, not by this timestamp, so no recorded
  // activity means nothing is holding the worktree — offer it.
  const activity = lastActivityAt(item);
  if (!activity) return null;
  const idleMs = now - new Date(activity).getTime();
  if (Number.isNaN(idleMs)) return null;
  return idleMs > STALE_THRESHOLD_MS ? null : 'owner_recently_active';
}

/**
 * create_worktree — 🔴heavy. Spawns a background `git worktree add` job and
 * returns IMMEDIATELY with a jobId; never blocks. The job dedupes on
 * (repo, branch, path) so retries are idempotent. Poll get_worktree_job until
 * it succeeds, then link_worktree.
 *
 * Branch resolution order:
 *  1. Branch exists locally → proceed, optionally fetch+snapshot when from_origin=true.
 *  2. Branch missing locally + from_origin=true → fetch from origin (creates local
 *     tracking branch), then proceed with snapshot.
 *  3. Branch missing locally + from_origin unset/false + startPoint provided →
 *     create a new local branch forked from startPoint (no remote lookup).
 *  4. Branch missing locally + from_origin unset/false + startPoint omitted →
 *     auto-detect the repo's default branch via `refs/remotes/origin/HEAD` and
 *     use it as startPoint. If detection fails, error so the agent can decide.
 *
 * Freshness: pass fetch_start_point:true to run `git fetch origin <base>` before
 * the job starts, ensuring the branch is forked from the latest upstream commit.
 *
 * Reuse gate: unless `force` is set, the pool is scanned first and any clean,
 * session-free worktree is returned as a reclaimable candidate instead of
 * creating anything. Candidates are ranked (unowned first, then longest-idle) so
 * the truncated list is the best of the pool, and the worktrees that were ruled
 * out come back with a physical `reason` — the caller never has to infer
 * suitability from names or branches. `force` requires a `forceReason` from a
 * closed enum so "these look unrelated to my task" cannot be expressed.
 */
export const createWorktreeTool = defineTool({
  name: 'create_worktree',
  title: 'Create worktree',
  costClass: 'heavy',
  mutates: true,
  description:
    'Start a background job to create a new git worktree for a branch and return a jobId immediately (never blocks). 🔴heavy. ' +
    'IMPORTANT: reusing an existing worktree is the default and this tool enforces it — if any clean, session-free worktree exists (unowned, or owned but idle >72 h) it returns those as candidates instead of creating anything, and you are expected to link_worktree/steal_worktree one of them. ' +
    'A worktree is disposable infrastructure, not a record of what it was used for: the branch it holds, its name, and the task it was created for do NOT make it unsuitable — rename_worktree + switch_branch reset it completely. The only real blockers (uncommitted changes, conflicts, lock, attached sessions) are already filtered out for you, and reported in the response so you do not have to guess. ' +
    'force:true is therefore not a way to override a judgement call: it requires forceReason and is limited to the human asking for a new worktree, candidates that actually failed to link, or needing several worktrees at once. ' +
    'If branchName has no local ref and neither from_origin nor startPoint is set, the tool auto-detects the repo default branch (origin/HEAD) and uses it as startPoint — no extra call needed for the common "new branch off main" case. ' +
    'Pass startPoint explicitly to fork from a specific ref (e.g. "origin/release/2.0"). ' +
    'Pass fetch_start_point: true (recommended for new feature branches) to fetch the base ref from origin before forking, so the new branch starts from the latest upstream commit rather than a potentially stale local tracking ref. ' +
    'Pass from_origin: true to fetch an existing remote branch instead of creating a new one; this also returns a branchSnapshot (ahead/behind, last commit). ' +
    'Prefer passing an explicit worktreePath with a name of its own (task/feature-based, e.g. "fix-login-timeout") rather than letting it default to a slug of branchName — branches get renamed/rebased/reused across worktrees, so a worktree name tied to the branch name goes stale and gets confusing; give the worktree an identity that is decorrelated from the branch it currently holds. ' +
    'The job dedupes on repo+branch+path. Next: poll get_worktree_job until succeeded, then link_worktree.',
  annotations: { idempotentHint: true },
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe('Repo to create the worktree in. From add_repo / project_overview.'),
    branchName: z
      .string()
      .min(1)
      .describe('Branch to check out in the new worktree (e.g. feature/foo).'),
    from_origin: z
      .boolean()
      .optional()
      .describe(
        'When true: fetch the branch from origin before creating the worktree. ' +
        'If the branch has no local ref, git creates it from origin/<branch>. ' +
        'If the branch already exists locally, the fetch refreshes the remote tracking ref. ' +
        'In both cases a branchSnapshot (ahead/behind, last commit) is returned alongside the jobId.',
      ),
    startPoint: z
      .string()
      .optional()
      .describe(
        'Base ref to fork a NEW local branch from (e.g. "main", "origin/main", "origin/release/2.0"). ' +
        'Used only when branchName has no local ref and from_origin is not true; ignored otherwise. ' +
        'When omitted the tool auto-detects the repo default branch (origin/HEAD) so you rarely need to set this.',
      ),
    fetch_start_point: z
      .boolean()
      .optional()
      .describe(
        'When true: fetch the base ref from origin before forking the new branch. ' +
        'Ensures the worktree starts from the latest upstream commit rather than a potentially ' +
        'stale local tracking ref. Recommended when creating feature branches off main/master. ' +
        'Ignored when from_origin is true (which already performs its own fetch) or when ' +
        'branchName already exists locally.',
      ),
    worktreePath: z
      .string()
      .optional()
      .describe(
        'Explicit absolute path for the worktree. Choose a name for the worktree itself (its final path segment), not just a copy of branchName — worktrees often outlive or get relinked to a different branch than the one they were created for, so a good name describes the task/workspace, not the branch. ' +
        'Omit only if you have no better name; the default falls back to .worktrees/<repo>/<slug-of-branchName>.',
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        'Skip the pool pre-check and create a new worktree unconditionally. Requires forceReason. ' +
        'Not for overriding your own judgement of the candidates: a clean, session-free worktree is always reusable no matter what branch, name or past task it carries.',
      ),
    forceReason: z
      .enum(FORCE_REASONS)
      .optional()
      .describe(
        'Required when force is true. The only accepted justifications: ' +
        "'user_confirmed' (the human explicitly asked for a brand-new worktree), " +
        "'candidates_unusable' (you tried link_worktree/steal_worktree on the returned candidates and they failed), " +
        "'concurrent_worktrees_needed' (this mission needs several worktrees at the same time and the candidates are already claimed by its other tasks). " +
        '"The candidates look unrelated to my task", "they hold other branches", "they are named for something else" and "one is still useful as a reference" are NOT reasons — the first three are irrelevant for a clean worktree, and the last is already handled: worktrees with sessions attached are never offered as candidates.',
      ),
  },
  handler: async (args, ctx) => {
    const { worktreeJobs, worktrees, worktreePool } = ctx.services;
    const repo = await resolveRepo(ctx, args.repoId);
    const branchName = args.branchName.trim();
    if (!branchName) {
      throw new ToolError({
        code: 'invalid_branch',
        message: 'branchName is required.',
        remediation: 'Pass a non-empty branch name.',
      });
    }

    if (args.force && !args.forceReason) {
      throw new ToolError({
        code: 'force_reason_required',
        message:
          'force:true requires forceReason — a new worktree is only warranted when reuse is physically impossible or the human asked for one.',
        remediation:
          `Re-call with forceReason set to one of: ${FORCE_REASONS.join(', ')}. ` +
          "If your reason is that the candidates hold other branches, carry other tasks' names, or look unrelated to this task, none of those apply: " +
          'a clean worktree with no attached sessions is interchangeable — link_worktree/steal_worktree it, then rename_worktree and switch_branch to make it yours. Drop force and reuse one.',
        retryable: true,
      });
    }

    // Pool pre-check: surface reclaimable worktrees before spawning a new one.
    if (!args.force) {
      const now = Date.now();
      const reclaimable: Array<
        ReturnType<typeof poolItemHandle> & {
          reclaimAction: ReclaimAction;
          idleSince?: string;
        }
      > = [];
      const blocked: Array<{
        worktreeId: number;
        name: string;
        reason: string;
      }> = [];

      await worktreePool.streamForRepo(repo, (item) => {
        const reason = blockedReason(item, now);
        if (reason) {
          blocked.push({ worktreeId: item.id, name: item.name, reason });
          return;
        }
        reclaimable.push({
          ...poolItemHandle(item),
          reclaimAction: item.owner ? 'steal_worktree' : 'link_worktree',
          idleSince: lastActivityAt(item) ?? undefined,
        });
      });

      if (reclaimable.length > 0) {
        // Rank so the truncated list holds the *best* candidates rather than
        // whichever ones the concurrent pool scan happened to finish first:
        // unowned before owned, then longest-idle first.
        reclaimable.sort((left, right) => {
          if (left.reclaimAction !== right.reclaimAction) {
            return left.reclaimAction === 'link_worktree' ? -1 : 1;
          }
          return (left.idleSince ?? '').localeCompare(right.idleSince ?? '');
        });

        return {
          data: {
            poolCheckResult: 'reclaimable_worktrees_found',
            candidateCount: reclaimable.length,
            candidates: reclaimable.slice(0, MAX_CANDIDATES),
            // Surfaced so you can see that the busy ones WERE considered and
            // ruled out for you — no need to reason about them yourself.
            blockedCount: blocked.length,
            blocked: blocked.slice(0, MAX_CANDIDATES),
          },
          nextStep:
            'Reuse one of these instead of creating a new worktree — that is the expected outcome of this call, not an option. ' +
            'Every candidate listed is clean, unlocked and has no sessions attached, which is the whole test: a worktree is disposable infrastructure, ' +
            'so the branch it currently holds, the name it carries, and the task it was created for are all irrelevant to whether you may take it. ' +
            'Do NOT reject a candidate for looking unrelated to your task; anything you were about to worry about (someone still needs it, work would be lost) ' +
            'is already covered by the blocked list. ' +
            'Take the first candidate: link_worktree if reclaimAction is link_worktree, steal_worktree if it is steal_worktree; then rename_worktree it for YOUR task and switch_branch (or pass branchName on link) to the branch you want. ' +
            'Only if every candidate then fails to link/steal may you re-call with force:true plus forceReason.',
        };
      }
    }

    const worktreePath = args.worktreePath?.trim() || defaultWorktreePath(repo, branchName);

    const localExists = await worktrees.localBranchExists(repo.path, branchName);

    // Resolved start point: explicit arg wins; otherwise auto-detect default branch.
    let resolvedStartPoint = args.startPoint?.trim() || undefined;

    if (!localExists) {
      if (!args.from_origin && !resolvedStartPoint) {
        // Auto-detect the repo's default branch from refs/remotes/origin/HEAD.
        const detected = await worktrees.getDefaultBranch(repo.path);
        if (detected) {
          resolvedStartPoint = detected;
        } else {
          // Detection failed (no remote, shallow clone, etc.) — ask the agent.
          const remoteExists = await worktrees.remoteBranchExists(repo.path, branchName);
          throw new ToolError({
            code: 'branch_not_found_locally',
            message: `Branch "${branchName}" does not exist locally and the repo default branch could not be detected.`,
            remediation: remoteExists
              ? `origin/${branchName} exists. Re-call with from_origin: true to fetch and create a local tracking branch, or pass startPoint to create a fresh branch from a different base.`
              : `No local or remote branch named "${branchName}" was found. Pass startPoint (e.g. "origin/main") to create a new branch from that base.`,
            retryable: true,
          });
        }
      }

      if (args.from_origin) {
        // from_origin=true: fetch creates the local tracking branch
        const remoteExists = await worktrees.remoteBranchExists(repo.path, branchName);
        if (!remoteExists) {
          throw new ToolError({
            code: 'remote_branch_not_found',
            message: `Branch "${branchName}" does not exist on origin and has no local ref.`,
            remediation: `Pass startPoint (e.g. "origin/main") to create a new branch from a base ref instead.`,
          });
        }

        await worktrees.fetchBranch(repo.path, branchName, true);
      }
    } else if (args.from_origin) {
      // Branch exists locally; refresh the remote tracking ref
      await worktrees.fetchBranch(repo.path, branchName, false);
    }

    // Refresh the base ref so the new branch starts from the latest upstream commit.
    if (!localExists && !args.from_origin && args.fetch_start_point && resolvedStartPoint) {
      const baseRemoteBranch = resolvedStartPoint.startsWith('origin/')
        ? resolvedStartPoint.slice('origin/'.length)
        : resolvedStartPoint;
      await worktrees.fetchBranch(repo.path, baseRemoteBranch, false);
    }

    let branchSnapshot: BranchSnapshot | undefined;
    if (args.from_origin) {
      branchSnapshot = await worktrees.getBranchSnapshot(repo.path, branchName);
    }

    const job = worktreeJobs.startJob(
      repo.id,
      repo.path,
      branchName,
      worktreePath,
      // resolvedStartPoint is set for new branches (explicit or auto-detected).
      // After a from_origin fetch the local branch already points at the right
      // commit, so startPoint would be ignored by git anyway.
      !localExists && !args.from_origin ? resolvedStartPoint : undefined,
    );

    return {
      data: {
        jobId: job.id,
        status: job.status,
        repoId: repo.id,
        branchName,
        worktreePath,
        ...(branchSnapshot !== undefined ? { branchSnapshot } : {}),
      },
      touched: { jobId: job.id },
      nextStep:
        'Poll get_worktree_job with this repoId + jobId until status is "succeeded", then link_worktree.',
    };
  },
});
