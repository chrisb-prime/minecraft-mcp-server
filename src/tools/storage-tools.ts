import { z } from 'zod';
import type { Bot, Chest } from 'mineflayer';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ToolFactory } from '../tool-factory.js';
import { safeGoto } from '../safe-navigation.js';
import { closestPoint, eyePosition, requireAwake } from './interaction-utils.js';
import { sameItem } from './inventory-utils.js';
import { log } from '../logger.js';

const coordinates = {
  x: z.coerce.number().finite().describe('Storage block X coordinate'),
  y: z.coerce.number().finite().describe('Storage block Y coordinate'),
  z: z.coerce.number().finite().describe('Storage block Z coordinate')
};
const transferSchema = {
  ...coordinates,
  itemName: z.string().trim().min(1).describe('Exact item name, for example oak_log'),
  count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('Exact quantity to transfer; may span stacks')
};
type Coordinates = { x: number; y: number; z: number };
type Transfer = Coordinates & { itemName: string; count: number };

function contents(chest: Chest) {
  return chest.slots.slice(0, chest.inventoryStart).flatMap((item, slot) =>
    item ? [{ slot, name: item.name, count: item.count, stackSize: item.stackSize }] : []);
}

function planTransfer(chest: Chest, itemName: string, count: number, deposit: boolean) {
  const sourceStart = deposit ? chest.inventoryStart : 0;
  const sourceEnd = deposit ? chest.inventoryEnd : chest.inventoryStart;
  const destStart = deposit ? 0 : chest.inventoryStart;
  const destEnd = deposit ? chest.inventoryStart : chest.inventoryEnd;
  const available = chest.slots.slice(sourceStart, sourceEnd)
    .reduce((sum, item) => sum + (item?.name === itemName ? item.count : 0), 0);
  if (available < count) throw new Error(`Insufficient ${itemName} in ${deposit ? 'inventory' : 'storage'}: requested ${count}, available ${available}`);
  const slots = chest.slots.map(item => item ? { ...item } : null);
  const plan: { source: number; dest: number; count: number; item: Item }[] = [];
  let remaining = count;
  for (let source = sourceStart; source < sourceEnd && remaining > 0; source++) {
    const item = slots[source];
    if (!item || item.name !== itemName) continue;
    const destinations = Array.from({ length: destEnd - destStart }, (_, index) => destStart + index)
      .sort((a, b) => Number(slots[b] !== null) - Number(slots[a] !== null));
    for (const dest of destinations) {
      if (remaining === 0 || item.count === 0) break;
      const target = slots[dest];
      if (target && !sameItem(target, item)) continue;
      const moved = Math.min(remaining, item.count, item.stackSize - (target?.count ?? 0));
      if (moved <= 0) continue;
      plan.push({ source, dest, count: moved, item: chest.slots[source]! });
      slots[dest] = { ...item, count: (target?.count ?? 0) + moved };
      item.count -= moved;
      remaining -= moved;
    }
  }
  if (remaining > 0) throw new Error(`Insufficient ${deposit ? 'storage' : 'inventory'} capacity for ${count} ${itemName}; no items transferred`);
  return plan;
}

