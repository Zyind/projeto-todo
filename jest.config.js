module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  // Cobertura obrigatória: apenas os arquivos de produção em TypeScript (api.ts, db.ts e cli.ts).
  collectCoverageFrom: ['api.ts', 'db.ts', 'cli.ts'],
  coverageReporters: ['text', 'text-summary'],
  coverageThreshold: { global: { lines: 100 } },
};
