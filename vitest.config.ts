import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['setup/test/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
