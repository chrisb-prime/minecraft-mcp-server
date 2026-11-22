import { z } from 'zod';
import { Vec3 } from 'vec3';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import type { Item } from 'prismarine-item';
import type { ToolFactory } from '../tool-factory.js';
import { closestPoint, eyePosition, requireAwake } from './interaction-utils.js';
import { sameItem } from './inventory-utils.js';
import { acquireInventoryOperation, syncInventory } from './cursor-utils.js';
import { log } from '../logger.js';

type Window = NonNullable<Bot['currentWindow']>;
interface Recipe { input: { ids?: number[]; name?: string }; slotDisplay: { type: string; data?: unknown } }
interface ServerRecipes { recipes?: Recipe[]; tags?: Map<string, number[]> }
const serverRecipes = new WeakMap<Bot, ServerRecipes>();
const pendingOpenings = new WeakSet<Bot>();

// Register before login: Mineflayer has no stonecutter recipe tracker.
export function trackStonecutterRecipes(bot: Bot): void {
  const state: ServerRecipes = {};
  serverRecipes.set(bot, state);
  bot._client.on('declare_recipes', (packet: { stoneCutterRecipes?: Recipe[] }) => {
    state.recipes = packet.stoneCutterRecipes;
  });
  bot._client.on('tags', (packet: { tags: { tagType: string; tags: { tagName: string; entries: number[] }[] }[] }) => {
    const items = packet.tags.find(group => group.tagType === 'minecraft:item');
    if (items) state.tags = new Map(items.tags.map(tag => [tag.tagName, tag.entries]));
  });
  bot._client.on('packet', (_packet, meta) => {
    if (meta.name === 'start_configuration') { state.recipes = undefined; state.tags = undefined; }
  });
  bot.once('end', () => { serverRecipes.delete(bot); });
}

function itemClass(bot: Bot): typeof Item {
  return (createRequire(import.meta.url)('prismarine-item') as (registry: Bot['registry']) => typeof Item)(bot.registry);
}

function recipesFor(bot: Bot, inputItem: string) {
  if (bot.version !== '26.1') throw new Error('Stonecutter protocol is validated for Java 26.1 only');
  const input = bot.registry.itemsByName[inputItem];
  if (!input) throw new Error(`Unknown exact input item ${inputItem}`);
  const state = serverRecipes.get(bot);
  if (!Array.isArray(state?.recipes)) throw new Error('Server stonecutter recipes unavailable; no static recipe indices or fallback assumed');
  const Items = itemClass(bot);
  const visible = state.recipes.filter(recipe => {
    const ids = recipe.input?.ids ?? (recipe.input?.name ? state.tags?.get(recipe.input.name) : undefined);
    if (!Array.isArray(ids) || !ids.every(id => Number.isInteger(id) && id >= 0)) {
      throw new Error('Unresolved/malformed server recipe ingredient or item tag; menu indices cannot be proven');
    }
    return ids.includes(input.id);
  });
  return visible.map((recipe, index) => {
    const display = recipe.slotDisplay;
    let output: Item | null = null;
    if (display?.type === 'item' && typeof display.data === 'number' && bot.registry.items[display.data]) {
      output = new Items(display.data, 1);
    } else if (display?.type === 'item_stack' && display.data && typeof display.data === 'object') {
      output = Items.fromNotch(display.data);
    }
    if (output && (!output.name || !Number.isSafeInteger(output.count) || output.count <= 0 || output.count > output.stackSize)) {
      throw new Error('Invalid server stonecutter output stack');
    }
    return { index, output, display };
  });
}

const coordinates = {
  x: z.coerce.number().int().describe('Explicit stonecutter block X'),
  y: z.coerce.number().int().describe('Explicit stonecutter block Y'),
  z: z.coerce.number().int().describe('Explicit stonecutter block Z')
};
type Coordinates = { x: number; y: number; z: number };
type Cut = Coordinates & { inputItem: string; outputItem: string; count: number; timeoutMs: number };

