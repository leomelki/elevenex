import { defineTool } from '../../tool-registry/tool.types.js';

/**
 * get_focused_session — resolves the code session/project the human currently
 * has open in the elevenex UI. ⚡instant: one DB read of the volatile focus the
 * UI reported with the user's last message, no transcript.
 *
 * This is the agent's ONLY way to learn "this session" / "the project I'm in".
 * It is intentionally pull-based: the focus is NOT injected into the
 * conversation, so the agent only consults it when the user's words imply the
 * currently-open thing — and otherwise keeps working on the session the
 * conversation has been about. The result is a point-in-time snapshot that can
 * change between turns; re-call it each time and never rely on a remembered id.
 */
export const getFocusedSessionTool = defineTool({
  name: 'get_focused_session',
  title: 'Get focused session',
  costClass: 'instant',
  description:
    "Resolve the session/project the human has OPEN in the elevenex UI right now (live name, branch, status, project). ⚡instant. Call this ONLY when the user's words imply the current/open thing — \"this session\", \"the session I have open\", \"the project I'm in\", \"here\" — to learn which session they mean. Do NOT call it for follow-ups that refer to the session this conversation is already about. Ephemeral: it reflects the user's LAST message and can change between turns, so fetch it fresh each time and never reuse a remembered value.",
  annotations: { readOnlyHint: true },
  inputShape: {},
  handler: async (_args, ctx) => {
    const noneEnvelope = (note: string) => ({
      data: { focused: null, note },
      nextStep:
        'No focused session to act on. Use the session this conversation is about, or ask the user which session/project they mean.',
    });

    if (ctx.agentSessionId == null) {
      return noneEnvelope(
        'Focus is only tracked for agent missions, and this caller is not one.',
      );
    }

    const record = ctx.services.agentFocus.get(ctx.agentSessionId);
    if (!record) {
      return noneEnvelope(
        'The user has no elevenex session focused in the UI (or has not focused one since this mission began).',
      );
    }

    const session = await ctx.services.sessions
      .findOne(record.focusedSessionId)
      .catch(() => null);
    if (!session) {
      return noneEnvelope(
        'The session the user last had open no longer exists (it may have been archived or deleted).',
      );
    }

    const project = await ctx.services.projects
      .findOne(session.projectId)
      .catch(() => null);

    return {
      data: {
        focused: {
          sessionId: session.id,
          name: session.name ?? null,
          branchName: session.branchName,
          status: session.status,
          projectId: session.projectId,
          projectName: project?.name ?? null,
          workspaceName: session.workspaceName ?? null,
          focusReportedAt: record.reportedAt,
        },
        note: "Ephemeral UI focus — what the human had open when they last messaged you. It can change between turns; re-fetch each time and never rely on a remembered value. Only act on it if the user's words imply the current/open session or project.",
      },
      deepLink: ctx.deepLink.session(session.id),
      nextStep:
        'To work in it: session_status to poll, read_session to read its transcript, or project_overview with this projectId for the project.',
    };
  },
});
