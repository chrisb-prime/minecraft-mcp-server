import test from 'ava';
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
import { registerVillagerTools, trackVillagerProfessions } from '../src/tools/villager-tools.js';

const require = createRequire(import.meta.url);
function setup() {
  const registry = minecraftData('26.1');
  const Items = (require('prismarine-item') as (version: string) => typeof Item)('26.1');
  const windows = (require('prismarine-windows') as (version: string) => {
    createWindow(id: number, type: string, title: string): NonNullable<Bot['currentWindow']>;
  })('26.1');
  const window = windows.createWindow(2, 'minecraft:merchant', 'Shop');
  const metadata: unknown[] = [];
  metadata[registry.entitiesByName.villager.metadataKeys!.indexOf('villager_data')] = {
    villagerType: 2, villagerProfession: 5, level: 2
  };
  const entity = { id: 7731, name: 'villager', entityType: registry.entitiesByName.villager.id,
    metadata, isValid: true, position: new Vec3(1, 64, 0), width: 0.6, height: 1.95 };
  const client = Object.assign(new EventEmitter(), { write: sinon.stub() });
  const bot = Object.assign(new EventEmitter(), {
    version: '26.1', registry, _client: client, supportFeature: registry.supportFeature, health: 20, isSleeping: false,
    game: { gameMode: 'survival' }, entity: { id: 1, position: new Vec3(0, 64, 0), height: 1.8 },
    inventory: { selectedItem: null }, currentWindow: null,
    entities: { 7731: entity }, world: { raycast: sinon.stub().returns(null) },
    getControlState: sinon.stub().returns(false), closeWindow: sinon.stub(),
    openEntity: sinon.stub(), trade: sinon.stub(), clickWindow: sinon.stub(), activateEntity: sinon.stub()
  }) as unknown as Bot;
  const packet = {
    windowId: 2, villagerLevel: 2, canRestock: true,
    trades: [{
      inputItem1: { itemId: registry.itemsByName.emerald.id, itemCount: 10, components: {} },
      inputItem2: { itemId: registry.itemsByName.book.id, itemCount: 1, components: {} },
      outputItem: Items.toNotch(new Items(registry.itemsByName.enchanted_book.id, 1)),
      tradeDisabled: false, nbTradeUses: 2, maximumNbTradeUses: 12,
      demand: 2, specialPrice: -3, priceMultiplier: 0.2
    }]
  };
  (bot.closeWindow as sinon.SinonStub).callsFake(async () => {
    bot.currentWindow = null;
    EventEmitter.prototype.emit.call(window, 'close');
  });
  (bot.openEntity as sinon.SinonStub).callsFake(async () => {
    bot.currentWindow = window;
    bot.emit('windowOpen', window);
    client.emit('trade_list', packet);
    return window;
  });
  const tool = sinon.stub();
  const factory = new ToolFactory({ tool } as unknown as McpServer, {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection);
  registerVillagerTools(factory, () => bot);
  const call = (args: Record<string, unknown> = { entityId: 7731 }) => tool.firstCall.args[3](args) as Promise<ReturnType<ToolFactory['createResponse']>>;
  return { bot, window, entity, client, packet, call, tool };
}

test('viewer shows full server offers, adjusted first cost, second cost and remaining uses then closes without purchase', async t => {
  const { call, bot, client, tool } = setup();
  const result = await call();
  t.falsy(result.isError, result.content[0].text);
  const state = JSON.parse(result.content[0].text);
  t.is(state.level, 2);
  t.is(state.professionId, 5);
  t.is(state.profession, null);
  t.regex(state.professionNote, /No server profession mapping/);
  t.is(state.offers[0].inputs[0].count, 11);
  t.is(state.offers[0].inputs[1].name, 'book');
  t.is(state.offers[0].output.name, 'enchanted_book');
  t.is(state.offers[0].remainingUses, 10);
  t.true(state.serverConfirmed);
  t.false(state.purchased);
  t.true((bot.closeWindow as sinon.SinonStub).calledOnce);
  t.false((bot.trade as sinon.SinonStub).called);
  t.false((bot.clickWindow as sinon.SinonStub).called);
  t.false(client.write.called);
  t.is(tool.callCount, 1);
  t.is(client.listenerCount('trade_list'), 0);
});

test('sold-out offers and price caps use server fields, not guessed stock', async t => {
  const { packet, call } = setup();
  packet.trades[0].demand = 200;
  packet.trades[0].nbTradeUses = 12;
  packet.trades[0].tradeDisabled = true;
  const state = JSON.parse((await call()).content[0].text);
  t.is(state.offers[0].inputs[0].count, 64);
  t.false(state.offers[0].available);
  t.is(state.offers[0].remainingUses, 0);
});

test('discounted one-input offer clamps to one and retains exact component matchers', async t => {
  const { packet, call } = setup();
  const matcher = { components: [{ type: 'custom_name', data: { text: 'Specific payment' } }] };
  packet.trades[0].inputItem1.components = matcher;
  packet.trades[0].specialPrice = -100;
  Object.assign(packet.trades[0], { inputItem2: null });
  const offer = JSON.parse((await call()).content[0].text).offers[0];
  t.is(offer.inputs.length, 1);
  t.is(offer.inputs[0].count, 1);
  t.deepEqual(offer.inputs[0].components, matcher);
  t.deepEqual(offer.output.details, packet.trades[0].outputItem);
});

test('readable job follows actual server registry IDs rather than vanilla bootstrap order', async t => {
  const { bot, client, entity, call } = setup();
  trackVillagerProfessions(bot);
  client.emit('registry_data', {
    id: 'minecraft:villager_profession',
    entries: ['minecraft:none', 'minecraft:armorer', 'minecraft:butcher',
      'minecraft:cartographer', 'minecraft:cleric', 'minecraft:librarian'].map(key => ({ key }))
  });
  const state = JSON.parse((await call()).content[0].text);
  t.is(state.profession, 'minecraft:librarian');
  t.is(state.job, 'librarian');
  t.is(state.professionSource, 'server_registry');
  client.emit('packet', {}, { name: 'start_configuration' });
  t.is(JSON.parse((await call()).content[0].text).profession, null);
  entity.metadata.length = 0;
  t.is(JSON.parse((await call()).content[0].text).professionId, null);
});

test('26.1 server merchant NBT title supplies job independently of unmapped metadata ID and offers', async t => {
  for (const id of [8, 999]) {
    const { window, entity, call, packet } = setup();
    const key = minecraftData('26.1').entitiesByName.villager.metadataKeys!.indexOf('villager_data');
    entity.metadata[key] = { villagerProfession: id, level: 1 };
    packet.villagerLevel = 1;
    packet.trades.length = 0;
    Object.assign(window, { title: {
      type: 'compound', value: { translate: { type: 'string', value: 'entity.minecraft.villager.leatherworker' } }
    } });
    const state = JSON.parse((await call()).content[0].text);
    t.is(state.professionId, id);
    t.is(state.profession, 'minecraft:leatherworker');
    t.is(state.job, 'leatherworker');
    t.is(state.professionSource, 'merchant_title');
    t.is(state.level, 1);
    t.is(state.metadataLevel, 1);
    t.regex(state.professionNote, /numeric metadata ID mapping unavailable/);
    t.false(state.purchased);
  }
});

test('server title can resolve a label without metadata, but never caches that label against a numeric ID', async t => {
  const { window, entity, call } = setup();
  entity.metadata.length = 0;
  Object.assign(window, { title: { translate: 'entity.minecraft.villager.toolsmith' } });
  let state = JSON.parse((await call()).content[0].text);
  t.is(state.professionId, null);
  t.is(state.job, 'toolsmith');
  window.title = 'Shop';
  state = JSON.parse((await call()).content[0].text);
  t.is(state.job, null);
  t.is(state.professionSource, null);
});

test('literal/custom/nested/malformed titles do not fabricate jobs from labels, offers or metadata ID8', async t => {
  for (const title of [
    'Leatherworker',
    { type: 'string', value: 'Leatherworker - Novice' },
    { text: 'Leatherworker' },
    { text: '', extra: [{ translate: 'entity.minecraft.villager.leatherworker' }] },
    { translate: 'entity.minecraft.villager.leatherworker', extra: [{ text: ' custom' }] },
    { translate: 'entity.minecraft.villager.leatherworker', with: ['custom'] },
    { translate: 'entity.minecraft.villager' },
    { translate: 'entity.minecraft.zombie.leatherworker' },
    { type: 'compound', value: { translate: { type: 'int', value: 8 } } },
    null
  ]) {
    const { window, entity, call } = setup();
    entity.metadata[minecraftData('26.1').entitiesByName.villager.metadataKeys!.indexOf('villager_data')] = {
      villagerProfession: 8, level: 1
    };
    Object.assign(window, { title });
    const result = await call();
    t.falsy(result.isError, result.content[0].text);
    const state = JSON.parse(result.content[0].text);
    t.is(state.professionId, 8);
    t.is(state.job, null);
    t.is(state.professionSource, null);
    t.regex(state.professionNote, /no job inferred/);
  }
});

test('conflicting server registry and title remain explicit unknowns instead of choosing a guessed profession', async t => {
  const { bot, client, window, call } = setup();
  trackVillagerProfessions(bot);
  client.emit('registry_data', {
    id: 'minecraft:villager_profession', entries: Array.from({ length: 6 }, () => ({ key: 'minecraft:librarian' }))
  });
  Object.assign(window, { title: { translate: 'entity.minecraft.villager.leatherworker' } });
  const state = JSON.parse((await call()).content[0].text);
  t.is(state.profession, null);
  t.is(state.professionSource, null);
  t.regex(state.professionNote, /disagree/);
});

test('rejects existing merchant or unrelated windows without stealing, claiming identity or closing them', async t => {
  for (const type of ['minecraft:merchant', 'minecraft:generic_9x3']) {
    const { bot, window, call } = setup();
    window.type = type;
    bot.currentWindow = window;
    const result = await call();
    t.true(result.isError);
    t.regex(result.content[0].text, /not owned/);
    t.false((bot.openEntity as sinon.SinonStub).called);
    t.false((bot.closeWindow as sinon.SinonStub).called);
  }
});

test('invalid, stale, distant, obstructed or unsafe villagers do not open', async t => {
  for (const reason of ['missing', 'type', 'stale', 'distant', 'blocked', 'cursor', 'sleep', 'sneak']) {
    const { bot, entity, call } = setup();
    if (reason === 'type') entity.name = 'wandering_trader';
    if (reason === 'stale') entity.isValid = false;
    if (reason === 'distant') entity.position.x = 20;
    if (reason === 'blocked') (bot.world.raycast as sinon.SinonStub).returns({});
    if (reason === 'cursor') bot.inventory.selectedItem = { name: 'emerald' } as Item;
    if (reason === 'sleep') bot.isSleeping = true;
    if (reason === 'sneak') (bot.getControlState as sinon.SinonStub).returns(true);
    const result = await call({ entityId: reason === 'missing' ? 0 : 7731 });
    t.true(result.isError, reason);
    t.false((bot.openEntity as sinon.SinonStub).called);
  }
  t.true((await setup().call({ entityId: -1 })).isError);
});

test('missing or malformed offers fail explicitly and close only empty owned merchant', async t => {
  const { packet, call, bot } = setup();
  packet.trades[0].inputItem1.itemCount = 0;
  const result = await call();
  t.true(result.isError);
  t.true((bot.closeWindow as sinon.SinonStub).calledOnce);
  t.false((bot.trade as sinon.SinonStub).called);
});

test('trade-slot or cursor contents are left open with explicit error rather than risk return/drop effects', async t => {
  const { window, call, bot } = setup();
  window.slots[0] = { name: 'emerald', count: 1 } as Item;
  const result = await call();
  t.true(result.isError);
  t.regex(result.content[0].text, /left open/);
  t.false((bot.closeWindow as sinon.SinonStub).called);
});

test.serial('native openEntity with fake client receives offers before promise resolution without trade selection', async t => {
  const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  t.teardown(async () => { await clock.runAllAsync(); clock.restore(); });
  const { bot, window, packet, client, call } = setup();
  const protocol = require('minecraft-protocol') as {
    createSerializer(options: { state: string; isServer: boolean; version: string }): {
      createPacketBuffer(packet: { name: string; params: object }): Buffer
    };
    createDeserializer(options: { state: string; isServer: boolean; version: string }): {
      parsePacketBuffer(buffer: Buffer): { data: { name: string; params: unknown } }
    };
  };
  const serializer = protocol.createSerializer({ state: 'play', isServer: true, version: '26.1' });
  const parser = protocol.createDeserializer({ state: 'play', isServer: false, version: '26.1' });
  const menus = (require('prismarine-windows') as (version: string) => {
    windows: Record<string, { type: number }>
  })('26.1');
  const open = { windowId: 2, inventoryType: menus.windows['minecraft:merchant'].type,
    windowTitle: { type: 'compound', value: { translate: { type: 'string', value: 'entity.minecraft.villager.leatherworker' } } } };
  const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'open_window', params: open })).data;
  const Items = (require('prismarine-item') as (version: string) => typeof Item)('26.1');
  bot.activateEntity = sinon.stub().callsFake(() => setImmediate(() => {
    client.emit(decoded.name, decoded.params);
    client.emit('window_items', { windowId: 2, stateId: 1,
      items: window.slots.map(item => Items.toNotch(item)), carriedItem: Items.toNotch(null) });
    client.emit('trade_list', packet);
  }));
  const originalActivate = bot.activateEntity;
  (require('mineflayer/lib/plugins/inventory.js') as (bot: Bot, options: { hideErrors: boolean }) => void)(bot, { hideErrors: true });
  bot.activateEntity = originalActivate;
  const result = await call();
  t.falsy(result.isError, result.content[0].text);
  t.is(JSON.parse(result.content[0].text).job, 'leatherworker');
  t.is(JSON.parse(result.content[0].text).professionSource, 'merchant_title');
  t.is(JSON.parse(result.content[0].text).merchantTitleTranslation, 'entity.minecraft.villager.leatherworker');
  t.falsy(bot.currentWindow);
  t.true(client.write.calledOnceWith('close_window', { windowId: 2 }));
  t.true((bot.activateEntity as sinon.SinonStub).calledOnce);
  t.false(client.write.getCalls().some(call => ['select_trade', 'window_click'].includes(call.args[0])));
});

