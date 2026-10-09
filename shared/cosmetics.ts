// Cosmetic catalog. Every family has a bare base body (the character sheets) and items worn in slots.
// The DEFAULT set of each family is the look of its reference render. Cosmetics never change stats.
// This file is the contract between the character models, the Locker / Store / Marketplace UI,
// the server inventory and (for premium items, later) the Steam Inventory item definitions. Item ids are permanent: never rename one.
import type { FamilyId } from './types.ts';

export type CosmeticSlot = 'head' | 'face' | 'body' | 'hands' | 'feet' | 'back';
export const COSMETIC_SLOTS: readonly CosmeticSlot[] = ['head', 'face', 'body', 'hands', 'feet', 'back'];

export const SLOT_NAMES: Record<CosmeticSlot, string> = {
  head: 'Head',
  face: 'Face',
  body: 'Outfit',
  hands: 'Hook',
  feet: 'Feet',
  back: 'Back',
};

/**
 * default  = everyone owns it, part of the family's reference look
 * common / rare / epic = bought with Pearls, which you earn by playing; epic can be traded for Pearls
 * premium  = bought with real money in the Steam version (Steam Item Store, tradable on the Steam
 *            Community Market). The free browser version shows them as "Available in the Steam version".
 */
export type Rarity = 'default' | 'common' | 'rare' | 'epic' | 'premium';
export const RARITIES: readonly Rarity[] = ['default', 'common', 'rare', 'epic', 'premium'];

export interface CosmeticDef {
  id: string; // `${family}.${slug}`, permanent
  family: FamilyId;
  slot: CosmeticSlot;
  name: string;
  rarity: Rarity;
  blurb: string;
  pearls?: number; // price in Pearls (common / rare / epic)
  usd?: number; // price in US dollars on Steam (premium); Steam converts it per region
  tradable: boolean;
}

/** One item per slot; a missing slot shows the bare base there. */
export type Loadout = Partial<Record<CosmeticSlot, string>>;

const D = (family: FamilyId, slot: CosmeticSlot, slug: string, name: string, blurb: string): CosmeticDef =>
  ({ id: `${family}.${slug}`, family, slot, name, rarity: 'default', blurb, tradable: false });
const P = (family: FamilyId, slot: CosmeticSlot, slug: string, name: string, rarity: 'common' | 'rare' | 'epic', pearls: number, blurb: string): CosmeticDef =>
  ({ id: `${family}.${slug}`, family, slot, name, rarity, blurb, pearls, tradable: rarity === 'epic' });
const PM = (family: FamilyId, slot: CosmeticSlot, slug: string, name: string, usd: number, blurb: string): CosmeticDef =>
  ({ id: `${family}.${slug}`, family, slot, name, rarity: 'premium', blurb, usd, tradable: true });

