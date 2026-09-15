import nextJest from 'next/jest.js';

// `next/jest` supplies the SWC transform, the CSS/image module mocks and the
// `/.next/` + `/node_modules/` exclusions; only the app-specific remainder
// belongs here.
const createJestConfig = nextJest({ dir: './' });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'jest-environment-jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // The `@/*` path alias lives in tsconfig.json, which Jest does not read.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  // `next build` emits a standalone copy of the workspace under .next; without
  // this Jest's haste map reports a module-name collision against package.json.
  modulePathIgnorePatterns: ['<rootDir>/.next/'],
};

export default createJestConfig(config);
