import test, { type ExecutionContext } from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import minecraftData from 'minecraft-data';
import type { Bot } from 'mineflayer';
import type { Item } from 'prismarine-item';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../src/tool-factory.js';
import { registerStonecutterTools, trackStonecutterRecipes } from '../src/tools/stonecutter-tools.js';
import { withInventoryOperation } from '../src/tools/cursor-utils.js';

const require = createRequire(import.meta.url);
type Window = NonNullable<Bot['currentWindow']>;
const clocks = new WeakMap<ExecutionContext, sinon.SinonFakeTimers>();
function setup(t: ExecutionContext) {
  let clock = clocks.get(t);
  if (!clock) {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    clocks.set(t, clock);
    const ownedClock = clock;
    t.teardown(async () => { await ownedClock.runAllAsync(); ownedClock.restore(); });
  }
  const registry = minecraftData('26.1');
  const Items = (require('prismarine-item') as (version: string) => typeof Item)('26.1');
  const windows = (require('prismarine-windows') as (version: string) => {
    createWindow(id: number, type: string, title: string): Window;
  })('26.1');
  const item = (name: string, count: number) => new Items(registry.itemsByName[name].id, count);
  const clone = (stack: Item | null) => stack ? Items.fromNotch(Items.toNotch(stack)) : null;
  const serverInventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory');
  serverInventory.updateSlot(9, item('andesite', 64));
  const serverWindow = windows.createWindow(1, 'minecraft:stonecutter', 'Cut');
  const client = Object.assign(new EventEmitter(), { write: sinon.stub() });
  const block = { name: 'stonecutter', position: new Vec3(325, 64, -200) };
  const bot = Object.assign(new EventEmitter(), {
    version: '26.1', registry, _client: client, supportFeature: registry.supportFeature,
    health: 20, isSleeping: false, game: { gameMode: 'survival' },
    entity: { isValid: true, position: new Vec3(324, 63, -199), height: 1.8 },
    blockAt: sinon.stub().returns(block), canSeeBlock: sinon.stub().returns(true),
    getControlState: sinon.stub().returns(false)
  }) as unknown as Bot;
  (require('mineflayer/lib/plugins/inventory.js') as (bot: Bot, options: { hideErrors: boolean }) => void)(bot, { hideErrors: true });
  trackStonecutterRecipes(bot);
  const packet: { recipes: never[]; stoneCutterRecipes: {
    input: { ids?: number[]; name?: string }; slotDisplay: { type: string; data: unknown }
  }[] } = { recipes: [], stoneCutterRecipes: [
    { input: { ids: [registry.itemsByName.stone.id] }, slotDisplay: { type: 'item', data: registry.itemsByName.stone_bricks.id } },
    { input: { ids: [registry.itemsByName.andesite.id] }, slotDisplay: { type: 'item', data: registry.itemsByName.andesite_stairs.id } },
    { input: { ids: [registry.itemsByName.andesite.id] }, slotDisplay: { type: 'item', data: registry.itemsByName.polished_andesite.id } }
  ] };
  client.emit('declare_recipes', packet);
  let selected = -1;
  let taken = 0;
  let ignoreSelection = false;
  let onClick: ((slot: number) => boolean) | undefined;
  let onSync: ((window: Window) => void) | undefined;
  const sync = (window: Window) => {
    onSync?.(window);
    client.emit('window_items', { windowId: window.id, stateId: 2,
      items: window.slots.map(stack => Items.toNotch(stack)), carriedItem: Items.toNotch(window.selectedItem) });
  };
  client.write.callsFake((name: string, data: { windowId: number; slot: number; mouseButton: number; mode: number; enchantment: number }) => {
    const window = data.windowId === 0 ? serverInventory : serverWindow;
    if (name === 'window_click' && data.mode === 5) setImmediate(() => sync(window));
    else if (name === 'enchant_item' && !ignoreSelection) {
      selected = data.enchantment;
      const visible = packet.stoneCutterRecipes.filter(recipe => recipe.input.ids?.includes(registry.itemsByName.andesite.id) || recipe.input.name);
      const display = visible[selected].slotDisplay;
      if (display.type === 'item' && typeof display.data === 'number') serverWindow.updateSlot(1, new Items(display.data, 1));
      else if (display.data && typeof display.data === 'object') serverWindow.slots[1] = Items.fromNotch(display.data);
    } else if (name === 'window_click' && data.mode === 0) {
      if (onClick?.(data.slot)) return;
      if (data.slot === 1 && serverWindow.slots[1]) {
        serverWindow.selectedItem = clone(serverWindow.slots[1]);
        serverWindow.slots[0] = null;
        serverWindow.slots[1] = null;
        selected = -1;
        taken++;
      } else {
        const click = { slot: data.slot, mouseButton: data.mouseButton, mode: data.mode, item: window.slots[data.slot] };
        window.acceptClick(click, 0);
      }
    } else if (name === 'close_window') {
      for (let slot = 2; slot < 38; slot++) serverInventory.slots[slot + 7] = clone(serverWindow.slots[slot]);
      serverInventory.selectedItem = clone(serverWindow.selectedItem);
    }
  });
  bot.activateBlock = sinon.stub().callsFake(() => setImmediate(() => {
    for (let slot = 2; slot < 38; slot++) serverWindow.slots[slot] = clone(serverInventory.slots[slot + 7]);
    client.emit('open_window', { windowId: 1, inventoryType: 'minecraft:stonecutter', windowTitle: 'Cut' });
    sync(serverWindow);
  }));
  sync(serverInventory);
  const tool = sinon.stub();
  const factory = new ToolFactory({ tool } as unknown as McpServer, {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection);
  registerStonecutterTools(factory, () => bot);
  const args = { x: 325, y: 64, z: -200, inputItem: 'andesite', outputItem: 'polished_andesite', count: 64 };
  const call = (name = 'stonecut', extra: Record<string, unknown> = {}) =>
    tool.getCalls().find(call => call.args[0] === name)!.args[3]({ ...args, ...extra }) as Promise<ReturnType<ToolFactory['createResponse']>>;
  return { bot, client, packet, call, clock, serverWindow, serverInventory, item, block,
    taken: () => taken, ignoreSelection: () => { ignoreSelection = true; },
    onClick: (fn: (slot: number) => boolean) => { onClick = fn; },
    onSync: (fn: (window: Window) => void) => { onSync = fn; } };
}

test.serial('native 26.1 open/click/sync makes exactly 64 polished andesite with zero cursor, no drops or guessed indices', async t => {
  const { call, bot, client, taken } = setup(t);
  const result = await call();
  t.falsy(result.isError, result.content[0].text);
  const state = JSON.parse(result.content[0].text);
  t.is(state.collected, 64);
  t.is(state.consumed, 64);
  t.is(state.recipeIndex, 1);
  t.is(taken(), 64);
  t.is(bot.inventory.items().find(item => item.name === 'polished_andesite')?.count, 64);
  t.false(bot.inventory.items().some(item => item.name === 'andesite'));
  t.falsy(bot.inventory.selectedItem);
  t.falsy(bot.currentWindow);
  t.false(client.write.getCalls().some(call => call.args[0] === 'window_click' &&
    (call.args[1].mode === 4 || call.args[1].mode === 1 || (call.args[1].slot === -999 && call.args[1].mode !== 5))));
});

test.serial('recipe browsing resolves server item tags and preserves input-filtered indices without opening/spending', async t => {
  const { packet, client, call, bot } = setup(t);
  Object.assign(packet.stoneCutterRecipes[1].input, { ids: undefined, name: 'minecraft:cuttable' });
  client.emit('tags', { tags: [{ tagType: 'minecraft:item', tags: [
    { tagName: 'minecraft:cuttable', entries: [bot.registry.itemsByName.andesite.id] }
  ] }] });
  const result = await call('stonecutter-recipes');
  t.falsy(result.isError, result.content[0].text);
  t.deepEqual(JSON.parse(result.content[0].text).recipes.map((recipe: { index: number }) => recipe.index), [0, 1]);
  t.false((bot.activateBlock as sinon.SinonStub).called);
  t.false(client.write.called);
  client.emit('packet', {}, { name: 'start_configuration' });
  t.regex((await call()).content[0].text, /recipes unavailable/);
});

test.serial('recipe yield controls exact output quantity and rejects nonmultiples before any input moves', async t => {
  const { packet, client, call, bot, taken } = setup(t);
  Object.assign(packet.stoneCutterRecipes[2].slotDisplay, { type: 'item_stack', data: {
    itemId: bot.registry.itemsByName.andesite_slab.id, itemCount: 2,
    addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: []
  } });
  t.true((await call('stonecut', { outputItem: 'andesite_slab', count: 3 })).isError);
  t.false(client.write.called);
  const result = await call('stonecut', { outputItem: 'andesite_slab', count: 4 });
  t.falsy(result.isError, result.content[0].text);
  t.is(JSON.parse(result.content[0].text).consumed, 2);
  t.is(taken(), 2);
});

test.serial('occupied cursor, insufficient stock/capacity and existing unattributed window never start cutting', async t => {
  for (const reason of ['cursor', 'stock', 'capacity', 'window']) {
    const { bot, call, item, serverInventory } = setup(t);
    if (reason === 'cursor') serverInventory.selectedItem = item('stick', 1);
    if (reason === 'stock') serverInventory.updateSlot(9, item('andesite', 1));
    if (reason === 'capacity') for (let slot = 10; slot < 45; slot++) serverInventory.updateSlot(slot, item('cobblestone', 64));
    if (reason === 'window') bot.currentWindow = { id: 9, type: 'minecraft:stonecutter' } as Window;
    const result = await call();
    t.true(result.isError, reason);
    t.false((bot.activateBlock as sinon.SinonStub).called);
  }
});

test.serial('unknown/unresolved/ambiguous recipe and unsupported display fail before spending', async t => {
  for (const reason of ['tag', 'ambiguous', 'display', 'missing']) {
    const { packet, call } = setup(t);
    if (reason === 'tag') Object.assign(packet.stoneCutterRecipes[0].input, { ids: undefined, name: 'minecraft:unknown' });
    if (reason === 'ambiguous') packet.stoneCutterRecipes.push(packet.stoneCutterRecipes[2]);
    if (reason === 'display') Object.assign(packet.stoneCutterRecipes[2].slotDisplay, { type: 'composite', data: [] });
    const result = await call('stonecut', reason === 'missing' ? { outputItem: 'diamond' } : {});
    t.true(result.isError, reason);
  }
});

test.serial('ignored result destination returns partial consumption, leaves occupied cursor open and never retries', async t => {
  const { call, onClick, serverWindow, client, taken } = setup(t);
  onClick(slot => slot >= 2 && serverWindow.selectedItem?.name === 'polished_andesite');
  const result = await call('stonecut', { count: 2 });
  t.true(result.isError);
  t.regex(result.content[0].text, /accessible output 0\/2, confirmed input consumed 1/);
  t.is(taken(), 1);
  t.is(serverWindow.selectedItem?.name, 'polished_andesite');
  t.false(client.write.getCalls().some(call => call.args[0] === 'close_window'));
});

test.serial('partial confirmed output before concurrent inventory change is an error, not repeated consumption', async t => {
  const { call, onClick, serverWindow, taken } = setup(t);
  onClick(slot => {
    if (taken() === 1 && slot === 2 && !serverWindow.selectedItem) {
      serverWindow.slots[5] = serverWindow.slots[2];
      return true;
    }
    return false;
  });
  const result = await call('stonecut', { count: 3 });
  t.true(result.isError);
  t.regex(result.content[0].text, /accessible output 1\/3, confirmed input consumed 1/);
  t.is(taken(), 1);
});

test.serial('deadline after first cut reports partial output without starting another consuming step', async t => {
  const { call, clock, onClick, serverWindow, taken } = setup(t);
  onClick(slot => {
    if (serverWindow.selectedItem?.name === 'polished_andesite' && slot >= 2) {
      clock.setSystemTime(2000);
    }
    return false;
  });
  const result = await call('stonecut', { count: 2, timeoutMs: 1000 });
  t.true(result.isError);
  t.regex(result.content[0].text, /deadline/);
  t.is(taken(), 1);
});

test.serial('selection rejection times out with input intact and item-bearing owned window left open', async t => {
  const { call, clock, ignoreSelection, taken, serverWindow, client } = setup(t);
  ignoreSelection();
  const pending = call('stonecut', { count: 1 });
  for (let i = 0; i < 120; i++) {
    await new Promise(resolve => setImmediate(resolve));
    await clock.tickAsync(50);
  }
  const result = await pending;
  t.true(result.isError);
  t.is(taken(), 0);
  t.is(serverWindow.slots[0]?.count, 1);
  t.false(client.write.getCalls().some(call => call.args[0] === 'close_window'));
});

test('installed 26.1 binary recipe and container-button codecs round-trip exact supported shapes', t => {
  const protocol = require('minecraft-protocol') as {
    createSerializer(options: { state: string; isServer: boolean; version: string }): {
      createPacketBuffer(packet: { name: string; params: object }): Buffer
    };
    createDeserializer(options: { state: string; isServer: boolean; version: string }): {
      parsePacketBuffer(buffer: Buffer): { data: { name: string; params: unknown } }
    };
  };
  const declared = { recipes: [], stoneCutterRecipes: [
    { input: { name: 'minecraft:stone' }, slotDisplay: { type: 'item', data: 3 } },
    { input: { ids: [1, 2] }, slotDisplay: { type: 'item_stack', data: {
      itemId: 4, itemCount: 2, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: []
    } } }
  ] };
  for (const [isServer, name, params] of [
    [true, 'declare_recipes', declared],
    [false, 'enchant_item', { windowId: 1, enchantment: 3 }]
  ] as const) {
    const serializer = protocol.createSerializer({ state: 'play', isServer, version: '26.1' });
    const parser = protocol.createDeserializer({ state: 'play', isServer: !isServer, version: '26.1' });
    t.deepEqual(parser.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data, { name, params });
  }
});

test.serial('blocked, distant, missing, sleeping and sneaking targets do not open the workbench', async t => {
  for (const reason of ['blocked', 'distant', 'missing', 'sleeping', 'sneaking']) {
    const { bot, call, block } = setup(t);
    if (reason === 'blocked') (bot.canSeeBlock as sinon.SinonStub).returns(false);
    if (reason === 'distant') bot.entity.position.x = 350;
    if (reason === 'missing') block.name = 'smoker';
    if (reason === 'sleeping') bot.isSleeping = true;
    if (reason === 'sneaking') (bot.getControlState as sinon.SinonStub).returns(true);
    t.true((await call()).isError, reason);
    t.false((bot.activateBlock as sinon.SinonStub).called);
  }
});

test.serial('late opening retains shared inventory lock, then closes only empty owned window and allows retry', async t => {
  const { bot, call, clock, client } = setup(t);
  const activate = bot.activateBlock;
  bot.activateBlock = sinon.stub();
  const pending = call('stonecut', { count: 1 });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  await clock.tickAsync(5001);
  t.true((await pending).isError);
  t.true((await call('stonecut', { count: 1 })).isError);
  await t.throwsAsync(withInventoryOperation(bot, async () => 1), { message: /operation is in progress/ });
  await activate(bot.blockAt(new Vec3(325, 64, -200))!);
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  t.falsy(bot.currentWindow);
  t.true(client.write.getCalls().some(call => call.args[0] === 'close_window'));
  t.is(await withInventoryOperation(bot, async () => 1), 1);
});

test.serial('unexpected server window is rejected without closing it or consuming any inputs', async t => {
  const { bot, call, client, serverWindow } = setup(t);
  bot.openBlock = sinon.stub().callsFake(async () => {
    serverWindow.type = 'minecraft:merchant';
    bot.currentWindow = serverWindow;
    bot.emit('windowOpen', bot.currentWindow);
    return bot.currentWindow;
  });
  const result = await call();
  t.true(result.isError);
  t.regex(result.content[0].text, /Unexpected stonecutter/);
  t.false(client.write.getCalls().some(call => call.args[0] === 'close_window' || call.args[0] === 'enchant_item'));
});

test.serial('server recipes changed after input insertion cause explicit error without selecting or taking result', async t => {
  const { call, onSync, packet, client, serverWindow, taken } = setup(t);
  let changed = false;
  onSync(window => {
    if (window === serverWindow && window.slots[0] && !changed) {
      changed = true;
      client.emit('declare_recipes', { ...packet, stoneCutterRecipes: [] });
    }
  });
  const result = await call('stonecut', { count: 1 });
  t.true(result.isError);
  t.regex(result.content[0].text, /recipes changed/);
  t.is(taken(), 0);
});

test.serial('final player snapshot must still contain the confirmed output before success', async t => {
  const { call, onSync, serverInventory, taken } = setup(t);
  onSync(window => {
    if (window === serverInventory && taken() === 1) {
      window.slots = window.slots.map(item => item?.name === 'polished_andesite' ? null : item);
    }
  });
  const result = await call('stonecut', { count: 1 });
  t.true(result.isError);
  t.regex(result.content[0].text, /Final server player inventory/);
});