export const COSMETICS: readonly CosmeticDef[] = [
  // ---------------------------------------------------------------- Harbour Brawler
  // default set = reference render: captain cap, cigar, oilskin apron over a green jumper, green wellies, rope hook
  D('brawler', 'head', 'captain_cap', 'Captain Cap', 'White captain cap with a black peak and a gold anchor badge.'),
  D('brawler', 'face', 'cigar', 'Dockside Cigar', 'A fat cigar with a curl of smoke.'),
  D('brawler', 'body', 'oilskin_apron', 'Oilskin Apron', 'Yellow oilskin apron with leather straps over a rolled-sleeve green jumper.'),
  D('brawler', 'hands', 'rope_hook', 'Rope Hook', 'Rusty barbed fishing hook on a knotted rope.'),
  D('brawler', 'feet', 'green_wellies', 'Green Wellies', 'Rubber boots, salt-stained and squeaky.'),
  P('brawler', 'head', 'souwester', "Sou'wester", 'common', 300, 'Yellow storm hat with a long back brim.'),
  P('brawler', 'head', 'bobble_beanie', 'Bobble Beanie', 'common', 300, 'Knitted beanie with a bobble on top.'),
  P('brawler', 'head', 'tricorn', 'Pirate Tricorn', 'rare', 900, 'A battered three-cornered hat.'),
  P('brawler', 'head', 'lighthouse_helm', 'Lighthouse Helm', 'epic', 2400, 'A tiny lighthouse with a working lamp.'),
  P('brawler', 'face', 'pipe', 'Corncob Pipe', 'common', 250, 'A short pipe, puffing gently.'),
  P('brawler', 'face', 'eyepatch', 'Eyepatch', 'rare', 800, 'For the one eye that saw too much.'),
  P('brawler', 'body', 'striped_shirt', 'Striped Shirt', 'common', 400, 'Navy and white sailor stripes.'),
  P('brawler', 'body', 'net_cape', 'Fishing Net Coat', 'rare', 1100, 'A long coat knotted from old nets, with corks.'),
  P('brawler', 'body', 'admiral_coat', 'Admiral Coat', 'epic', 2800, 'Brass buttons, gold braid, epaulettes.'),
  P('brawler', 'hands', 'harpoon_hook', 'Harpoon Hook', 'rare', 1200, 'A barbed harpoon head on tarred rope.'),
  P('brawler', 'hands', 'anchor_hook', 'Anchor Hook', 'epic', 3000, 'A small anchor on a heavy chain.'),
  P('brawler', 'feet', 'clogs', 'Wooden Clogs', 'common', 250, 'Clack clack clack.'),
  P('brawler', 'back', 'lobster_pot', 'Lobster Pot', 'common', 350, 'A wicker pot with a grumpy lobster inside.'),
  P('brawler', 'back', 'barrel_pack', 'Rum Barrel', 'rare', 900, 'A little barrel strapped to the back.'),
  PM('brawler', 'hands', 'golden_harpoon', 'Golden Harpoon', 1.99, 'A gilded harpoon with a pearl inlay.'),

  // ---------------------------------------------------------------- Swamp Ogre
  // default set = reference render: moss mane, tooth necklace, vine-bound tusk hook, moss drapes, reed skirt
  D('ogre', 'head', 'moss_mane', 'Moss Mane', 'Long mossy dreadlocks with little orange fungi.'),
  D('ogre', 'body', 'tooth_necklace', 'Tooth Necklace', 'A necklace of big teeth over a reed and moss skirt.'),
  D('ogre', 'hands', 'vine_tusk_hook', 'Vine Tusk Hook', 'A curved tusk wrapped in vines, dripping moss.'),
  D('ogre', 'back', 'moss_drapes', 'Moss Drapes', 'Hanging moss over the shoulders and back.'),
  D('ogre', 'feet', 'mud_toes', 'Muddy Toes', 'Caked in bog mud. Smells about right.'),
  P('ogre', 'head', 'mushroom_cap', 'Mushroom Cap', 'common', 300, 'A huge red toadstool, worn proudly.'),
  P('ogre', 'head', 'lily_crown', 'Lily Crown', 'common', 300, 'Water lilies woven into a crown.'),
  P('ogre', 'head', 'antler_rack', 'Antler Rack', 'rare', 900, 'Branching antlers tied on with vine.'),
  P('ogre', 'head', 'skull_helm', 'Croc Skull Helm', 'epic', 2400, 'The skull of a very big crocodile.'),
  P('ogre', 'face', 'nose_ring', 'Bone Nose Ring', 'common', 250, 'A ring of polished bone.'),
  P('ogre', 'face', 'war_paint', 'Mud War Paint', 'rare', 800, 'Stripes of swamp clay across the face.'),
  P('ogre', 'body', 'frog_pouch', 'Frog Pouch Belt', 'common', 400, 'A belt of pouches, one with a frog in it.'),
  P('ogre', 'body', 'shell_armor', 'Turtle Shell Plate', 'rare', 1100, 'A turtle shell worn as a breastplate.'),
  P('ogre', 'body', 'glow_spots', 'Glowcap Colony', 'epic', 2800, 'Glowing mushrooms all over the belly.'),
  P('ogre', 'hands', 'croc_jaw_hook', 'Croc Jaw Hook', 'rare', 1200, 'A crocodile jaw on a vine rope.'),
  P('ogre', 'hands', 'root_hook', 'Living Root Hook', 'epic', 3000, 'A root that still grows leaves.'),
  P('ogre', 'feet', 'reed_wraps', 'Reed Wraps', 'common', 250, 'Feet wrapped in woven reeds.'),
  P('ogre', 'back', 'firefly_jar', 'Firefly Jar', 'common', 350, 'A jar of fireflies on a string.'),
  P('ogre', 'back', 'stump_pack', 'Stump Backpack', 'rare', 900, 'A hollow stump, full of snacks.'),
  PM('ogre', 'face', 'crystal_tusks', 'Crystal Tusks', 1.99, 'Tusks of glowing amethyst.'),

  // ---------------------------------------------------------------- Dredge-Bot
  // default set = reference render: rusted hazard plating, grille dome, twin smokestacks, crane hook, heavy feet
  D('bot', 'head', 'grille_dome', 'Grille Dome', 'Riveted dome with a glowing furnace grille.'),
  D('bot', 'body', 'hazard_plates', 'Rusted Hazard Plates', 'Rust-streaked plating with orange hazard stripes, a porthole and a red valve.'),
  D('bot', 'hands', 'crane_hook', 'Crane Hook', 'A red and grey crane hook on a hydraulic arm.'),
  D('bot', 'back', 'twin_stacks', 'Twin Smokestacks', 'Two smokestacks puffing steam.'),
  D('bot', 'feet', 'stomper_feet', 'Stomper Feet', 'Heavy piston feet with hazard trim.'),
  P('bot', 'head', 'radar_dish', 'Radar Dish', 'common', 300, 'Spins when it finds a target.'),
  P('bot', 'head', 'lamp_head', 'Lamp Head', 'common', 300, 'A bright searchlight dome.'),
  P('bot', 'head', 'kettle_lid', 'Kettle Lid', 'rare', 900, 'Whistles when the bot gets angry.'),
  P('bot', 'head', 'diving_helm', 'Diving Helm', 'epic', 2400, 'Brass diving helmet with portholes.'),
  P('bot', 'face', 'monocle', 'Monocle Sensor', 'common', 250, 'A brass monocle lens.'),
  P('bot', 'face', 'screen_smile', 'Screen Smile', 'rare', 800, 'A little screen that shows a smile.'),
  P('bot', 'body', 'clean_chrome', 'Polished Chrome', 'common', 400, 'Fresh from the factory, no rust at all.'),
  P('bot', 'body', 'copper_coils', 'Copper Coils', 'rare', 1100, 'Glowing copper coils wrapped around the belly.'),
  P('bot', 'body', 'brass_boiler', 'Brass Boiler', 'epic', 2800, 'A gleaming brass boiler with pressure gauges.'),
  P('bot', 'hands', 'magnet_hook', 'Magnet Hook', 'rare', 1200, 'A big horseshoe magnet.'),
  P('bot', 'hands', 'claw_grabber', 'Claw Grabber', 'epic', 3000, 'A three-fingered arcade claw.'),
  P('bot', 'feet', 'treads', 'Tank Treads', 'common', 250, 'Rolls instead of stomping.'),
  P('bot', 'back', 'propeller', 'Propeller Pack', 'common', 350, 'It does not actually fly.'),
  P('bot', 'back', 'gear_wheel', 'Gear Wheel', 'rare', 900, 'A big turning cog.'),
  PM('bot', 'head', 'chrome_crown', 'Chrome Crown', 1.99, 'A mirror-chrome crown with ruby lamps.'),
];