test('empty server offers are an empty shop, not an inferred profession or purchase', async t => {
  const { packet, call } = setup();
  packet.trades.length = 0;
  const state = JSON.parse((await call()).content[0].text);
  t.deepEqual(state.offers, []);
  t.false(state.purchased);
});

test('native opening or closure failure returns MCP error and releases operation for retry', async t => {
  const { bot, call, client } = setup();
  (bot.openEntity as sinon.SinonStub).throws(new Error('native denied'));
  t.regex((await call()).content[0].text, /native denied/);
  t.is(client.listenerCount('trade_list'), 0);
  (bot.openEntity as sinon.SinonStub).rejects(new Error('open rejected'));
  t.regex((await call()).content[0].text, /open rejected/);
  t.is(client.listenerCount('trade_list'), 0);
});

test('cleanup failure is explicit, not a successful shop or a repeated closure', async t => {
  const { bot, call } = setup();
  (bot.closeWindow as sinon.SinonStub).throws(new Error('close failed'));
  const result = await call();
  t.true(result.isError);
  t.regex(result.content[0].text, /close failed/);
  t.true((bot.closeWindow as sinon.SinonStub).calledOnce);
});

test('window replacement and disconnect before offers fail without closing unrelated windows', async t => {
  for (const reason of ['replacement', 'disconnect']) {
    const { bot, window, call } = setup();
    (bot.openEntity as sinon.SinonStub).callsFake(async () => {
      bot.currentWindow = window;
      bot.emit('windowOpen', window);
      setImmediate(() => {
        if (reason === 'disconnect') bot.emit('end', 'Disconnected');
        else {
          bot.currentWindow = { ...window, id: 3 } as NonNullable<Bot['currentWindow']>;
          bot.emit('windowClose', window);
        }
      });
      return window;
    });
    t.true((await call()).isError);
    if (reason === 'replacement') t.false((bot.closeWindow as sinon.SinonStub).called);
  }
});

