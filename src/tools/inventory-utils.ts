import type { Item } from 'prismarine-item';
import { isDeepStrictEqual } from 'node:util';

type StackIdentity = Pick<Item, 'type' | 'metadata' | 'nbt'> & { components?: unknown; removedComponents?: unknown };

export function sameItem(a: StackIdentity, b: StackIdentity): boolean {
  return a.type === b.type && a.metadata === b.metadata &&
    isDeepStrictEqual(a.nbt, b.nbt) && isDeepStrictEqual(a.components, b.components) &&
    isDeepStrictEqual(a.removedComponents, b.removedComponents);
}
