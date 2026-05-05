module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Conventional default rejects 'sentence-case'/'start-case'/'pascal-case'/
    // 'upper-case' subjects. That breaks legitimate subjects like
    // "fix: P0 hardening pass" or anything starting with an acronym
    // (CI, MCP, V3, etc.). Disable subject-case enforcement.
    'subject-case': [0],
    // Default header-max-length is 100. Bump to 120 so we can keep
    // descriptive subjects without truncation.
    'header-max-length': [2, 'always', 120],
  },
};
