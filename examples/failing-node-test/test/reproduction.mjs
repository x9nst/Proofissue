import { calculate } from '../src/calculate.mjs';

if (calculate(2) !== 4) {
  console.error('Expected 4 from calculate(2)');
  process.exitCode = 1;
}
