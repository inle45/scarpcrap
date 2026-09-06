import cron from 'node-cron';
import { config, configWarnings } from './config.js';
import { createLogger, errInfo } from './logger.js';
import { getDb, closeDb } from './db/index.js';
import { logConnectorState } from './connectors/registry.js';
import { buildServer } from './http/server.js';
import { isRunInFlight, setRunInFlight } from './http/routes.js';
import { runCycle } from './pipeline/run.js';

const log = createLogger('main');

async function main(): Promise<void> {
  for (const warning of configWarnings()) log.warn(warning);

  const db = getDb();
  logConnectorState();

  const app = await buildServer(db);
  await app.listen({ port: config.port, host: config.host });
  log.info('dashboard demarre', {
    url: config.publicUrl || `http://localhost:${config.port}`,
    authentification: config.authToken ? 'jeton requis' : 'AUCUNE',
  });

  /** Lance un cycle en respectant le verrou partage avec l'API. */
  const trigger = async (reason: 'cron' | 'boot'): Promise<void> => {
    if (isRunInFlight()) {
      log.warn('cycle ignore : un autre est deja en cours', { reason });
      return;
    }
    const promise = runCycle(db, reason);
    setRunInFlight(promise);
    try {
      await promise;
    } catch (err) {
      log.error('cycle en echec', errInfo(err));
    } finally {
      setRunInFlight(null);
    }
  };

  if (config.schedule.enabled) {
    if (!cron.validate(config.schedule.cron)) {
      log.error('expression cron invalide, planification desactivee', { cron: config.schedule.cron });
    } else {
      cron.schedule(config.schedule.cron, () => void trigger('cron'), {
        timezone: config.schedule.timezone,
      });
      log.info('planification active', {
        cron: config.schedule.cron,
        timezone: config.schedule.timezone,
      });
    }
  } else {
    log.info('planification desactivee (SCHEDULE_ENABLED=false)');
  }

  if (config.schedule.runOnBoot) void trigger('boot');

  const shutdown = (signal: string): void => {
    log.info('arret demande', { signal });
    void app
      .close()
      .catch((err) => log.error('fermeture du serveur en echec', errInfo(err)))
      .finally(() => {
        closeDb();
        process.exit(0);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('demarrage impossible', errInfo(err));
  process.exit(1);
});
