import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'events';
import { registerFurnaceTools } from '../src/tools/furnace-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import { BotConnection } from '../src/bot-connection.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';

const createMockItem = (fields: {
  name: string;
  count: number;
  type: number;
  metadata: number;
  slot?: number;
}): Item => ({ stackSize: 64, nbt: null, ...fields }) as unknown as Item;

test('registerFurnaceTools registers smelt-item tool', (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerFurnaceTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const smeltCall = toolCalls.find(call => call.args[0] === 'smelt-item');
  t.truthy(smeltCall);
  t.is(smeltCall!.args[1], 'Smelt items using a furnace-like block');
});

test('smelt-item returns error when no furnace block found', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    blockAt: sinon.stub().returns(null),
    inventory: {
      items: () => [
        createMockItem({ name: 'iron_ore', count: 3, type: 15, metadata: 0 }),
        createMockItem({ name: 'coal', count: 2, type: 263, metadata: 0 })
      ]
    }
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerFurnaceTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const smeltCall = toolCalls.find(call => call.args[0] === 'smelt-item');
  const executor = smeltCall!.args[3];

  const result = await executor({
    x: 1,
    y: 2,
    z: 3,
    inputItem: 'iron_ore',
    fuelItem: 'coal'
  });

  t.true(result.content[0].text.includes('No furnace block found'));
});

test('smelt-item loads input and fuel and takes output', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const furnace = new EventEmitter() as mineflayer.Furnace & EventEmitter;
  const outputItem = createMockItem({
    name: 'iron_ingot',
    count: 1,
    type: 100,
    metadata: 0,
    slot: 0
  });

  furnace.inventoryStart = 3;
  furnace.inventoryEnd = 4;
  furnace.slots = [null, null, null, null];
  furnace.putInput = sinon.stub().callsFake(async () => { furnace.slots[2] = outputItem; });
  furnace.putFuel = sinon.stub().resolves();
  furnace.takeOutput = sinon.stub().callsFake(async () => {
    furnace.slots[2] = null;
    furnace.slots[3] = outputItem;
    return outputItem;
  });
  furnace.inputItem = sinon.stub().returns(null);
  furnace.fuelItem = sinon.stub().returns(null);
  furnace.outputItem = () => furnace.slots[2]!;
  furnace.close = sinon.stub();

  const mockBot = {
    currentWindow: furnace,
    blockAt: sinon.stub().returns({ name: 'furnace' }),
    openFurnace: sinon.stub().callsFake(async () => {
      mockBot.currentWindow = furnace;
      return furnace;
    }),
    inventory: {
      items: () => [
        createMockItem({ name: 'iron_ore', count: 3, type: 15, metadata: 0 }),
        createMockItem({ name: 'coal', count: 2, type: 263, metadata: 0 })
      ]
    }
  } as unknown as Partial<mineflayer.Bot>;
  mockBot.currentWindow = null;
  const getBot = () => mockBot as mineflayer.Bot;

  registerFurnaceTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const smeltCall = toolCalls.find(call => call.args[0] === 'smelt-item');
  const executor = smeltCall!.args[3];

  const result = await executor({
    x: 1,
    y: 2,
    z: 3,
    inputItem: 'iron_ore',
    fuelItem: 'coal'
  });

  t.true(result.content[0].text.includes('Smelted 1 iron_ingot'));
  t.true((furnace.putInput as sinon.SinonStub).calledOnce);
  t.true((furnace.putFuel as sinon.SinonStub).calledOnce);
  t.true((furnace.takeOutput as sinon.SinonStub).calledOnce);
  t.true((furnace.close as sinon.SinonStub).calledOnce);
});

test('smelt-item returns validation error for non-positive counts', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerFurnaceTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const smeltCall = toolCalls.find(call => call.args[0] === 'smelt-item');
  const executor = smeltCall!.args[3];

  const inputCountResult = await executor({
    x: 1,
    y: 2,
    z: 3,
    inputItem: 'iron_ore',
    inputCount: 0,
    fuelItem: 'coal',
    fuelCount: 1
  });

  t.true(inputCountResult.isError);
  t.true(inputCountResult.content[0].text.includes('Invalid tool arguments'));
  t.true(inputCountResult.content[0].text.includes('inputCount'));

  const fuelCountResult = await executor({
    x: 1,
    y: 2,
    z: 3,
    inputItem: 'iron_ore',
    inputCount: 1,
    fuelItem: 'coal',
    fuelCount: -1
  });

  t.true(fuelCountResult.isError);
  t.true(fuelCountResult.content[0].text.includes('Invalid tool arguments'));
  t.true(fuelCountResult.content[0].text.includes('fuelCount'));
});

