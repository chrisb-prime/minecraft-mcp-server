import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot, Chest, TransferOptions } from 'mineflayer';
import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../src/tool-factory.js';
import { registerStorageTools } from '../src/tools/storage-tools.js';

const require = createRequire(import.meta.url);
const Items = (require('prismarine-item') as (version: string) => typeof Item)('1.21.11');
const windows = (require('prismarine-windows') as (version: string) => {
  createWindow(id: number, type: string, title: string): Chest;
})('1.21.11');
const registry = minecraftData('1.21.11');
function item(name: string, count: number): Item {
  return new Items(registry.itemsByName[name].id, count);
}

function setup(double: boolean | 'hopper' = false, version = '1.21.11') {
  const Items = (require('prismarine-item') as (version: string) => typeof Item)(version);
  const windows = (require('prismarine-windows') as (version: string) => {
    createWindow(id: number, type: string, title: string): Chest;
  })(version);
  const events = new EventEmitter();
  const chest = windows.createWindow(1, double === 'hopper' ? 'minecraft:hopper' : double ? 'minecraft:generic_9x6' : 'minecraft:generic_9x3', 'Storage');
  const block = { name: double === 'hopper' ? 'hopper' : 'chest', position: new Vec3(2, 64, 0) } as Block;
  const bot = {
    health: 20, isSleeping: false, game: { gameMode: 'survival' },
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8 },
    inventory: { selectedItem: null as Item | null },
    currentWindow: null as Chest | null,
    once: events.once.bind(events), removeListener: events.removeListener.bind(events),
    closeWindow: sinon.stub().callsFake(() => { bot.currentWindow = null; }),
    getControlState: sinon.stub().returns(false),
    blockAt: sinon.stub().returns(block), canSeeBlock: sinon.stub().returns(true),
    openChest: sinon.stub().callsFake(async () => { bot.currentWindow = chest; events.emit('windowOpen', chest); return chest; }),
    openContainer: sinon.stub(),
    transfer: sinon.stub(),
    pathfinder: { movements: { canDig: true, allow1by1towers: true, scafoldingBlocks: [1] },
      goto: sinon.stub().resolves() }
  };
  bot.openContainer = bot.openChest;
  const getBot = () => bot as unknown as Bot;
  chest.close = sinon.stub().callsFake(() => { bot.currentWindow = null; });
  const move = ({ sourceStart, sourceEnd, destStart, destEnd, count = 1 }: TransferOptions) => {
    if (sourceEnd !== sourceStart + 1 || destEnd !== destStart + 1) throw new Error('Expected slot-bounded transfer');
    const source = chest.slots[sourceStart]!;
    const target = chest.slots[destStart];
    const remaining = source.count - count;
    const pickup = { slot: sourceStart, mode: 0, mouseButton: 0, item: source };
    chest.acceptClick(pickup, 0);
    chest.updateSlot(destStart, Object.assign(new Items(source.type, (target?.count ?? 0) + count), source, { count: (target?.count ?? 0) + count }));
    if (remaining) chest.updateSlot(sourceStart, Object.assign(new Items(source.type, remaining), source, { count: remaining }));
    chest.selectedItem = null;
  };
  bot.transfer.callsFake(async (options: TransferOptions) => move(options));
  const tool = sinon.stub();
  const factory = new ToolFactory({ tool } as unknown as McpServer, {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection);
  registerStorageTools(factory, getBot);
  const call = (name: string, args: Record<string, unknown> = { x: 2, y: 64, z: 0 }) =>
    tool.getCalls().find(call => call.args[0] === name)!.args[3](args) as Promise<ReturnType<ToolFactory['createResponse']>>;
  const transfer = (name: string, count: number, itemName = 'oak_log') => call(name, { x: 2, y: 64, z: 0, itemName, count });
  return { bot, block, chest, call, transfer, move, events };
}

