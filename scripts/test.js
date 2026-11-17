const { spawnSync } = require('node:child_process');

// Each Node test process receives an independent in-memory database.
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    AI_PROVIDER: 'mock',
    AI_API_KEY: '',
    QUEST_API_KEY: '',
    DB_PATH: ':memory:',
  },
});
process.exit(result.status ?? 1);
