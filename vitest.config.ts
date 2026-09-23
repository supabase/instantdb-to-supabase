import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: [
        'src/import/**/*.ts',
        'src/server/**/*.ts',
        'src/workflow/**/*.ts',
        'workflows/**/*.ts',
        'app/api/**/*.ts',
      ],
    },
  },
})
