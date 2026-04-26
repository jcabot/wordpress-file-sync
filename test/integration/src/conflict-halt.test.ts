import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURE,
  disposeRoot,
  initRoot,
  readPostFile,
  runCli,
  wpCliCheck,
} from './helpers';

// PRD §8 AC: "Both sides modified since last_sync causes the tool to exit
// non-zero, name affected slugs, and perform no writes."
describe('conflict halt with exit 4', () => {
  const SLUG = `${FIXTURE.seedSlugPrefix}050`;

  it('halts with exit 4 when both sides changed and writes nothing', async () => {
    const root = await initRoot();
    try {
      // 1. Pull so the post is mirrored locally with a known modified_gmt.
      let r = await runCli(root, ['pull', '--full', '--type', 'post']);
      expect(r.code, r.stderr).toBe(0);

      const filePath = join(root, 'posts', `${SLUG}.html`);
      const baseline = await readPostFile(root, 'post', SLUG);

      // 2. Edit locally and bump mtime past the 2s tolerance.
      await fs.writeFile(filePath, `${baseline}\n<!-- local-side change -->`, 'utf8');
      const future = Date.now() / 1000 + 60;
      await fs.utimes(filePath, future, future);
      const localContents = await fs.readFile(filePath, 'utf8');

      // 3. Mutate the server-side post via wp-cli. Resolve the post id, then
      //    bump its modified_gmt by writing a new title.
      const idOut = await wpCliCheck([
        'post',
        'list',
        `--name=${SLUG}`,
        '--field=ID',
        '--format=ids',
      ]);
      const id = Number.parseInt(idOut.trim(), 10);
      expect(Number.isFinite(id)).toBe(true);
      await wpCliCheck([
        'post',
        'update',
        String(id),
        `--post_title=server-side-edit-${Date.now()}`,
      ]);

      // 4. Pull must halt with exit 4 and name the conflicting slug.
      r = await runCli(root, ['pull']);
      expect(r.code).toBe(4);
      expect(`${r.stdout}\n${r.stderr}`).toContain(`post/${SLUG}`);

      // Local file content must be UNCHANGED across the halted pull.
      expect(await fs.readFile(filePath, 'utf8')).toBe(localContents);

      // 5. Push must also halt with exit 4 and write nothing.
      const pushBeforeServerTitle = await wpCliCheck([
        'post',
        'get',
        String(id),
        '--field=post_title',
      ]);
      r = await runCli(root, ['push']);
      expect(r.code).toBe(4);
      const pushAfterServerTitle = await wpCliCheck([
        'post',
        'get',
        String(id),
        '--field=post_title',
      ]);
      expect(pushAfterServerTitle).toBe(pushBeforeServerTitle);
      // And the local file is still unchanged.
      expect(await fs.readFile(filePath, 'utf8')).toBe(localContents);
    } finally {
      await disposeRoot(root);
    }
  });
});
