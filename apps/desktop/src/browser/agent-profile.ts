import type { Session } from 'electron';
import type { BrowserAgentHost } from '@elevenex/browser-agent';

/** Fallback for profile operations before a native task has any live target.
 * Existing targets use their own task-partition CDP cookie implementation. */
export function agentProfile(
  session: Session,
): NonNullable<BrowserAgentHost['profile']> {
  return {
    cookies: async () =>
      (await session.cookies.get({})).map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? '',
        path: cookie.path ?? '/',
        expires: cookie.expirationDate ?? -1,
        httpOnly: cookie.httpOnly ?? false,
        secure: cookie.secure ?? false,
        sameSite:
          cookie.sameSite === 'strict'
            ? ('Strict' as const)
            : cookie.sameSite === 'no_restriction'
              ? ('None' as const)
              : ('Lax' as const),
      })),
    addCookies: async (cookies) => {
      for (const cookie of cookies) {
        if (cookie.partitionKey)
          throw new Error(
            'Partitioned cookies require a live native task page',
          );
        const domain = cookie.domain?.replace(/^\./u, ''),
          url =
            cookie.url ??
            `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path ?? '/'}`;
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol))
          throw new Error('Invalid cookie URL');
        await session.cookies.set({
          url,
          name: cookie.name,
          value: cookie.value,
          ...(cookie.domain ? { domain: cookie.domain } : {}),
          path: cookie.path,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite:
            cookie.sameSite === 'Strict'
              ? 'strict'
              : cookie.sameSite === 'None'
                ? 'no_restriction'
                : 'lax',
          ...(cookie.expires !== undefined && cookie.expires >= 0
            ? { expirationDate: cookie.expires }
            : {}),
        });
      }
    },
    clearCookies: () => session.clearStorageData({ storages: ['cookies'] }),
  };
}
