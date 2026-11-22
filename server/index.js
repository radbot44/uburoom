'use strict';
// uburoom's entry point: setup mode when the config file is missing, otherwise the server (server/start.js).
require('./start')
  .run()
  .catch(error => {
    process.stderr.write(`[uburoom] ${error.message}\n`);
    process.exitCode = 1;
  });
