import test from 'ava';
import sinon from 'sinon';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { Block } from 'prismarine-block';

test('registerBlockTools registers place-block tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const placeBlockCall = toolCalls.find(call => call.args[0] === 'place-block');

  t.truthy(placeBlockCall);
  t.is(placeBlockCall!.args[1], 'Place a block at the specified position');
});

test('registerBlockTools registers dig-block tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const digBlockCall = toolCalls.find(call => call.args[0] === 'dig-block');

  t.truthy(digBlockCall);
  t.is(digBlockCall!.args[1], 'Dig a block at the specified position');
});

test('registerBlockTools registers get-block-info tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const getBlockInfoCall = toolCalls.find(call => call.args[0] === 'get-block-info');

  t.truthy(getBlockInfoCall);
  t.is(getBlockInfoCall!.args[1], 'Get information about a block at the specified position');
});

test('registerBlockTools registers find-blocks tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findBlockCall = toolCalls.find(call => call.args[0] === 'find-blocks');

  t.truthy(findBlockCall);
  t.is(findBlockCall!.args[1], 'Find one or more nearby blocks of a specific type');
});

test('get-block-info returns block information', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBlock = {
    name: 'stone',
    type: 1,
    position: new Vec3(10, 64, 20),
    stateId: 1,
    getProperties: () => ({}),
    boundingBox: 'block',
    shapes: [[0, 0, 0, 1, 1, 1]]
  };
  const mockBot = {
    blockAt: sinon.stub().returns(mockBlock)
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const getBlockInfoCall = toolCalls.find(call => call.args[0] === 'get-block-info');
  const executor = getBlockInfoCall!.args[3];

  const result = await executor({ x: 10, y: 64, z: 20 });

  t.true(result.content[0].text.includes('stone'));
  t.true(result.content[0].text.includes('10'));
  t.true(result.content[0].text.includes('64'));
  t.true(result.content[0].text.includes('20'));
  t.deepEqual(JSON.parse(result.content[0].text.split('\n')[1]), {
    stateId: 1, properties: {}, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]]
  });
});

test('get-block-info handles missing block', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBot = {
    blockAt: sinon.stub().returns(null)
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const getBlockInfoCall = toolCalls.find(call => call.args[0] === 'get-block-info');
  const executor = getBlockInfoCall!.args[3];

  const result = await executor({ x: 10, y: 64, z: 20 });

  t.true(result.content[0].text.includes('No block information found'));
});

test('dig-block handles air blocks', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBlock = {
    name: 'air'
  };
  const mockBot = {
    blockAt: sinon.stub().returns(mockBlock)
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const digBlockCall = toolCalls.find(call => call.args[0] === 'dig-block');
  const executor = digBlockCall!.args[3];

  const result = await executor({ x: 10, y: 64, z: 20 });

  t.true(result.content[0].text.includes('No block found'));
});

test('place-block blocks placing at bot position and one block above', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    entity: { position: new Vec3(10.4, 64, 20.7) },
    blockAt: sinon.stub().returns({ name: 'air' })
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const placeBlockCall = toolCalls.find(call => call.args[0] === 'place-block');
  const executor = placeBlockCall!.args[3];

  const resultAtFeet = await executor({ x: 10, y: 64, z: 20 });
  const resultAtHead = await executor({ x: 10, y: 65, z: 20 });

  t.true(resultAtFeet.content[0].text.includes("can't place a block"));
  t.true(resultAtHead.content[0].text.includes("can't place a block"));
});

test('place-block floors input coordinates before self-placement guard', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    entity: { position: new Vec3(10.4, 64, 20.7) },
    blockAt: sinon.stub().returns({ name: 'air' })
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const placeBlockCall = toolCalls.find(call => call.args[0] === 'place-block');
  const executor = placeBlockCall!.args[3];

  const result = await executor({ x: 10.4, y: 64, z: 20.7 });

  t.true(result.content[0].text.includes("can't place a block"));
});