const BY_ID = new Map(COSMETICS.map((c) => [c.id, c]));

export function cosmeticById(id: string): CosmeticDef | undefined {
  return BY_ID.get(id);
}

/** Each family's reference look. */
export const DEFAULT_LOADOUT: Record<FamilyId, Loadout> = {
  brawler: { head: 'brawler.captain_cap', face: 'brawler.cigar', body: 'brawler.oilskin_apron', hands: 'brawler.rope_hook', feet: 'brawler.green_wellies' },
  ogre: { head: 'ogre.moss_mane', body: 'ogre.tooth_necklace', hands: 'ogre.vine_tusk_hook', back: 'ogre.moss_drapes', feet: 'ogre.mud_toes' },
  bot: { head: 'bot.grille_dome', body: 'bot.hazard_plates', hands: 'bot.crane_hook', back: 'bot.twin_stacks', feet: 'bot.stomper_feet' },
};

/** Items everyone owns (the default sets). */
export const DEFAULT_ITEM_IDS: readonly string[] = COSMETICS.filter((c) => c.rarity === 'default').map((c) => c.id);

/**
 * Keep only items that exist, belong to this family and sit in the right slot.
 * Ownership is checked separately (the server against its inventory, solo against the local save).
 */
export function cleanLoadout(family: FamilyId, raw: unknown): Loadout {
  const out: Loadout = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const slot of COSMETIC_SLOTS) {
    const id = (raw as Record<string, unknown>)[slot];
    if (typeof id !== 'string' || id.length > 64) continue;
    const def = BY_ID.get(id);
    if (def && def.family === family && def.slot === slot) out[slot] = id;
  }
  return out;
}

/** Drop anything the player does not own. */
export function ownedLoadout(loadout: Loadout, owns: (id: string) => boolean): Loadout {
  const out: Loadout = {};
  for (const slot of COSMETIC_SLOTS) {
    const id = loadout[slot];
    if (id && owns(id)) out[slot] = id;
  }
  return out;
}

export function itemsFor(family: FamilyId, slot?: CosmeticSlot): CosmeticDef[] {
  return COSMETICS.filter((c) => c.family === family && (!slot || c.slot === slot));
}

/** A plausible outfit for a bot: the family default with a few random swaps (rnd returns 0..1). */
export function randomBotLoadout(family: FamilyId, rnd: () => number): Loadout {
  const out: Loadout = { ...DEFAULT_LOADOUT[family] };
  for (const slot of COSMETIC_SLOTS) {
    if (rnd() > 0.35) continue;
    const pool = COSMETICS.filter((c) => c.family === family && c.slot === slot && c.rarity !== 'premium');
    if (pool.length) out[slot] = pool[Math.floor(rnd() * pool.length) % pool.length].id;
  }
  return out;
}

/** Pearls rewarded at the end of an online match (the server is the only authority for these). */
export function matchPearls(won: boolean, kills: number, hooksHit: number, saves: number): number {
  return Math.min(200, (won ? 60 : 30) + kills * 3 + hooksHit + saves * 4);
}
