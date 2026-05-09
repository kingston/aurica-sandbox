import { readState } from '#src/state/index.js';

export async function runList(): Promise<void> {
  const state = await readState();
  const items = Object.values(state.sandboxes);
  if (items.length === 0) {
    console.info('No sandboxes registered.');
    return;
  }
  const rows = items.map((i) => ({
    name: i.name,
    status: i.status,
    ip: i.ip ?? '-',
    projectDir: i.projectDir,
  }));
  console.table(rows);
}
