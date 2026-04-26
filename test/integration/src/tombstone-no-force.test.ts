import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  disposeRoot,
  initRoot,
  postFileExists,
  readPostFile,
  runCli,
  wpCli,
  wpCliCheck,
} from './helpers';

// PRD §4.5 / §8 AC: "The tool never sends `force=true` on any DELETE request
// (verifiable by HTTP capture)." We verify *behaviorally*: a tombstoned post
// should land in the WP trash and remain restorable via `wp post update
// --post_status=publish`. If `force=true` had been sent, WP would have purged
// the row entirely and the restore would fail with "Could not find the post".
describe('tombstone deletion without force=true', () => {
  it('moves the post to trash and leaves it restorable', async () => {
    const slug = `wpsync-tomb-${randomUUID().slice(0, 8)}`;
    const root = await initRoot();
    try {
      // 1. Create a fresh post on the server so the test is independent of
      //    the seeded fixture.
      const idOut = await wpCliCheck([
        'post',
        'create',
        `--post_title=tomb-${slug}`,
        `--post_name=${slug}`,
        '--post_status=publish',
        '--post_type=post',
        '--post_content=tomb-body',
        '--porcelain',
      ]);
      const id = Number.parseInt(idOut.trim(), 10);
      expect(Number.isFinite(id)).toBe(true);

      try {
        // 2. Pull — local mirror now has the new post.
        let r = await runCli(root, ['pull', '--full', '--type', 'post']);
        expect(r.code, r.stderr).toBe(0);
        expect(await postFileExists(root, 'post', slug)).toBe(true);

        // 3. Mark it tombstoned by flipping `status: publish` → `status: trash`
        //    and bumping the file mtime so push picks it up.
        const filePath = join(root, 'posts', `${slug}.html`);
        const original = await readPostFile(root, 'post', slug);
        const trashed = original.replace(/\nstatus: publish\n/, '\nstatus: trash\n');
        expect(trashed).not.toBe(original);
        await fs.writeFile(filePath, trashed, 'utf8');
        const future = Date.now() / 1000 + 120;
        await fs.utimes(filePath, future, future);

        // 4. Push — should DELETE the server post and remove the local file.
        r = await runCli(root, ['push', '--type', 'post']);
        expect(r.code, r.stderr).toBe(0);
        expect(await postFileExists(root, 'post', slug)).toBe(false);

        // 5. Server-side: post must be in trash, NOT permanently deleted.
        const status = (
          await wpCliCheck(['post', 'get', String(id), '--field=post_status'])
        ).trim();
        expect(status).toBe('trash');

        // 6. The proof: restoring the post must succeed. If `force=true` had
        //    been sent, the row would be gone and this would error.
        const restore = await wpCli([
          'post',
          'update',
          String(id),
          '--post_status=draft',
        ]);
        expect(
          restore.code,
          `wp post update failed; force=true must have been sent. stderr: ${restore.stderr}`,
        ).toBe(0);
        const afterRestore = (
          await wpCliCheck(['post', 'get', String(id), '--field=post_status'])
        ).trim();
        expect(afterRestore).toBe('draft');
      } finally {
        // Cleanup: best-effort permanent delete (with force) so the fixture
        // doesn't accumulate orphaned posts across runs.
        await wpCli(['post', 'delete', String(id), '--force']);
      }
    } finally {
      await disposeRoot(root);
    }
  });
});
