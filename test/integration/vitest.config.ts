import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/global-setup.ts'],
    // The fixture is a single shared WordPress instance, so tests must run
    // serially — concurrent mutations on the same posts would race.
    fileParallelism: false,
    sequence: { concurrent: false },
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Pulling 100+ items + docker-compose roundtrips means individual tests
    // can take 10s+ on a cold cache.
    testTimeout: 60_000,
    hookTimeout: 240_000,
    include: ['src/**/*.test.ts'],
  },
});
