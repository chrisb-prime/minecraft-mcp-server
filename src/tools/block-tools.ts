import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { safeGoto } from '../safe-navigation.js';
import type { Item } from 'prismarine-item';
import { DigApproachGoal, hasReachableDigFace } from '../digging-geometry.js';
import type { Block } from 'prismarine-block';
import { closestPoint, eyePosition } from './interaction-utils.js';

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
const MAX_FIND_BLOCKS_COUNT = 256;
const REPLACEABLE_PLANTS = new Set(['fern', 'short_grass', 'dead_bush']);
const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
// Native placement handles these items; their planted block names differ from
// inventory names. Registry block data alone is not an item-placement mapping.
const PLANTING_BLOCKS: Record<string, readonly string[]> = {
  wheat_seeds: ['wheat'],
  beetroot_seeds: ['beetroots'],
  carrot: ['carrots'],
  potato: ['potatoes'],
  melon_seeds: ['melon_stem'],
  pumpkin_seeds: ['pumpkin_stem'],
  torchflower_seeds: ['torchflower_crop'],
  pitcher_pod: ['pitcher_crop'],
  cocoa_beans: ['cocoa'],
  sweet_berries: ['sweet_berry_bush'],
  glow_berries: ['cave_vines'],
  bamboo: ['bamboo_sapling', 'bamboo']
};

function canReplaceForPlacement(block: Block): boolean {
  return AIR_BLOCKS.has(block.name) || REPLACEABLE_PLANTS.has(block.name) ||
    (block.name === 'snow' && Number(block.getProperties().layers) === 1);
}

interface FaceOption {
  direction: string;
  vector: Vec3;
}