test('potentially mutating held interaction items fail before merchant activation', async t => {
  for (const name of ['name_tag', 'lead', 'villager_spawn_egg', 'water_bucket']) {
    const { bot, call } = setup();
    bot.heldItem = { name } as Item;
    t.true((await call()).isError);
    t.false((bot.openEntity as sinon.SinonStub).called);
  }
});

test.serial('wrong-window offers cannot satisfy deadline; empty opened shop is safely closed', async t => {
  const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  t.teardown(() => clock.restore());
  const { bot, packet, call, client } = setup();
  packet.windowId = 999;
  const pending = call();
  await clock.tickAsync(5001);
  const result = await pending;
  t.true(result.isError);
  t.regex(result.content[0].text, /timed out/);
  await new Promise(resolve => setImmediate(resolve));
  t.true((bot.closeWindow as sinon.SinonStub).calledOnce);
  t.is(client.listenerCount('trade_list'), 0);
});

test.serial('bounded late opening keeps lock and closes empty late merchant without buying', async t => {
  const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  t.teardown(() => clock.restore());
  const { bot, window, call, client } = setup();
  let finish = (_window: NonNullable<Bot['currentWindow']>) => {};
  (bot.openEntity as sinon.SinonStub).callsFake(() => new Promise(resolve => { finish = resolve; }));
  const pending = call();
  await new Promise(resolve => setImmediate(resolve));
  await clock.tickAsync(5001);
  t.true((await pending).isError);
  t.true((await call()).isError);
  bot.currentWindow = window;
  bot.emit('windowOpen', window);
  finish(window);
  await new Promise(resolve => setImmediate(resolve));
  t.true((bot.closeWindow as sinon.SinonStub).calledOnce);
  t.is(client.listenerCount('trade_list'), 0);
});
