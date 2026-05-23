import { readState } from '#src/state/index.js';

export async function runList(): Promise<void> {
  const state = await readState();
  const items = Object.values(state.sandboxes);
  if (items.length === 0) {
    console.info('No sandboxes registered.');
    return;
  }

  // Group primaries first, each followed by their forks in concurrencyIndex order.
  const primaries = items.filter((i) => i.kind === 'primary');
  const forksByParent = new Map<string, typeof items>();
  for (const item of items) {
    if (item.kind === 'fork' && item.parentName) {
      const list = forksByParent.get(item.parentName) ?? [];
      list.push(item);
      forksByParent.set(item.parentName, list);
    }
  }

  const rows: Record<string, string>[] = [];
  for (const primary of primaries) {
    rows.push({
      name: primary.name,
      kind: 'primary',
      status: primary.status,
      ip: primary.ip ?? '-',
      projectDir: primary.projectDir,
    });
    const forks = (forksByParent.get(primary.name) ?? []).sort(
      (a, b) => (a.concurrencyIndex ?? 0) - (b.concurrencyIndex ?? 0),
    );
    for (const fork of forks) {
      rows.push({
        name: `  └ ${fork.name}`,
        kind: `fork #${fork.concurrencyIndex ?? '?'}`,
        status: fork.status,
        ip: fork.ip ?? '-',
        projectDir: '',
      });
    }
  }

  console.table(rows);
}
