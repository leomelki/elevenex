import {
  SPEECH_TO_TEXT_TIMEOUT_MS,
  SpeechToTextProviderError,
  throwIfTranscriptionAborted,
} from '../speech-to-text.types.js';

/** One deadline for the upload, response headers, and response body together. */
export async function fetchTranscriptionJson(
  url: string,
  init: RequestInit,
  options: {
    signal?: AbortSignal;
    provider: string;
    describeFailure: (status: number) => string;
  },
): Promise<unknown> {
  throwIfTranscriptionAborted(options.signal);
  const controller = new AbortController();
  let rejectAbort!: (error: SpeechToTextProviderError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (error: SpeechToTextProviderError) => {
    if (!controller.signal.aborted) {
      controller.abort(error);
      rejectAbort(error);
    }
  };
  const onClientAbort = () =>
    abort(new SpeechToTextProviderError('Transcription cancelled.', 499));
  options.signal?.addEventListener('abort', onClientAbort, { once: true });
  const timer = setTimeout(
    () =>
      abort(
        new SpeechToTextProviderError(
          `Transcription with ${options.provider} timed out. Try again.`,
          504,
        ),
      ),
    SPEECH_TO_TEXT_TIMEOUT_MS,
  );

  try {
    // The race also bounds transports that do not settle promptly on abort.
    return await Promise.race([
      aborted,
      (async () => {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw controller.signal.reason;
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw new SpeechToTextProviderError(
            options.describeFailure(response.status),
            response.status,
          );
        }
        return await response.json();
      })(),
    ]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    if (error instanceof SpeechToTextProviderError) {
      throw error;
    }
    // Transport and parsing errors can contain request data or credentials.
    throw new SpeechToTextProviderError(
      `Could not complete transcription with ${options.provider}. Check the connection and try again.`,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onClientAbort);
  }
}
