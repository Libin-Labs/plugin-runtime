export interface PluginManifest {
  id: string;
  version: string;
  dependencies?: readonly string[];
  capabilities?: readonly string[];
}

export interface PluginContext {
  readonly manifest: Readonly<PluginManifest>;
  getDependency<T = unknown>(id: string): T;
}

export interface PluginDefinition<T = unknown> {
  manifest: PluginManifest;
  activate(context: PluginContext): T | PromiseLike<T>;
  deactivate?(instance: T, context: PluginContext): void | PromiseLike<void>;
}

export type PluginRuntimeState =
  'created' | 'starting' | 'started' | 'failed' | 'stopping' | 'stopped';

export interface PluginRuntimeOptions {
  maxPlugins?: number;
  maxDependenciesPerPlugin?: number;
  maxCapabilitiesPerPlugin?: number;
}

export interface PluginRuntime {
  readonly state: PluginRuntimeState;
  readonly order: readonly string[];
  start(): Promise<void>;
  get<T = unknown>(id: string): T;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export class PluginRuntimeError extends Error {
  constructor(
    readonly code:
      | 'invalid-manifest'
      | 'duplicate-plugin'
      | 'missing-dependency'
      | 'dependency-cycle'
      | 'invalid-state'
      | 'activation-failed'
      | 'disposal-failed',
    message: string,
    readonly pluginId?: string,
    readonly errors?: readonly unknown[],
    readonly path?: readonly string[],
  ) {
    super(message);
    this.name = 'PluginRuntimeError';
  }
}

function bounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) {
    throw new RangeError(`${name} must be an integer from 0 through ${maximum}.`);
  }
  return result;
}