function target(bot: Bot, args: Coordinates) {
  requireAwake(bot);
  const position = new Vec3(args.x, args.y, args.z);
  const block = bot.blockAt(position);
  if (block?.name !== 'stonecutter') throw new Error(`No loaded stonecutter at ${position}`);
  const eye = eyePosition(bot);
  if (eye.distanceTo(closestPoint(eye, position, position.offset(1, 1, 1))) >
      (bot.game.gameMode === 'creative' ? 5 : 4.5) || !bot.canSeeBlock(block)) {
    throw new Error('Stonecutter is out of reach or obstructed; approach explicitly first');
  }
  return block;
}

function describe(window: Window | null) {
  const item = (stack: Item | null) => stack ? { name: stack.name, count: stack.count } : null;
  return window ? { windowId: window.id, input: item(window.slots[0]), output: item(window.slots[1]),
    cursor: item(window.selectedItem), serverConfirmed: false } : null;
}

type Stack = Pick<Item, 'type' | 'metadata' | 'nbt' | 'count'> & { components?: unknown; removedComponents?: unknown };
function copy(item: Stack | null): Stack | null {
  return item ? { ...item } : null;
}
function equal(a: Stack | null, b: Stack | null): boolean {
  return a === b || (!!a && !!b && sameItem(a, b) && a.count === b.count);
}

