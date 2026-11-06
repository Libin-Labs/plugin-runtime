import {
  createPluginRuntime,
  type PluginContext,
  type PluginRuntimeOptions,
} from '@lp-labs/plugin-runtime';

const options: PluginRuntimeOptions = { maxPlugins: 4 };
const runtime = createPluginRuntime(
  [
    {
      manifest: { id: 'cache', version: '1', capabilities: ['memory'] },
      activate: (context: PluginContext) => context.manifest.id,
    },
  ],
  options,
);
const active: Promise<void> = runtime.start();
void active;
