import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export async function buildUploadPlan({ files, cache = {} }) {
  const plan = [];
  for (const [kind, file] of Object.entries(files || {})) {
    const sha256 = await sha256File(file);
    const previous = cache?.images?.[kind];
    if (previous?.sha256 === sha256 && previous?.image_key) continue;
    plan.push({ kind, file, sha256 });
  }
  return plan;
}
