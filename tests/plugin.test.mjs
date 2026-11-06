import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginRuntime, PluginRuntimeError } from '../dist/esm/index.js';

test('activates in dependency order and disposes in reverse order', async () => {
  const events = [];
  const runtime = createPluginRuntime([
    {
      manifest: { id: 'app', version: '1', dependencies: ['store'] },
      activate: (context) => {
        events.push(`start:app:${context.getDependency('store').value}`);
        return { value: 'ready' };
      },
      deactivate: () => events.push('stop:app'),
    },
    {
      manifest: { id: 'store', version: '1' },
      activate: () => {
        events.push('start:store');
        return { value: 5 };
      },
      deactivate: () => events.push('stop:store'),
    },
  ]);
  assert.deepEqual(runtime.order, ['store', 'app']);
  await runtime.start();
  assert.equal(runtime.get('app').value, 'ready');
  await runtime.dispose();
  assert.deepEqual(events, ['start:store', 'start:app:5', 'stop:app', 'stop:store']);
});

test('rolls back already activated plugins when a later plugin fails', async () => {
  const events = [];
  const runtime = createPluginRuntime([
    {
      manifest: { id: 'one', version: '1' },
      activate: () => 1,
      deactivate: () => events.push('rollback'),
    },
    {
      manifest: { id: 'two', version: '1', dependencies: ['one'] },
      activate: () => {
        throw Error('activation');
      },
    },
  ]);
  await assert.rejects(
    runtime.start(),
    (error) => error instanceof PluginRuntimeError && error.code === 'activation-failed',
  );
  assert.deepEqual(events, ['rollback']);
  assert.equal(runtime.state, 'failed');
});

test('rejects missing dependencies and dependency cycles before activation', () => {
  assert.throws(
    () =>
      createPluginRuntime([
        { manifest: { id: 'one', version: '1', dependencies: ['missing'] }, activate: () => null },
      ]),
    (error) => error.code === 'missing-dependency',
  );
  assert.throws(
    () =>
      createPluginRuntime([
        { manifest: { id: 'a', version: '1', dependencies: ['b'] }, activate: () => null },
        { manifest: { id: 'b', version: '1', dependencies: ['a'] }, activate: () => null },
      ]),
    (error) => error.code === 'dependency-cycle',
  );
});

test('continues cleanup when one plugin disposer fails', async () => {
  const events = [];
  const runtime = createPluginRuntime([
    {
      manifest: { id: 'one', version: '1' },
      activate: () => 1,
      deactivate: () => events.push('one'),
    },
    {
      manifest: { id: 'two', version: '1', dependencies: ['one'] },
      activate: () => 2,
      deactivate: () => {
        events.push('two');
        throw Error('cleanup');
      },
    },
  ]);
  await runtime.start();
  await assert.rejects(runtime.stop(), (error) => error.code === 'disposal-failed');
  assert.deepEqual(events, ['two', 'one']);
  assert.equal(runtime.state, 'stopped');
});

test('shares concurrent startup and rejects restarting after disposal', async () => {
  let activations = 0;
  const runtime = createPluginRuntime([
    {
      manifest: { id: 'slow', version: '1' },
      activate: async () => {
        activations++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return true;
      },
    },
  ]);
  const first = runtime.start();
  const second = runtime.start();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(activations, 1);
  await runtime.stop();
  await assert.rejects(runtime.start(), (error) => error.code === 'invalid-state');
});
