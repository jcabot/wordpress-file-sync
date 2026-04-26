import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURE,
  disposeRoot,
  frontmatterAndBody,
  initRoot,
  postFileExists,
  readPostFile,
  runCli,
} from './helpers';

// PRD §8 AC: "Pull → push → pull produces a body byte-identical to the first pull."
// We use a dedicated seed slug so concurrent tests aren't a concern (vitest is
// configured to run files serially anyway).
describe('round-trip integrity (pull → push → pull)', () => {
  const SLUG = `${FIXTURE.seedSlugPrefix}099`;

  it('preserves the locally-edited body across a full server round-trip', async () => {
    const root = await initRoot();
    try {
      // 1. Initial pull gives us the seed post locally.
      let r = await runCli(root, ['pull', '--full', '--type', 'post']);
      expect(r.code, r.stderr).toBe(0);
      expect(await postFileExists(root, 'post', SLUG)).toBe(true);

      // 2. Edit the body locally — distinctive marker we'll look for after the round-trip.
      const filePath = join(root, 'posts', `${SLUG}.html`);
      const original = await readPostFile(root, 'post', SLUG);
      const marker = `<!-- wpsync-roundtrip-${Date.now()} -->`;
      const edited = original.replace(/\n<!-- wp:paragraph -->/, `\n${marker}\n<!-- wp:paragraph -->`);
      expect(edited).not.toBe(original);
      await fs.writeFile(filePath, edited, 'utf8');
      // Bump mtime past the 2s tolerance so push sees it as locally newer.
      const future = Date.now() / 1000 + 60;
      await fs.utimes(filePath, future, future);

      // 3. Push — server now holds our edited body.
      r = await runCli(root, ['push', '--type', 'post']);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/(updated 1|Pushed 1)/);

      // Stash the post-push body before the next pull rewrites the file.
      const afterPush = frontmatterAndBody(await readPostFile(root, 'post', SLUG)).body;
      expect(afterPush).toContain(marker);

      // 4. Force a full pull — this rewrites the file from the server's authoritative copy.
      r = await runCli(root, ['pull', '--full', '--type', 'post']);
      expect(r.code, r.stderr).toBe(0);

      const afterPull = frontmatterAndBody(await readPostFile(root, 'post', SLUG)).body;

      // The body must be byte-identical between (post-push) and (post-pull).
      expect(afterPull).toBe(afterPush);
      expect(afterPull).toContain(marker);
    } finally {
      await disposeRoot(root);
    }
  });
});