export function registerStorageTools(factory: ToolFactory, getBot: () => Bot): void {
  const busy = new WeakSet<Bot>();
  async function withStorage<T>({ x, y, z }: Coordinates, chestOnly: boolean,
    operation: (chest: Chest, blockName: string) => Promise<T>): Promise<T> {
    const bot = getBot();
    const activeWindow = () => bot.currentWindow;
    if (busy.has(bot)) throw new Error('Another storage operation or pending storage opening is in progress');
    requireAwake(bot);
    if (activeWindow()) throw new Error('Close the current inventory window before using storage');
    if (bot.getControlState('sneak')) throw new Error('Cannot open storage while sneaking');
    if (bot.inventory.selectedItem) throw new Error('Inventory cursor is occupied');
    const position = new Vec3(x, y, z).floored();
    const target = () => {
      const block = bot.blockAt(position);
      if (!block || (block.name !== 'chest' && (chestOnly || block.name !== 'hopper'))) {
        throw new Error(`No loaded ${chestOnly ? 'normal chest' : 'supported chest or hopper'} at ${position}`);
      }
      return block;
    };
    let block = target();
    const originalName = block.name;
    let chest: Chest | undefined;
    let openedWindow: Bot['currentWindow'] = null;
    const onWindowOpen = (window: NonNullable<Bot['currentWindow']>) => { openedWindow = window; };
    const closeUnexpectedWindow = () => {
      if (openedWindow && activeWindow() === openedWindow) bot.closeWindow(openedWindow);
    };
    let openingTimedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome!: { result: T } | { error: unknown };
    busy.add(bot);
    try {
      const inReach = () => eyePosition(bot).distanceTo(
        closestPoint(eyePosition(bot), position, position.offset(1, 1, 1))
      ) <= (bot.game.gameMode === 'creative' ? 5 : 4.5);
      if (!inReach()) await safeGoto(bot, new pathfinderPkg.goals.GoalNear(position.x, position.y, position.z, 3));
      requireAwake(bot);
      block = target();
      if (block.name !== originalName) throw new Error('Storage block changed during approach; inspect before retrying');
      if (!inReach() || !bot.canSeeBlock(block)) throw new Error('Storage is inaccessible: out of reach or not visible after safe approach');
      if (activeWindow()) throw new Error('Another inventory window opened during chest approach');
      if (bot.getControlState('sneak')) throw new Error('Cannot open storage while sneaking');
      // Native openContainer has no opening timeout. Retain the lock until a late
      // window settles, and close that window instead of transferring afterward.
      bot.once('windowOpen', onWindowOpen);
      const opening = bot.openContainer(block).then(window => {
        if (openingTimedOut) {
          try { if (activeWindow() === window) window.close(); }
          catch (error) { log('error', `Failed to close late storage window after timeout: ${String(error)}`); }
          finally { busy.delete(bot); }
          throw new Error('Late storage window closed after opening timed out');
        }
        return window;
      }, error => {
        if (openingTimedOut) {
          try { closeUnexpectedWindow(); }
          catch (closeError) { log('error', `Failed to close rejected late storage window: ${String(closeError)}`); }
          finally { busy.delete(bot); }
        }
        throw error;
      }).finally(() => bot.removeListener('windowOpen', onWindowOpen));
      chest = await Promise.race([opening, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          openingTimedOut = true;
          reject(new Error('Storage opening timed out after 5000ms; it may be blocked or denied by the server. No transfer attempted; further storage calls wait for this opening to settle or a reconnect'));
        }, 5000);
      })]);
      clearTimeout(timer);
      bot.removeListener('windowOpen', onWindowOpen);
      const validLayout = block.name === 'hopper'
        ? chest.inventoryStart === 5 && chest.type === 'minecraft:hopper'
        : [27, 54].includes(chest.inventoryStart) && typeof chest.type === 'string' &&
          /^(minecraft:)?(generic_9x[36]|chest|container)$/.test(chest.type);
      if (!validLayout ||
          chest.inventoryEnd - chest.inventoryStart !== 36 ||
          chest.slots.length < chest.inventoryEnd) {
        throw new Error('Server opened an unexpected window; expected matching chest or 5-slot hopper storage');
      }
      if (activeWindow() !== chest || chest.selectedItem) throw new Error('Storage window is no longer active or its cursor is occupied');
      outcome = { result: await operation(chest, block.name) };
    } catch (error) {
      outcome = { error: new Error(`${String(error)}${chest ? `; storage snapshot: ${JSON.stringify(contents(chest))}; cursor before close: ${JSON.stringify(chest.selectedItem ? { name: chest.selectedItem.name, count: chest.selectedItem.count } : null)}` : ''}`) };
    } finally {
      clearTimeout(timer);
      if (!openingTimedOut) {
        busy.delete(bot);
        bot.removeListener('windowOpen', onWindowOpen);
      }
      if (chest && activeWindow() === chest) {
        try { chest.close(); }
        catch (error) {
          outcome = { error: new Error(`${'error' in outcome ? String(outcome.error) : `Operation finished: ${JSON.stringify(outcome.result)}`}; failed to close storage window: ${String(error)}`) };
        }
      } else if (!openingTimedOut) {
        try { closeUnexpectedWindow(); }
        catch (error) {
          outcome = { error: new Error(`${'error' in outcome ? String(outcome.error) : `Operation finished: ${JSON.stringify(outcome.result)}`}; failed to close unexpected storage window: ${String(error)}`) };
        }
      }
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.result;
  }

  for (const chestOnly of [false, true]) {
    factory.registerTool(chestOnly ? 'chest-status' : 'container-status',
      `Inspect ${chestOnly ? 'a normal single/double chest' : 'supported normal chest or hopper storage'} at explicit coordinates; opens/closes its window; contents are a snapshot`,
      coordinates, async (args: Coordinates) => withStorage(args, chestOnly, async (chest, blockName) => factory.createResponse(JSON.stringify({
      ...(!chestOnly ? { block: blockName, snapshotOnly: true, automaticTransfersPossible: true } : {}),
      position: new Vec3(args.x, args.y, args.z).floored(), slotCount: chest.inventoryStart,
      emptySlots: chest.slots.slice(0, chest.inventoryStart).filter(item => !item).length,
      items: contents(chest)
    }))));

    for (const deposit of [true, false]) {
    factory.registerTool(deposit ? (chestOnly ? 'deposit-chest' : 'deposit-container') : (chestOnly ? 'withdraw-chest' : 'withdraw-container'),
      `Transfer an exact item name and quantity ${deposit ? 'into' : 'from'} ${chestOnly ? 'a normal chest' : 'supported normal chest or hopper storage'}; partial or concurrent changes fail explicitly`,
      transferSchema, async (args: Transfer) => withStorage(args, chestOnly, async (chest, blockName) => {
        const bot = getBot();
        const sourceStart = deposit ? chest.inventoryStart : 0;
        const sourceEnd = deposit ? chest.inventoryEnd : chest.inventoryStart;
        const destStart = deposit ? 0 : chest.inventoryStart;
        const destEnd = deposit ? chest.inventoryStart : chest.inventoryEnd;
        const countIn = (start: number, end: number) => chest.slots.slice(start, end)
          .reduce((sum, item) => sum + (item?.name === args.itemName ? item.count : 0), 0);
        const beforeSource = countIn(sourceStart, sourceEnd);
        const beforeDest = countIn(destStart, destEnd);
        let nativeCompleted = 0;
        let verifiedTransferred = 0;
        let concurrentUpdate = false;
        let active: { slot: number; item: Item; before: number; count: number; pickedUp: boolean } | null = null;
        const onUpdate = (slot: number, oldItem: Item | null, newItem: Item | null) => {
          if (slot >= chest.inventoryStart) return;
          if ((!oldItem && !newItem) || (oldItem && newItem && sameItem(oldItem, newItem) && oldItem.count === newItem.count)) return;
          if (!active || slot !== active.slot) { concurrentUpdate = true; return; }
          if (deposit) {
            if (!newItem || !sameItem(newItem, active.item) || (oldItem && !sameItem(oldItem, active.item)) ||
                newItem.count < Math.max(active.before, oldItem?.count ?? 0) ||
                newItem.count > active.before + active.count) concurrentUpdate = true;
          } else if (!active.pickedUp && !newItem && oldItem && sameItem(oldItem, active.item) && oldItem.count === active.before) {
            active.pickedUp = true;
          } else if (!(active.pickedUp && !oldItem && newItem && sameItem(newItem, active.item) && newItem.count === active.before - active.count)) {
            concurrentUpdate = true;
          }
        };
        chest.on('updateSlot', onUpdate);
        try {
          const plan = planTransfer(chest, args.itemName, args.count, deposit);
          for (const step of plan) {
            if (concurrentUpdate) throw new Error('Storage changed concurrently; transfer attribution is uncertain');
            if (bot.currentWindow !== chest || chest.selectedItem) throw new Error('Storage closed or cursor occupied during transfer');
            const source = chest.slots[step.source];
            const dest = chest.slots[step.dest];
            if (!source || !sameItem(source, step.item) || source.count < step.count ||
                (dest && !sameItem(dest, step.item)) || (dest?.count ?? 0) + step.count > step.item.stackSize) {
              throw new Error('Storage/inventory slots changed during transfer');
            }
            const sourceCount = source.count;
            const destCount = dest?.count ?? 0;
            active = { slot: deposit ? step.dest : step.source, item: step.item,
              before: deposit ? destCount : sourceCount, count: step.count, pickedUp: false };
            // Slot-bounded native transfer avoids mixing custom-item variants and
            // permits withdrawal into a partial stack even without an empty slot.
            await bot.transfer({ window: chest, itemType: source.type, metadata: source.metadata,
              count: step.count, sourceStart: step.source, sourceEnd: step.source + 1,
              destStart: step.dest, destEnd: step.dest + 1 });
            nativeCompleted += step.count;
            active = null;
            if (concurrentUpdate) throw new Error('Storage changed concurrently; transfer attribution is uncertain');
            if (bot.currentWindow !== chest || chest.selectedItem ||
                (chest.slots[step.source]?.count ?? 0) !== sourceCount - step.count ||
                (chest.slots[step.dest]?.count ?? 0) !== destCount + step.count ||
                !sameItem(chest.slots[step.dest]!, step.item)) {
              throw new Error('Native transfer was not fully confirmed');
            }
            verifiedTransferred += step.count;
          }
          const gained = countIn(destStart, destEnd) - beforeDest;
          const removed = beforeSource - countIn(sourceStart, sourceEnd);
          if (gained !== args.count || removed !== args.count) throw new Error('Inventory/storage totals changed unexpectedly');
          return factory.createResponse(JSON.stringify({ itemName: args.itemName, requested: args.count,
            transferred: verifiedTransferred, direction: deposit ? 'deposit' : 'withdraw',
            ...(chestOnly ? { remainingChest: contents(chest) } : {
              block: blockName, nativeCompleted, remainingStorage: contents(chest), snapshotOnly: true,
              confirmation: 'Native calls and observed slot changes; contents may subsequently move automatically'
            }) }));
        } catch (error) {
          throw new Error(`${String(error)}; partial effects: ${JSON.stringify({
            itemName: args.itemName, requested: args.count,
            nativeCompleted, verifiedTransferred, concurrentUpdate,
            sourceRemoved: beforeSource - countIn(sourceStart, sourceEnd),
            destinationGained: countIn(destStart, destEnd) - beforeDest
          })}. Already transferred items are not rolled back; concurrent changes cannot be attributed to this tool`);
        } finally {
          chest.removeListener('updateSlot', onUpdate);
        }
      }));
    }
  }
}
