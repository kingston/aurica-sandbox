import { readFile } from 'node:fs/promises';

import { defineConfig, type OxlintConfig } from 'oxlint';

function loadOxlintConfigPresets(paths: string[]): Promise<OxlintConfig[]> {
  return Promise.all(
    paths.map(async (path) => {
      const config = await readFile(
        `./node_modules/oxlint-config-presets/${path}`,
        'utf-8',
      );
      const parsedConfig = JSON.parse(config) as OxlintConfig;
      if (!parsedConfig.rules) {
        throw new Error(`Config ${path} is missing rules`);
      }
      return parsedConfig;
    }),
  );
}

const reactRules = {
  'react/display-name': 'error',
  'react/jsx-key': 'error',
  'react/jsx-no-comment-textnodes': 'error',
  'react/jsx-no-duplicate-props': 'error',
  'react/jsx-no-target-blank': 'error',
  'react/jsx-no-undef': 'error',
  'react/no-children-prop': 'error',
  'react/no-danger-with-children': 'error',
  'react/no-direct-mutation-state': 'error',
  'react/no-find-dom-node': 'error',
  'react/no-is-mounted': 'error',
  'react/no-render-return-value': 'error',
  'react/no-string-refs': 'error',
  'react/no-unescaped-entities': 'error',
  'react/no-unknown-property': 'error',
  'react/no-unsafe': 'off',
  // We use React 19 which does not require the react-in-jsx-scope import
  // "react/react-in-jsx-scope": "error",
  'react/require-render-return': 'error',
} as const;

const unicornRules = {
  'unicorn/consistent-assert': 'error',
  'unicorn/consistent-date-clone': 'error',
  'unicorn/consistent-empty-array-spread': 'error',
  'unicorn/consistent-existence-index-check': 'error',
  'unicorn/error-message': 'error',
  'unicorn/escape-case': 'error',
  'unicorn/explicit-length-check': 'error',
  'unicorn/filename-case': ['error', { case: 'kebabCase' }],
  'unicorn/new-for-builtins': 'error',
  'unicorn/no-abusive-eslint-disable': 'error',
  'unicorn/no-anonymous-default-export': 'error',
  'unicorn/no-array-for-each': 'error',
  'unicorn/no-array-reduce': 'error',
  'unicorn/no-await-expression-member': 'error',
  'unicorn/no-console-spaces': 'error',
  'unicorn/no-document-cookie': 'error',
  'unicorn/no-hex-escape': 'error',
  'unicorn/no-immediate-mutation': 'error',
  'unicorn/no-lonely-if': 'error',
  'unicorn/no-magic-array-flat-depth': 'error',
  'unicorn/no-negation-in-equality-check': 'error',
  'unicorn/no-new-buffer': 'error',
  'unicorn/no-object-as-default-parameter': 'error',
  'unicorn/no-process-exit': 'error',
  'unicorn/no-static-only-class': 'error',
  'unicorn/no-this-assignment': 'error',
  'unicorn/no-typeof-undefined': 'error',
  'unicorn/no-unnecessary-array-flat-depth': 'error',
  'unicorn/no-unnecessary-array-splice-count': 'error',
  'unicorn/no-unnecessary-slice-end': 'error',
  'unicorn/no-unreadable-array-destructuring': 'error',
  'unicorn/no-unreadable-iife': 'error',
  'unicorn/no-useless-collection-argument': 'error',
  'unicorn/no-useless-error-capture-stack-trace': 'error',
  'unicorn/no-useless-promise-resolve-reject': 'error',
  'unicorn/no-useless-switch-case': 'error',
  'unicorn/no-zero-fractions': 'error',
  'unicorn/numeric-separators-style': 'error',
  'unicorn/prefer-array-find': 'error',
  'unicorn/prefer-array-flat': 'error',
  'unicorn/prefer-array-flat-map': 'error',
  'unicorn/prefer-array-index-of': 'error',
  'unicorn/prefer-array-some': 'error',
  'unicorn/prefer-at': 'error',
  'unicorn/prefer-bigint-literals': 'error',
  'unicorn/prefer-blob-reading-methods': 'error',
  'unicorn/prefer-class-fields': 'error',
  'unicorn/prefer-classlist-toggle': 'error',
  'unicorn/prefer-code-point': 'error',
  'unicorn/prefer-date-now': 'error',
  'unicorn/prefer-default-parameters': 'error',
  'unicorn/prefer-dom-node-append': 'error',
  'unicorn/prefer-dom-node-dataset': 'error',
  'unicorn/prefer-dom-node-remove': 'error',
  'unicorn/prefer-dom-node-text-content': 'error',
  'unicorn/prefer-event-target': 'error',
  'unicorn/prefer-global-this': 'error',
  'unicorn/prefer-includes': 'error',
  'unicorn/prefer-keyboard-event-key': 'error',
  'unicorn/prefer-math-min-max': 'error',
  'unicorn/prefer-math-trunc': 'error',
  'unicorn/prefer-modern-dom-apis': 'error',
  'unicorn/prefer-modern-math-apis': 'error',
  'unicorn/prefer-native-coercion-functions': 'error',
  'unicorn/prefer-negative-index': 'error',
  'unicorn/prefer-node-protocol': 'error',
  'unicorn/prefer-number-properties': 'error',
  'unicorn/prefer-object-from-entries': 'error',
  'unicorn/prefer-optional-catch-binding': 'error',
  'unicorn/prefer-prototype-methods': 'error',
  'unicorn/prefer-query-selector': 'error',
  'unicorn/prefer-reflect-apply': 'error',
  'unicorn/prefer-regexp-test': 'error',
  'unicorn/prefer-response-static-json': 'error',
  'unicorn/prefer-set-has': 'error',
  'unicorn/prefer-spread': 'error',
  'unicorn/prefer-string-raw': 'error',
  'unicorn/prefer-string-replace-all': 'error',
  'unicorn/prefer-string-slice': 'error',
  'unicorn/prefer-string-trim-start-end': 'error',
  'unicorn/prefer-structured-clone': 'error',
  'unicorn/prefer-ternary': 'error',
  'unicorn/prefer-top-level-await': 'error',
  'unicorn/prefer-type-error': 'error',
  'unicorn/relative-url-style': 'error',
  'unicorn/require-array-join-separator': 'error',
  'unicorn/require-module-attributes': 'error',
  'unicorn/require-number-to-fixed-digits-argument': 'error',
  'unicorn/switch-case-braces': 'error',
  'unicorn/throw-new-error': 'error',
} as const;

