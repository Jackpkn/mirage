import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'

// integ is its own base path, so this config lives here rather than in
// typescript/: ESLint 9 ignores any file outside the directory holding the
// config that selected it, which is why `eslint ../integ` from typescript/
// answered "File ignored because outside of base path" and integ was silently
// unlinted. The rule set is the untyped one on purpose -- typescript/'s
// strictTypeChecked presets are calibrated for the published packages, and the
// runners and the older fakes here would answer with hundreds of findings that
// have nothing to do with the fakes this tree exists to serve.
export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/generated/**', 'truth/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The CLI fixtures are plain JavaScript loaded by the tally-CLI cases, so
    // no-undef is live for them where it is off for every TypeScript file.
    // TextEncoder is a node builtin; naming the two of them is cheaper than
    // pulling in the `globals` package for one identifier.
    files: ['fixtures/**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { TextEncoder: 'readonly', TextDecoder: 'readonly' } },
  },
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // varsIgnorePattern as well as argsIgnorePattern: the runners omit a key
      // by destructuring it into a leading-underscore name and spreading the
      // rest, which is a variable and not an argument.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  prettierConfig,
)
