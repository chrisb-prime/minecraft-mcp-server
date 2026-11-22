import test, { type ExecutionContext } from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import minecraftData from 'minecraft-data';
import type { Bot } from 'mineflayer';
import type { Item } from 'prismarine-item';
import type { Window } from 'prismarine-windows';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../src/tool-factory.js';
import { registerCraftingTools } from '../src/tools/crafting-tools.js';
import { syncInventory } from '../src/tools/cursor-utils.js';

const require = createRequire(import.meta.url);

function setup(t: ExecutionContext) {
  const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  t.teardown(async () => { await clock.runAllAsync(); clock.restore(); });
  const registry = minecraftData('26.1');
  const Items = (require('prismarine-item') as (version: string) => typeof Item)('26.1');
  const windows = require('prismarine-windows')('26.1') as {
    createWindow: (id: number, type: string, title: string) =>
      Omit<Window, 'updateSlot' | 'acceptClick'> & {
        updateSlot: (slot: number, item: Item | null) => void;
        acceptClick: (click: { slot: number; mouseButton: number; mode: number; item: Item | null }, gameMode: number) => void;
      };
  };
  const server = windows.createWindow(0, 'minecraft:inventory', 'Inventory');
  const item = (name: string, count: number) => new Items(registry.itemsByName[name].id, count);
  const client = Object.assign(new EventEmitter(), { write: sinon.stub() });
  const bot = Object.assign(new EventEmitter(), {
    version: '26.1', registry, _client: client, supportFeature: registry.supportFeature,
    health: 20, isSleeping: false, game: { gameMode: 'survival' },
    entity: { position: new Vec3(0, 64, 0), height: 1.8 },
    findBlock: sinon.stub().returns(null)
  }) as unknown as Bot;
  (require('mineflayer/lib/plugins/inventory.js') as (bot: Bot, options: { hideErrors: boolean }) => void)(bot, { hideErrors: true });
  (require('mineflayer/lib/plugins/craft.js') as (bot: Bot) => void)(bot);
  const preview = () => {
    const plank = (slot: number) => server.slots[slot]?.name === 'oak_planks';
    server.updateSlot(0, server.slots[1]?.name === 'oak_log' && !server.slots.slice(2, 5).some(Boolean)
      ? item('oak_planks', 4)
      : server.slots[2]?.name === 'iron_ingot' && server.slots[3]?.name === 'iron_ingot' && !server.slots[1] && !server.slots[4]
        ? item('shears', 1)
        : plank(1) && plank(3) && !server.slots[2] && !server.slots[4]
      ? item('stick', 4)
      : plank(1) && !server.slots.slice(2, 5).some(Boolean) ? item('oak_button', 1) : null);
  };
  const snapshot = () => ({
    windowId: 0, stateId: 1,
    items: server.slots.map(stack => Items.toNotch(stack)),
    carriedItem: Items.toNotch(server.selectedItem)
  });
  let syncAnswer: (() => void) | undefined;
  let rejectPlacement = false;
  let wrongPreview = false;
  let staleResponses = false;
  let queued: ReturnType<typeof snapshot> | undefined;
  let outputs = 0;
  let rejectAfterOutputs = Infinity;
  let rejectOutput = false;
  client.write.callsFake((name: string, packet: { mode: number; slot: number; mouseButton: number }) => {
    if (name !== 'window_click') return;
    if (packet.mode === 5) {
      const response = queued ?? snapshot();
      queued = undefined;
      setImmediate(() => syncAnswer ? syncAnswer() : client.emit('window_items', response));
      return;
    }
    if (packet.mode === 0) {
      if (staleResponses) queued = snapshot();
      if (!(((rejectPlacement || outputs >= rejectAfterOutputs) && packet.slot === 3) || (rejectOutput && packet.slot === 0))) {
        if (packet.slot === 0 && server.slots[0]) {
          outputs++;
          const result = server.slots[0]!;
          server.selectedItem = item(result.name, result.count);
          for (const slot of result.name === 'stick' ? [1, 3] : result.name === 'shears' ? [2, 3] : [1]) {
            const stack = server.slots[slot]!;
            server.updateSlot(slot, stack.count > 1 ? item(stack.name, stack.count - 1) : null);
          }
        } else {
          server.acceptClick({
            slot: packet.slot, mouseButton: packet.mouseButton, mode: 0,
            item: server.slots[packet.slot]
          }, 0);
        }
      }
      preview();
      if (wrongPreview && server.slots[1] && server.slots[3]) server.updateSlot(0, item('oak_button', 1));
      if (packet.slot <= 4) {
        const response = Items.toNotch(server.slots[0]);
        setImmediate(() => client.emit('set_slot', { windowId: 0, stateId: 1, slot: 0, item: response }));
      }
    }
  });
  const tool = sinon.stub();
  const factory = new ToolFactory({ tool } as unknown as McpServer, {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection);
  registerCraftingTools(factory, () => bot);
  const call = (args: { outputItem: string; amount?: number }) =>
    tool.getCalls().find(call => call.args[0] === 'craft-item')!.args[3](args) as Promise<ReturnType<ToolFactory['createResponse']>>;
  return {
    bot, server, client, item, preview, snapshot, call, clock,
    setSyncAnswer: (answer: () => void) => { syncAnswer = answer; },
    rejectPlacement: () => { rejectPlacement = true; },
    wrongPreview: () => { wrongPreview = true; },
    staleResponses: () => { staleResponses = true; },
    rejectAfter: (count: number) => { rejectAfterOutputs = count; },
    rejectOutput: () => { rejectOutput = true; }
  };
}

test.serial('native prediction can hide slot-1 residue and button preview when a preflight snapshot was queued before the grid changed', async t => {
  const { bot, server, item, client, preview, snapshot, setSyncAnswer } = setup(t);
  server.updateSlot(9, item('oak_planks', 61));
  const queued = snapshot();
  server.updateSlot(9, item('oak_planks', 60));
  server.updateSlot(1, item('oak_planks', 1));
  preview();
  setSyncAnswer(() => client.emit('window_items', queued));
  await syncInventory(bot);
  const recipe = bot.recipesFor(bot.registry.itemsByName.stick.id, null, 1, null)[0];
  await bot.craft(recipe, 1);
  t.falsy(bot.inventory.slots[1], 'Native craft clears its local grid prediction');
  t.is(server.slots[1]?.name, 'oak_planks');
  t.is(server.slots[1]?.count, 1);
  t.is(server.slots[0]?.name, 'oak_button');
  setSyncAnswer(() => client.emit('window_items', snapshot()));
  await syncInventory(bot);
  t.is(bot.inventory.slots[1]?.count, 1);
  t.is(bot.inventory.slots[0]?.name, 'oak_button');
});

test.serial('verified 31-stick batch consumes exactly 62 planks with independent server grid and accessible output', async t => {
  const { bot, server, item, client, call } = setup(t);
  server.updateSlot(9, item('oak_planks', 62));
  server.updateSlot(10, item('stick', 64));
  const native = sinon.spy(bot, 'craft');
  const result = await call({ outputItem: 'stick', amount: 31 });
  t.falsy(result.isError, result.content[0].text);
  t.regex(result.content[0].text, /31 time/);
  t.is(bot.inventory.items().filter(stack => stack.name === 'stick').reduce((sum, stack) => sum + stack.count, 0), 188);
  t.is(server.slots.filter(stack => stack?.name === 'oak_planks').length, 0);
  t.deepEqual(server.slots.slice(1, 5), [null, null, null, null]);
  t.falsy(bot.inventory.selectedItem);
  t.falsy(server.selectedItem);
  t.falsy(bot.inventory.slots[0]);
  t.false(native.called);
  const clicks = client.write.getCalls().filter(call => call.args[1].mode !== 5).map(call => call.args[1]);
  t.is(clicks.filter(packet => packet.slot === 0).length, 31);
  t.true(clicks.every(packet => packet.mode === 0 && packet.slot >= 0));
});

test.serial('actual slot-1 residue with button preview blocks further crafting without cleanup or consuming clicks', async t => {
  const { server, item, preview, call, client } = setup(t);
  server.updateSlot(9, item('oak_planks', 57));
  server.updateSlot(10, item('stick', 64));
  server.updateSlot(11, item('stick', 8));
  server.updateSlot(1, item('oak_planks', 1));
  preview();
  const result = await call({ outputItem: 'stick', amount: 29 });
  t.true(result.isError);
  t.regex(result.content[0].text, /residual inputs/);
  t.regex(result.content[0].text, /"slot":1/);
  t.regex(result.content[0].text, /oak_button/);
  t.false(client.write.getCalls().some(call => call.args[1].mode !== 5));
});

test.serial('verified batch tolerates one queued pre-click snapshot per movement without repeating any click', async t => {
  const { server, item, call, client, staleResponses } = setup(t);
  server.updateSlot(9, item('oak_planks', 62));
  staleResponses();
  const result = await call({ outputItem: 'stick', amount: 31 });
  t.falsy(result.isError, result.content[0].text);
  t.is(server.slots.filter(stack => stack?.name === 'stick').reduce((sum, stack) => sum + stack!.count, 0), 124);
  const clicks = client.write.getCalls().filter(call => call.args[1].mode === 0);
  t.is(clicks.filter(call => call.args[1].slot === 0).length, 31);
  t.is(clicks.filter(call => call.args[1].slot === 1).length, 31);
  t.is(clicks.filter(call => call.args[1].slot === 3).length, 31);
  t.falsy(server.selectedItem);
  t.deepEqual(server.slots.slice(1, 5), [null, null, null, null]);
});

test.serial('failure after two confirmed crafts reports partial completion and leaves unconsumed grid inputs visible', async t => {
  const { server, item, call, client, rejectAfter } = setup(t);
  server.updateSlot(9, item('oak_planks', 62));
  rejectAfter(2);
  const result = await call({ outputItem: 'stick', amount: 31 });
  t.true(result.isError);
  t.regex(result.content[0].text, /confirmed 2\/31/);
  t.regex(result.content[0].text, /oak_button/);
  t.is(server.slots.filter(stack => stack?.name === 'stick').reduce((sum, stack) => sum + stack!.count, 0), 8);
  t.is(server.slots.filter(stack => stack?.name === 'oak_planks').reduce((sum, stack) => sum + stack!.count, 0) +
    (server.selectedItem?.name === 'oak_planks' ? server.selectedItem.count : 0), 58);
  t.is(server.slots[1]?.count, 1);
  t.is(client.write.getCalls().filter(call => call.args[1].mode === 0 && call.args[1].slot === 0).length, 2);
});

test.serial('unconfirmed grid placement cannot advance to output even when a preview event acknowledges the native click wait', async t => {
  const { server, item, call, client, rejectPlacement } = setup(t);
  server.updateSlot(9, item('oak_planks', 62));
  rejectPlacement();
  const result = await call({ outputItem: 'stick', amount: 31 });
  t.true(result.isError);
  t.regex(result.content[0].text, /attribution uncertain/);
  t.regex(result.content[0].text, /confirmed 0\/31/);
  t.is(server.slots[0]?.name, 'oak_button');
  const clicks = client.write.getCalls().filter(call => call.args[1].mode === 0);
  t.is(clicks.filter(call => call.args[1].slot === 3).length, 1);
  t.false(clicks.some(call => call.args[1].slot === 0));
});

test.serial('wrong server preview is never picked up or replaced with predicted sticks', async t => {
  const { server, item, call, client, wrongPreview } = setup(t);
  server.updateSlot(9, item('oak_planks', 62));
  wrongPreview();
  const result = await call({ outputItem: 'stick', amount: 31 });
  t.true(result.isError);
  t.regex(result.content[0].text, /preview does not match/);
  t.false(client.write.getCalls().some(call => call.args[1].mode === 0 && call.args[1].slot === 0));
  t.is(server.slots[1]?.count, 1);
  t.is(server.slots[3]?.count, 1);
});

test.serial('queued empty-grid snapshot cannot hide real residue from verified source pickup', async t => {
  const { bot, server, item, client, preview, snapshot, setSyncAnswer, call } = setup(t);
  server.updateSlot(9, item('oak_planks', 62));
  const queued = snapshot();
  server.updateSlot(9, item('oak_planks', 61));
  server.updateSlot(1, item('oak_planks', 1));
  preview();
  let reads = 0;
  setSyncAnswer(() => client.emit('window_items', reads++ === 0 ? queued : snapshot()));
  const result = await call({ outputItem: 'stick' });
  t.true(result.isError);
  t.regex(result.content[0].text, /attribution uncertain/);
  t.is(bot.inventory.slots[1]?.count, 1);
  t.false(client.write.getCalls().some(call => call.args[1].mode === 0 && call.args[1].slot <= 4));
});

test.serial('verified inventory crafting preserves log yield and diagonal shears recipe without table or fabricated output', async t => {
  const { bot, server, item, call } = setup(t);
  server.updateSlot(9, item('oak_log', 32));
  const planks = await call({ outputItem: 'oak_planks', amount: 32 });
  t.falsy(planks.isError, planks.content[0].text);
  t.is(bot.inventory.items().filter(stack => stack.name === 'oak_planks').reduce((sum, stack) => sum + stack.count, 0), 128);
  server.updateSlot(12, item('iron_ingot', 2));
  const shears = await call({ outputItem: 'shears' });
  t.falsy(shears.isError, shears.content[0].text);
  t.is(bot.inventory.items().find(stack => stack.name === 'shears')?.count, 1);
  t.falsy(server.selectedItem);
  t.deepEqual(server.slots.slice(1, 5), [null, null, null, null]);
});

test.serial('rejected output pickup is never counted or retried and leaves actual inputs untouched', async t => {
  const { server, item, call, client, rejectOutput } = setup(t);
  server.updateSlot(9, item('oak_planks', 62));
  rejectOutput();
  const result = await call({ outputItem: 'stick', amount: 31 });
  t.true(result.isError);
  t.regex(result.content[0].text, /confirmed 0\/31/);
  t.regex(result.content[0].text, /attribution uncertain/);
  t.is(server.slots[1]?.count, 1);
  t.is(server.slots[3]?.count, 1);
  t.falsy(server.selectedItem);
  t.is(client.write.getCalls().filter(call => call.args[1].mode === 0 && call.args[1].slot === 0).length, 1);
});

test.serial('server silence after source pickup stops before placing ingredients and does not retry the click', async t => {
  const { server, item, client, snapshot, setSyncAnswer, clock, call } = setup(t);
  server.updateSlot(9, item('oak_planks', 62));
  let reads = 0;
  setSyncAnswer(() => { if (reads++ === 0) client.emit('window_items', snapshot()); });
  const pending = call({ outputItem: 'stick', amount: 31 });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  await clock.tickAsync(20001);
  const result = await pending;
  t.true(result.isError);
  t.regex(result.content[0].text, /timeout/);
  t.is(client.write.getCalls().filter(call => call.args[1].mode === 0).length, 1);
  t.deepEqual(server.slots.slice(1, 5), [null, null, null, null]);
  t.is(server.selectedItem?.count, 62);
});
