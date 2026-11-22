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
import { registerInventoryTools } from '../src/tools/inventory-tools.js';
import { registerCraftingTools } from '../src/tools/crafting-tools.js';

const require = createRequire(import.meta.url);

function setup(t: ExecutionContext) {
  const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  t.teardown(async () => { await clock.runAllAsync(); clock.restore(); });
  const registry = minecraftData('26.1');
  const Items = (require('prismarine-item') as (version: string) => typeof Item)('26.1');
  const item = (name: string, count: number) => new Items(registry.itemsByName[name].id, count);
  const client = Object.assign(new EventEmitter(), { write: sinon.stub() });
  const bot = Object.assign(new EventEmitter(), {
    version: '26.1', registry, _client: client, supportFeature: registry.supportFeature,
    health: 20, isSleeping: false, game: { gameMode: 'survival' },
    entity: { position: new Vec3(0, 64, 0), height: 1.8 },
    craft: sinon.stub().resolves(), findBlock: sinon.stub().returns(null)
  }) as unknown as Bot;
  (require('mineflayer/lib/plugins/inventory.js') as (bot: Bot, options: { hideErrors: boolean }) => void)(bot, { hideErrors: true });
  let answer: (() => void) | undefined;
  const sync = () => {
    client.emit('window_items', {
      windowId: 0, stateId: 1,
      items: bot.inventory.slots.map(slot => Items.toNotch(slot)),
      carriedItem: Items.toNotch(bot.inventory.selectedItem)
    });
  };
  client.write.callsFake((name: string, packet: { mode: number }) => {
    if (name === 'window_click' && packet.mode === 5) setImmediate(() => (answer ?? sync)());
  });
  const tool = sinon.stub();
  const factory = new ToolFactory({ tool } as unknown as McpServer, {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection);
  registerInventoryTools(factory, () => bot);
  registerCraftingTools(factory, () => bot);
  const call = (name: string, args = {}) => tool.getCalls().find(call => call.args[0] === name)!.args[3](args) as Promise<ReturnType<ToolFactory['createResponse']>>;
  const ackResult = () => client.emit('set_slot', {
    windowId: 0, stateId: 1, slot: 0, item: Items.toNotch(bot.inventory.slots[0])
  });
  return { bot, client, item, call, sync, clock, ackResult, setAnswer: (fn: () => void) => { answer = fn; } };
}

test.serial('installed native 2x2 craft returns predicted output without requesting the final server inventory', async t => {
  const { bot, item, client, call, sync, ackResult } = setup(t);
  (require('mineflayer/lib/plugins/craft.js') as (bot: Bot) => void)(bot);
  const write = client.write;
  write.callsFake((name: string, packet: { mode: number; slot: number }) => {
    if (name === 'window_click' && packet.mode === 5) setImmediate(sync);
    if (name === 'window_click' && packet.mode === 0 && packet.slot >= 0 && packet.slot <= 4) {
      setImmediate(ackResult);
    }
  });
  bot.inventory.updateSlot(9, item('iron_ingot', 2));
  const recipe = bot.recipesFor(bot.registry.itemsByName.shears.id, null, 1, null)[0];
  t.truthy(recipe);
  await bot.craft(recipe, 1);
  t.is(bot.inventory.items().find(item => item.name === 'shears')?.count, 1);
  t.falsy(bot.inventory.selectedItem);
  t.false(client.write.getCalls().some(call => call.args[1].mode === 5));
  write.callsFake((name: string, packet: { mode: number }) => {
    if (name === 'window_click' && packet.mode === 5) setImmediate(() => {
      bot.inventory.slots[9] = null;
      bot.inventory.selectedItem = item('shears', 1);
      sync();
    });
  });
  const result = await call('inventory-cursor-status');
  t.is(JSON.parse(result.content[0].text).cursor.name, 'shears');
  t.false(bot.inventory.items().some(item => item.name === 'shears'));
});

test.serial('server snapshot reveals cursor-only shears excluded from ordinary inventory', async t => {
  const { bot, item, call, setAnswer, sync, client } = setup(t);
  setAnswer(() => { bot.inventory.selectedItem = item('shears', 1); sync(); });
  t.false(bot.inventory.items().some(item => item.name === 'shears'));
  const result = await call('inventory-cursor-status');
  t.falsy(result.isError, result.content[0].text);
  t.is(JSON.parse(result.content[0].text).cursor.name, 'shears');
  t.is(JSON.parse(result.content[0].text).cursor.count, 1);
  t.true(client.write.calledOnce);
  t.is(client.write.firstCall.args[1].mode, 5);
  t.is(client.write.firstCall.args[1].mouseButton, 2);
});

test.serial('native cursor recovery puts shears in accessible inventory without drops or crafting', async t => {
  const { bot, item, call, client } = setup(t);
  bot.inventory.selectedItem = item('shears', 1);
  const result = await call('recover-inventory-cursor');
  t.falsy(result.isError, result.content[0].text);
  t.is(JSON.parse(result.content[0].text).recovered, 1);
  t.falsy(bot.inventory.selectedItem);
  t.is(bot.inventory.items().find(item => item.name === 'shears')?.count, 1);
  const placements = client.write.getCalls().filter(call => call.args[1].mode === 0);
  t.is(placements.length, 1);
  t.is(placements[0].args[1].slot, 9);
  t.false((bot.craft as sinon.SinonStub).called);
});

test.serial('native ignores standalone cursor packet but full sync clears stale model without moving recovered output', async t => {
  const { bot, item, call, client, setAnswer, sync } = setup(t);
  bot.inventory.selectedItem = item('shears', 1);
  client.emit('set_cursor_item', { contents: null });
  t.is(bot.inventory.selectedItem?.name, 'shears', 'Installed plugin has no standalone set_cursor_item handler');
  setAnswer(() => {
    bot.inventory.selectedItem = null;
    bot.inventory.updateSlot(39, item('shears', 1));
    sync();
  });
  const result = await call('recover-inventory-cursor');
  t.falsy(result.isError, result.content[0].text);
  t.is(JSON.parse(result.content[0].text).recovered, 0);
  t.true(JSON.parse(result.content[0].text).serverConfirmed);
  t.false(client.write.getCalls().some(call => call.args[1].mode === 0));
});

test.serial('recovery merges a partial stack then uses empty slot and respects custom identities', async t => {
  const { bot, item, call, client } = setup(t);
  const custom = Object.assign(item('oak_planks', 60), { components: [{ type: 'custom_data', data: { other: true } }] });
  bot.inventory.updateSlot(9, custom);
  bot.inventory.updateSlot(10, item('oak_planks', 60));
  bot.inventory.selectedItem = item('oak_planks', 12);
  const result = await call('recover-inventory-cursor');
  t.falsy(result.isError, result.content[0].text);
  t.is(bot.inventory.slots[9]!.count, 60);
  t.is(bot.inventory.slots[10]!.count, 64);
  t.is(bot.inventory.slots[11]!.count, 8);
  t.deepEqual(client.write.getCalls().filter(call => call.args[1].mode === 0).map(call => call.args[1].slot), [10, 11]);
});

test.serial('queued pre-click full snapshot must not turn successful cursor placement into a failed craft', async t => {
  const { bot, item, call, client, sync } = setup(t);
  bot.inventory.updateSlot(9, item('oak_planks', 3));
  bot.inventory.selectedItem = item('oak_planks', 61);
  let placed = false;
  let snapshots = 0;
  client.write.callsFake((name: string, packet: { mode: number }) => {
    if (name !== 'window_click') return;
    if (packet.mode === 0) placed = true;
    if (packet.mode === 5) setImmediate(() => {
      if (placed && snapshots++ === 0) {
        // An already-queued authoritative snapshot predates the placement.
        bot.inventory.updateSlot(9, item('oak_planks', 3));
        bot.inventory.selectedItem = item('oak_planks', 61);
      } else if (placed) {
        bot.inventory.updateSlot(9, item('oak_planks', 64));
        bot.inventory.selectedItem = null;
      }
      sync();
    });
  });
  const result = await call('recover-inventory-cursor');
  t.falsy(result.isError, result.content[0].text);
  t.is(JSON.parse(result.content[0].text).recovered, 61);
  t.is(bot.inventory.slots[9]?.count, 64);
  t.true(client.write.getCalls().filter(call => call.args[1].mode === 0).length === 1);
});

test.serial('eight stick crafts confirm exact output while each leftover-input placement receives one stale snapshot', async t => {
  const { bot, item, call, client, sync } = setup(t);
  const clone = (stack: typeof bot.inventory.selectedItem) => stack ? item(stack.name, stack.count) : null;
  const capture = () => ({ slots: bot.inventory.slots.map(clone), cursor: clone(bot.inventory.selectedItem) });
  const restore = (state: ReturnType<typeof capture>) => {
    bot.inventory.slots = state.slots.map(clone);
    bot.inventory.selectedItem = clone(state.cursor);
  };
  bot.inventory.updateSlot(9, item('oak_planks', 64));
  bot.inventory.updateSlot(10, item('oak_planks', 64));
  let crafts = 0;
  let previous: ReturnType<typeof capture> | undefined;
  let confirmed: ReturnType<typeof capture> | undefined;
  let stale = false;
  (bot.craft as sinon.SinonStub).callsFake(async () => {
    crafts++;
    bot.inventory.slots[9] = null;
    bot.inventory.updateSlot(11, item('stick', crafts * 4));
    bot.inventory.selectedItem = item('oak_planks', 64 - crafts * 2);
    previous = capture();
    confirmed = undefined;
  });
  client.write.callsFake((name: string, packet: { mode: number }) => {
    if (name !== 'window_click') return;
    if (packet.mode === 0) { confirmed = capture(); stale = true; }
    if (packet.mode === 5) setImmediate(() => {
      if (confirmed && previous) {
        restore(stale ? previous : confirmed);
        stale = false;
      }
      sync();
    });
  });
  const result = await call('craft-item', { outputItem: 'stick', amount: 8 });
  t.falsy(result.isError, result.content[0].text);
  t.is(crafts, 8);
  t.is(bot.inventory.items().find(stack => stack.name === 'stick')?.count, 32);
  t.is(bot.inventory.items().filter(stack => stack.name === 'oak_planks').reduce((sum, stack) => sum + stack.count, 0), 112);
  t.falsy(bot.inventory.selectedItem);
  t.is(client.write.getCalls().filter(call => call.args[1].mode === 0).length, 8);
});

test.serial('cursor status exposes residual crafting inputs separately without pretending they are ordinary inventory', async t => {
  const { bot, item, call } = setup(t);
  bot.inventory.updateSlot(1, item('oak_planks', 1));
  bot.inventory.updateSlot(3, item('oak_planks', 1));
  const state = JSON.parse((await call('inventory-cursor-status')).content[0].text);
  t.deepEqual(state.craftingGrid.map((item: { slot: number; name: string; count: number }) =>
    ({ slot: item.slot, name: item.name, count: item.count })), [
    { slot: 1, name: 'oak_planks', count: 1 }, { slot: 3, name: 'oak_planks', count: 1 }
  ]);
  t.deepEqual(state.items, []);
});

test.serial('persistent old-state response remains an error with exactly one click, not a recovery retry', async t => {
  const { bot, item, call, client, setAnswer, sync } = setup(t);
  bot.inventory.selectedItem = item('oak_planks', 61);
  setAnswer(() => {
    bot.inventory.slots[9] = null;
    bot.inventory.selectedItem = item('oak_planks', 61);
    sync();
  });
  const result = await call('recover-inventory-cursor');
  t.true(result.isError);
  t.regex(result.content[0].text, /confirmed recovered 0\/61/);
  t.is(client.write.getCalls().filter(call => call.args[1].mode === 0).length, 1);
  t.is(client.write.getCalls().filter(call => call.args[1].mode === 5).length, 3);
});

test.serial('matching recovery balance cannot hide unrelated slot changes or residual grid material', async t => {
  const { bot, item, call, client, sync } = setup(t);
  bot.inventory.selectedItem = item('oak_planks', 33);
  client.write.callsFake((name: string, packet: { mode: number }) => {
    if (name !== 'window_click') return;
    if (packet.mode === 0) bot.inventory.updateSlot(1, item('oak_planks', 1));
    if (packet.mode === 5) setImmediate(sync);
  });
  const result = await call('recover-inventory-cursor');
  t.true(result.isError);
  t.regex(result.content[0].text, /attribution uncertain/);
  t.is(client.write.getCalls().filter(call => call.args[1].mode === 0).length, 1);
});

test.serial('residual grid inputs block new crafting and are reported on partial native completion without cleanup clicks', async t => {
  const { bot, item, call } = setup(t);
  bot.inventory.updateSlot(9, item('oak_planks', 64));
  bot.inventory.updateSlot(1, item('oak_planks', 1));
  const blocked = await call('craft-item', { outputItem: 'stick', amount: 8 });
  t.true(blocked.isError);
  t.regex(blocked.content[0].text, /residual inputs/);
  t.false((bot.craft as sinon.SinonStub).called);
  bot.inventory.slots[1] = null;
  (bot.craft as sinon.SinonStub).callsFake(async () => {
    bot.inventory.updateSlot(10, item('stick', 4));
    bot.inventory.updateSlot(1, item('oak_planks', 1));
    bot.inventory.updateSlot(3, item('oak_planks', 1));
  });
  const partial = await call('craft-item', { outputItem: 'stick', amount: 8 });
  t.true(partial.isError);
  t.regex(partial.content[0].text, /still contains inputs/);
  t.regex(partial.content[0].text, /craftingGrid/);
  t.true((bot.craft as sinon.SinonStub).calledOnce);
});

test.serial('full inventory and active own window reject recovery without a destination click', async t => {
  const { bot, item, call, client } = setup(t);
  for (let slot = 9; slot < 45; slot++) bot.inventory.updateSlot(slot, item('dirt', 64));
  bot.inventory.selectedItem = item('shears', 1);
  t.true((await call('recover-inventory-cursor')).isError);
  t.is(bot.inventory.selectedItem?.name, 'shears');
  t.false(client.write.getCalls().some(call => call.args[1].mode === 0));
  client.write.resetHistory();
  bot.currentWindow = bot.inventory;
  t.true((await call('inventory-cursor-status')).isError);
  t.false(client.write.called);
});

test.serial('prediction-only placement is rejected when authoritative snapshot restores the cursor', async t => {
  const { bot, item, call, setAnswer, sync } = setup(t);
  setAnswer(() => {
    bot.inventory.updateSlot(9, item('dirt', 1));
    bot.inventory.slots[9] = null;
    bot.inventory.selectedItem = item('shears', 1);
    sync();
  });

  const result = await call('recover-inventory-cursor');
  t.true(result.isError);
  t.regex(result.content[0].text, /Server did not confirm/);
  t.regex(result.content[0].text, /confirmed recovered 0\/1/);
  t.is(bot.inventory.selectedItem?.name, 'shears');
});

test.serial('failure after one recovered portion reports confirmed partial count without dropping or retrying', async t => {
  const { bot, item, call, client, sync } = setup(t);
  bot.inventory.updateSlot(9, item('oak_planks', 60));
  bot.inventory.selectedItem = item('oak_planks', 12);
  client.write.callsFake((name: string, packet: { mode: number; slot: number }) => {
    if (name === 'window_click' && packet.mode === 5) setImmediate(sync);
    if (name === 'window_click' && packet.mode === 0 && packet.slot === 10) throw new Error('connection ended');
  });
  const result = await call('recover-inventory-cursor');
  t.true(result.isError);
  t.regex(result.content[0].text, /confirmed recovered 4\/12/);
  t.regex(result.content[0].text, /No rollback or automatic retry/);
  t.deepEqual(client.write.getCalls().filter(call => call.args[1].mode === 0).map(call => call.args[1].slot), [9, 10]);
});

test.serial('craft confirms shears only after inventory sync and cursor recovery', async t => {
  const { bot, item, call } = setup(t);
  bot.inventory.updateSlot(9, item('iron_ingot', 2));
  (bot.craft as sinon.SinonStub).callsFake(async () => {
    bot.inventory.slots[9] = null;
    bot.inventory.selectedItem = item('shears', 1);
  });
  const result = await call('craft-item', { outputItem: 'shears', amount: 1 });
  t.falsy(result.isError, result.content[0].text);
  t.is(bot.inventory.items().find(item => item.name === 'shears')?.count, 1);
  t.falsy(bot.inventory.selectedItem);
  t.true((bot.craft as sinon.SinonStub).calledOnce);
});

test.serial('craft cannot claim output, retry another recipe or return success for a partial batch', async t => {
  const { bot, item, call } = setup(t);
  bot.inventory.updateSlot(9, item('iron_ingot', 2));
  const result = await call('craft-item', { outputItem: 'shears' });
  t.true(result.isError);
  t.regex(result.content[0].text, /output not confirmed/);
  t.true((bot.craft as sinon.SinonStub).calledOnce);
  (bot.craft as sinon.SinonStub).resetHistory();
  (bot.craft as sinon.SinonStub).callsFake(async () => {
    bot.inventory.slots[9] = null;
    bot.inventory.updateSlot(10, item('shears', 1));
  });
  const partial = await call('craft-item', { outputItem: 'shears', amount: 2 });
  t.true(partial.isError);
  t.regex(partial.content[0].text, /1\/2 craft/);
  t.true((bot.craft as sinon.SinonStub).calledOnce);
});

test.serial('occupied cursor blocks crafting before consuming iron, and overlapping tools do not click', async t => {
  const { bot, item, call, setAnswer, sync, client } = setup(t);
  bot.inventory.updateSlot(9, item('iron_ingot', 2));
  bot.inventory.selectedItem = item('shears', 1);
  t.true((await call('craft-item', { outputItem: 'shears' })).isError);
  t.false((bot.craft as sinon.SinonStub).called);
  let finish = () => {};
  setAnswer(() => { finish = sync; });
  const pending = call('inventory-cursor-status');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const writes = client.write.callCount;
  t.true((await call('recover-inventory-cursor')).isError);
  t.is(client.write.callCount, writes);
  finish();
  t.falsy((await pending).isError);
});

test.serial('server sync timeout makes no recovery click and releases operation lock', async t => {
  const { bot, item, call, setAnswer, sync, client, clock } = setup(t);
  bot.inventory.selectedItem = item('shears', 1);
  setAnswer(() => {});
  const pending = call('recover-inventory-cursor');
  // The installed native sync uses a 20s bounded event wait.
  await new Promise(resolve => setImmediate(resolve));
  await clock.tickAsync(20001);
  const result = await pending;
  t.true(result.isError);
  t.regex(result.content[0].text, /did not fire within timeout/);
  t.false(client.write.getCalls().some(call => call.args[1].mode === 0));
  setAnswer(sync);
  t.falsy((await call('inventory-cursor-status')).isError);
});

test.serial('craft rejects full inventory before native crafting and reports native partial failure without retry', async t => {
  const { bot, item, call } = setup(t);
  for (let slot = 9; slot < 45; slot++) bot.inventory.updateSlot(slot, item('dirt', 64));
  bot.inventory.updateSlot(9, item('iron_ingot', 2));
  const full = await call('craft-item', { outputItem: 'shears' });
  t.true(full.isError);
  t.regex(full.content[0].text, /Reserve empty/);
  t.false((bot.craft as sinon.SinonStub).called);
  bot.inventory.slots[10] = null;
  (bot.craft as sinon.SinonStub).callsFake(async () => {
    bot.inventory.slots[9] = null;
    bot.inventory.selectedItem = item('shears', 1);
    throw new Error('transaction refused after output pickup');
  });
  const failed = await call('craft-item', { outputItem: 'shears' });
  t.true(failed.isError);
  t.regex(failed.content[0].text, /transaction refused/);
  t.regex(failed.content[0].text, /"cursor":\{"name":"shears"/);
  t.true((bot.craft as sinon.SinonStub).calledOnce);
});
