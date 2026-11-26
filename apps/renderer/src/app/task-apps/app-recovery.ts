import { APP_INPUT_GUIDANCE, APP_SHARING_STOPPED, type BackendClientError } from '@elevenex/shared';

/**
 * Plain-language problems for the Apps panel: what happened, which machine is
 * involved and what to do next. This module only words situations. It never
 * decides what happens, so it cannot start, retry or claim anything.
 */

/** The machine that owns the apps. A local machine has no name worth repeating. */
export interface AppPlace {
  readonly machine: string;
  readonly remote: boolean;
}

export interface AppProblem {
  readonly title: string;
  readonly body: string;
  /** Adapter-owned code, status and text. Shown only behind a disclosure. */
  readonly diagnostic?: string;
}

/** `Studio Mac` for a remote machine, otherwise `this computer`. */
export function hostName(place: AppPlace): string {
  return place.remote ? place.machine || 'the task machine' : 'this computer';
}

/** Like `hostName`, for steps that only apply to a Mac. */
export function macName(place: AppPlace): string {
  return place.remote ? place.machine || 'the task Mac' : 'this Mac';
}

export function diagnosticOf(error: BackendClientError): string {
  return [error.code, error.status === undefined ? '' : 'HTTP ' + error.status, error.message].filter(Boolean).join(' · ');
}

type Failure = BackendClientError | 'interrupted' | 'unsupported';

function failureClass(failure: Failure): 'unsupported' | 'unknown' | 'refused' | 'stale' | 'unreachable' {
  if (failure === 'unsupported') return 'unsupported';
  if (failure === 'interrupted') return 'unknown';
  // The desktop reports a lost reply to a mutation as outcome-unknown. A 4xx means the host answered "no".
  if (failure.code === 'outcome-unknown') return 'unknown';
  if (failure.code === 'http' && (failure.status ?? 500) < 500) return 'refused';
  if (failure.code === 'stale-scope') return 'stale';
  return 'unreachable';
}

function withDiagnostic(problem: AppProblem, failure: Failure): AppProblem {
  return typeof failure === 'string' ? problem : { ...problem, diagnostic: diagnosticOf(failure) };
}

/** The desktop app itself lacks the named operation, so no machine was asked. */
export function clientOutdated(place: AppPlace): AppProblem {
  return {
    title: 'Update Elevenex to view apps',
    body: `This version of Elevenex can't read apps from ${hostName(place)}. Update it, then restart Elevenex.`,
  };
}

/** A failed read of the run list. Reads never change anything, so retrying is always safe. */
export function readProblem(error: BackendClientError | 'interrupted', place: AppPlace): AppProblem {
  const host = hostName(place);
  const engine = place.remote ? host : 'the engine on this computer';
  const problem = ((): AppProblem => {
    if (error === 'interrupted' || error.code === 'transport' || error.code === 'timeout') return {
      title: place.remote ? `Can't reach ${host}` : `Can't reach ${engine}`,
      body: `Elevenex couldn't read apps. Check ${place.remote ? 'the connection' : 'that Elevenex is still running'}, then try again. Running apps aren't relaunched or stopped by a retry.`,
    };
    if (error.code === 'unavailable') return {
      title: `${place.remote ? host : 'This machine'} isn't connected`,
      body: 'Elevenex has no connection to read apps from right now. Reconnect, then try again.',
    };
    if (error.code === 'stale-scope') return {
      title: 'The connection changed',
      body: 'Elevenex switched machines or reconnected while loading. Try again to read the current apps.',
    };
    if (error.code === 'invalid-response') return {
      title: `${host} sent data Elevenex can't read`,
      body: `The engine there and this app are out of step. Update Elevenex ${place.remote ? `on ${host} and ` : ''}here, then try again.`,
    };
    return {
      title: `${place.remote ? host : 'The engine'} returned an error`,
      body: `It couldn't list this task's apps${error.status ? ` (HTTP ${error.status})` : ''}. Try again. If it keeps failing, update the engine on ${host}.`,
    };
  })();
  return typeof error === 'string' ? problem : withDiagnostic(problem, error);
}

export type ActionKind = 'launch' | 'decline' | 'stop' | 'open-setup' | 'reveal-agent' | 'open-window';

interface ActionContext {
  readonly name: string;
  readonly place: AppPlace;
  /** What `open-setup` opens, for example `Elevenex Agent setup` or `System Settings`. */
  readonly surface?: string;
}

