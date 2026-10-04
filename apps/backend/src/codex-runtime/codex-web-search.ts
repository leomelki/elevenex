/** The app-server and persisted response items use different action casing. */
export function codexWebSearchInput(item: {
  query?: unknown;
  action?: unknown;
}): Record<string, unknown> {
  const action =
    item.action && typeof item.action === 'object'
      ? (item.action as Record<string, unknown>)
      : null;
  const queries = Array.isArray(action?.['queries'])
    ? action['queries'].filter(
        (query): query is string => typeof query === 'string' && !!query.trim(),
      )
    : [];
  const query = queries.length
    ? queries.join('\n')
    : typeof action?.['query'] === 'string' && action['query'].trim()
      ? action['query']
      : typeof item.query === 'string'
        ? item.query
        : '';
  return {
    query:
      query ||
      [action?.['pattern'], action?.['url']]
        .filter((value) => typeof value === 'string' && value.trim())
        .join(' in '),
    ...(queries.length ? { queries } : {}),
    ...(action ? { action } : {}),
  };
}
