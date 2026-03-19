module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'cobertura'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  // Force exit after all tests complete so open handles (e.g. HTTP servers,
  // timers) don't cause CI jobs to hang indefinitely.
  forceExit: true,
  // Fail fast if a single test exceeds 30s — catches accidental hangs.
  testTimeout: 30000,
};
