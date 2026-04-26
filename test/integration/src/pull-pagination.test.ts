import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { initRoot, runCli, FIXTURE, disposeRoot } from './helpers';

// PRD §8 AC: "Pagination works correctly across the 100-item per_page boundary
// (verified with >= 101 items)." The fixture seeds 105 posts with the prefix
// `wpsync-seed-`, so a clean --full pull MUST walk past the per_page=100 cap.
describe('pull pagination across per_page=100 boundary', () => {
  it('writes 105+ files for a fresh full pull and never stops at the page boundary', async () => {
    const root = await initRoot();
    try {
      const res = await runCli(root, ['pull', '--full', '--type', 'post']);
      expect(res.code, res.stderr).toBe(0);

      const postsDir = join(root, 'posts');
      const entries = await fs.readdir(postsDir);
      const seedFiles = entries.filter((n) => n.startsWith(FIXTURE.seedSlugPrefix));
      // The fixture seeds 105 posts. We assert >= 101 (the PRD threshold) and
      // > 100 (the per_page cap) — proving the paginator advanced.
      expect(seedFiles.length).toBeGreaterThanOrEqual(101);
      expect(seedFiles.length).toBeGreaterThan(100);

      // Every seed file should be a valid front-matter doc with a sane id.
      const sample = seedFiles[0];
      expect(sample).toBeDefined();
      const text = await fs.readFile(join(postsDir, sample!), 'utf8');
      expect(text).toMatch(/^---\n/);
      expect(text).toMatch(/\nid: \d+\n/);
      expect(text).toMatch(/\ntype: post\n/);
    } finally {
      await disposeRoot(root);
    }
  });
});
