import {
  createPluginRuntime,
  type PluginDefinition,
  type PluginRuntime,
} from '@lp-labs/plugin-runtime';

const plugins: PluginDefinition[] = [
  { manifest: { id: 'worker', version: '1' }, activate: async () => ({ running: true }) },
];
const runtime: PluginRuntime = createPluginRuntime(plugins);
await runtime.start();
const state: string = runtime.state;
await runtime.stop();
void state;
