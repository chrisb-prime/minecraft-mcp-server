# Minecraft MCP Server

<a href="https://github.com/yuniko-software/minecraft-mcp-server/actions">
  <img alt="CI" src="https://github.com/yuniko-software/minecraft-mcp-server/actions/workflows/build.yml/badge.svg">
</a>
<a href="https://github.com/yuniko-software">
  <img alt="Contribution Welcome" src="https://img.shields.io/badge/Contribution-Welcome-blue">
</a>
<a href="https://github.com/yuniko-software/minecraft-mcp-server/releases/latest">
  <img alt="Latest Release" src="https://img.shields.io/github/v/release/yuniko-software/minecraft-mcp-server?label=Latest%20Release">
</a>

<img width="2063" height="757" alt="image" src="https://github.com/user-attachments/assets/3f0f0438-f079-4226-90bd-87b9e1311d19" />

___

> [!IMPORTANT]
> This full local build uses released Mineflayer 4.39.0 and minecraft-data 3.119.0 for Java versions through 26.1, including 1.21.11. Java 26.3 is not supported. Compatibility is validated offline; gameplay on 26.1 must still be checked after a user-controlled switch.

https://github.com/user-attachments/assets/6f17f329-3991-4bc7-badd-7cde9aacb92f

A Minecraft bot powered by large language models and [Mineflayer API](https://github.com/PrismarineJS/mineflayer). This bot uses the [Model Context Protocol](https://github.com/modelcontextprotocol) (MCP) to enable Claude and other supported models to control a Minecraft character.

<a href="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server/badge" alt="mcp-minecraft MCP server" />
</a>

## Prerequisites

- Git
- Node.js (>= 22)
- A running Minecraft game (the setup below was tested with Minecraft 1.21.8 Java Edition included in Microsoft Game Pass)
- An MCP-compatible client. Claude Desktop will be used as an example, but other MCP clients are also supported

## Getting started

This bot is designed to be used with Claude Desktop through the Model Context Protocol (MCP).

### Run Minecraft

Create a singleplayer world and open it to LAN (`ESC -> Open to LAN`). Bot will try to connect using port `25565` and hostname `localhost`. These parameters could be configured in `claude_desktop_config.json` on a next step. 

### MCP Configuration

Make sure that [Claude Desktop](https://claude.ai/download) is installed. Open `File -> Settings -> Developer -> Edit Config`. It should open installation directory. Find file with a name `claude_desktop_config.json` and insert the following code:

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "npx",
      "args": [
        "-y",
        "github:yuniko-software/minecraft-mcp-server",
        "--host",
        "localhost",
        "--port",
        "25565",
        "--username",
        "ClaudeBot"
      ]
    }
  }
}
```

Double-check that right `--port` and `--host` parameters were used. Make sure to completely reboot the Claude Desktop application (should be closed in OS tray). 

## Running

Make sure Minecraft game is running and the world is opened to LAN. Then start Claude Desktop application and the bot should join the game. 

**It could take some time for Claude Desktop to boot the MCP server**. The marker that the server has booted successfully:

<img width="885" height="670" alt="image" src="https://github.com/user-attachments/assets/ccbb42f8-6544-462c-8ac1-8af13ddfcddd" />

You can give bot any commands through any active Claude Desktop chat. You can also upload images of buildings and ask bot to build them 😁

Don't forget to mention that bot should do something in Minecraft in your prompt. Because saying this is a trigger to run MCP server. It will ask for your permissions.

Using Claude Sonnet could give you some interesting results. The bot-agent would be really smart 🫡

Example usage: [shared Claude chat](https://claude.ai/share/535d5f69-f102-4cdb-9801-f74ea5709c0b)

## Available Commands

Once connected to a Minecraft server, Claude can use these commands:

### Movement
- `get-position` - Get the current position of the bot
- `move-to-position` - Move to specific coordinates
- `look-at` - Make the bot look at specific coordinates
- `jump` - Make the bot jump
- `move-in-direction` - Move in a specific direction for a duration

Pathfinding is non-destructive: navigation and implicit dig/place approaches do
not break blocks, build towers or place scaffolding. Unreachable routes return
MCP errors instead of breaking through walls. Open doors or provide an accessible
route explicitly. Intentional `dig-block` and `place-block` remain available.
Before an explicit dig, the bot selects the fastest available eligible harvesting
tool after approaching (for example, iron axe before stone axe for logs); stone is
a fallback when iron is absent. Valid hand mining remains supported, and missing
required harvesting tools or native equip/dig failures return errors.
Already-open doors are traversable only when both halves are loaded/open and
their collision shapes clear the centered player body; navigation never opens or
closes them automatically. Timeout cancellation clears the path immediately.
Door centering remains a known live limitation: a five-second path timeout can
still require a user-controlled manual-forward workaround. This connector update
does not expand navigation or fix that limitation.
`move-to-position` uses floored block coordinates and a block-grid goal radius,
not an exact body-position tolerance; a radius below 1 selects the target block.
Digging approaches seek a safely reachable, visible block face rather than just
standing within a radius of the block. A usable current position is retained;
native raycast digging can use an exposed face even if the center ray is blocked.
Non-colliding diggable plants (such as sugar cane) instead require an unobstructed
center sightline within normal reach and use native center-targeted digging.
Range, collision and harvesting-tool checks still apply; supporting foliage is
never cleared automatically.

### Flight
- `fly-to` - Make the bot fly directly to specific coordinates

### Inventory
- `list-inventory` - List all items in the bot's inventory
- `find-item` - Find a specific item in inventory
- `equip-item` - Equip a specific item
- `drop-item` - Drop exact `itemName` and positive integer `count` in one call, up to the item's full stack size (64 for ordinary materials, 16 or 1 for other items)

For example, `drop-item` with `itemName: "cobblestone", count: 64` drops a full
stack in one call. Availability is checked before dropping; missing items,
insufficient quantities, native failures and unconfirmed/partial transfers return
MCP errors with inventory changes. A full matching stack is selected when available
to clear its slot directly; otherwise the quantity can come from matching inventory
stacks. Smaller drops use Mineflayer's native toss API and may involve multiple
inventory clicks, but still require only one tool call. The bot does not turn or
move automatically. Ground items may be picked up again; inventory changes do not
guarantee that another player received the items.

### Survival
- `eat` - Consume one inventory food item using its exact `itemName` (for example, `bread`); equips it in the main hand and leaves it equipped
- `sleep` - Enter the nearby bed at explicit `x`, `y`, `z` coordinates in the overworld; returns upon entering, not after the night
- `wake` - Wake from bed, waiting up to 3 seconds for confirmation
- `status` - JSON health, food (out of 20), saturation and oxygen (`null` when unavailable), sleeping, position, gamemode, dimension, held item, worn equipment, vehicle and other current state

`status {}` includes `equipment: { head, torso, legs, feet, mainHand, offHand,
serverConfirmed: false }`. Each occupied entry is `{ name, count, slot }` with
the native player-inventory slot; empty entries are null. Equipment is read from
Mineflayer's player inventory using its native equipment mapping, not searched
from loose items or another entity's equipment. `mainHand` follows the selected
hotbar slot; the existing `heldItem` field remains unchanged.
This is a local model snapshot, not a new server acknowledgement. It sends no
inventory clicks, opens/closes no windows and changes no equipment. During an
open container or an in-flight inventory operation, the player model may lag;
inspect again after the operation completes. Invalid native slot mappings fail
explicitly rather than pretending those slots are empty. `list-inventory`,
`find-item` and cursor snapshots retain their existing loose-inventory semantics.

Eating, sleeping and boarding retain Mineflayer/server restrictions (including hunger,
time, bed occupancy, monsters and available vehicle seats). Failures return MCP errors.
These tools do not automatically move, alter game rules or select a different target.

### Block Interaction
- `place-block` - Place a block at specified coordinates
- `dig-block` - Dig a block at specified coordinates
- `get-block-info` - Get a block's name/type, state ID, properties and collision shapes for read-only inspection
- `find-blocks` - Find one or more nearby blocks of a specific type
- `interact-block` - Right-click the visible block at `x`, `y`, `z` within normal reach; use `sleep` for beds

Local `place-block` can natively replace a single snow layer, fern, short grass or
dead bush in the same explicit call, without digging first. It still rejects
solids, thicker snow, liquids and other plants/fixtures (including sugar cane,
flowers and torches); empty collision shapes alone do not imply replaceability.
Hold a block item or a plantable item. Ordinary seed/crop planting is preserved:
`wheat_seeds` produces `wheat`, `beetroot_seeds` produces `beetroots`, carrot/potato
produce `carrots`/`potatoes`, melon/pumpkin seeds produce stems, torchflower seeds
and pitcher pods produce their crops. Cocoa beans, sweet/glow berries and bamboo
are also checked against their native planted block names. Planting still uses
explicit placement and native support rules (for example, wheat above farmland);
it does not automatically harvest, till soil or replant. Bucket placements,
same-type replacement and snow-layer stacking remain unsupported. Native support,
reach and server rules still apply. Safe approach refreshes the target/reference,
and success requires the intended cell to contain the held block or its mapped
planted block afterward.
A native failure is an MCP error reporting the observed target; it does not
automatically retry other faces after possible partial effects.

Local `equip-item` prefers an exact name (so `oak_fence` never loses to an earlier
`oak_fence_gate` when a fence is present). Without an exact match, a substring is
accepted only if it resolves to one distinct item name; ambiguous names return an
MCP error listing sorted candidates. Multiple stacks of the same name retain
inventory-order selection.

### Storage (local connector)
- `container-status` - Inspect a supported ordinary chest or hopper at explicit `x`, `y`, `z`; JSON block type, slot count (27/54/5), empty slots and per-slot items
- `deposit-container` - Deposit exact `itemName` and positive integer `count` into a supported chest/hopper at explicit `x`, `y`, `z`
- `withdraw-container` - Withdraw exact `itemName` and positive integer `count` from a supported chest/hopper at explicit `x`, `y`, `z`
- `chest-status` - Inspect the normal chest at explicit `x`, `y`, `z`; JSON slot count (27/54), empty slots and per-slot item names/counts/stack sizes
- `deposit-chest` - Deposit exact `itemName` and positive integer `count` from inventory at explicit `x`, `y`, `z`
- `withdraw-chest` - Withdraw exact `itemName` and positive integer `count` into inventory at explicit `x`, `y`, `z`

The generic tools support only normal single/double chests and ordinary hoppers.
The three legacy chest names remain chest-only compatibility tools using the same
implementation and operation lock. No barrels, ender/trapped chests, minecarts or
other containers are enabled. Storage uses the actual native `openContainer`
window: either double-chest half opens its combined contents; a hopper has five
storage slots and 36 player-inventory slots. Quantities may span multiple stacks.
Stock and compatible-stack/empty-slot capacity are checked before any transfer.
For example, `deposit-chest` with `x: 319, y: 64, z: -199`,
`itemName: "oak_log", count: 64` requests exactly 64 logs, never a clamped amount.
Custom item variants are not merged into incompatible stacks.

These tools may approach safely without digging, scaffolding or building towers;
normal visibility/reach restrictions still apply. Blocked or server-denied opening
fails after 5 seconds. A pending native opening stays locked until it settles or
the bot reconnects; a late window is closed without transferring. Existing windows
and occupied cursors are rejected. Opened windows are closed after inspection or
transfer, including failures. Native transfer failures/timeouts and unexpected slot
changes are MCP errors with observed source removal, destination gain, remaining
storage contents and cursor contents before closing; partial effects are not rolled
back. Closing with cursor-held items may cause server-side return/drop behavior,
so inspect inventory and ground items after a partial failure. Do not concurrently
edit storage/player inventory during a transfer. Support is limited to ordinary
chests and hoppers; there is no general container automation.
These local tools are not part of upstream
[yuniko-software/minecraft-mcp-server#275](https://github.com/yuniko-software/minecraft-mcp-server/pull/275),
whose baseline is already merged into this fork.

Hoppers, and chests connected to them, can move items automatically while open. Inspection and remaining-content
results are snapshots, not persistent balances. Transfers additionally observe
storage-slot updates during each native call, refuse unexpected/concurrent changes,
and check both player inventory and storage transitions; equal final balance
deltas alone are not completion proof. Errors report `nativeCompleted` (quantities
whose native calls returned), `verifiedTransferred` (steps passing checks),
`concurrentUpdate` and observed balance deltas. Those counters do not attribute
unknown automated/player changes or imply a rollback. Generic success includes
`transferred`, `nativeCompleted`, `remainingStorage`, `snapshotOnly: true` and a
confirmation caveat; a successful deposit does not guarantee items remain in the
hopper afterward. If automation races a transfer, stop and inspect/reconcile before
retrying; disabling the hopper externally may be necessary. The tools never
disable automation themselves or repeatedly drain/refill a container.

### Inventory cursor and crafting confirmation

`inventory-cursor-status {}` requests a full server-confirmed player inventory
snapshot, including the carried cursor stack (which ordinary inventory listings
exclude). It does not open a chest or move items. A stale local cursor may clear
when this snapshot arrives. `craftingGrid` separately lists occupied player
2x2 input slots 1-4, and `craftingResult` reports slot 0 (a recipe preview,
not accessible crafted output). These are not added to the ordinary `items`
list. A null cursor does not prove the crafting grid is empty. Items remaining
in that grid are not necessarily lost, and this viewer does not move them.
`recover-inventory-cursor {}` first synchronizes, then
moves the entire actual cursor stack into compatible player-inventory slots,
merging only matching item identities and otherwise using empty slots. It never
clears the cursor blindly, clicks an outside-drop slot, opens a container or crafts.
If the server reports no cursor, recovery is an explicit zero-item no-op.

Both tools reject an open bot window and overlapping crafting/cursor operations.
Native synchronization has a 20-second server-response deadline. Recovery reserves
capacity before clicking and requests a fresh server snapshot after every placement;
the entire slot array and cursor must match the exact planned change, with
custom identity preserved. Native full inventory events do not identify their
request, so an already-queued pre-click snapshot can satisfy a synchronization.
If and only if the first observed snapshot exactly matches the immutable
pre-click state, recovery requests **one additional read-only synchronization**.
It never repeats the placement click. Persistent rejection, unexpected slots,
changed grid contents or wrong cursor counts remain explicit attribution errors.
Each native synchronization retains its 20-second bound; this extra observation
can therefore add up to another 20 seconds to a placement confirmation.
Prediction alone is not confirmation. Failures report confirmed recovered amounts
and observed cursor/slot state, with no rollback or retry. Error snapshots can be
unconfirmed local models; only successful results carry `serverConfirmed: true`.
Do not run concurrent inventory operations or competing same-name bot connections.

`craft-item` now synchronizes before crafting, rejects a pre-existing cursor or
residual player crafting-grid inputs, and
verifies each recipe's output count in accessible inventory after server sync.
On Java 26.1, ordinary shaped/shapeless 2x2 recipes with unit ingredients and no
returned ingredient containers use verified native inventory clicks instead of
`bot.craft`'s predicted grid/result cleanup. Every source pickup, single-unit
grid placement and result pickup must match an authoritative full slot/cursor
snapshot before the next step. Only slot 0 is excluded from intermediate state
comparisons because it is a recomputed recipe preview, not owned inventory.
Before collecting output, that **actual server preview** must match the requested
recipe's item and yield; the connector never writes a fabricated result locally.
Result pickup must consume exactly the planned grid inputs and place the exact
preview stack on the cursor, which is then recovered to accessible inventory.
A queued unchanged pre-click snapshot permits one additional observation, never
a repeated consuming click. These extra network round trips favor confirmation
over throughput and retain the native 20-second per-response deadlines.
Crafting-table recipes, recipes with returned containers and other versions
retain the existing native crafting path and its post-craft guards.
Residual grid inputs after native crafting also stop the batch with a diagnostic
snapshot; the connector does not clear them automatically or spend further
ingredients to obscure an incomplete cleanup.
Any cursor remainder is safely recovered using the same helper. Native failures
stop rather than retrying another recipe with potentially consumed ingredients,
and an incomplete batch is an MCP error, not success. Conservatively reserve empty
player-inventory space for the recipe output before crafting; this can reject a
full inventory even if a craft would have freed ingredient slots. No extra materials
are consumed for inspection or recovery. These local fixes are not part of PR #275.

### Furnace
- `smelt-item` - Load a batch into a furnace, smoker or blast furnace and collect output repeatedly until the loaded input is exhausted
- `retrieve-furnace-output` - Retrieve the currently cooked output at `x`, `y`, `z`, without supplying more input/fuel or waiting for further cooking
- `furnace-status` - Inspect input/fuel/output names and counts, burn fraction and cooking progress at `x`, `y`, `z` (`null` when progress properties are unavailable)

`smelt-item` takes `inputItem`, `inputCount` (default 1), `fuelItem`, `fuelCount`
(default 1), `takeOutput` (default true) and `timeoutMs` (default 60000, maximum
300000). It already supports loading more than one input; collection now drains
the **whole loaded batch**, rather than stopping after the first cooked item.
It counts actual retrieved items instead of assuming every recipe produces one
output per input. Completion requires empty input/output and a short slot-update
settling period. Counts remain limited to the selected inventory stack; responses
explicitly distinguish loaded and requested amounts.

Start a batch only with empty input and output slots. Pre-existing input is rejected
(even if the same type) to avoid mixing batches; retrieve pre-existing output
explicitly first. Compatible existing fuel may remain, but additional fuel must fit
the slot. Do not share the furnace with another player during collection.

Set `takeOutput: false` to load items for background cooking, close the window and
return immediately without claiming they have cooked. Later use `furnace-status`
and `retrieve-furnace-output`; retrieval takes only the output available at that
moment, so repeat it as cooking progresses. Example: load 8 `raw_iron` with 1
`coal` in a furnace, or 8 `beef` with 1 `coal` in a smoker.

Timeouts (including insufficient fuel or unsupported recipes), inventory-capacity
problems, closed windows and native transfer failures return **MCP errors** with
collected amounts and remaining slot contents. Already transferred items are not
rolled back; remaining input may continue cooking after the window closes. Keep
inventory room for output (a full output stack is reserved while more input is
cooking, to avoid Mineflayer dropping overflow). Native transfer timeouts remain
in effect in addition to the collection deadline. No game rules are changed.

### Entity Interaction
- `find-entity` - Find the nearest entity of a specific type, including its entity ID
- `interact-entity` - Right-click a nearby unobstructed entity using its `entityId`
- `mount` - Try boarding an entity by `entityId` (for example, a boat), waiting up to 3 seconds for confirmation
- `dismount` - Leave the current vehicle, waiting up to 3 seconds for confirmation

Interactions use the currently equipped main-hand item, which may feed a mob, place
an item, open a container or activate a block. They report a **sent request**, not a
guaranteed server-side result; inspect the world or `status` afterward. Local checks
use vanilla reach (4.5 blocks for blocks, 3 for entities; 5 in creative) and do not
override server rules. Mounting may still be rejected by the server; timeout is an error.

### Stonecutter (Java 26.1)

`stonecutter-recipes { "x": 325, "y": 64, "z": -200, "inputItem": "andesite" }`
reads the server-synced recipe list for a nearby, visible stonecutter without
opening it or moving any items. Results include input-filtered menu `index`,
`outputItem`, `outputCount`, `supported` and raw `display` details.

`stonecut { "x": 325, "y": 64, "z": -200, "inputItem": "andesite",
"outputItem": "polished_andesite", "count": 64 }` makes exactly **64 output
items**, not 64 recipes. Coordinates are explicit integers; item names are
exact. `count` is a positive integer up to 4096 and must be divisible by the
server recipe's yield. Each cut consumes one input item; a two-slab recipe
therefore requires one input per two requested slabs. Optional `timeoutMs`
defaults to 120000 (range 1000-300000).

Mineflayer 4.39 has no stonecutter helper. This tool captures Java 26.1
`declare_recipes.stoneCutterRecipes` and item tags before login, preserves the
server list order when filtering by input, and sends the corresponding native
container-button packet (`enchant_item` in minecraft-protocol). It never guesses
static indices or falls back to crafting-table recipes. Direct `item` and
`item_stack` output displays are supported, including native stack components;
other display types remain visible in inspection but are not executed. Missing
recipes, unresolved ingredient tags, unknown outputs or ambiguous matching
outputs fail before loading materials. Server recipe changes invalidate an
in-progress operation.

Approach explicitly first: no movement, digging or placement is performed.
The tool rejects sleeping/dead/spectator state, sneaking/held-item use, occupied
cursor or an existing window. It requests an authoritative player inventory
snapshot, checks ordinary exact-identity input stock and reserves compatible
space for the entire output **before** consuming anything. Custom input stacks
are not spent. It opens an empty tool-owned stonecutter, loads one input per cut
using exact normal clicks, confirms the selected output, then verifies exact
consumption, cursor and destination changes against full server window snapshots.
It uses neither shift-click batch crafting nor helpers with overflow/drop
fallbacks. The final player inventory must also confirm the exact total input
decrease and accessible output increase before success.

Success reports `requested`, `collected`, `consumed`, `recipeIndex` and
`serverConfirmed: true`. Failure is an **MCP error** with previously confirmed
output/input totals, input/output/cursor snapshot and cleanup result. It stops
at the first unconfirmed step: already spent materials are not rolled back and
no consuming step is automatically retried. A failed destination click can leave
confirmed consumption with output still on the cursor; do not repeat the batch
without inspecting that error and resolving the window.

Opening is bounded to five seconds; an uncancellable late native opening retains
the shared crafting/cursor lock until settlement and attempts to close only its
empty matching stonecutter. Output selection is bounded to five seconds.
`timeoutMs` prevents starting further steps after the operation deadline;
an in-flight native inventory confirmation may take up to its native 20-second
timeout. Empty owned windows close on completion; unexpected windows, inputs,
outputs or cursor contents are left open with explicit errors rather than risking
return/drop effects. Pre-existing windows (including a stonecutter opened by
`interact-block`) cannot prove coordinate ownership and are rejected untouched.
Close them through a user-controlled action before cutting. Do not concurrently
run other inventory/window tools; snapshots detect unexpected slot changes, but
cannot authorize competing operations.

The menu-index/one-input rule is verified against the
[Java 26.1 native StonecutterMenu](https://github.com/extremeheat/extracted_minecraft_data/blob/client26.1/client/net/minecraft/world/inventory/StonecutterMenu.java)
and
[SelectableRecipe](https://github.com/extremeheat/extracted_minecraft_data/blob/client26.1/client/net/minecraft/world/item/crafting/SelectableRecipe.java).
Offline tests exercise installed 26.1 binary recipe/button codecs and native
Mineflayer window opening, clicking and synchronization. Actual server recipe
delivery and exact 1- and 63-input andesite-to-polished-andesite conversions were
confirmed in a separately approved live session on the preserved algorithm.
The latest approved smoke check confirmed server-synced cobblestone and stone
recipe lists without cutting. Publishing-checkout validation remains offline;
it does not establish live coverage for every recipe or failure mode.

### Read-only villager shop (Java 26.1)

`villager-trades { "entityId": 7731 }` browses an explicitly identified, loaded
ordinary villager within entity interaction reach and unobstructed view. It opens
an empty merchant window using native Mineflayer interaction, waits up to five
seconds for the server's matching offers, then closes that owned window. It does
not move, select an offer, put items in trade slots, buy, or click inventory slots.
Put away name tags, leads, spawn eggs and buckets before browsing to avoid
main-hand interaction side effects; finish sneaking/using items and clear the
cursor first. No equipment is changed automatically.

The JSON result includes `entityId`, `windowId`, `professionId`, namespaced
`profession`, readable `job`, `professionSource`, `merchantTitleTranslation`,
`professionNote`, `level`, `metadataLevel`, `canRestock` and `offers`.
`professionId` remains the numeric entity metadata value, not a hardcoded job
lookup. The original viewer waited only for a `villager_profession` registry
packet, but that registry is absent from the installed 26.1 synced configuration
registry set. This left readable jobs unknown even when metadata and offers
arrived correctly; no missed packet or listener timing race has been demonstrated.

The viewer now also reads the owned merchant window's **server-provided root
title translation** (26.1 `open_window.windowTitle`, anonymous NBT). A canonical
`entity.minecraft.villager.leatherworker` title supplies the label
`profession: "minecraft:leatherworker"`, `job: "leatherworker"` and
`professionSource: "merchant_title"`, independently of the numeric ID or products.
This identifies the server's profession **label**, not a verified mapping from
metadata IDs. It never caches a title against an ID. A supplied server profession
registry remains supported (`professionSource: "server_registry"`); a conflict
between that mapping and the title leaves the job unresolved with a note.

Literal/custom names, nested/parameterized/decorated or unrecognized title
components do not prove a profession: absent another authoritative mapping,
`profession`, `job` and `professionSource` are null with an explicit
`professionNote`. `merchantTitleTranslation` exposes the root key when present.
No job is inferred from trade products, screenshots, English literal text or
vanilla numeric ordering. Custom servers can change title labels; provenance is
reported rather than treating a title as metadata. Trading rank is unchanged:
`level` comes from received offers and `metadataLevel` from entity metadata.
Each zero-based offer has complete `inputs` with current
displayed `count`, `baseCount` and component matchers, an `output` with name,
count and native slot `details` (including custom components), `available`,
`remainingUses`, `uses` and `maximumUses`. The first cost applies the native
demand/reputation adjustment and stack-size clamp. `serverConfirmed: true` refers
to the received offers; `snapshotOnly: true` means prices/stock can change.
`purchased` is always false. No purchase tool is provided.

Existing windows, including a merchant previously opened by `interact-entity`,
are left untouched and rejected explicitly: Mineflayer's generic window has no
villager association, so its ID/type cannot prove that it belongs to this target.
Close that window through a user-controlled action before browsing. Other window
operations should not run concurrently. Invalid targets, native failures,
malformed offers and timeouts are MCP errors, never empty-success fallbacks. If
an opening completes late, the viewer remains busy until native opening settles
and attempts to close only its matching empty merchant; it never closes another
current window or an item-bearing shop. Late cleanup failures are logged.
An empty server offer list is reported as an empty shop, not inferred trades.

### Running a local build on Windows

Install with `npm ci`, build with `npm run build`, then point the MCP client at the
absolute path to `dist\main.js` using Node instead of downloading via npx:

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "cmd.exe",
      "args": [
        "/d", "/s", "/c",
        "node \"C:\\path\\to\\minecraft-mcp-server\\dist\\main.js\" --host localhost --port CURRENT_LAN_PORT --username Kit"
      ]
    }
  }
}
```

Replace the example path and `CURRENT_LAN_PORT` with the port displayed by the
currently open LAN world (it can change). Before applying this configuration, pause
any sessions using the old connector and disable it so only one Kit connection runs.
Building and mocked tests do not require a Minecraft connection.

### Communication
- `send-chat` - Send a chat message in-game
- `read-chat` - Get recent chat messages from players

### Game State
- `detect-gamemode` - Detect the gamemode on game

## Contributing

Feel free to submit pull requests or open issues for improvements. All refactoring commits, functional and test contributions, issues and discussion are greatly appreciated!

To get started with contributing, please see [CONTRIBUTING.md](CONTRIBUTING.md).

---

⭐ If you find this project useful, please consider giving it a star on GitHub! ⭐

Your support helps make this project more visible to other people who might benefit from it.
