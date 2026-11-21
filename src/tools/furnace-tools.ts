import { z } from "zod";
import mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { sameItem } from './inventory-utils.js';

const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker']);
const coordinates = {
  x: z.coerce.number().finite().describe("X coordinate"),
  y: z.coerce.number().finite().describe("Y coordinate"),
  z: z.coerce.number().finite().describe("Z coordinate")
};

function describeItem(item: Item | null) {
  return item ? { name: item.name, count: item.count } : null;
}

function furnaceState(furnace: mineflayer.Furnace) {
  const available = (value: number) => Number.isFinite(value) ? value : null;
  return {
    input: describeItem(furnace.inputItem()),
    fuel: describeItem(furnace.fuelItem()),
    output: describeItem(furnace.outputItem()),
    burnFraction: available(furnace.fuel),
    progressFraction: available(furnace.progress)
  };
}

async function collectOutput(furnace: mineflayer.Furnace): Promise<{ name: string; count: number }> {
  const output = furnace.outputItem();
  if (!output) throw new Error('No cooked output available');
  const { name, count, stackSize } = output;
  if (furnace.selectedItem) throw new Error('Inventory cursor is occupied');
  const slots = furnace.slots.slice(furnace.inventoryStart, furnace.inventoryEnd);
  const capacity = slots.reduce((total, item) => total + (
    !item ? stackSize : sameItem(item, output) ? Math.max(0, item.stackSize - item.count) : 0
  ), 0);
  // Mineflayer takeOutput uses putAway, which can drop overflow. Check first.
  const requiredCapacity = furnace.inputItem() ? stackSize : count;
  if (capacity < requiredCapacity) throw new Error(`Inventory cannot hold ${requiredCapacity} ${name}${requiredCapacity > count ? ' (reserve for cooking output)' : ''}; output left in furnace`);
  const inventoryCount = () => furnace.slots.slice(furnace.inventoryStart, furnace.inventoryEnd)
    .reduce((total, item) => total + (item && sameItem(item, output) ? item.count : 0), 0);
  const before = inventoryCount();
  await furnace.takeOutput();
  const received = inventoryCount() - before;
  if (received < count) throw new Error(`Output transfer not fully confirmed: expected at least ${count} ${name}, inventory gained ${received}; inspect furnace and inventory`);
  return { name, count: received };
}