for (const double of [false, true]) {
  test.serial(`${double ? 'double' : 'single'} chest inspection exposes real container slots and closes the window`, async t => {
    const { chest, call, bot } = setup(double);
    chest.slots[0] = item('oak_log', 32);
    chest.slots[chest.inventoryStart] = item('dirt', 4);
    const result = await call('chest-status');
    t.falsy(result.isError);
    t.deepEqual(JSON.parse(result.content[0].text), { position: { x: 2, y: 64, z: 0 },
      slotCount: double ? 54 : 27, emptySlots: (double ? 54 : 27) - 1,
      items: [{ slot: 0, name: 'oak_log', count: 32, stackSize: 64 }] });
    t.true((chest.close as sinon.SinonStub).calledOnce);
    t.false(bot.transfer.called);
  });

  for (const deposit of [true, false]) {
    test.serial(`${double ? 'double' : 'single'} chest ${deposit ? 'deposit' : 'withdraw'} transfers exact quantities across stacks`, async t => {
      const { chest, transfer, bot } = setup(double);
      const source = deposit ? chest.inventoryStart : 0;
      const dest = deposit ? 0 : chest.inventoryStart;
      chest.slots[source] = item('oak_log', 64);
      chest.slots[source + 1] = item('oak_log', 48);
      const result = await transfer(deposit ? 'deposit-chest' : 'withdraw-chest', 96);
      t.falsy(result.isError);
      t.is(JSON.parse(result.content[0].text).transferred, 96);
      t.is(chest.slots[dest]!.count, 64);
      t.is(chest.slots[dest + 1]!.count, 32);
      t.is(chest.slots[source + 1]!.count, 16);
      t.true((chest.close as sinon.SinonStub).calledOnce);
      t.true(bot.transfer.calledTwice);
    });
  }
}

test.serial('withdrawal merges into partial inventory stacks with no empty slots and honors item-specific stack sizes', async t => {
  const { chest, transfer, bot } = setup();
  chest.slots[0] = item('ender_pearl', 16);
  for (let slot = chest.inventoryStart; slot < chest.inventoryEnd; slot++) chest.slots[slot] = item('dirt', 64);
  chest.slots[chest.inventoryStart] = item('ender_pearl', 8);
  const result = await transfer('withdraw-chest', 8, 'ender_pearl');
  t.falsy(result.isError);
  t.is(chest.slots[chest.inventoryStart]!.count, 16);
  t.is(chest.slots[0]!.count, 8);
  t.true(bot.transfer.calledOnce);
});

test.serial('installed native Mineflayer transfer moves a full stack and a smaller exact count without outside-window drops', async t => {
  const injectInventory = require('mineflayer/lib/plugins/inventory.js') as (bot: Bot, options: { hideErrors: boolean }) => void;
  for (const [name, count] of [['deposit-chest', 64], ['withdraw-chest', 5]] as const) {
    const { chest, bot, transfer } = setup();
    const client = Object.assign(new EventEmitter(), { write: sinon.stub() });
    const native = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry, _client: client, supportFeature: registry.supportFeature,
      game: { gameMode: 'survival' }, entity: { position: new Vec3(0, 64, 0), height: 1.8 }
    }) as unknown as Bot;
    injectInventory(native, { hideErrors: true });
    native.currentWindow = chest;
    const source = name === 'deposit-chest' ? chest.inventoryStart : 0;
    const dest = name === 'deposit-chest' ? 0 : chest.inventoryStart;
    chest.updateSlot(source, item('oak_log', 64));
    bot.transfer.callsFake((options: TransferOptions) => native.transfer(options));
    const result = await transfer(name, count);
    t.falsy(result.isError, result.content[0].text);
    t.is(chest.slots[dest]!.count, count);
    t.is(chest.slots[source]?.count ?? 0, 64 - count);
    t.is(chest.selectedItem, null);
    t.true(client.write.called);
    t.true(client.write.getCalls().every(call => call.args[0] !== 'window_click' || call.args[1].slot !== -999));
  }
});

test.serial('custom component and NBT variants never consume incompatible stack capacity', async t => {
  const { chest, transfer, bot } = setup();
  const first = item('oak_log', 8) as Item & { components?: unknown };
  const second = item('oak_log', 56) as Item & { components?: unknown };
  first.components = [{ type: 'custom_name', data: 'first' }];
  second.components = [{ type: 'custom_name', data: 'second' }];
  chest.slots[chest.inventoryStart] = first;
  for (let slot = 0; slot < chest.inventoryStart; slot++) chest.slots[slot] = item('dirt', 64);
  chest.slots[0] = second;
  t.true((await transfer('deposit-chest', 8)).isError);
  t.false(bot.transfer.called);
  chest.slots[1] = null;
  t.falsy((await transfer('deposit-chest', 8)).isError);
  t.is(chest.slots[0]!.count, 56);
  t.is(chest.slots[1]!.count, 8);
  first.nbt = { type: 'compound', value: { label: { type: 'string', value: 'special' } } };
  first.count = 8;
  second.nbt = null;
  chest.slots[chest.inventoryStart] = first;
  chest.slots[1] = null;
  t.falsy((await transfer('deposit-chest', 8)).isError);
  t.is(chest.slots[0]!.count, 56);
});