/**
 * A failed action. `interrupted` and `outcome-unknown` mean the host may have acted,
 * so the wording tells the person to check the refreshed status instead of repeating blindly.
 */
export function actionProblem(kind: ActionKind, failure: Failure, context: ActionContext): AppProblem {
  const { name, place } = context;
  const host = hostName(place), mac = macName(place);
  const surface = context.surface ?? 'setup';
  const outcome = failureClass(failure);
  const make = (title: string, body: string) => withDiagnostic({ title, body }, failure);
  const noun = outcome === 'stale' ? 'The connection changed' : `Can't reach ${host}`;
  switch (kind) {
    case 'launch':
      if (outcome === 'unsupported') return make('This version of Elevenex can\'t launch apps', 'Nothing was launched. Update Elevenex, then review the request again.');
      if (outcome === 'unknown') return make('Couldn\'t confirm the launch', `Elevenex doesn't know whether ${name} started on ${host}. The status is being refreshed. Launch again only if the request is still waiting.`);
      if (outcome === 'refused') return make('This request is no longer available', `It expired (requests last ten minutes) or was already handled. Nothing was launched. Ask your agent to launch ${name} again if you still need it.`);
      return make(noun, 'Nothing was launched. Reconnect, review the request, then launch again.');
    case 'decline':
      if (outcome === 'unsupported') return make('This version of Elevenex can\'t decline requests', 'The request is still waiting and nothing was launched. Update Elevenex, or let it expire after ten minutes.');
      if (outcome === 'unknown') return make('Couldn\'t confirm the request was declined', 'The status is being refreshed. Decline again if it is still waiting. Nothing was launched.');
      if (outcome === 'refused') return make('This request is already gone', 'It expired or was handled elsewhere. Nothing was launched and there is nothing left to decline.');
      return make(noun, 'The request may still be waiting. Nothing was launched. Reconnect and decline again, or let it expire after ten minutes.');
    case 'stop':
      if (outcome === 'unsupported') return make('This version of Elevenex can\'t stop apps', `Update Elevenex, or stop ${name} on ${host} yourself.`);
      if (outcome === 'unknown') return make('Couldn\'t confirm the app stopped', `The status is being refreshed. If ${name} still shows Running or Stopping, choose Retry stop. If it will not stop, check its logs or restart ${host}.`);
      if (outcome === 'refused') return make('This app can\'t be stopped from here', `It may have already ended. The status is being refreshed.`);
      return make(noun, `${name} was not asked to stop. Reconnect and try again.`);
    case 'open-setup':
      if (outcome === 'unsupported') return make(`This version of Elevenex can't open ${surface} remotely`, `Follow the steps below on ${host}, or update Elevenex.`);
      if (outcome === 'unknown') return make(`Couldn't confirm ${surface} opened`, `It may already be open on ${mac}. Look at its screen before trying again, or follow the steps below by hand.`);
      if (outcome === 'refused') return make(`${surface[0]!.toUpperCase()}${surface.slice(1)} can't be opened for this run`, `The run may have ended, or the engine on ${host} may be too old to open it. Follow the steps below on ${mac}.`);
      return make(noun, `Nothing was opened on ${host}. Reconnect and try again, or follow the steps below on ${mac}.`);
    case 'reveal-agent':
      if (outcome === 'unsupported') return make('This version of Elevenex can\'t show the agent in Finder', 'Open setup instead, or update Elevenex.');
      if (outcome === 'unknown') return make('Couldn\'t confirm Finder opened', `It may have opened on ${mac}. If not, try again, or open Elevenex Agent yourself from the engine's folder there.`);
      if (outcome === 'refused') return make('Couldn\'t find Elevenex Agent', `${host} reports no installed agent for this run. Update or reconnect its managed engine, then try again.`);
      return make(noun, `Finder was not asked to open. Reconnect and try again.`);
    case 'open-window':
      return make('Couldn\'t open a separate window', `${name} is still running. Keep using it here, or try again.`);
  }
}

/** Output is read-only metadata, so a retry is always safe. */
export function logsProblem(failure: Failure, place: AppPlace): AppProblem {
  const host = hostName(place);
  if (failure === 'unsupported') return { title: 'This version of Elevenex can\'t show output', body: 'Update Elevenex to read app output.' };
  const outcome = failureClass(failure);
  if (outcome === 'refused') return withDiagnostic({ title: 'Output isn\'t available', body: `${host} no longer has output for this run. The engine clears it when it restarts.` }, failure);
  return withDiagnostic({ title: 'Couldn\'t load output', body: `Elevenex couldn't read it from ${host}. Try again.` }, failure);
}

