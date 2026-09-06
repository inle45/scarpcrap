/** Lance un seul cycle de collecte puis sort. Utile en cron systeme ou pour tester. */
import { configWarnings } from '../config.js';
import { createLogger, errInfo } from '../logger.js';
import { closeDb, getDb } from '../db/index.js';
import { logConnectorState } from '../connectors/registry.js';
import { runCycle } from '../pipeline/run.js';

const log = createLogger('cli:run');

async function main(): Promise<void> {
  for (const warning of configWarnings()) log.warn(warning);
  const db = getDb();
  logConnectorState();
  const summary = await runCycle(db, 'manual');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  closeDb();
  process.exit(summary.status === 'failed' ? 1 : 0);
}

main().catch((err) => {
  log.error('cycle en echec', errInfo(err));
  closeDb();
  process.exit(1);
});
