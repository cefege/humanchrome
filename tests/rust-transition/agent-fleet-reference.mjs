import { readFile } from 'node:fs/promises';

const path = new URL('./agent-fleet-reference.json', import.meta.url);
let reference;

export async function agentFleetReference() {
  reference ??= JSON.parse(await readFile(path, 'utf8'));
  return reference;
}
