import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Domain code must stay framework-free: no React, no Dexie, no UI or storage imports. */
describe('architecture', () => {
  const dir = join(import.meta.dirname, 'domain');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  it.each(files)('%s imports only domain code', (file) => {
    const src = readFileSync(join(dir, file), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    for (const spec of imports) {
      if (file.endsWith('.test.ts') && spec === 'vitest') continue;
      expect(spec, `${file} imports ${spec}`).toMatch(/^\.\//);
    }
  });
});