test.serial('capacity planning merges matching variants before allocating the last empty slot', async t => {
  const { chest, transfer } = setup();
  const plain = item('oak_log', 8);
  const named = item('oak_log', 8) as Item & { components?: unknown };
  named.components = [{ type: 'custom_name', data: 'named' }];
  chest.slots[chest.inventoryStart] = plain;
  chest.slots[chest.inventoryStart + 1] = named;
  for (let slot = 1; slot < chest.inventoryStart; slot++) chest.slots[slot] = item('dirt', 64);
  chest.slots[1] = item('oak_log', 56);
  const result = await transfer('deposit-chest', 16);
  t.falsy(result.isError);
  t.is(chest.slots[1]!.count, 64);
  t.is(chest.slots[0]!.count, 8);
});

test.serial('a window opened before native openChest rejects is still closed without transferring', async t => {
  const { bot, call, chest, events } = setup();
  bot.openChest.callsFake(async () => {
    bot.currentWindow = chest;
    events.emit('windowOpen', chest);
    throw new Error('Non-container window used as container');
  });
  t.regex((await call('chest-status')).content[0].text, /Non-container/);
  t.true(bot.closeWindow.calledOnceWithExactly(chest));
  t.false(bot.transfer.called);
});

test.serial('missing items, insufficient exact stock and insufficient total capacity cause no partial transfers', async t => {
  for (const name of ['deposit-chest', 'withdraw-chest']) {
    const { chest, transfer, bot } = setup();
    const source = name === 'deposit-chest' ? chest.inventoryStart : 0;
    const destStart = name === 'deposit-chest' ? 0 : chest.inventoryStart;
    const destEnd = name === 'deposit-chest' ? chest.inventoryStart : chest.inventoryEnd;
    t.regex((await transfer(name, 1)).content[0].text, /Insufficient oak_log/);
    chest.slots[source] = item('oak_log', 64);
    t.regex((await transfer(name, 65)).content[0].text, /requested 65, available 64/);
    for (let slot = destStart; slot < destEnd; slot++) chest.slots[slot] = item('dirt', 64);
    chest.slots[destStart] = item('oak_log', 63);
    t.regex((await transfer(name, 2)).content[0].text, /capacity/);
    t.is(chest.slots[destStart]!.count, 63);
    t.false(bot.transfer.called);
    t.is((chest.close as sinon.SinonStub).callCount, 3);
  }
});

test.serial('argument validation and exact names reject invalid transfers before mutation', async t => {
  const { call, chest, bot, transfer } = setup();
  for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '64', undefined]) {
    t.true((await call('deposit-chest', { x: 2, y: 64, z: 0, itemName: 'oak_log', count })).isError);
  }
  t.true((await call('chest-status', { x: Infinity, y: 64, z: 0 })).isError);
  t.false(bot.openChest.called);
  chest.slots[chest.inventoryStart] = item('oak_log', 64);
  t.true((await transfer('deposit-chest', 1, 'oak')).isError);
  t.false(bot.transfer.called);
});

test.serial('invalid chests, unsafe state and occupied windows/cursors never activate a block', async t => {
  for (const invalid of ['missing', 'barrel', 'ender_chest', 'trapped_chest', 'sleeping', 'dead', 'spectator', 'sneak', 'window', 'cursor']) {
    const { bot, call } = setup();
    if (invalid === 'missing') bot.blockAt.returns(null);
    else if (['barrel', 'ender_chest', 'trapped_chest'].includes(invalid)) bot.blockAt.returns({ name: invalid });
    else if (invalid === 'sleeping') bot.isSleeping = true;
    else if (invalid === 'dead') bot.health = 0;
    else if (invalid === 'spectator') bot.game.gameMode = 'spectator';
    else if (invalid === 'sneak') bot.getControlState.returns(true);
    else if (invalid === 'window') bot.currentWindow = windows.createWindow(2, 'minecraft:generic_9x3', 'Other');
    else bot.inventory.selectedItem = item('oak_log', 1);
    t.true((await call('chest-status')).isError, invalid);
    t.false(bot.openChest.called, invalid);
  }
});

