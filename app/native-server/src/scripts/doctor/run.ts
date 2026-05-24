/**
 * Console-mode entry point. Wraps collectDoctorReport with the human-readable
 * stdout rendering used by the CLI. JSON mode dumps the report verbatim.
 */

import { COMMAND_NAME } from '../constant';
import { colorText } from '../utils';
import { collectDoctorReport } from './collect';
import { statusBadge } from './util';
import type { DoctorOptions } from './types';

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const report = await collectDoctorReport(options);
  const packageVersion = report.environment.package.version;

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log(`${COMMAND_NAME} doctor v${packageVersion}\n`);
    for (const check of report.checks) {
      console.log(`${statusBadge(check.status)}    ${check.title}: ${check.message}`);
      const fix = (check.details as Record<string, unknown> | undefined)?.fix as
        | string[]
        | undefined;
      if (check.status !== 'ok' && fix && fix.length > 0) {
        console.log(`        Fix: ${fix[0]}`);
      }
    }
    if (report.fixes.length > 0) {
      console.log('\nFix attempts:');
      for (const f of report.fixes) {
        const badge = f.success ? colorText('[OK]', 'green') : colorText('[ERROR]', 'red');
        console.log(`${badge} ${f.description}${f.success ? '' : ` (${f.error})`}`);
      }
    }
    if (report.nextSteps.length > 0) {
      console.log('\nNext steps:');
      report.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    }
  }

  return report.ok ? 0 : 1;
}
