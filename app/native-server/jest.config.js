module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/scripts/**/*'],
  coverageDirectory: 'coverage',
  // `uuid` v14 ships ESM-only and breaks jest's CJS loader. Map it to a tiny
  // CJS shim that delegates to node's built-in `crypto.randomUUID()`. Same
  // surface (`v4()`), no transform-pipeline gymnastics needed.
  moduleNameMapper: {
    '^uuid$': '<rootDir>/__mocks__/uuid.js',
  },
  // No coverageThreshold gate yet — only one test suite exists. Add thresholds
  // back once meaningful coverage is in place (target server/, tools/ dispatch).
};
