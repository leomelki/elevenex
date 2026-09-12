const TRUSTED_CLIPBOARD_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
]);

function isTrustedAppUrl(url) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return true;

    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

function shouldGrantAppPermission(permission, url, details = {}) {
  if (!isTrustedAppUrl(url)) return false;

  if (permission === 'media') {
    return !details.mediaTypes?.includes('video');
  }

  return TRUSTED_CLIPBOARD_PERMISSIONS.has(permission);
}

module.exports = {
  isTrustedAppUrl,
  shouldGrantAppPermission,
};
