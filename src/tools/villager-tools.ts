import { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Item } from 'prismarine-item';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { ToolFactory } from '../tool-factory.js';
import { closestPoint, eyePosition, requireAwake } from './interaction-utils.js';
import { log } from '../logger.js';

interface Cost { itemId: number; itemCount: number; components: unknown }
interface Offer {
  inputItem1: Cost; inputItem2?: Cost | null; outputItem: object;
  tradeDisabled: boolean; nbTradeUses: number; maximumNbTradeUses: number;
  demand: number; specialPrice: number; priceMultiplier: number;
}
interface Offers { windowId: number; trades: Offer[]; villagerLevel: number; canRestock: boolean }

const professions = new WeakMap<Bot, readonly string[]>();

// Retain a server-supplied mapping if provided. Vanilla 26.1's synced registry
// set does not include professions; do not assume one will arrive.
export function trackVillagerProfessions(bot: Bot): void {
  bot._client.on('registry_data', (packet: { id: string; entries: { key: string }[] }) => {
    if (packet.id !== 'minecraft:villager_profession') return;
    if (!Array.isArray(packet.entries) || packet.entries.some(entry => typeof entry.key !== 'string')) {
      professions.delete(bot);
      log('warn', 'Invalid villager profession registry; names will be unavailable');
      return;
    }
    professions.set(bot, packet.entries.map(entry => entry.key));
  });
  bot._client.on('packet', (_packet, meta) => {
    if (meta.name === 'start_configuration') professions.delete(bot);
  });
  bot.once('end', () => { professions.delete(bot); });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function merchantProfession(title: unknown) {
  let component = record(title);
  if (component?.type === 'compound') {
    const fields = record(component.value);
    const translation = record(fields?.translate);
    // Java 26.1 open_window carries anonymous NBT, not a JSON/string title.
    // Only the root translation is a job label; custom text/children are not.
    component = fields && translation?.type === 'string'
      ? { translate: translation.value, with: fields.with, extra: fields.extra } : null;
  }
  const translation = typeof component?.translate === 'string' ? component.translate : null;
  const match = translation?.match(/^entity\.([a-z0-9_-]+)\.villager\.([a-z0-9_./-]+)$/);
  const profession = match && component?.with === undefined && component?.extra === undefined
    ? `${match[1]}:${match[2]}` : null;
  return { translation, profession };
}

function target(bot: Bot, entityId: number): Entity {
  requireAwake(bot);
  const entity = bot.entities[entityId];
  if (!entity?.isValid || entity.name !== 'villager' || entity.entityType !== bot.registry.entitiesByName.villager.id) {
    throw new Error(`No loaded normal villager with ID ${entityId}`);
  }
  const eye = eyePosition(bot);
  const point = closestPoint(eye, entity.position.offset(-entity.width / 2, 0, -entity.width / 2),
    entity.position.offset(entity.width / 2, entity.height, entity.width / 2));
  const distance = eye.distanceTo(point);
  if (distance > (bot.game.gameMode === 'creative' ? 5 : 3)) throw new Error('Villager is out of interaction reach');
  if (distance && bot.world.raycast(eye, point.minus(eye).normalize(), distance)) throw new Error('Villager is obstructed');
  return entity;
}

export function registerVillagerTools(factory: ToolFactory, getBot: () => Bot): void {
  const busy = new WeakSet<Bot>();
  factory.registerTool('villager-trades', 'Browse a nearby villager by entity ID; opens and closes its empty merchant window without buying or selecting offers',
    { entityId: z.coerce.number().int().nonnegative().describe('Explicit loaded villager ID from find-entity') },
    async ({ entityId }: { entityId: number }) => {
      const bot = getBot();
      if (bot.version !== '26.1') throw new Error('This merchant packet reader is validated for Java 26.1 only');
      if (busy.has(bot)) throw new Error('Another merchant inspection or pending opening is in progress');
      const entity = target(bot, entityId);
      if (bot.currentWindow) {
        throw new Error(`Existing window ${bot.currentWindow.id} (${bot.currentWindow.type}) is not owned by this viewer; merchant windows do not identify their villager. Close it explicitly before browsing; nothing was closed`);
      }
      if (bot.inventory.selectedItem || bot.getControlState('sneak') || bot.usingHeldItem) {
        throw new Error('Clear the inventory cursor and finish sneaking/using items before browsing');
      }
      const held = bot.heldItem?.name;
      if (held === 'name_tag' || held === 'lead' || held?.endsWith('_spawn_egg') || held?.endsWith('bucket')) {
        throw new Error('Put away the held interaction item before read-only browsing; no equipment or item changes attempted');
      }
      busy.add(bot);
      let window: Bot['currentWindow'] = null;
      const received = new Map<number, Offers>();
      let signal = () => {};
      const onOffers = (packet: Offers) => { received.set(packet.windowId, packet); signal(); };
      const onOpen = (opened: NonNullable<Bot['currentWindow']>) => {
        window ??= opened;
        signal();
      };
      bot._client.on('trade_list', onOffers);
      bot.on('windowOpen', onOpen);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let disposed = false;
      let disconnected = false;
      const onEnd = () => { disconnected = true; signal(); };
      const onClose = () => { signal(); };
      bot.on('end', onEnd);
      bot.on('windowClose', onClose);
      let closeAttempted = false;
      const close = async () => {
        if (closeAttempted || !window || bot.currentWindow !== window) return;
        closeAttempted = true;
        if (window.type !== 'minecraft:merchant' || window.selectedItem || bot.inventory.selectedItem || window.slots.slice(0, 3).some(Boolean)) {
          throw new Error('Opened window has unexpected type, trade-slot items or cursor; left open to avoid item effects');
        }
        await bot.closeWindow(window);
      };
      const cleanup = () => {
        disposed = true;
        signal();
        if (timer) clearTimeout(timer);
        bot._client.removeListener('trade_list', onOffers);
        bot.removeListener('windowOpen', onOpen);
        bot.removeListener('end', onEnd);
        bot.removeListener('windowClose', onClose);
        busy.delete(bot);
      };
      const pending = Promise.resolve().then(() => bot.openEntity(entity, EventEmitter));
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('Merchant opening/offers timed out after 5 seconds'));
            signal();
          }, 5000);
        });
        const read = async () => {
          const opened = await pending;
          window = opened;
          if (opened.type !== 'minecraft:merchant') throw new Error('Server opened a non-merchant window');
          while (!received.has(opened.id)) {
            if (timedOut || disposed || disconnected || bot.currentWindow !== opened) throw new Error('Merchant inspection ended before offers arrived');
            await new Promise<void>(resolve => { signal = resolve; });
          }
          if (disconnected || bot.currentWindow !== opened || bot.entities[entityId] !== entity || !entity.isValid) throw new Error('Merchant closed or villager changed while browsing');
          if (opened.selectedItem || opened.slots.slice(0, 3).some(Boolean)) throw new Error('Merchant contains trade-slot/cursor items; no purchase or item movement attempted');
          const packet = received.get(opened.id)!;
          if (!Array.isArray(packet.trades) || !Number.isInteger(packet.villagerLevel) ||
              packet.villagerLevel < 1 || packet.villagerLevel > 5 || typeof packet.canRestock !== 'boolean') {
            throw new Error('Invalid/unavailable merchant level or offers');
          }
          const Items = (createRequire(import.meta.url)('prismarine-item') as (registry: Bot['registry']) => typeof Item)(bot.registry);
          const cost = (input: Cost, adjusted?: number) => {
            const definition = bot.registry.items[input.itemId];
            if (!definition || !Number.isSafeInteger(input.itemCount) || input.itemCount <= 0) throw new Error('Invalid/unavailable merchant cost');
            return { name: definition.name, count: adjusted ?? input.itemCount, baseCount: input.itemCount, components: input.components };
          };
          const trades = packet.trades.map((offer, index) => {
            const definition = bot.registry.items[offer.inputItem1.itemId];
            if (!definition || ![offer.demand, offer.specialPrice, offer.priceMultiplier].every(Number.isFinite) ||
                !Number.isSafeInteger(offer.nbTradeUses) || !Number.isSafeInteger(offer.maximumNbTradeUses) ||
                offer.nbTradeUses < 0 || offer.maximumNbTradeUses < offer.nbTradeUses ||
                typeof offer.tradeDisabled !== 'boolean') throw new Error('Invalid/unavailable merchant offer fields');
            const price = Math.min(definition.stackSize, Math.max(1, offer.inputItem1.itemCount + offer.specialPrice +
              Math.max(0, Math.floor(offer.inputItem1.itemCount * offer.demand * offer.priceMultiplier))));
            const output = Items.fromNotch(offer.outputItem);
            if (!output?.name || !Number.isSafeInteger(output.count) || output.count <= 0) throw new Error('Merchant output unavailable');
            const remainingUses = offer.maximumNbTradeUses - offer.nbTradeUses;
            return { index, inputs: [cost(offer.inputItem1, price), ...(offer.inputItem2 ? [cost(offer.inputItem2)] : [])],
              output: { name: output.name, count: output.count, details: offer.outputItem },
              available: !offer.tradeDisabled && remainingUses > 0, remainingUses,
              uses: offer.nbTradeUses, maximumUses: offer.maximumNbTradeUses };
          });
          const key = bot.registry.entitiesByName.villager.metadataKeys?.indexOf('villager_data') ?? -1;
          const metadata: unknown = key >= 0 ? entity.metadata[key] : undefined;
          const data = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
          const professionId = typeof data.villagerProfession === 'number' && Number.isInteger(data.villagerProfession) &&
            data.villagerProfession >= 0 ? data.villagerProfession : null;
          const registryProfession = professionId === null ? null : professions.get(bot)?.[professionId] ?? null;
          const title = merchantProfession(opened.title);
          const conflict = registryProfession !== null && title.profession !== null && registryProfession !== title.profession;
          const profession = conflict ? null : registryProfession ?? title.profession;
          const professionSource = profession === null ? null : registryProfession ? 'server_registry' : 'merchant_title';
          const professionNote = conflict
            ? 'Server registry and merchant title disagree; profession unresolved'
            : professionSource === 'merchant_title'
              ? 'Profession label from the server merchant title; numeric metadata ID mapping unavailable'
              : profession ? null
                : 'No server profession mapping or unambiguous merchant profession title; no job inferred from offers or numeric ID';
          const metadataLevel = typeof data.level === 'number' && Number.isInteger(data.level) &&
            data.level >= 1 && data.level <= 5 ? data.level : null;
          return { entityId, windowId: opened.id, professionId, profession, professionSource,
            job: profession?.replace(/^minecraft:/, '').replaceAll('_', ' ') ?? null,
            professionNote, merchantTitleTranslation: title.translation,
            level: packet.villagerLevel, metadataLevel, canRestock: packet.canRestock,
            offers: trades, serverConfirmed: true, snapshotOnly: true, purchased: false };
        };
        const result = await Promise.race([read(), deadline]);
        await close();
        return factory.createResponse(JSON.stringify(result));
      } catch (error) {
        if (!timedOut) {
          try { await close(); } catch (closeError) { throw new Error(`${String(error)}; cleanup failed: ${String(closeError)}`); }
        }
        throw error;
      } finally {
        if (timedOut) {
          // Native opening is uncancellable: keep ownership until its late result
          // settles, then close only the empty matching merchant.
          void pending.then(close, async () => { await close(); }).catch(error => {
            log('warn', `Late merchant cleanup failed: ${String(error)}`);
          }).finally(cleanup);
        } else cleanup();
      }
    });
}
