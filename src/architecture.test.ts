import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Domain code must stay framework-free: no React, no Dexie, no browser
 * storage, no UI. It may import other domain files and pure parsing
 * libraries (PapaParse).
 */
const ALLOWED_PACKAGES = new Set(['papaparse']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('architecture', () => {
  const root = join(process.cwd(), 'src/domain');
  const files = walk(root).map((f) => relative(root, f));
  it.each(files)('domain/%s imports only domain code', (file) => {
    const src = readFileSync(join(root, file), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    for (const spec of imports) {
      if (file.endsWith('.test.ts') && spec === 'vitest') continue;
      if (ALLOWED_PACKAGES.has(spec)) continue;
      // Tax parameter files are data, kept at /tax/lu/YYYY.json as the PRD asks.
      if (/\.json$/.test(spec) && join(root, file, '..', spec).startsWith(join(process.cwd(), 'tax', 'lu'))) continue;
      expect(spec, `${file} imports ${spec}`).toMatch(/^\.\.?\//);
      const resolved = join(root, file, '..', spec);
      expect(resolved.startsWith(root), `${file} reaches outside domain via ${spec}`).toBe(true);
    }
  });
});
