import type { Bot } from 'mineflayer';
import type { Recipe, RecipeItem } from 'prismarine-recipe';
import { confirmInventoryChange, cursorCapacity, inventoryState, recoverCursor } from './cursor-utils.js';

export function verifiedInventoryRecipe(recipe: unknown): recipe is Recipe {
  if (!recipe || typeof recipe !== 'object') return false;
  const r = recipe as Partial<Recipe>;
  const valid = (cell: RecipeItem) => !!cell && Number.isSafeInteger(cell.id) &&
    (cell.id === -1 || (cell.id >= 0 && Math.abs(cell.count) === 1));
  return !r.requiresTable && !r.outShape && !(r.inShape && r.ingredients) && !!r.result &&
    Number.isSafeInteger(r.result.id) && r.result.id >= 0 && Number.isSafeInteger(r.result.count) && r.result.count > 0 &&
    (Array.isArray(r.inShape)
      ? r.inShape.length > 0 && r.inShape.length <= 2 &&
        r.inShape.every(row => Array.isArray(row) && row.length > 0 && row.length <= 2 && row.every(valid)) &&
        r.inShape.some(row => row.some(cell => cell.id >= 0))
      : Array.isArray(r.ingredients) && r.ingredients.length > 0 && r.ingredients.length <= 4 &&
        r.ingredients.every(cell => valid(cell) && cell.id >= 0));
}

// Native craft predicts slot 0 and clears its local grid without confirming
// each input placement. This path uses the actual server preview and exact
// slot/cursor changes; a preview update is not a placement acknowledgement.
export async function craftInventoryOnce(bot: Bot, recipe: Recipe): Promise<void> {
  if (bot.currentWindow || bot.inventory.selectedItem || bot.inventory.slots.slice(1, 5).some(Boolean)) {
    throw new Error('Verified inventory crafting requires an empty cursor and player crafting grid');
  }
  const inputs: { slot: number; ingredient: RecipeItem }[] = [];
  if (recipe.inShape) {
    recipe.inShape.forEach((row, y) => row.forEach((ingredient, x) => {
      if (ingredient.id >= 0) inputs.push({ slot: 1 + x + y * 2, ingredient });
    }));
  } else {
    recipe.ingredients.forEach((ingredient, index) => inputs.push({ slot: 1 + index, ingredient }));
  }
  for (const { slot, ingredient } of inputs) {
    const source = bot.inventory.slots.findIndex((stack, index) =>
      index >= bot.inventory.inventoryStart && index < bot.inventory.inventoryEnd && !!stack &&
      stack.type === ingredient.id && (ingredient.metadata == null || stack.metadata === ingredient.metadata));
    if (source < 0) throw new Error('Craft ingredient no longer available; no recipe retry');
    let previous = inventoryState(bot);
    let expected = structuredClone(previous);
    expected.cursor = expected.slots[source];
    expected.slots[source] = null;
    await bot.clickWindow(source, 0, 0);
    await confirmInventoryChange(bot, previous, expected, true);

    previous = inventoryState(bot);
    expected = structuredClone(previous);
    expected.slots[slot] = { ...expected.cursor!, count: 1 };
    expected.cursor = expected.cursor!.count > 1 ? { ...expected.cursor!, count: expected.cursor!.count - 1 } : null;
    await bot.clickWindow(slot, 1, 0);
    await confirmInventoryChange(bot, previous, expected, true);
    if (bot.inventory.selectedItem) await recoverCursor(bot);
  }
  const result = bot.inventory.slots[0];
  if (!result || result.type !== recipe.result.id || result.count !== recipe.result.count ||
      (recipe.result.metadata != null && result.metadata !== recipe.result.metadata)) {
    throw new Error('Server crafting preview does not match the requested recipe; no output click attempted');
  }
  if (cursorCapacity(bot, result) < result.count) {
    throw new Error('Inventory capacity changed before output pickup; no output click attempted');
  }
  const previous = inventoryState(bot);
  const expected = structuredClone(previous);
  expected.cursor = expected.slots[0];
  for (const { slot } of inputs) expected.slots[slot] = null;
  await bot.clickWindow(0, 0, 0);
  await confirmInventoryChange(bot, previous, expected, true);
  await recoverCursor(bot);
}
