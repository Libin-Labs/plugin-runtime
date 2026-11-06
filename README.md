# @lp-labs/plugin-runtime

Manifest-ordered plugin lifecycle management with explicit activation rollback and reverse-order
cleanup. **This library is not a security sandbox.**

## Install and quickstart

```bash
npm install @lp-labs/plugin-runtime
```

```js
import { createPluginRuntime } from '@lp-labs/plugin-runtime';

const runtime = createPluginRuntime([
  {
    manifest: { id: 'storage', version: '1.0.0', capabilities: ['memory'] },
    activate: async () => ({ ready: true }),
    deactivate: async (storage) => {
      storage.ready = false;
    },
  },
]);
await runtime.start();
if (!runtime.get('storage').ready) throw new Error('Plugin did not start');
await runtime.dispose();
```

ESM and CommonJS builds include declarations. CommonJS:
`require('@lp-labs/plugin-runtime')`.

## API, manifests, and lifecycle

- `createPluginRuntime(definitions, options?)` copies and validates each manifest before any
  activation. Manifests provide a unique `id`, bounded non-empty `version`, optional
  `dependencies`, and optional `capabilities`.
- Dependencies are topologically ordered, preserving input order among independent plugins.
  Missing dependencies and cycles fail during construction with `PluginRuntimeError`.
- Each `activate(context)` runs once in dependency order. `PluginContext` exposes its immutable
  manifest and `getDependency<T>(id)`, which only returns a declared, already active dependency.
- If activation fails, active plugins are deactivated in reverse order and an
  `activation-failed` error reports the original and rollback errors.
- `start()` returns a promise; `get<T>(id)` returns an active instance; `stop()` and `dispose()`
  perform reverse-order cleanup. Cleanup attempts continue after individual errors.
- `PluginRuntimeOptions` bounds plugin count (default 256, maximum 2,000), dependencies per
  plugin (64, maximum 256), and capabilities per plugin (64, maximum 256).
- `PluginRuntime` exposes state and resolved `order`. States are `created`, `starting`, `started`,
  `failed`, `stopping`, and `stopped`. `PluginRuntimeError` includes a stable `code`, optional
  plugin id, cycle path, and underlying errors.

## Safety, failures, and limits

Plugin functions execute directly in the current JavaScript process with the caller's authority.
They can access globals, block the event loop, mutate shared state, or fail to settle. This package
provides no isolation, permissions enforcement, timeouts, capability security, hot reload,
version-range negotiation, plugin discovery, or hard cancellation. Treat plugin definitions and
their lifecycle hooks as trusted code. Activation failures and disposal failures are explicit;
failed cleanup does not prevent attempts to clean up remaining active plugins.
If an activation hook fails before returning its instance, that hook remains responsible for
cleaning up any partial resources it acquired.

No runtime or peer dependencies.

## Runtime exports

`createPluginRuntime` and `PluginRuntimeError`.

Types: `PluginManifest`, `PluginContext`, `PluginDefinition`, `PluginRuntimeState`,
`PluginRuntimeOptions`, and `PluginRuntime`.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
