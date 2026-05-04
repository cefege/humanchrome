import type { TriggerSpec, TriggerKind } from '../../domain/triggers';

export interface TriggerHandler<K extends TriggerKind = TriggerKind> {
  readonly kind: K;

  /** Install the trigger (e.g. register chrome API listeners). */
  install(trigger: Extract<TriggerSpec, { kind: K }>): Promise<void>;

  /** Uninstall a single trigger. */
  uninstall(triggerId: string): Promise<void>;

  /** Uninstall every trigger of this kind. */
  uninstallAll(): Promise<void>;

  getInstalledIds(): string[];
}

/** Callback the TriggerManager injects into each handler. */
export interface TriggerFireCallback {
  onFire(
    triggerId: string,
    context: {
      sourceTabId?: number;
      sourceUrl?: string;
    },
  ): Promise<void>;
}

export type TriggerHandlerFactory<K extends TriggerKind> = (
  fireCallback: TriggerFireCallback,
) => TriggerHandler<K>;