test('find-blocks returns not found when block not found', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBot = {
    version: '1.21',
    findBlock: sinon.stub().returns(null)
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findBlockCall = toolCalls.find(call => call.args[0] === 'find-blocks');
  const executor = findBlockCall!.args[3];

  const result = await executor({ blockType: 'diamond_ore', maxDistance: 16 });

  t.true(result.content[0].text.includes('No diamond_ore found'));
});

test('find-blocks returns multiple results when count is greater than one', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: sinon.stub().returns([new Vec3(1, 64, 0), new Vec3(2, 64, 0)])
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findBlockCall = toolCalls.find(call => call.args[0] === 'find-blocks');
  const executor = findBlockCall!.args[3];

  const result = await executor({ blockType: 'stone', maxDistance: 16, count: 2 });

  t.true(result.content[0].text.includes('Found 2 stone block(s)'));
  t.true(result.content[0].text.includes('(1, 64, 0)'));
  t.true(result.content[0].text.includes('(2, 64, 0)'));
});

test('find-blocks clamps oversized count before calling bot.findBlocks', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const findBlocksStub = sinon.stub().returns([new Vec3(1, 64, 0)]);
  const mockBot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: findBlocksStub
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findBlockCall = toolCalls.find(call => call.args[0] === 'find-blocks');
  const executor = findBlockCall!.args[3];

  await executor({ blockType: 'stone', maxDistance: 16, count: 10_000 });

  const findBlocksArgs = findBlocksStub.firstCall.args[0];
  t.is(findBlocksArgs.count, 256);
});

