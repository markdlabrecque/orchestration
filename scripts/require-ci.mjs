// Repository policy, executed after the engine's required-CI wait and before merge.
import { execFileSync } from 'node:child_process';
const run = (program, args) => execFileSync(program, args, {encoding: 'utf8'}).trim();
const head = run('git', ['rev-parse', 'HEAD']);
const prHead = () => JSON.parse(run('gh', ['pr', 'view', '--json', 'headRefOid'])).headRefOid;
if (prHead() !== head) throw new Error('PR head differs from this checkout');
const checks = JSON.parse(run('gh', ['pr', 'checks', '--json', 'name,bucket,workflow']));
const required = checks.filter(check => check.workflow === 'v2' && check.name === 'check');
if (!required.length || required.some(check => check.bucket !== 'pass'))
  throw new Error('The v2 / check CI job must pass before merge');
if (prHead() !== head) throw new Error('PR head changed while checking CI');
console.log(`v2 / check passed on ${head}`);
