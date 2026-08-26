import { useEffect } from 'react';

import { usePlugins } from '../../../contexts/PluginsContext';
import { authenticatedFetch } from '../../../utils/api';

type PluginContext = {
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
};

/**
 * Auto-activates enabled tab plugins on app load, so plugins that register
 * global listeners (e.g. push-to-talk) work without visiting their tab.
 * Tab UI still mounts normally when the user opens the tab; this only runs
 * the module's mount() side effects early.
 */
export default function PluginAutoBoot() {
  const { plugins } = usePlugins();

  useEffect(() => {
    const enabled = plugins.filter((p) => p.enabled && p.type === 'module');
    if (enabled.length === 0) return;

    let cancelled = false;

    const bootContext = (): PluginContext => ({
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      project: null,
      session: null,
    });

    void (async () => {
      for (const plugin of enabled) {
        if (cancelled) return;
        try {
          const entryFile = plugin.entry || 'index.js';
          const assetUrl = `/api/plugins/${encodeURIComponent(plugin.name)}/assets/${encodeURIComponent(entryFile)}`;
          const res = await authenticatedFetch(assetUrl);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const jsText = await res.text();
          const blobUrl = URL.createObjectURL(new Blob([jsText], { type: 'application/javascript' }));
          const mod = await import(/* @vite-ignore */ blobUrl).finally(() => URL.revokeObjectURL(blobUrl));
          if (cancelled) {
            try { mod?.unmount?.(null); } catch { /* ignore */ }
            return;
          }
          // Mount into a detached container: plugins that only bind window
          // listeners work fine; DOM-building plugins render nothing visible
          // until their real tab mounts them again.
          await mod.mount?.(document.createElement('div'), {
            get context() { return bootContext(); },
            onContextChange: () => () => {},
            rpc: async () => { throw new Error('rpc unavailable in auto-boot'); },
          });
        } catch (err) {
          console.warn(`[PluginAutoBoot] ${plugin.name}:`, err);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-run when the enabled set changes (install/enable/disable in settings).
  }, [plugins]);

  return null;
}