test.serial('safe approach rechecks chest reach/visibility and never enables digging or scaffolding', async t => {
  const { bot, block, call } = setup();
  bot.entity.position = new Vec3(20, 64, 0);
  bot.pathfinder.goto.callsFake(async () => {
    t.false(bot.pathfinder.movements.canDig);
    t.false(bot.pathfinder.movements.allow1by1towers);
    t.deepEqual(bot.pathfinder.movements.scafoldingBlocks, []);
    bot.entity.position = new Vec3(0.5, 64, 0.5);
  });
  t.falsy((await call('chest-status')).isError);
  t.true(bot.pathfinder.goto.calledBefore(bot.openChest));
  bot.canSeeBlock.returns(false);
  t.true((await call('chest-status')).isError);
  t.true(bot.openChest.calledOnce);
  bot.canSeeBlock.returns(true);
  bot.entity.position = new Vec3(20, 64, 0);
  bot.pathfinder.goto.rejects(new Error('No safe path'));
  t.regex((await call('chest-status')).content[0].text, /No safe path/);
  bot.pathfinder.goto.callsFake(async () => { bot.blockAt.returns(null); });
  t.regex((await call('chest-status')).content[0].text, /No loaded normal chest/);
  bot.blockAt.returns(block);
});

test.serial('native failure reports partial destination/source and cursor effects, then closes and releases the lock', async t => {
  const { chest, bot, transfer, move, call } = setup();
  chest.slots[chest.inventoryStart] = item('oak_log', 64);
  bot.transfer.callsFake(async (options: TransferOptions) => {
    move({ ...options, count: 5 });
    chest.slots[chest.inventoryStart]!.count -= 2;
    chest.selectedItem = item('oak_log', 2);
    throw new Error('Server refused transfer');
  });
  const result = await transfer('deposit-chest', 64);
  t.true(result.isError);
  t.regex(result.content[0].text, /Server refused transfer/);
  t.regex(result.content[0].text, /"sourceRemoved":7,"destinationGained":5/);
  t.regex(result.content[0].text, /cursor before close: {"name":"oak_log","count":2}/);
  t.true((chest.close as sinon.SinonStub).calledOnce);
  chest.selectedItem = null;
  t.falsy((await call('chest-status')).isError);
});

test.serial('unconfirmed native success and closed windows remain explicit partial-transfer errors', async t => {
  const { bot, chest, transfer } = setup();
  chest.slots[0] = item('oak_log', 8);
  bot.transfer.resolves();
  t.regex((await transfer('withdraw-chest', 4)).content[0].text, /not fully confirmed/);
  bot.transfer.callsFake(async () => { bot.currentWindow = null; });
  t.regex((await transfer('withdraw-chest', 4)).content[0].text, /not fully confirmed/);
  t.is((chest.close as sinon.SinonStub).callCount, 1);
});

test.serial('close failures preserve completed transfers and original partial errors', async t => {
  const { chest, bot, transfer } = setup();
  chest.slots[chest.inventoryStart] = item('oak_log', 8);
  (chest.close as sinon.SinonStub).throws(new Error('close refused'));
  const result = await transfer('deposit-chest', 4);
  t.true(result.isError);
  t.regex(result.content[0].text, /transferred.*4/);
  t.regex(result.content[0].text, /failed to close storage.*close refused/);
  bot.currentWindow = null;
  bot.transfer.rejects(new Error('transfer refused'));
  const failure = await transfer('deposit-chest', 1);
  t.regex(failure.content[0].text, /transfer refused/);
  t.regex(failure.content[0].text, /failed to close storage/);
});

test.serial('opening failures and unexpected windows are explicit and do not transfer', async t => {
  const { bot, call, chest } = setup();
  bot.openChest.rejects(new Error('Chest inaccessible'));
  t.regex((await call('chest-status')).content[0].text, /Chest inaccessible/);
  bot.openChest.callsFake(async () => { bot.currentWindow = chest; return chest; });
  chest.type = 'minecraft:generic_9x1';
  t.regex((await call('chest-status')).content[0].text, /unexpected window/);
  t.true((chest.close as sinon.SinonStub).calledOnce);
  t.false(bot.transfer.called);
});