function setupFurnace(blockName = 'furnace') {
  const input = createMockItem({ name: 'iron_ore', count: 8, type: 15, metadata: 0 });
  const fuel = createMockItem({ name: 'coal', count: 8, type: 263, metadata: 0 });
  const output = (count: number) => createMockItem({ name: 'iron_ingot', count, type: 100, metadata: 0, slot: 2 });
  const furnace = new EventEmitter() as mineflayer.Furnace;
  furnace.slots = Array(39).fill(null);
  furnace.inventoryStart = 3;
  furnace.inventoryEnd = 39;
  furnace.fuel = 0;
  furnace.progress = 0;
  furnace.inputItem = () => furnace.slots[0]!;
  furnace.fuelItem = () => furnace.slots[1]!;
  furnace.outputItem = () => furnace.slots[2]!;
  const putFuel = sinon.stub().callsFake(async (_type, _metadata, count) => {
    furnace.slots[1] = { ...fuel, count } as Item;
  });
  const putInput = sinon.stub().callsFake(async (_type, _metadata, count) => {
    furnace.slots[0] = { ...input, count } as Item;
  });
  const takeOutput = sinon.stub().callsFake(async () => {
    const result = furnace.slots[2]!;
    const slot = furnace.slots.slice(3).findIndex(item => item === null) + 3;
    furnace.slots[slot] = { ...result } as Item;
    furnace.slots[2] = null;
    return result;
  });
  const close = sinon.stub().callsFake(() => { furnace.emit('close'); bot.currentWindow = null; });
  furnace.putFuel = putFuel;
  furnace.putInput = putInput;
  furnace.takeOutput = takeOutput;
  furnace.close = close;
  const bot = {
    currentWindow: null as mineflayer.Furnace | null,
    blockAt: sinon.stub().returns({ name: blockName, position: new Vec3(1, 64, 0) }),
    openFurnace: sinon.stub().callsFake(async () => { bot.currentWindow = furnace; return furnace; }),
    inventory: { items: sinon.stub().returns([input, fuel]) }
  };
  const serverTool = sinon.stub();
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) };
  const factory = new ToolFactory({ tool: serverTool } as unknown as McpServer, connection as unknown as BotConnection);
  registerFurnaceTools(factory, () => bot as unknown as mineflayer.Bot);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const registration = serverTool.getCalls().find(call => call.args[0] === name)!;
    return registration.args[3]({ x: 1, y: 64, z: 0, ...args }) as Promise<ReturnType<ToolFactory['createResponse']>>;
  };
  const smelt = (args: Record<string, unknown> = {}) =>
    call('smelt-item', { inputItem: 'iron_ore', fuelItem: 'coal', timeoutMs: 1000, ...args });
  return { bot, furnace, input, fuel, output, putFuel, putInput, takeOutput, close, call, smelt };
}

for (const family of ['furnace', 'smoker', 'blast_furnace']) {
  test(`${family} collects an entire progressing batch including multiple outputs per input`, async t => {
    const setup = setupFurnace(family);
    const { furnace, input, putInput, output, takeOutput, smelt, close } = setup;
    putInput.callsFake(async () => {
      furnace.slots[0] = { ...input, count: 2 } as Item;
      furnace.slots[2] = output(2);
    });
    takeOutput.callsFake(async () => {
      const taken = furnace.outputItem();
      furnace.slots[3 + takeOutput.callCount] = { ...taken } as Item;
      furnace.slots[2] = null;
      const remaining = furnace.inputItem()?.count ?? 0;
      furnace.slots[0] = remaining > 1 ? { ...input, count: remaining - 1 } as Item : null;
      if (remaining) furnace.slots[2] = output(2);
      return taken;
    });
    const result = await smelt({ inputCount: 3 });
    t.falsy(result.isError);
    t.regex(result.content[0].text, /Smelted 6 iron_ingot; processed 3\/3/);
    t.is(takeOutput.callCount, 3);
    t.true(close.calledOnce);
    t.is(furnace.listenerCount('close'), 0);
  });

  test(`${family} retrieve-only collects existing output without requiring input or fuel`, async t => {
    const { bot, furnace, output, call, takeOutput, putInput, putFuel, close } = setupFurnace(family);
    bot.inventory.items.returns([]);
    furnace.slots[2] = output(5);
    const result = await call('retrieve-furnace-output');
    t.falsy(result.isError);
    t.deepEqual(JSON.parse(result.content[0].text).retrieved, { name: 'iron_ingot', count: 5 });
    t.true(takeOutput.calledOnce);
    t.false(putInput.called);
    t.false(putFuel.called);
    t.true(close.calledOnce);
  });

  test(`${family} status reports cooking and remaining output without collecting`, async t => {
    const { furnace, input, output, call, takeOutput, close } = setupFurnace(family);
    furnace.slots[0] = input;
    furnace.slots[2] = output(3);
    furnace.fuel = 0.5;
    furnace.progress = 0.2;
    const result = await call('furnace-status');
    t.deepEqual(JSON.parse(result.content[0].text), {
      block: family, input: { name: 'iron_ore', count: 8 }, fuel: null,
      output: { name: 'iron_ingot', count: 3 }, burnFraction: 0.5, progressFraction: 0.2
    });
    t.false(takeOutput.called);
    t.true(close.calledOnce);
  });
}