export function registerStonecutterTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool('stonecutter-recipes', 'Inspect server-synced stonecutter menu recipes for an exact input; no opening or item movement',
    { ...coordinates, inputItem: z.string().trim().min(1) },
    async (args: Coordinates & { inputItem: string }) => {
      const bot = getBot();
      target(bot, args);
      return factory.createResponse(JSON.stringify({ inputItem: args.inputItem, serverSynced: true,
        recipes: recipesFor(bot, args.inputItem).map(recipe => ({ index: recipe.index,
          outputItem: recipe.output?.name ?? null, outputCount: recipe.output?.count ?? null,
          supported: !!recipe.output, display: recipe.display })) }));
    });
  factory.registerTool('stonecut', 'Make an exact output quantity at an explicit stonecutter using server recipes and confirmed inventory; errors report partial completion, never retry',
    { ...coordinates, inputItem: z.string().trim().min(1), outputItem: z.string().trim().min(1),
      count: z.number().int().positive().max(4096).describe('Exact OUTPUT item count; must be a multiple of recipe yield'),
      timeoutMs: z.number().int().min(1000).max(300000).default(120000).describe('Deadline for starting steps; in-flight native confirmations remain bounded by native 20s timeout') },
    async (args: Cut) => {
      const bot = getBot();
      if (pendingOpenings.has(bot)) throw new Error('A stonecutter opening is still pending; wait for settlement or reconnect');
      const release = acquireInventoryOperation(bot);
      try {
        const block = target(bot, args);
        if (bot.getControlState('sneak') || bot.usingHeldItem) throw new Error('Finish sneaking/using items before stonecutting');
        const recipes = recipesFor(bot, args.inputItem);
        const matches = recipes.filter(recipe => recipe.output?.name === args.outputItem);
        if (matches.length !== 1) throw new Error('No unique supported server recipe for the requested output; inspect stonecutter-recipes');
        const recipe = matches[0];
        const output = recipe.output!;
        const input = new (itemClass(bot))(bot.registry.itemsByName[args.inputItem].id, 1);
        if (args.count % output.count !== 0) throw new Error(`Requested output count must be a multiple of recipe yield ${output.count}`);
        const iterations = args.count / output.count;
        if (sameItem(input, output)) throw new Error('Input and output identity must differ for exact attribution');
        await syncInventory(bot);
        if (bot.inventory.selectedItem) throw new Error('Inventory cursor is occupied; inspect/recover explicitly first');
        const countInventory = (item: Item) => bot.inventory.items()
          .reduce((sum, stack) => sum + (sameItem(stack, item) ? stack.count : 0), 0);
        const initialInput = countInventory(input);
        const initialOutput = countInventory(output);
        const available = bot.inventory.items().reduce((sum, item) => sum + (sameItem(item, input) ? item.count : 0), 0);
        if (available < iterations) throw new Error(`Insufficient ordinary ${args.inputItem}: need ${iterations}, available ${available}; custom stacks are not consumed`);
        // Reserve the full output before spending ingredients; never rely on freed input slots.
        const capacity = bot.inventory.slots.slice(bot.inventory.inventoryStart, bot.inventory.inventoryEnd)
          .reduce((sum, item) => sum + (!item ? output.stackSize : sameItem(item, output) ? Math.max(0, item.stackSize - item.count) : 0), 0);
        if (capacity < args.count) throw new Error('Insufficient compatible inventory capacity; no ingredients loaded');
        let window: Window | null = null;
        let completed = 0;
        let consumed = 0;
        let openingTimedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = Date.now() + args.timeoutMs;
        let closeAttempted = false;
        const closeEmpty = async () => {
          if (closeAttempted || !window || bot.currentWindow !== window) return;
          closeAttempted = true;
          if (window.type !== 'minecraft:stonecutter' || window.selectedItem || bot.inventory.selectedItem ||
              window.slots[0] || window.slots[1]) {
            throw new Error('Stonecutter/window contains items or cursor; left open to avoid return/drop effects');
          }
          await bot.closeWindow(window);
        };
        const onOpen = (opened: Window) => { window ??= opened; };
        bot.once('windowOpen', onOpen);
        const opening = Promise.resolve().then(() => bot.openBlock(block));
        pendingOpenings.add(bot);
        try {
          window = await Promise.race([opening, new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              openingTimedOut = true;
              reject(new Error('Stonecutter opening timed out after 5 seconds; no ingredients loaded'));
            }, 5000);
          })]);
          clearTimeout(timer);
          pendingOpenings.delete(bot);
          if (window.type !== 'minecraft:stonecutter' || window.inventoryStart !== 2 ||
              window.inventoryEnd !== 38 || bot.currentWindow !== window) throw new Error('Unexpected stonecutter window/layout');
          const owned = window;
          const check = () => {
            requireAwake(bot);
            if (Date.now() >= deadline) throw new Error('Stonecutting deadline reached; no further consuming steps started');
            if (bot.currentWindow !== owned || !bot.entity.isValid) throw new Error('Stonecutter closed/replaced or bot disconnected');
            target(bot, args);
            if (recipesFor(bot, args.inputItem)[recipe.index]?.display !== recipe.display) {
              throw new Error('Server recipes changed during operation');
            }
          };
          const sync = async () => {
            check();
            if (!('_syncWindow' in bot) || typeof bot._syncWindow !== 'function') throw new Error('Native window synchronization unavailable');
            await bot._syncWindow(owned);
            check();
          };
          await sync();
          if (owned.selectedItem || owned.slots[0] || owned.slots[1]) throw new Error('Stonecutter not empty; no items moved');
          const assertState = (slots: (Stack | null)[], cursor: Stack | null) => {
            if (!equal(owned.selectedItem, cursor) || slots.some((slot, index) => !equal(slot, owned.slots[index]))) {
              const mismatchedSlots = slots.flatMap((slot, index) => equal(slot, owned.slots[index]) ? [] : [index]);
              throw new Error(`Server did not confirm exact slot/cursor changes (slots ${mismatchedSlots.join(',')}; expected cursor ${cursor?.count ?? 0}, observed ${owned.selectedItem?.count ?? 0}); attribution uncertain`);
            }
          };
          const click = async (slot: number, button: number, expected: (Stack | null)[], cursor: Stack | null) => {
            check();
            await bot.clickWindow(slot, button, 0);
            await sync();
            assertState(expected, cursor);
          };
          for (let n = 0; n < iterations; n++) {
            check();
            if (owned.selectedItem || owned.slots[0] || owned.slots[1]) throw new Error('Unexpected input/output/cursor between cuts');
            const source = owned.slots.findIndex((item, slot) => slot >= owned.inventoryStart &&
              slot < owned.inventoryEnd && !!item && sameItem(item, input));
            if (source < 0) throw new Error('Input inventory changed');
            const stack = copy(owned.slots[source])!;
            let expected = owned.slots.map(copy);
            expected[source] = null;
            await click(source, 0, expected, stack);
            expected = owned.slots.map(copy);
            expected[0] = { ...stack, count: 1 };
            const remainder = stack.count > 1 ? { ...stack, count: stack.count - 1 } : null;
            await click(0, 1, expected, remainder);
            if (remainder) {
              expected = owned.slots.map(copy);
              expected[source] = remainder;
              await click(source, 0, expected, null);
            }
            // Container-button packet is named enchant_item in minecraft-protocol.
            check();
            const beforeSelection = owned.slots.map(copy);
            bot._client.write('enchant_item', { windowId: owned.id, enchantment: recipe.index });
            let ready = false;
            const selectionDeadline = Math.min(deadline, Date.now() + 5000);
            while (!ready) {
              await sync();
              ready = equal(owned.slots[1], output);
              if (!ready && Date.now() >= selectionDeadline) throw new Error('Server did not provide the requested selected recipe output');
              if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
            }
            beforeSelection[1] = copy(output);
            assertState(beforeSelection, null);
            let dest = owned.slots.findIndex((item, slot) => slot >= owned.inventoryStart &&
              slot < owned.inventoryEnd && !!item && sameItem(item, output) && item.count + output.count <= item.stackSize);
            if (dest < 0) dest = owned.slots.findIndex((item, slot) => slot >= owned.inventoryStart && slot < owned.inventoryEnd && !item);
            if (dest < 0) throw new Error('Output capacity changed; no result taken');
            expected = owned.slots.map(copy);
            expected[0] = null;
            expected[1] = null;
            await click(1, 0, expected, output);
            consumed++;
            expected = owned.slots.map(copy);
            expected[dest] = { ...output, count: (expected[dest]?.count ?? 0) + output.count };
            await click(dest, 0, expected, null);
            completed += output.count;
          }
          await closeEmpty();
          await syncInventory(bot);
          if (bot.inventory.selectedItem) throw new Error('Cursor not empty after final server inventory confirmation');
          if (countInventory(input) !== initialInput - consumed || countInventory(output) !== initialOutput + completed) {
            throw new Error('Final server player inventory did not confirm exact consumption and accessible output');
          }
          return factory.createResponse(JSON.stringify({ inputItem: args.inputItem, outputItem: args.outputItem,
            requested: args.count, collected: completed, consumed, recipeIndex: recipe.index, serverConfirmed: true }));
        } catch (error) {
          let cleanup = '';
          if (!openingTimedOut) {
            try { await closeEmpty(); } catch (closeError) { cleanup = `; cleanup: ${String(closeError)}`; }
          }
          throw new Error(`${String(error)}; previously confirmed accessible output ${completed}/${args.count}, confirmed input consumed ${consumed}; snapshot ${JSON.stringify(describe(window))}${cleanup}. No rollback or automatic retry; inspect before further crafting`);
        } finally {
          clearTimeout(timer);
          if (openingTimedOut) {
            // Do not cancel/release a native opening and then mistake its late window for another operation.
            void opening.then(opened => { window ??= opened; return closeEmpty(); }, closeEmpty)
              .catch(error => log('warn', `Late stonecutter cleanup failed: ${String(error)}`))
              .finally(() => { pendingOpenings.delete(bot); bot.removeListener('windowOpen', onOpen); release(); });
          } else {
            pendingOpenings.delete(bot);
            bot.removeListener('windowOpen', onOpen);
          }
        }
      } finally {
        if (!pendingOpenings.has(bot)) release();
      }
    });
}
