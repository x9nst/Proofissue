#!/usr/bin/env node
import { argv } from 'node:process';

import { runCli } from './index.js';

const outcome = await runCli(argv.slice(2));
process.exitCode = outcome.exit_code;