test('batch timeout reports already collected output and remaining input as an MCP error', async t => {
  const { furnace, input, output, putInput, smelt, takeOutput, close } = setupFurnace();
  putInput.callsFake(async () => {
    furnace.slots[0] = { ...input, count: 2 } as Item;
    furnace.slots[2] = output(1);
  });
  const result = await smelt({ inputCount: 3, timeoutMs: 30 });
  t.true(result.isError);
  t.regex(result.content[0].text, /timed out/);
  t.regex(result.content[0].text, /"collected":\[\{"name":"iron_ingot","count":1\}\]/);
  t.regex(result.content[0].text, /"input":\{"name":"iron_ore","count":2\}/);
  t.true(takeOutput.calledOnce);
  t.true(close.calledOnce);
});

test('existing output and same-type input are rejected without loading or taking unrelated contents', async t => {
  const { furnace, input, output, smelt, takeOutput, putInput, putFuel } = setupFurnace();
  furnace.slots[2] = output(2);
  t.true((await smelt()).isError);
  furnace.slots[2] = null;
  furnace.slots[0] = input;
  t.true((await smelt()).isError);
  t.false(takeOutput.called);
  t.false(putInput.called);
  t.false(putFuel.called);
});

test('background cooking loads the batch without waiting or retrieving and preserves compatible fuel', async t => {
  const { furnace, fuel, putInput, putFuel, takeOutput, smelt, close } = setupFurnace();
  furnace.slots[1] = { ...fuel, count: 2 } as Item;
  const result = await smelt({ inputCount: 8, fuelCount: 3, takeOutput: false });
  t.falsy(result.isError);
  t.regex(result.content[0].text, /Loaded 8\/8/);
  t.true(putInput.calledOnceWithExactly(15, 0, 8));
  t.true(putFuel.calledOnceWithExactly(263, 0, 3));
  t.false(takeOutput.called);
  t.true(close.calledOnce);
});

test('unsupported cooking or insufficient fuel times out rather than claiming completion', async t => {
  const { smelt, close, takeOutput } = setupFurnace();
  const result = await smelt({ timeoutMs: 20 });
  t.true(result.isError);
  t.regex(result.content[0].text, /fuel may be insufficient or recipe unsupported/);
  t.false(takeOutput.called);
  t.true(close.calledOnce);
});

test('retrieve rejects empty output and full inventory without invoking native takeOutput', async t => {
  const { furnace, fuel, output, takeOutput, call } = setupFurnace();
  t.true((await call('retrieve-furnace-output')).isError);
  furnace.slots.fill(fuel, 3);
  furnace.slots[2] = output(3);
  const full = await call('retrieve-furnace-output');
  t.true(full.isError);
  t.regex(full.content[0].text, /Inventory cannot hold/);
  t.is(furnace.outputItem().count, 3);
  t.false(takeOutput.called);
});

test('retrieve uses available matching-stack capacity and verifies inventory transfer', async t => {
  const { furnace, fuel, output, takeOutput, call } = setupFurnace();
  furnace.slots.fill(fuel, 3);
  furnace.slots[3] = output(60);
  furnace.slots[2] = output(4);
  takeOutput.callsFake(async () => {
    const taken = furnace.outputItem();
    furnace.slots[3]!.count += taken.count;
    furnace.slots[2] = null;
    return taken;
  });
  t.falsy((await call('retrieve-furnace-output')).isError);
  t.is(furnace.slots[3]!.count, 64);
  furnace.slots[2] = output(1);
  takeOutput.resolves(output(1));
  // Make room, but emulate a native transfer which fails to actually move items.
  furnace.slots[4] = null;
  t.true((await call('retrieve-furnace-output')).isError);
});

test('retrieval reserves capacity for growing output while input remains', async t => {
  const { furnace, input, fuel, output, takeOutput, call } = setupFurnace();
  furnace.slots.fill(fuel, 3);
  furnace.slots[3] = output(60);
  furnace.slots[0] = input;
  furnace.slots[2] = output(1);
  const result = await call('retrieve-furnace-output');
  t.true(result.isError);
  t.regex(result.content[0].text, /reserve for cooking output/);
  t.false(takeOutput.called);
});

