const { defineConfig } = require('eslint/config')
const nextConfig = require('eslint-config-next/core-web-vitals')
const prettier = require('eslint-config-prettier/flat')
const parser = require('@typescript-eslint/parser')
const compilerRulesOff = {}
for (const config of nextConfig) {
  for (const name of Object.keys(config.rules ?? {})) {
    if (
      name.startsWith('react-hooks/') &&
      !['react-hooks/exhaustive-deps', 'react-hooks/rules-of-hooks'].includes(name)
    )
      compilerRulesOff[name] = 'off'
  }
}
module.exports = defineConfig([
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'vendor/**',
      'coverage/**',
      'next-env.d.ts',
      'app/.well-known/workflow/**',
      '.workflow-data/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  ...nextConfig,
  prettier,
  {
    rules: {
      ...compilerRulesOff,
      '@next/next/no-html-link-for-pages': 'off',
      'react/jsx-key': 'off',
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser },
    plugins: {
      supabase: {
        rules: {
          'no-await-before-copy-to-clipboard': require('./vendor/eslint/no-await-before-copy-to-clipboard.cjs'),
          'require-explicit-tabindex': require('./vendor/eslint/require-explicit-tabindex.cjs'),
        },
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'supabase/no-await-before-copy-to-clipboard': 'error',
      'supabase/require-explicit-tabindex': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    ignores: ['app/**', '**/*.config.*'],
    rules: { 'no-restricted-exports': ['error', { restrictDefaultExports: { direct: true } }] },
  },
])
