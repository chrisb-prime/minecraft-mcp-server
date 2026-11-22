import type { Bot } from 'mineflayer';
import type { Item } from 'prismarine-item';
import { sameItem } from './inventory-utils.js';
import { isDeepStrictEqual } from 'node:util';

const busy = new WeakSet<Bot>();

export function acquireInventoryOperation(bot: Bot): () => void {
  if (busy.has(bot)) throw new Error('Another crafting/cursor operation is in progress');
  if (bot.currentWindow) throw new Error('Close the current window before crafting or recovering the inventory cursor');
  busy.add(bot);
  return () => { busy.delete(bot); };
}

export async function withInventoryOperation<T>(bot: Bot, operation: () => Promise<T>): Promise<T> {
  const release = acquireInventoryOperation(bot);
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function syncInventory(bot: Bot): Promise<void> {
  if (bot.currentWindow) throw new Error('Inventory window changed during cursor/crafting operation');
  if (!bot.supportFeature('stateIdUsed') || !('_syncWindow' in bot) || typeof bot._syncWindow !== 'function') {
    throw new Error('Server-confirmed inventory synchronization is unavailable in this runtime');
  }
  // Installed Mineflayer's no-op drag-end with stale stateId requests a full
  // server snapshot including carriedItem, without dropping or picking items.
  await bot._syncWindow(bot.inventory);
  if (bot.currentWindow) throw new Error('Inventory window changed during synchronization');
}

export function cursorSnapshot(bot: Bot) {
  const describe = (item: Item | null) => item ? {
    name: item.name, count: item.count, stackSize: item.stackSize,
    type: item.type, metadata: item.metadata
  } : null;
  return {
    cursor: describe(bot.inventory.selectedItem),
    items: bot.inventory.slots.slice(bot.inventory.inventoryStart, bot.inventory.inventoryEnd)
      .flatMap((item, index) => item ? [{ slot: index + bot.inventory.inventoryStart, ...describe(item) }] : []),
    craftingGrid: bot.inventory.slots.slice(1, 5)
      .flatMap((item, index) => item ? [{ slot: index + 1, ...describe(item) }] : []),
    craftingResult: describe(bot.inventory.slots[0]),
    confirmation: 'Local inventory model; server-confirmed only when serverConfirmed is explicitly true'
  };
}

export function cursorCapacity(bot: Bot, item: Item): number {
  return bot.inventory.slots.slice(bot.inventory.inventoryStart, bot.inventory.inventoryEnd)
    .reduce((total, slot) => total + (!slot ? item.stackSize : sameItem(slot, item) ? Math.max(0, slot.stackSize - slot.count) : 0), 0);
}

export function inventoryState(bot: Bot) {
  const stack = (item: Item | null) => item ? structuredClone({
    type: item.type, metadata: item.metadata, nbt: item.nbt, count: item.count,
    components: (item as Item & { components?: unknown }).components,
    removedComponents: (item as Item & { removedComponents?: unknown }).removedComponents
  }) : null;
  return { slots: bot.inventory.slots.map(stack), cursor: stack(bot.inventory.selectedItem) };
}

export async function confirmInventoryChange(
  bot: Bot, previous: ReturnType<typeof inventoryState>, expected: ReturnType<typeof inventoryState>,
  ignoreRecipePreview = false
): Promise<void> {
  const comparable = (state: ReturnType<typeof inventoryState>) => {
    if (ignoreRecipePreview) state.slots[0] = null;
    return state;
  };
  await syncInventory(bot);
  if (isDeepStrictEqual(comparable(inventoryState(bot)), comparable(structuredClone(previous)))) await syncInventory(bot);
  if (!isDeepStrictEqual(comparable(inventoryState(bot)), comparable(structuredClone(expected)))) {
    throw new Error('Server did not confirm inventory change; attribution uncertain');
  }
}

export async function recoverCursor(bot: Bot): Promise<number> {
  await syncInventory(bot);
  const original = bot.inventory.selectedItem;
  if (!original) return 0;
  const requested = original.count;
  if (!Number.isSafeInteger(requested) || requested <= 0 || !Number.isSafeInteger(original.stackSize) || original.stackSize <= 0) {
    throw new Error('Invalid cursor stack size/count; no recovery click attempted');
  }
  if (cursorCapacity(bot, original) < requested) throw new Error('Insufficient compatible inventory capacity; cursor left untouched');
  let recovered = 0;
  try {
    while (bot.inventory.selectedItem) {
      const cursor = bot.inventory.selectedItem;
      if (!sameItem(cursor, original) || cursor.count !== requested - recovered) {
        throw new Error('Cursor changed concurrently');
      }
      const start = bot.inventory.inventoryStart;
      const end = bot.inventory.inventoryEnd;
      let slot = bot.inventory.slots.findIndex((item, index) => index >= start && index < end &&
        !!item && sameItem(item, cursor) && item.count < item.stackSize);
      if (slot < 0) slot = bot.inventory.slots.findIndex((item, index) => index >= start && index < end && !item);
      if (slot < 0) throw new Error('Inventory capacity changed during recovery');
      const dest = bot.inventory.slots[slot];
      const before = dest?.count ?? 0;
      const moved = Math.min(cursor.count, (dest?.stackSize ?? cursor.stackSize) - before);
      const snapshot = () => inventoryState(bot);
      const previous = snapshot();
      const expected = structuredClone(previous);
      expected.slots[slot] = { ...previous.cursor!, count: before + moved };
      expected.cursor = cursor.count > moved ? { ...previous.cursor!, count: cursor.count - moved } : null;
      await bot.clickWindow(slot, 0, 0);
      await syncInventory(bot);
      // Full inventory events carry no request ID. A previously queued response
      // can resolve native _syncWindow before this click's response. Only an
      // exact pre-click snapshot permits one more read; never repeat the click.
      if (isDeepStrictEqual(snapshot(), previous)) await syncInventory(bot);
      const actual = bot.inventory.slots[slot];
      const remaining = bot.inventory.selectedItem;
      if (!isDeepStrictEqual(snapshot(), expected) || !actual || !sameItem(actual, original) || actual.count !== before + moved ||
          (remaining?.count ?? 0) !== requested - recovered - moved ||
          (remaining && !sameItem(remaining, original))) {
        throw new Error('Server did not confirm cursor placement; attribution uncertain');
      }
      recovered += moved;
    }
    return recovered;
  } catch (error) {
    throw new Error(`${String(error)}; confirmed recovered ${recovered}/${requested}; snapshot ${JSON.stringify(cursorSnapshot(bot))}. No rollback or automatic retry`);
  }
}
