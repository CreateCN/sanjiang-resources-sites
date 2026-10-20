/** Check unseen resources first, then the oldest result; published order breaks ties. */
export function selectLinkCheckResources<T extends { id: string }>(
  resources: T[], checks: { resourceId: string; checkedAt: string }[], limit: number,
): T[] {
  const dates = new Map(checks.map((check) => [check.resourceId, check.checkedAt]));
  return [...resources].sort((a, b) => (dates.get(a.id) ?? '').localeCompare(dates.get(b.id) ?? '')).slice(0, limit);
}