test.serial('blocked opening times out, rejects overlapping calls and closes late windows without transferring', async t => {
  const { bot, call, chest } = setup();
  const clock = sinon.useFakeTimers();
  let resolve!: (chest: Chest) => void;
  bot.openChest.callsFake(() => new Promise<Chest>(done => { resolve = done; }));
  try {
    const pending = call('container-status');
    await clock.tickAsync(1);
    t.regex((await call('chest-status')).content[0].text, /in progress/);
    await clock.tickAsync(5000);
    t.regex((await pending).content[0].text, /opening timed out/);
    t.regex((await call('chest-status')).content[0].text, /in progress/);
    bot.currentWindow = chest;
    resolve(chest);
    await clock.tickAsync(1);
    t.true((chest.close as sinon.SinonStub).calledOnce);
    t.false(bot.transfer.called);
    bot.openChest.callsFake(async () => { bot.currentWindow = chest; return chest; });
    t.falsy((await call('chest-status')).isError);
  } finally {
    clock.restore();
  }
});

test.serial('generic storage inspection uses installed openContainer for a real five-slot hopper', async t => {
  const { bot, chest, call, events, block } = setup('hopper');
  const BlockClass = (require('prismarine-block') as (version: string) => typeof Block)('1.21.11');
  const hopper = BlockClass.fromStateId(registry.blocksByName.hopper.defaultState, 0);
  hopper.position = block.position;
  bot.blockAt.returns(hopper);
  const native = {
    openBlock: async () => { bot.currentWindow = chest; events.emit('windowOpen', chest); return chest; }
  } as unknown as Bot;
  (require('mineflayer/lib/plugins/chest.js') as (bot: Bot) => void)(native);
  bot.openContainer.callsFake((block: Block) => native.openContainer(block));
  chest.updateSlot(4, item('oak_log', 12));
  const result = await call('container-status');
  t.falsy(result.isError, result.content[0].text);
  const state = JSON.parse(result.content[0].text);
  t.is(state.block, 'hopper');
  t.is(state.slotCount, 5);
  t.is(state.emptySlots, 4);
  t.true(state.snapshotOnly);
  t.true(state.automaticTransfersPossible);
  t.deepEqual(state.items, [{ slot: 4, name: 'oak_log', count: 12, stackSize: 64 }]);
  t.is(chest.inventoryEnd - chest.inventoryStart, 36);
  t.true((chest.close as sinon.SinonStub).calledOnce);
});

for (const deposit of [true, false]) {
  test.serial(`generic hopper ${deposit ? 'deposit' : 'withdraw'} supports exact multi-stack amounts`, async t => {
    const { chest, transfer } = setup('hopper');
    const source = deposit ? chest.inventoryStart : 0;
    const dest = deposit ? 0 : chest.inventoryStart;
    chest.updateSlot(source, item('oak_log', 64));
    chest.updateSlot(source + 1, item('oak_log', 64));
    const result = await transfer(deposit ? 'deposit-container' : 'withdraw-container', 96);
    t.falsy(result.isError, result.content[0].text);
    const output = JSON.parse(result.content[0].text);
    t.is(output.block, 'hopper');
    t.is(output.transferred, 96);
    t.is(output.nativeCompleted, 96);
    t.true(output.snapshotOnly);
    t.is(chest.slots[dest]!.count, 64);
    t.is(chest.slots[dest + 1]!.count, 32);
    t.is(chest.listenerCount('updateSlot'), 0);
  });
}

for (const version of ['1.21.11', '26.1']) {
test.serial(`native ${version} hopper withdrawal into a partial player stack does not misclassify pickup/return as automation`, async t => {
  const { bot, chest, transfer } = setup('hopper', version);
  const registry = minecraftData(version);
  const Items = (require('prismarine-item') as (version: string) => typeof Item)(version);
  const item = (name: string, count: number) => new Items(registry.itemsByName[name].id, count);
  const client = Object.assign(new EventEmitter(), { write: sinon.stub() });
  const native = Object.assign(new EventEmitter(), {
    version, registry, _client: client, supportFeature: registry.supportFeature,
    game: { gameMode: 'survival' }, entity: { position: new Vec3(0, 64, 0), height: 1.8 }
  }) as unknown as Bot;
  (require('mineflayer/lib/plugins/inventory.js') as (bot: Bot, options: { hideErrors: boolean }) => void)(native, { hideErrors: true });
  native.currentWindow = chest;
  chest.updateSlot(0, item('oak_log', 64));
  for (let slot = chest.inventoryStart; slot < chest.inventoryEnd; slot++) chest.updateSlot(slot, item('dirt', 64));
  chest.updateSlot(chest.inventoryStart, item('oak_log', 59));
  bot.transfer.callsFake((options: TransferOptions) => native.transfer(options));
  const result = await transfer('withdraw-container', 5);
  t.falsy(result.isError, result.content[0].text);
  t.is(chest.slots[chest.inventoryStart]!.count, 64);
  t.is(chest.slots[0]!.count, 59);
  t.is(chest.selectedItem, null);
});
}

