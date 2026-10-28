import type { Command } from 'commander';
import { loadCoordinatorConfig } from './coordinator-config';
import { FleetCoordinator } from './coordinator';

export function registerCoordinatorCommand(fleet: Command): void {
  fleet
    .command('coordinator')
    .description('Run a browserless coordinator for registered native workers')
    .requiredOption(
      '--config <file>',
      'Coordinator configuration JSON (credentials must be private)',
    )
    .action(async (options: { config: string }) => {
      const coordinator = new FleetCoordinator(await loadCoordinatorConfig(options.config));
      console.log(`fleet: coordinator: listening on ${await coordinator.listen()}`);
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        try {
          await coordinator.close();
          process.exitCode = 0;
        } catch {
          console.error('fleet: coordinator: shutdown failed');
          process.exitCode = 1;
        }
      };
      process.once('SIGTERM', () => void shutdown());
      process.once('SIGINT', () => void shutdown());
    });
}
