/** Popups retain JavaScript references to their opener. CDP isolation alone
 * cannot prevent same-origin DOM access through those references, so ownership
 * changes must cover the entire linked group, including nested popups. */
export class RelatedBrowserTabs {
  private readonly groups = new Map<string, Set<string>>();
  link(tabId: string, openerId: string): void {
    const group = this.groups.get(openerId) ?? new Set([openerId]);
    const previous = this.groups.get(tabId);
    for (const id of previous ?? [tabId]) {
      group.add(id);
      this.groups.set(id, group);
    }
    for (const id of group) this.groups.set(id, group);
  }
  members(tabId: string): readonly string[] {
    return [...(this.groups.get(tabId) ?? [tabId])];
  }
  remove(tabId: string): void {
    const group = this.groups.get(tabId);
    this.groups.delete(tabId);
    group?.delete(tabId);
    if (group?.size === 1) for (const id of group) this.groups.delete(id);
  }
}
