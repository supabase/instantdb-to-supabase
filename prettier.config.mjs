const config = {
  trailingComma: 'es5',
  tabWidth: 2,
  semi: false,
  singleQuote: true,
  printWidth: 100,
  endOfLine: 'lf',
  sqlKeywordCase: 'lower',
  sqlLiteralCase: 'lower',
  sqlTypeCase: 'lower',
  plugins: ['prettier-plugin-sql-cst', '@ianvs/prettier-plugin-sort-imports'],
  importOrder: ['<THIRD_PARTY_MODULES>', '', '^(@|\\.{1,2})/(.*)$'],
}

export default config
