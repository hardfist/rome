import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppCatalog } from "./catalog.js";
import { AppInstaller } from "./installer.js";
import { AppManager } from "./manager.js";
import type { CatalogEvent, SubscriberHandler, Unsubscribe } from "./state.js";
import type { BundleFetcher } from "./store-bundle.js";

export interface CreateTestAppsOpts {
  profileRoot?: string;
  bundleFetcher?: BundleFetcher;
}

export interface SubscriberRecorder {
  events: CatalogEvent[];
  unsubscribe: Unsubscribe;
}

export interface TestAppsHarness {
  profileRoot: string;
  lockfilePath: string;
  installedRoot: string;
  installer: AppInstaller;
  catalog: AppCatalog;
  appManager: AppManager;
  recordSubscribed(name: string): SubscriberRecorder;
  cleanup(): Promise<void>;
}

/**
 * Build a fully-wired AppManager + AppCatalog + AppInstaller against a tmp
 * profile dir. Tests get a real lockfile + real installer; only the
 * filesystem root is isolated. Callers must `await harness.cleanup()`.
 */
export async function createTestApps(opts: CreateTestAppsOpts = {}): Promise<TestAppsHarness> {
  const profileRoot = opts.profileRoot ?? (await mkdtemp(join(tmpdir(), "rome-test-apps-")));
  const installedRoot = join(profileRoot, "apps", "installed");
  const lockfilePath = join(profileRoot, "apps.lock.json");

  const installer = new AppInstaller({ installedRoot, bundleFetcher: opts.bundleFetcher });
  const appManager = new AppManager({ lockfilePath, installer });
  const catalog = new AppCatalog({
    installer,
    readLockfileEntry: (appId) => appManager.readLockfileEntry(appId),
    getInFlight: (appId) => appManager.getInFlight(appId),
    markBroken: (appId, code, message) => appManager.markBroken(appId, code, message),
  });
  appManager.attachCatalog(catalog);

  function recordSubscribed(name: string): SubscriberRecorder {
    const events: CatalogEvent[] = [];
    const handler = {
      [name](event: CatalogEvent) {
        events.push(event);
      },
    }[name] as SubscriberHandler;
    const unsubscribe = catalog.subscribe(handler);
    return { events, unsubscribe };
  }

  async function cleanup(): Promise<void> {
    if (opts.profileRoot == null) {
      await rm(profileRoot, { recursive: true, force: true });
    }
  }

  return {
    profileRoot,
    lockfilePath,
    installedRoot,
    installer,
    catalog,
    appManager,
    recordSubscribed,
    cleanup,
  };
}