function setupPlacement(name = 'fern', stateOffset = 0) {
  const data = minecraftData('1.21.11');
  const BlockClass = (createRequire(import.meta.url)('prismarine-block') as (version: string) => typeof Block)('1.21.11');
  const targetPos = new Vec3(331, 63, -226);
  const blocks = new Map<string, Block>();
  const put = (name: string, position = targetPos, stateOffset = 0) => {
    const block = BlockClass.fromStateId(data.blocksByName[name].minStateId + stateOffset, 0);
    block.position = position;
    blocks.set(position.toString(), block);
    return block;
  };
  const target = put(name, targetPos, stateOffset);
  const reference = put('grass_block', targetPos.offset(0, -1, 0));
  const bot = {
    registry: data, game: { gameMode: 'survival' },
    heldItem: { name: 'oak_fence' },
    entity: { position: new Vec3(331.5, 63, -228.5), height: 1.8 },
    blockAt: sinon.stub().callsFake((position: Vec3) => blocks.get(position.toString()) ?? put('air', position)),
    canSeeBlock: sinon.stub().returns(true),
    lookAt: sinon.stub().resolves(), dig: sinon.stub().resolves(),
    placeBlock: sinon.stub().callsFake(async () => { put('oak_fence'); }),
    pathfinder: { movements: { canDig: true, allow1by1towers: true, scafoldingBlocks: [1] },
      goto: sinon.stub().resolves() }
  };
  const tool = sinon.stub();
  const factory = new ToolFactory({ tool } as unknown as McpServer, {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection);
  registerBlockTools(factory, () => bot as unknown as mineflayer.Bot);
  const call = () => tool.getCalls().find(call => call.args[0] === 'place-block')!.args[3]({
    x: targetPos.x, y: targetPos.y, z: targetPos.z
  }) as Promise<ReturnType<ToolFactory['createResponse']>>;
  return { bot, call, put, target, targetPos, reference };
}

test('native placement replaces one-layer snow and simple replaceable plants at the explicit target without digging', async t => {
  const injectPlacement = createRequire(import.meta.url)('mineflayer/lib/plugins/place_block.js') as (bot: mineflayer.Bot) => void;
  for (const name of ['fern', 'snow', 'short_grass', 'dead_bush', 'air', 'cave_air']) {
    const { bot, call, put, reference, targetPos } = setupPlacement(name);
    const native = Object.assign(new EventEmitter(), {
      blockAt: bot.blockAt, _genericPlace: sinon.stub().callsFake(async () => { put('oak_fence'); })
    }) as unknown as mineflayer.Bot;
    injectPlacement(native);
    bot.placeBlock.callsFake((reference: Block, face: Vec3) => native.placeBlock(reference, face));
    const result = await call();
    t.falsy(result.isError, result.content[0].text);
    t.regex(result.content[0].text, /Placed oak_fence/);
    t.true(bot.placeBlock.calledOnce);
    t.is(bot.placeBlock.firstCall.args[0], reference);
    t.true(bot.placeBlock.firstCall.args[1].equals(new Vec3(0, 1, 0)));
    t.true(reference.position.plus(bot.placeBlock.firstCall.args[1]).equals(targetPos));
    t.false(bot.dig.called);
    t.false(bot.pathfinder.goto.called);
  }
});

test('placement does not blanket-replace empty shapes, solids, liquids or thicker snow', async t => {
  for (const [name, offset] of [
    ['stone', 0], ['water', 0], ['lava', 0], ['torch', 0], ['sugar_cane', 0],
    ['dandelion', 0], ['snow_block', 0], ['snow', 1], ['snow', 7]
  ] as const) {
    const { bot, call, target } = setupPlacement(name, offset);
    if (name === 'snow') t.true(Number(target.getProperties().layers) > 1);
    const result = await call();
    t.true(result.isError, `${name}/${offset}`);
    t.false(bot.placeBlock.called);
    t.false(bot.dig.called);
    t.false(bot.pathfinder.goto.called);
  }
});

test('native placement failures report partial target effects and never try extra faces', async t => {
  for (const changed of [false, true]) {
    const { bot, call, put } = setupPlacement();
    bot.placeBlock.callsFake(async () => {
      if (changed) put('oak_fence');
      throw new Error('Native placement refused');
    });
    const result = await call();
    t.true(result.isError);
    t.regex(result.content[0].text, /Native placement refused/);
    t.regex(result.content[0].text, changed ? /target now oak_fence/ : /target now fern/);
    t.true(bot.placeBlock.calledOnce);
    t.false(bot.dig.called);
  }
});

test('placement verifies the intended target rather than trusting native success or plant removal alone', async t => {
  for (const observed of ['fern', 'air', 'stone', 'unloaded']) {
    const { bot, call, put, targetPos } = setupPlacement();
    bot.placeBlock.callsFake(async () => {
      if (observed === 'unloaded') bot.blockAt.withArgs(targetPos).returns(null);
      else put(observed);
    });
    t.regex((await call()).content[0].text, /Placement not confirmed at intended target/);
    t.true(bot.placeBlock.calledOnce);
  }
});

test('replacement approach remains safe and refuses changed targets or held items', async t => {
  for (const change of ['none', 'target', 'item']) {
    const { bot, call, put } = setupPlacement();
    bot.canSeeBlock.returns(false);
    bot.pathfinder.goto.callsFake(async () => {
      t.false(bot.pathfinder.movements.canDig);
      t.false(bot.pathfinder.movements.allow1by1towers);
      t.deepEqual(bot.pathfinder.movements.scafoldingBlocks, []);
      bot.canSeeBlock.returns(true);
      if (change === 'target') put('stone');
      if (change === 'item') bot.heldItem.name = 'oak_fence_gate';
    });
    const result = await call();
    if (change === 'none') t.falsy(result.isError);
    else {
      t.true(result.isError);
      t.false(bot.placeBlock.called);
    }
    t.false(bot.dig.called);
  }
});

test('replacement requires a loaded target, a block item, normal reach and a usable solid reference', async t => {
  for (const scenario of ['unloaded', 'bucket', 'snow-stack', 'no-reference', 'reach', 'invisible']) {
    const { bot, call, targetPos, reference } = setupPlacement(scenario === 'snow-stack' ? 'snow' : 'fern');
    if (scenario === 'unloaded') bot.blockAt.withArgs(targetPos).returns(null);
    if (scenario === 'bucket') bot.heldItem.name = 'water_bucket';
    if (scenario === 'snow-stack') bot.heldItem.name = 'snow';
    if (scenario === 'no-reference') bot.blockAt.withArgs(reference.position).returns(null);
    if (scenario === 'reach') bot.entity.position = new Vec3(340, 63, -226);
    if (scenario === 'invisible') bot.canSeeBlock.returns(false);
    t.true((await call()).isError, scenario);
    t.false(bot.placeBlock.called);
    t.false(bot.dig.called);
  }
});

test('ordinary seed and food-crop planting into air above farmland uses native placement and confirms the crop block', async t => {
  const injectPlacement = createRequire(import.meta.url)('mineflayer/lib/plugins/place_block.js') as (bot: mineflayer.Bot) => void;
  for (const [held, crop] of [
    ['wheat_seeds', 'wheat'], ['beetroot_seeds', 'beetroots'], ['carrot', 'carrots'],
    ['potato', 'potatoes'], ['melon_seeds', 'melon_stem'], ['pumpkin_seeds', 'pumpkin_stem'],
    ['torchflower_seeds', 'torchflower_crop'], ['pitcher_pod', 'pitcher_crop']
  ] as const) {
    const { bot, call, put, reference, targetPos } = setupPlacement('air');
    t.truthy(bot.registry.itemsByName[held]);
    t.truthy(bot.registry.blocksByName[crop]);
    bot.heldItem.name = held;
    const farmland = put('farmland', reference.position);
    const native = Object.assign(new EventEmitter(), {
      blockAt: bot.blockAt,
      _genericPlace: sinon.stub().callsFake(async (clicked: Block, face: Vec3) => {
        t.is(clicked.name, 'farmland');
        t.true(clicked.position.plus(face).equals(targetPos));
        put(crop);
      })
    }) as unknown as mineflayer.Bot;
    injectPlacement(native);
    bot.placeBlock.callsFake((reference: Block, face: Vec3) => native.placeBlock(reference, face));
    const result = await call();
    t.falsy(result.isError, result.content[0].text);
    t.true(result.content[0].text.includes(`Placed ${crop}`));
    t.is(bot.placeBlock.firstCall.args[0], farmland);
    t.true(bot.placeBlock.calledOnce);
    t.is(bot.blockAt(reference.position).name, 'farmland');
    t.false(bot.dig.called);
    t.false(bot.pathfinder.goto.called);
  }
});

test('ordinary non-farmland planting confirms the native plant alias without loosening replacement policy', async t => {
  for (const [held, planted] of [
    ['cocoa_beans', 'cocoa'], ['sweet_berries', 'sweet_berry_bush'],
    ['glow_berries', 'cave_vines'], ['bamboo', 'bamboo_sapling'], ['bamboo', 'bamboo']
  ] as const) {
    const { bot, call, put } = setupPlacement('air');
    bot.heldItem.name = held;
    bot.placeBlock.callsFake(async () => { put(planted); });
    const result = await call();
    t.falsy(result.isError, result.content[0].text);
    t.true(result.content[0].text.includes(`Placed ${planted}`));
    t.false(bot.dig.called);
    const occupied = setupPlacement('wheat');
    occupied.bot.heldItem.name = held;
    t.true((await occupied.call()).isError);
    t.false(occupied.bot.placeBlock.called);
  }
});

test('seed placement requires the mapped crop at the requested target and surfaces native planting failures', async t => {
  for (const outcome of ['air', 'carrots', 'stone', 'refused']) {
    const { bot, call, put, reference } = setupPlacement('air');
    bot.heldItem.name = 'wheat_seeds';
    put('farmland', reference.position);
    bot.placeBlock.callsFake(async () => {
      if (outcome === 'refused') throw new Error('Native planting refused');
      put(outcome);
    });
    const result = await call();
    t.true(result.isError);
    t.regex(result.content[0].text, outcome === 'refused' ? /Native planting refused/ : /expected wheat/);
    t.true(bot.placeBlock.calledOnce);
    t.false(bot.dig.called);
  }
});
