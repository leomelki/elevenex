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
export function clientOutdated(): AppProblem {
  return { title: 'Update Elevenex to use apps', body: 'This version can\'t read apps.' };
}

/** A failed read of the run list. Reads never change anything, so retrying is always safe. */
export function readProblem(error: BackendClientError | 'interrupted', place: AppPlace): AppProblem {
  const host = hostName(place);
  const problem = ((): AppProblem => {
    if (error === 'interrupted' || error.code === 'transport' || error.code === 'timeout') return place.remote
      ? { title: `Can't reach ${host}`, body: 'Check the connection, then try again.' }
      : { title: 'Can\'t reach the engine on this computer', body: 'Make sure Elevenex is running, then try again.' };
    if (error.code === 'unavailable') return { title: place.remote ? `${host} isn't connected` : 'Not connected', body: 'Reconnect, then try again.' };
    if (error.code === 'stale-scope') return { title: 'The connection changed', body: 'Try again to load the current apps.' };
    if (error.code === 'invalid-response') return {
      title: 'Elevenex is out of date',
      body: place.remote ? `Update Elevenex here and reconnect ${host}.` : 'Update Elevenex, then restart it.',
    };
    return { title: 'Couldn\'t load apps', body: 'Try again. If it keeps failing, update Elevenex.' };
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
 * so the wording says the status is being refreshed instead of inviting a blind repeat.
 */
export function actionProblem(kind: ActionKind, failure: Failure, context: ActionContext): AppProblem {
  const { name, place } = context;
  const host = hostName(place), mac = macName(place);
  const surface = context.surface ?? 'setup';
  const outcome = failureClass(failure);
  const make = (title: string, body: string) => withDiagnostic({ title, body }, failure);
  const lost = outcome === 'stale' ? 'The connection changed' : `Can't reach ${host}`;
  switch (kind) {
    case 'launch':
      if (outcome === 'unsupported') return make('Update Elevenex to launch apps', 'Nothing was launched.');
      if (outcome === 'unknown') return make('Launch not confirmed', `${name} may have started. Refreshing its status.`);
      if (outcome === 'refused') return make('Request expired', `Nothing was launched. Ask your agent again if you still need ${name}.`);
      return make(lost, 'Nothing was launched. Reconnect, then try again.');
    case 'decline':
      if (outcome === 'unsupported') return make('Update Elevenex to decline requests', 'The request expires on its own after ten minutes.');
      if (outcome === 'unknown') return make('Decline not confirmed', 'Nothing was launched. Refreshing the request.');
      if (outcome === 'refused') return make('Request already gone', 'Nothing was launched.');
      return make(lost, 'Nothing was launched. Reconnect, then decline again.');
    case 'stop':
      if (outcome === 'unsupported') return make('Update Elevenex to stop apps', `Or stop ${name} on ${host}.`);
      if (outcome === 'unknown') return make('Stop not confirmed', 'Refreshing its status. Stop again if it\'s still running.');
      if (outcome === 'refused') return make('Couldn\'t stop the app', 'It may have already ended. Refreshing its status.');
      return make(lost, `${name} is still running. Reconnect, then try again.`);
    case 'open-setup':
      if (outcome === 'unsupported') return make(`Update Elevenex to open ${surface}`, `Or open it by hand on ${host}.`);
      if (outcome === 'unknown') return make(`Couldn't confirm ${surface} opened`, `Check ${mac}'s screen before trying again.`);
      if (outcome === 'refused') return make(`Couldn't open ${surface}`, `Open it by hand on ${mac}.`);
      return make(lost, 'Nothing was opened. Reconnect, then try again.');
    case 'reveal-agent':
      if (outcome === 'unsupported') return make('Update Elevenex to show the agent', 'Use the setup window instead.');
      if (outcome === 'unknown') return make('Couldn\'t confirm Finder opened', `Check ${mac}'s screen before trying again.`);
      if (outcome === 'refused') return make('Elevenex Agent isn\'t installed', place.remote ? `Reconnect ${host} to install it.` : 'Update Elevenex, then restart it.');
      return make(lost, 'Reconnect, then try again.');
    case 'open-window':
      return make('Couldn\'t open another window', `${name} is still running here.`);
  }
}

/** Output is read-only metadata, so a retry is always safe. */
export function logsProblem(failure: Failure, place: AppPlace): AppProblem {
  if (failure === 'unsupported') return { title: 'Update Elevenex to see output', body: 'This version can\'t read it.' };
  const outcome = failureClass(failure);
  if (outcome === 'refused') return withDiagnostic({ title: 'Output is gone', body: `${hostName(place)} clears it when its engine restarts.` }, failure);
  return withDiagnostic({ title: 'Couldn\'t load output', body: 'Try again.' }, failure);
}

/** Why a display could not be attached or stopped, from a transport failure or a host message. */
export function streamProblem(reason: BackendClientError | string, name: string, place: AppPlace): AppProblem {
  const host = hostName(place);
  if (typeof reason !== 'string') {
    const outcome = failureClass(reason);
    if (outcome === 'refused' && reason.status === 404) return withDiagnostic({
      title: 'This app is no longer available', body: 'Ask your agent to launch it again.',
    }, reason);
    if (outcome === 'unreachable' || outcome === 'stale') return withDiagnostic({
      title: outcome === 'stale' ? 'The connection changed' : `Can't reach ${host}`, body: `${name} is still running.`,
    }, reason);
    return withDiagnostic({
      title: 'Couldn\'t start the display', body: `${name} is still running. Close other viewers of it, then reconnect.`,
    }, reason);
  }
  switch (reason) {
    case 'The host screen is locked or capture permission changed.':
      return { title: 'Display paused', body: `${place.remote ? host + '\'s' : 'The'} screen is locked, or Screen Recording was turned off.` };
    case 'App window changed. Reopen the stream.':
      return { title: 'The window changed', body: 'Reconnect to show the new window.' };
    case 'No owned app window is visible on the host.':
      return { title: 'No window to show', body: `${name} has no visible window yet. It may still be starting.` };
    case 'App stream disconnected':
      return { title: 'Display disconnected', body: `${name} may still be running.` };
    case APP_SHARING_STOPPED:
      return { title: 'App sharing stopped', body: `${place.remote ? host : 'This computer'} stopped sharing ${name}.` };
    case 'The host could not capture or encode the app window.':
      return { title: 'Couldn\'t capture the window', body: `${name} is still running. Resize its window, then reconnect.` };
    case 'The video stream lost a frame.':
    case 'The display could not keep up with the stream.':
      return { title: 'The picture fell behind', body: 'The connection may be slow.' };
    case 'The app display was interrupted.':
      return { title: 'The picture stopped', body: 'This computer couldn\'t decode or draw the video.' };
    case 'The display could not connect.':
      return { title: 'Couldn\'t connect to the display', body: place.remote ? `Check the connection to ${host}.` : 'Make sure Elevenex is running.' };
    case 'Streaming is unavailable on this machine.':
      return { title: 'Update Elevenex to show apps', body: place.remote ? `Update Elevenex here and reconnect ${host}.` : 'This version can\'t stream app windows.' };
    default:
      return { title: 'The display stopped', body: reason };
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
    next: 'You can keep watching. Click the app again once it\'s allowed.',
  };
  if (detail.endsWith(APP_INPUT_GUIDANCE.foreground)) return {
    message: 'The app needs focus.',
    next: place.remote ? `Click it again, or bring it forward on ${host}.` : 'Click it again, or bring it forward.',
  };
  return { message: detail, next: '' };
}

export const INPUT_INTERRUPTED = 'Input interrupted. Click the app to continue.';
export const INPUT_TOO_LONG = 'Too much text at once. Paste it in parts.';