test.serial('generic tools allow only normal chests/hoppers and legacy chest tools remain chest-only', async t => {
  for (const name of ['container-status', 'deposit-container', 'withdraw-container']) {
    const { block, call, transfer, bot } = setup();
    const status = await call('container-status');
    t.falsy(status.isError);
    t.true(JSON.parse(status.content[0].text).automaticTransfersPossible);
    for (const unsupported of ['barrel', 'trapped_chest', 'ender_chest', 'dispenser', 'furnace']) {
      block.name = unsupported;
      const result = name === 'container-status' ? await call(name) : await transfer(name, 1);
      t.true(result.isError, `${name}/${unsupported}`);
    }
    t.true(bot.openContainer.calledOnce);
  }
  const { call, transfer, bot } = setup('hopper');
  t.true((await call('chest-status')).isError);
  t.true((await transfer('deposit-chest', 1)).isError);
  t.true((await transfer('withdraw-chest', 1)).isError);
  t.false(bot.openContainer.called);
});

test.serial('hopper storage capacity is exactly five slots and mismatched windows/native failures close safely', async t => {
  const { bot, chest, transfer, call } = setup('hopper');
  for (let slot = 0; slot < 5; slot++) chest.updateSlot(slot, item('dirt', 64));
  chest.updateSlot(chest.inventoryStart, item('oak_log', 64));
  t.regex((await transfer('deposit-container', 1)).content[0].text, /capacity/);
  t.regex((await transfer('withdraw-container', 1)).content[0].text, /Insufficient oak_log/);
  t.false(bot.transfer.called);
  chest.type = 'minecraft:generic_9x3';
  t.regex((await call('container-status')).content[0].text, /unexpected window/);
  t.is((chest.close as sinon.SinonStub).callCount, 3);
  chest.type = 'minecraft:hopper';
  bot.transfer.rejects(new Error('Native hopper transfer failed'));
  t.regex((await transfer('withdraw-container', 1, 'dirt')).content[0].text, /Native hopper transfer failed/);
  t.is(chest.listenerCount('updateSlot'), 0);
  t.is((chest.close as sinon.SinonStub).callCount, 4);
});

test.serial('compensating hopper automation cannot turn matching final balance deltas into claimed completion', async t => {
  const { chest, bot, transfer, move } = setup('hopper');
  chest.updateSlot(chest.inventoryStart, item('oak_log', 32));
  bot.transfer.callsFake(async (options: TransferOptions) => {
    move(options);
    chest.updateSlot(0, item('oak_log', 31));
    chest.updateSlot(0, item('oak_log', 32));
  });
  const result = await transfer('deposit-container', 32);
  t.true(result.isError);
  t.regex(result.content[0].text, /transfer attribution is uncertain/);
  t.regex(result.content[0].text, /"nativeCompleted":32,"verifiedTransferred":0,"concurrentUpdate":true/);
  t.regex(result.content[0].text, /"sourceRemoved":32,"destinationGained":32/);
  t.true((chest.close as sinon.SinonStub).calledOnce);
  t.is(chest.listenerCount('updateSlot'), 0);
});

test.serial('unexpected automated source transitions and unrelated storage updates stop withdrawal with partial evidence', async t => {
  for (const unrelated of [false, true]) {
    const { chest, bot, transfer, move } = setup('hopper');
    chest.updateSlot(0, item('oak_log', 32));
    bot.transfer.callsFake(async (options: TransferOptions) => {
      move(options);
      if (unrelated) chest.updateSlot(4, item('dirt', 1));
      else chest.updateSlot(0, item('oak_log', 1));
    });
    const result = await transfer('withdraw-container', 16);
    t.true(result.isError);
    t.regex(result.content[0].text, /concurrently/);
    t.regex(result.content[0].text, /"destinationGained":16/);
    t.is(chest.listenerCount('updateSlot'), 0);
  }
});