test('retrieval counts output which finishes during the native transfer', async t => {
  const { furnace, input, output, takeOutput, call } = setupFurnace();
  furnace.slots[0] = input;
  furnace.slots[2] = output(1);
  takeOutput.callsFake(async () => {
    furnace.slots[3] = output(2);
    furnace.slots[2] = null;
    return output(2);
  });
  const result = await call('retrieve-furnace-output');
  t.falsy(result.isError);
  t.is(JSON.parse(result.content[0].text).retrieved.count, 2);
});

test('batch waits through a gap between cooked outputs rather than completing after the first', async t => {
  const { furnace, input, output, putInput, takeOutput, smelt, close } = setupFurnace();
  let timer: ReturnType<typeof setTimeout> | undefined;
  putInput.callsFake(async () => {
    furnace.slots[0] = { ...input, count: 1 } as Item;
    furnace.slots[2] = output(1);
    timer = setTimeout(() => {
      furnace.slots[0] = null;
      furnace.slots[2] = output(1);
    }, 150);
  });
  const result = await smelt({ inputCount: 2 });
  if (timer) clearTimeout(timer);
  t.falsy(result.isError);
  t.regex(result.content[0].text, /Smelted 2 iron_ingot; processed 2\/2/);
  t.is(takeOutput.callCount, 2);
  t.true(close.calledOnce);
});

test('background batch reports clamped inventory counts rather than the full requested amount', async t => {
  const { smelt, putInput } = setupFurnace();
  const result = await smelt({ inputCount: 12, takeOutput: false });
  t.falsy(result.isError);
  t.regex(result.content[0].text, /Loaded 8\/12/);
  t.true(putInput.calledOnceWithExactly(15, 0, 8));
});

test('native loading failures report fuel already added and cleanup errors are not swallowed', async t => {
  const { putInput, smelt, close } = setupFurnace();
  putInput.rejects(new Error('server rejected input'));
  const result = await smelt();
  t.true(result.isError);
  t.regex(result.content[0].text, /server rejected input/);
  t.regex(result.content[0].text, /"fuelAdded":1/);
  t.true(close.calledOnce);
  close.throws(new Error('close failed'));
  const cleanup = await smelt();
  t.true(cleanup.isError);
  t.regex(cleanup.content[0].text, /server rejected input/);
  t.regex(cleanup.content[0].text, /close failed/);
});

test('native retrieval failure reports partial state and closes the window', async t => {
  const { furnace, output, takeOutput, call, close } = setupFurnace();
  furnace.slots[2] = output(2);
  takeOutput.rejects(new Error('transfer denied'));
  const result = await call('retrieve-furnace-output');
  t.true(result.isError);
  t.regex(result.content[0].text, /transfer denied/);
  t.regex(result.content[0].text, /"output":\{"name":"iron_ingot","count":2\}/);
  t.true(close.calledOnce);
});

test('furnace slot capacity, incompatible fuel, and shared input/fuel counts are validated before transfers', async t => {
  const { furnace, input, fuel, bot, smelt, putFuel } = setupFurnace();
  furnace.slots[1] = { ...fuel, count: 64 } as Item;
  t.true((await smelt()).isError);
  furnace.slots[1] = input;
  t.true((await smelt()).isError);
  furnace.slots[1] = null;
  bot.inventory.items.returns([fuel]);
  t.true((await smelt({ inputItem: 'coal', inputCount: 8, fuelCount: 1 })).isError);
  t.false(putFuel.called);
});

test('closed furnace and externally changed input fail without claiming completion', async t => {
  const { furnace, input, putInput, smelt, close } = setupFurnace();
  putInput.callsFake(async () => { furnace.emit('close'); });
  t.true((await smelt()).isError);
  putInput.callsFake(async () => { furnace.slots[0] = { ...input, count: 5 } as Item; });
  const changed = await smelt({ inputCount: 1 });
  t.true(changed.isError);
  t.regex(changed.content[0].text, /changed externally/);
  t.is(close.callCount, 2);
  t.is(furnace.listenerCount('close'), 0);
});

test('invalid targets, missing inventory, and excessive timeouts return MCP errors', async t => {
  const { bot, call, smelt, putInput } = setupFurnace();
  bot.blockAt.returns(null);
  t.true((await call('furnace-status')).isError);
  t.true((await call('retrieve-furnace-output')).isError);
  bot.inventory.items.returns([]);
  t.true((await smelt()).isError);
  t.true((await smelt({ timeoutMs: 300001 })).isError);
  t.false(putInput.called);
});
