import { setupFixture, teardownFixture } from '../../fixtures/wordpress/wp-init.mjs';

export async function setup(): Promise<void> {
  await setupFixture();
}

export async function teardown(): Promise<void> {
  // Leave the fixture running by default — fast iteration locally. Set
  // WPSYNC_TEARDOWN=1 (e.g. in CI) to actually `docker compose down`.
  if (process.env['WPSYNC_TEARDOWN'] === '1') {
    await teardownFixture({ volumes: process.env['WPSYNC_TEARDOWN_VOLUMES'] === '1' });
  }
}