/** Why a display could not be attached or stopped, from a transport failure or a host message. */
export function streamProblem(reason: BackendClientError | string, name: string, place: AppPlace): AppProblem {
  const host = hostName(place);
  if (typeof reason !== 'string') {
    const outcome = failureClass(reason);
    if (outcome === 'refused' && reason.status === 404) return withDiagnostic({
      title: 'This app is no longer available',
      body: `${host} no longer lists it, so there is no display to show. Check the app's tab or ask your agent to launch it again.`,
    }, reason);
    if (outcome === 'unreachable' || outcome === 'stale') return withDiagnostic({
      title: outcome === 'stale' ? 'The connection changed' : `Can't reach ${host}`,
      body: `Elevenex couldn't open the display. ${name} isn't affected. Reconnect to try again.`,
    }, reason);
    return withDiagnostic({
      title: `${host} couldn't start the display`,
      body: `${name} isn't affected. Try Reconnect. If it keeps failing, close other viewers of this app or update the engine on ${host}.`,
    }, reason);
  }
  switch (reason) {
    case 'The host screen is locked or capture permission changed.':
      return { title: `The display paused on ${host}`, body: `Unlock the screen on ${host}. On a Mac, also check that Elevenex Agent still has Screen Recording permission. Then reconnect.` };
    case 'App window changed. Reopen the stream.':
      return { title: 'The app window changed', body: 'It was resized or replaced. Reconnect to show the new window.' };
    case 'No owned app window is visible on the host.':
      return { title: 'No window to show yet', body: `${name} hasn't opened a visible window on ${host}. It may still be starting, or its window is minimized or closed. Check the logs, then reconnect.` };
    case 'App stream disconnected':
      return { title: 'The display disconnected', body: `The connection to ${name} on ${host} ended. The app may still be running. Reconnect to resume.` };
    case APP_SHARING_STOPPED:
      return { title: 'App sharing stopped', body: `${host} stopped sharing ${name}. Select Reconnect to request a new stream.` };
    case 'The host could not capture or encode the app window.':
      return { title: `${host} couldn't prepare the picture`, body: `${name} is still running. Resize its window on ${host}, then reconnect. If this repeats, update the engine on ${host}.` };
    case 'The video stream lost a frame.':
    case 'The display could not keep up with the stream.':
      return { title: 'The picture stopped', body: `The video fell behind or lost data on its way from ${host}. Reconnect for a fresh picture. If this repeats, the connection may be slow.` };
    case 'The app display was interrupted.':
      return { title: 'The picture stopped', body: `This computer couldn't decode or draw the video from ${host}. Reconnect for a fresh picture. If this repeats, update Elevenex on this computer.` };
    case 'The display could not connect.':
      return { title: 'Couldn\'t connect to the display', body: `Elevenex couldn't reach ${host}'s video stream. Check the connection, then reconnect.` };
    case 'Streaming is unavailable on this machine.':
      return { title: 'This build can\'t show app displays', body: `Update Elevenex${place.remote ? ` and the engine on ${host}` : ''}, then reconnect.` };
    default:
      return { title: 'The display stopped', body: `${host} reported: ${reason}. Reconnect to try again.` };
  }
}

export interface InputNotice {
  /** Protocol text from the host, shown exactly. */
  readonly message: string;
  /** What to do next and what still works. */
  readonly next: string;
}

/**
 * Explains an input failure beside the exact host guidance. The suffix match of
 * `APP_INPUT_GUIDANCE` is protocol-sensitive: Electron prefixes IPC errors, the host text stays last.
 */
export function inputNotice(detail: string, place: AppPlace): InputNotice {
  const host = hostName(place);
  if (detail.endsWith(APP_INPUT_GUIDANCE.permission)) return {
    message: APP_INPUT_GUIDANCE.permission,
    next: 'You can keep watching. After you allow it, click the app to try again.',
  };
  if (detail.endsWith(APP_INPUT_GUIDANCE.foreground)) return {
    message: 'The shared app needs focus.',
    next: `Click the preview to try again. If the app stays in the background, it may need to be brought forward on ${host}.`,
  };
  return { message: detail, next: '' };
}

export const INPUT_INTERRUPTED = 'Input was interrupted. Click the app to take control again.';
export const INPUT_TOO_LONG = 'That text is too long to send at once. Paste it in smaller pieces.';
