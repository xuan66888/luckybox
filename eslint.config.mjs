import tseslint from 'typescript-eslint';
export default tseslint.config(...tseslint.configs.recommended, {
  rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }], '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }] }
});
