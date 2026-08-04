module.exports = {
  collectCoverage: true,
  coveragePathIgnorePatterns: ['/node_modules|dist/'],
  collectCoverageFrom: ['src/**/*.ts'],
  transform: {
    '^.+\\.[tj]sx?$': 'ts-jest',
  },
  transformIgnorePatterns: ['/node_modules/(?!(@noble|@scure)/)'],
  testRegex: '(/__tests__/.*|\\.(test|spec))\\.(ts|tsx|js)$',
  moduleFileExtensions: ['ts', 'tsx', 'js'],
};