export function registerFurnaceTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  let busy = false;
  async function withFurnace<T>(x: number, y: number, z: number,
    operation: (furnace: mineflayer.Furnace, blockName: string) => Promise<T>): Promise<T> {
    if (busy) throw new Error('Another furnace operation is in progress');
    ({ x, y, z } = coerceCoordinates(x, y, z));
    const bot = getBot();
    const block = bot.blockAt(new Vec3(x, y, z).floored());
    if (!block || !FURNACE_BLOCKS.has(block.name)) throw new Error(`No furnace block found at (${x}, ${y}, ${z})`);
    if (bot.currentWindow) throw new Error('Close the current inventory window before using a furnace');
    busy = true;
    try {
      let furnace: mineflayer.Furnace | undefined;
      let outcome: { result: T } | { error: unknown };
      try {
        furnace = await bot.openFurnace(block);
        outcome = { result: await operation(furnace, block.name) };
      } catch (error) {
        outcome = { error };
      }
      if (furnace) {
        try {
          furnace.close();
        } catch (error) {
          outcome = { error: new Error(`${'error' in outcome ? `${String(outcome.error)}; ` : ''}Failed to close furnace: ${String(error)}`) };
        }
      }
      if ('error' in outcome) throw outcome.error;
      return outcome.result;
    } finally {
      busy = false;
    }
  }

  factory.registerTool('furnace-status', 'Inspect input, fuel, output and cooking progress without loading or collecting items',
    coordinates, async ({ x, y, z }: { x: number; y: number; z: number }) =>
      withFurnace(x, y, z, async (furnace, blockName) =>
        factory.createResponse(JSON.stringify({ block: blockName, ...furnaceState(furnace) }))));

  factory.registerTool('retrieve-furnace-output', 'Collect the currently cooked output only; does not add input or fuel or wait for further cooking',
    coordinates, async ({ x, y, z }: { x: number; y: number; z: number }) =>
      withFurnace(x, y, z, async (furnace) => {
        try {
          const taken = await collectOutput(furnace);
          return factory.createResponse(JSON.stringify({ retrieved: taken, remaining: furnaceState(furnace) }));
        } catch (error) {
          throw new Error(`${String(error)}; remaining: ${JSON.stringify(furnaceState(furnace))}`);
        }
      }));

  factory.registerTool(
    "smelt-item",
    "Smelt items using a furnace-like block",
    {
      ...coordinates,
      inputItem: z.string().trim().min(1).describe("Name of item to smelt"),
      inputCount: z.number().int().positive().optional().describe("Amount of input to smelt (default: 1)"),
      fuelItem: z.string().trim().min(1).describe("Name of fuel item"),
      fuelCount: z.number().int().positive().optional().describe("Amount of fuel to use (default: 1)"),
      takeOutput: z.boolean().optional().describe("Collect the whole loaded batch (default: true); false only loads items for background cooking"),
      timeoutMs: z.number().int().positive().max(300000).optional().describe("Timeout collecting the whole batch in ms (default: 60000; maximum: 300000)")
    },
    async ({
      x,
      y,
      z,
      inputItem,
      inputCount = 1,
      fuelItem,
      fuelCount = 1,
      takeOutput = true,
      timeoutMs = 60000
    }: {
      x: number;
      y: number;
      z: number;
      inputItem: string;
      inputCount?: number;
      fuelItem: string;
      fuelCount?: number;
      takeOutput?: boolean;
      timeoutMs?: number;
    }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const input = items.find((item) => item.name.includes(inputItem.toLowerCase()));
      if (!input) {
        throw new Error(`Couldn't find any item matching '${inputItem}' in inventory`);
      }

      const fuel = items.find((item) => item.name.includes(fuelItem.toLowerCase()));
      if (!fuel) {
        throw new Error(`Couldn't find any fuel item matching '${fuelItem}' in inventory`);
      }

      const resolvedInputCount = Math.min(inputCount, input.count);
      const resolvedFuelCount = Math.min(fuelCount, fuel.count);

      if (input === fuel && resolvedInputCount + resolvedFuelCount > input.count) {
        throw new Error('Not enough inventory items to supply both input and fuel');
      }
      return withFurnace(x, y, z, async (furnace) => {
        let loaded = false;
        let fuelAdded = false;
        const collected: { name: string; count: number }[] = [];
        let closed = false;
        const onClose = () => { closed = true; };
        furnace.on('close', onClose);
        try {
          const existingInput = furnace.inputItem();
          if (existingInput) {
            throw new Error(`Furnace input slot is occupied by ${existingInput.name}; finish or remove it before starting an isolated batch`);
          }
          if (furnace.outputItem()) {
            throw new Error('Furnace has pre-existing output; use retrieve-furnace-output first');
          }

          const existingFuel = furnace.fuelItem();
          if (existingFuel && !sameItem(existingFuel, fuel)) {
            throw new Error(`Furnace fuel slot is occupied by ${existingFuel.name}`);
          }
          if (resolvedInputCount > input.stackSize || (existingFuel?.count ?? 0) + resolvedFuelCount > fuel.stackSize) {
            throw new Error('Requested input or fuel does not fit its furnace slot');
          }

          await furnace.putFuel(fuel.type, fuel.metadata ?? null, resolvedFuelCount);
          fuelAdded = true;
          await furnace.putInput(input.type, input.metadata ?? null, resolvedInputCount);
          loaded = true;

          if (!takeOutput) {
            return factory.createResponse(
              `Loaded ${resolvedInputCount}/${inputCount} ${input.name} with ${resolvedFuelCount}/${fuelCount} ${fuel.name}; cooking is not confirmed. Use furnace-status and retrieve-furnace-output.`
            );
          }
          const deadline = Date.now() + timeoutMs;
          let emptySince: number | null = null;
          let previousRemaining = resolvedInputCount;
          let batchOutput: Item | null = null;
          // Observe input depletion rather than assume every recipe yields one output.
          while (true) {
            if (closed || bot.currentWindow !== furnace) throw new Error('Furnace window closed while collecting');
            if (Date.now() >= deadline) throw new Error(`Batch collection timed out after ${timeoutMs}ms (fuel may be insufficient or recipe unsupported)`);
            const remainingInput = furnace.inputItem();
            const remainingCount = remainingInput?.count ?? 0;
            if ((remainingInput && !sameItem(remainingInput, input)) || remainingCount > previousRemaining) {
              throw new Error('Furnace input changed externally; batch ownership cannot be confirmed');
            }
            previousRemaining = remainingCount;
            const output = furnace.outputItem();
            if (output) {
              if (batchOutput && !sameItem(output, batchOutput)) throw new Error('Furnace output changed type during collection');
              batchOutput ??= output;
              const taken = await collectOutput(furnace);
              collected.push(taken);
              emptySince = null;
            }
            const total = collected.reduce((count, item) => count + item.count, 0);
            if (remainingCount === 0 && !furnace.outputItem() && total > 0) {
              emptySince ??= Date.now();
              // Input/output arrive as separate slot updates; allow them to settle.
              if (Date.now() - emptySince >= 250) {
                return factory.createResponse(`Smelted ${total} ${collected[0].name}; processed ${resolvedInputCount}/${inputCount} loaded/requested ${input.name}. Remaining: ${JSON.stringify(furnaceState(furnace))}`);
              }
            } else {
              emptySince = null;
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
          }
        } catch (error) {
          throw new Error(`${String(error)}; partial batch: ${JSON.stringify({
            requestedInput: inputCount, loadedInput: loaded ? resolvedInputCount : 0,
            fuelAdded: fuelAdded ? resolvedFuelCount : 0, collected,
            remaining: furnaceState(furnace)
          })}. Items already transferred are not rolled back.`);
        } finally {
          furnace.removeListener('close', onClose);
        }
      });
    }
  );
}