export default defineConfig({
  categories: {
    correctness: 'error',
  },
  extends: await loadOxlintConfigPresets([
    '@eslint/recommended.json',
    '@typescript-eslint/strict-type-checked.json',
    '@typescript-eslint/stylistic-type-checked.json',
    'import-x/recommended.json',
    'import-x/typescript.json',
    'react-perf/recommended.json',
    'jsdoc/recommended-typescript-error.json',
    'jsx-a11y/recommended.json',
    '@vitest/recommended.json',
    'prettier.json',
  ]),
  env: {
    builtin: true,
  },
  globals: {},
  ignorePatterns: [
    '**/route-tree.gen.ts',
    '.agents/skills/**',
    '.claude/skills/**',
  ],
  options: {
    typeAware: true,
    typeCheck: true,
  },
  overrides: [
    {
      files: ['*.ts'],
      rules: {
        // Allow default exports for root config files
        'import/no-default-export': 'off',
      },
    },
    {
      files: ['**/routes/**/$*.tsx'],
      rules: {
        // TanStack Router uses $paramName convention for dynamic route files
        'unicorn/filename-case': 'off',
      },
    },
  ],
  plugins: [
    'eslint',
    'typescript',
    'unicorn',
    'jsdoc',
    'react',
    'jsx-a11y',
    'react-perf',
    'node',
    'oxc',
    'import',
    'jest',
    'vitest',
  ],
  rules: {
    ...reactRules,
    ...unicornRules,
    // Disable certain js-doc rules that are more than necessary
    'jsdoc/require-param': 'off',
    'jsdoc/require-returns': 'off',

    // Disallow console.log but allow console.warn, console.error, console.debug, and console.info
    'eslint/no-console': [
      'error',
      { allow: ['warn', 'error', 'debug', 'info'] },
    ],
    // Allow unassigned imports for CSS and Vitest
    'import/no-unassigned-import': [
      'error',
      { allow: ['**/*.css', '**/vitest'] },
    ],
    // Allow the use of arrow functions in nested scopes
    'unicorn/consistent-function-scoping': [
      'error',
      { checkArrowFunctions: false },
    ],
    // Enforce kebab-case for all filenames
    'unicorn/filename-case': ['error', { case: 'kebabCase' }],
    // Allow floating navigate from useNavigate to be handled by the router
    'typescript/no-floating-promises': [
      'error',
      { allowForKnownSafeCalls: [{ from: 'file', name: 'navigate' }] },
    ],
    // Allow promises to be returned from functions for attributes in React
    // To allow for React Hook Form handleSubmit to work as expected
    'typescript/no-misused-promises': [
      'error',
      { checksVoidReturn: { attributes: false } },
    ],
    // Allow redirect and notFound to be thrown from routes
    'typescript/only-throw-error': [
      'error',
      {
        allow: [
          {
            from: 'package',
            name: 'NotFoundError',
            package: '@tanstack/router-core',
          },
          {
            from: 'package',
            name: 'Redirect',
            package: '@tanstack/router-core',
          },
        ],
      },
    ],
    'typescript/explicit-function-return-type': [
      'error',
      { allowExpressions: true, allowTypedFunctionExpressions: true },
    ],
    'typescript/restrict-template-expressions': [
      'error',
      {
        allowNumber: true,
        allowBoolean: false,
        allowNullish: false,
        allowRegExp: false,
      },
    ],
    'react-perf/jsx-no-new-object-as-prop': 'off',
    'react-perf/jsx-no-new-function-as-prop': 'off',
  },
});