export function registerBlockTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "place-block",
    "Place a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      faceDirection: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Direction to place against (default: 'down')")
    },
    async ({ x, y, z, faceDirection = 'down' }: { x: number, y: number, z: number, faceDirection?: FaceDirection }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const placePos = new Vec3(x, y, z).floored();
      ({ x, y, z } = placePos);

      const botPos = bot.entity.position.floored();
      if (placePos.equals(botPos) || placePos.equals(botPos.offset(0, 1, 0))) {
        return factory.createResponse(`You can't place a block where you're standing or one block above`);
      }

      const blockAtPos = bot.blockAt(placePos);

      if (!blockAtPos) throw new Error('Placement target is not loaded');
      if (!canReplaceForPlacement(blockAtPos)) throw new Error(`There's already a nonreplaceable block (${blockAtPos.name}) at (${x}, ${y}, ${z})`);
      const originalState = blockAtPos.stateId;
      const originalType = blockAtPos.type;
      const heldName = bot.heldItem?.name;
      if (!heldName) throw new Error('Hold a block item or plantable item before placing');
      const expectedNames = (PLANTING_BLOCKS[heldName] ?? [heldName])
        .filter(name => bot.registry.blocksByName[name] && !['water', 'lava'].includes(name));
      if (!expectedNames.length) throw new Error('Hold a block item or supported plantable item before placing; liquid/bucket placements are not supported');
      if (expectedNames.includes(blockAtPos.name)) throw new Error('Same-type replacement or snow-layer stacking is not supported');

      const possibleFaces: FaceOption[] = [
        { direction: 'down', vector: new Vec3(0, -1, 0) },
        { direction: 'north', vector: new Vec3(0, 0, -1) },
        { direction: 'south', vector: new Vec3(0, 0, 1) },
        { direction: 'east', vector: new Vec3(1, 0, 0) },
        { direction: 'west', vector: new Vec3(-1, 0, 0) },
        { direction: 'up', vector: new Vec3(0, 1, 0) }
      ];

      if (faceDirection !== 'down') {
        const specificFace = possibleFaces.find(face => face.direction === faceDirection);
        if (specificFace) {
          possibleFaces.unshift(possibleFaces.splice(possibleFaces.indexOf(specificFace), 1)[0]);
        }
      }

      for (const face of possibleFaces) {
        const referencePos = placePos.plus(face.vector);
        let referenceBlock = bot.blockAt(referencePos);

        if (referenceBlock && referenceBlock.boundingBox === 'block' && !canReplaceForPlacement(referenceBlock)) {
          const withinReach = () => {
            const eye = eyePosition(bot);
            return eye.distanceTo(closestPoint(eye, referencePos, referencePos.offset(1, 1, 1))) <=
              (bot.game.gameMode === 'creative' ? 5 : 4.5);
          };
          if (!bot.canSeeBlock(referenceBlock) || !withinReach()) {
            const goal = new goals.GoalNear(referencePos.x, referencePos.y, referencePos.z, 2);
            await safeGoto(bot, goal);
          }

          const currentTarget = bot.blockAt(placePos);
          if (!currentTarget || currentTarget.stateId !== originalState || currentTarget.type !== originalType ||
              !canReplaceForPlacement(currentTarget)) throw new Error('Placement target changed during approach; inspect before retrying');
          const botNow = bot.entity.position.floored();
          if (placePos.equals(botNow) || placePos.equals(botNow.offset(0, 1, 0))) throw new Error("You can't place a block where you're standing or one block above");
          referenceBlock = bot.blockAt(referencePos);
          if (!referenceBlock || referenceBlock.boundingBox !== 'block' || canReplaceForPlacement(referenceBlock) ||
              !withinReach() || !bot.canSeeBlock(referenceBlock)) throw new Error('Reference block is inaccessible after safe approach');
          if (bot.heldItem?.name !== heldName) throw new Error('Held block item changed during approach; equip it again before retrying');
          await bot.lookAt(placePos, true);

          try {
            await bot.placeBlock(referenceBlock, face.vector.scaled(-1));
          } catch (placeError) {
            const observed = bot.blockAt(placePos);
            throw new Error(`Native placement failed: ${String(placeError)}; target now ${observed?.name ?? 'unloaded'}. Possible partial effects are not rolled back; inspect before retrying`);
          }
          const placed = bot.blockAt(placePos);
          if (!placed || !expectedNames.includes(placed.name) ||
              (placed.type === originalType && placed.stateId === originalState)) {
            throw new Error(`Placement not confirmed at intended target (${x}, ${y}, ${z}): expected ${expectedNames.join(' or ')}, observed ${placed?.name ?? 'unloaded'}. Inspect before retrying`);
          }
          return factory.createResponse(`Placed ${placed.name} at (${x}, ${y}, ${z}) using ${face.direction} face`);
        }
      }

      throw new Error(`Failed to place block at (${x}, ${y}, ${z}): No suitable reference block found`);
    }
  );

  factory.registerTool(
    "dig-block",
    "Dig a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const blockPos = new Vec3(x, y, z).floored();
      let block = bot.blockAt(blockPos);

      if (!block || block.name === 'air') {
        throw new Error(`No block found at position (${x}, ${y}, ${z})`);
      }

      if (!bot.canDigBlock(block) || !hasReachableDigFace(bot, block)) {
        const goal = new DigApproachGoal(bot, blockPos);
        await safeGoto(bot, goal);
      }

      const currentBlock = bot.blockAt(blockPos);
      if (!currentBlock || currentBlock.stateId !== block.stateId || currentBlock.type !== block.type) {
        throw new Error('Target block changed during approach; inspect before digging');
      }
      block = currentBlock;
      if (!bot.canDigBlock(block) || !hasReachableDigFace(bot, block)) throw new Error('Target block has no reachable visible face for digging');
      const creative = bot.game.gameMode === 'creative';
      let tool: Item | null = null;
      let fastest = block.canHarvest(null) || creative ? block.digTime(null, creative, false, false) : Infinity;
      for (const item of bot.inventory.items()) {
        if (!creative && !block.canHarvest(item.type)) continue;
        const time = block.digTime(item.type, creative, false, false, item.enchants, bot.entity.effects);
        if (time < fastest) {
          fastest = time;
          tool = item;
        }
      }
      if (!Number.isFinite(fastest)) throw new Error(`No suitable harvesting tool available for ${block.name}`);
      if (tool) await bot.equip(tool, 'hand');
      else if (bot.heldItem && (!block.canHarvest(bot.heldItem.type) ||
        block.digTime(bot.heldItem.type, creative, false, false) > fastest)) {
        // Native unequip can toss the held stack when inventory is full.
        if (bot.inventory.firstEmptyInventorySlot() === null) throw new Error('Inventory is full; cannot safely empty the hand for digging');
        await bot.unequip('hand');
      }
      await bot.dig(block, true, block.shapes?.length === 0 ? 'auto' : 'raycast');
      return factory.createResponse(`Dug ${block.name} at (${x}, ${y}, ${z})`);
    }
  );

  factory.registerTool(
    "get-block-info",
    "Get information about a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const blockPos = new Vec3(x, y, z);
      const block = bot.blockAt(blockPos);

      if (!block) {
        return factory.createResponse(`No block information found at position (${x}, ${y}, ${z})`);
      }

      return factory.createResponse(`Found ${block.name} (type: ${block.type}) at position (${block.position.x}, ${block.position.y}, ${block.position.z})\n${JSON.stringify({
        stateId: block.stateId,
        properties: block.getProperties(),
        boundingBox: block.boundingBox,
        shapes: block.shapes
      })}`);
    }
  );

  factory.registerTool(
    "find-blocks",
    "Find one or more nearby blocks of a specific type",
    {
      blockType: z.string().describe("Type of block to find"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)"),
      count: z.coerce.number().int().positive().optional().describe("Maximum number of blocks to return (default: 1; values above 256 are clamped)")
    },
    async ({ blockType, maxDistance = 16, count = 1 }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const blocksByName = mcData.blocksByName;
      const normalizedCount = Math.min(count, MAX_FIND_BLOCKS_COUNT);

      if (!blocksByName[blockType]) {
        return factory.createResponse(`Unknown block type: ${blockType}`);
      }

      const blockId = blocksByName[blockType].id;

      if (normalizedCount === 1) {
        const block = bot.findBlock({
          matching: blockId,
          maxDistance: maxDistance
        });

        if (!block) {
          return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
        }

        return factory.createResponse(`Found ${blockType} at position (${block.position.x}, ${block.position.y}, ${block.position.z})`);
      }

      const blocks = bot.findBlocks({
        point: bot.entity.position,
        matching: blockId,
        maxDistance: maxDistance,
        count: normalizedCount
      });

      if (blocks.length === 0) {
        return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
      }

      const blocksList = blocks
        .map((block, i) => `${i + 1}. (${block.x}, ${block.y}, ${block.z})`)
        .join('\n');

      return factory.createResponse(`Found ${blocks.length} ${blockType} block(s) within ${maxDistance} blocks:\n${blocksList}`);
    }
  );
}