function manifestCopy(
  value: PluginManifest,
  maxDependencies: number,
  maxCapabilities: number,
): PluginManifest {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.id) ||
    typeof value.version !== 'string' ||
    value.version.length === 0 ||
    value.version.length > 128
  ) {
    throw new PluginRuntimeError(
      'invalid-manifest',
      'Plugin manifest needs a bounded id and version.',
    );
  }
  const dependencies = [...(value.dependencies ?? [])];
  const capabilities = [...(value.capabilities ?? [])];
  if (
    dependencies.length > maxDependencies ||
    capabilities.length > maxCapabilities ||
    dependencies.some(
      (entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 128,
    ) ||
    capabilities.some(
      (entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 128,
    ) ||
    new Set(dependencies).size !== dependencies.length ||
    new Set(capabilities).size !== capabilities.length
  ) {
    throw new PluginRuntimeError(
      'invalid-manifest',
      `Plugin ${value.id} has invalid dependency or capability metadata.`,
      value.id,
    );
  }
  return Object.freeze({
    id: value.id,
    version: value.version,
    dependencies: Object.freeze(dependencies),
    capabilities: Object.freeze(capabilities),
  });
}

export function createPluginRuntime(
  definitions: readonly PluginDefinition[],
  options: PluginRuntimeOptions = {},
): PluginRuntime {
  const maxPlugins = bounded(options.maxPlugins, 256, 2_000, 'maxPlugins');
  const maxDependencies = bounded(
    options.maxDependenciesPerPlugin,
    64,
    256,
    'maxDependenciesPerPlugin',
  );
  const maxCapabilities = bounded(
    options.maxCapabilitiesPerPlugin,
    64,
    256,
    'maxCapabilitiesPerPlugin',
  );
  if (!Array.isArray(definitions) || definitions.length > maxPlugins) {
    throw new PluginRuntimeError('invalid-manifest', 'Plugin definitions must fit maxPlugins.');
  }
  const records = new Map<
    string,
    { definition: PluginDefinition; manifest: Readonly<PluginManifest> }
  >();
  const inputOrder: string[] = [];
  for (const definition of definitions) {
    if (
      !definition ||
      typeof definition.activate !== 'function' ||
      (definition.deactivate !== undefined && typeof definition.deactivate !== 'function')
    ) {
      throw new PluginRuntimeError('invalid-manifest', 'Each plugin needs an activation function.');
    }
    const manifest = manifestCopy(definition.manifest, maxDependencies, maxCapabilities);
    if (records.has(manifest.id)) {
      throw new PluginRuntimeError(
        'duplicate-plugin',
        `Duplicate plugin id: ${manifest.id}.`,
        manifest.id,
      );
    }
    records.set(manifest.id, { definition, manifest });
    inputOrder.push(manifest.id);
  }

  for (const [id, record] of records) {
    for (const dependency of record.manifest.dependencies ?? []) {
      if (!records.has(dependency)) {
        throw new PluginRuntimeError(
          'missing-dependency',
          `Plugin ${id} requires missing plugin ${dependency}.`,
          id,
        );
      }
      if (dependency === id) {
        throw new PluginRuntimeError(
          'dependency-cycle',
          `Plugin ${id} depends on itself.`,
          id,
          undefined,
          [id, id],
        );
      }
    }
  }

  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'visited'>();
  const visit = (id: string, trail: readonly string[]) => {
    const current = state.get(id);
    if (current === 'visited') return;
    if (current === 'visiting') {
      const start = trail.indexOf(id);
      const cycle = [...trail.slice(start), id];
      throw new PluginRuntimeError(
        'dependency-cycle',
        `Plugin dependency cycle: ${cycle.join(' -> ')}.`,
        id,
        undefined,
        cycle,
      );
    }
    state.set(id, 'visiting');
    const dependencies = records.get(id)!.manifest.dependencies ?? [];
    for (const dependency of dependencies) visit(dependency, [...trail, id]);
    state.set(id, 'visited');
    order.push(id);
  };
  for (const id of inputOrder) visit(id, []);

  const instances = new Map<string, unknown>();
  let runtimeState: PluginRuntimeState = 'created';
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  const contextFor = (id: string): PluginContext => {
    const record = records.get(id)!;
    return Object.freeze({
      manifest: record.manifest,
      getDependency<T = unknown>(dependencyId: string): T {
        if (!(record.manifest.dependencies ?? []).includes(dependencyId)) {
          throw new PluginRuntimeError(
            'invalid-manifest',
            `Plugin ${id} did not declare dependency ${dependencyId}.`,
            id,
          );
        }
        if (!instances.has(dependencyId)) {
          throw new PluginRuntimeError(
            'invalid-state',
            `Dependency ${dependencyId} is not active.`,
            id,
          );
        }
        return instances.get(dependencyId) as T;
      },
    });
  };

  const disposeActive = async (): Promise<unknown[]> => {
    const errors: unknown[] = [];
    for (const id of [...order].reverse()) {
      if (!instances.has(id)) continue;
      const record = records.get(id)!;
      const instance = instances.get(id);
      instances.delete(id);
      try {
        await record.definition.deactivate?.(instance, contextFor(id));
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };

  const start = (): Promise<void> => {
    if (runtimeState === 'starting' && starting) return starting;
    if (runtimeState !== 'created') {
      return Promise.reject(
        new PluginRuntimeError('invalid-state', `Cannot start a runtime in state ${runtimeState}.`),
      );
    }
    runtimeState = 'starting';
    starting = (async () => {
      try {
        for (const id of order) {
          const record = records.get(id)!;
          const instance = await record.definition.activate(contextFor(id));
          instances.set(id, instance);
        }
        runtimeState = 'started';
      } catch (error) {
        const rollbackErrors = await disposeActive();
        runtimeState = 'failed';
        throw new PluginRuntimeError(
          'activation-failed',
          `Plugin activation failed${rollbackErrors.length ? `; ${rollbackErrors.length} rollback operation(s) also failed` : ''}.`,
          undefined,
          [error, ...rollbackErrors],
        );
      }
    })();
    return starting;
  };

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (runtimeState === 'starting') {
        try {
          await starting;
        } catch {
          return;
        }
      }
      if (runtimeState === 'stopped' || runtimeState === 'failed') {
        runtimeState = runtimeState === 'failed' ? 'failed' : 'stopped';
        return;
      }
      if (runtimeState !== 'started') {
        if (runtimeState === 'created') {
          runtimeState = 'stopped';
          return;
        }
        throw new PluginRuntimeError(
          'invalid-state',
          `Cannot stop a runtime in state ${runtimeState}.`,
        );
      }
      runtimeState = 'stopping';
      const errors = await disposeActive();
      runtimeState = 'stopped';
      if (errors.length > 0) {
        throw new PluginRuntimeError(
          'disposal-failed',
          `${errors.length} plugin cleanup operation(s) failed.`,
          undefined,
          errors,
        );
      }
    })();
    return stopping;
  };

  return {
    get state() {
      return runtimeState;
    },
    order: Object.freeze([...order]),
    start,
    get<T = unknown>(id: string): T {
      if (runtimeState !== 'started' || !instances.has(id)) {
        throw new PluginRuntimeError('invalid-state', `Plugin ${id} is not active.`, id);
      }
      return instances.get(id) as T;
    },
    stop,
    dispose: stop,
  };
}
