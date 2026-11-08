// Human-friendly node handles ("Mango", "Otter"): one per canvas node, unique per workspace
// (case-insensitive), so people and Central can say "close Mango and Kiwi". Separate from `title`,
// which stays the user-editable / auto-from-work label. Client and server both run
// `withNodeNames`; it is pure and deterministic, so both compute the same names from one board.

/** Pool of handles: short single words (fruits, vegetables, animals, plants), no look/sound-alike pairs. */
export const NODE_NAMES: readonly string[] = [
  // fruits
  'Mango', 'Kiwi', 'Apple', 'Peach', 'Plum', 'Cherry', 'Grape', 'Lemon', 'Banana', 'Papaya',
  'Guava', 'Lychee', 'Fig', 'Apricot', 'Coconut', 'Olive', 'Quince', 'Mulberry', 'Avocado', 'Orange',
  // vegetables
  'Carrot', 'Tomato', 'Onion', 'Garlic', 'Leek', 'Kale', 'Celery', 'Pepper', 'Radish', 'Parsnip',
  'Beet', 'Squash', 'Pumpkin', 'Cabbage', 'Lettuce', 'Spinach', 'Broccoli', 'Okra', 'Bean', 'Lentil',
  'Chard', 'Fennel', 'Ginger', 'Taro', 'Arugula', 'Shallot', 'Zucchini', 'Eggplant', 'Sprout', 'Cress',
  'Rhubarb', 'Corn', 'Chickpea', 'Wasabi',
  // animals
  'Otter', 'Fox', 'Wolf', 'Lynx', 'Panda', 'Koala', 'Tiger', 'Lion', 'Zebra', 'Giraffe',
  'Hippo', 'Rhino', 'Camel', 'Llama', 'Alpaca', 'Bison', 'Moose', 'Elk', 'Badger', 'Beaver',
  'Hedgehog', 'Rabbit', 'Mole', 'Ferret', 'Weasel', 'Sloth', 'Gibbon', 'Gorilla', 'Coyote', 'Dingo',
  'Hyena', 'Jackal', 'Meerkat', 'Mongoose', 'Yak', 'Ibex', 'Gazelle', 'Impala', 'Tapir', 'Wombat',
  'Possum', 'Raccoon', 'Skunk', 'Chipmunk', 'Squirrel', 'Gopher', 'Hamster', 'Pony', 'Horse', 'Donkey',
  'Goat', 'Sheep', 'Cat', 'Dog', 'Pug', 'Corgi', 'Poodle', 'Husky', 'Bobcat', 'Jaguar',
  'Cheetah', 'Leopard', 'Puma', 'Cougar', 'Eagle', 'Falcon', 'Hawk', 'Owl', 'Robin', 'Wren',
  'Finch', 'Sparrow', 'Heron', 'Swan', 'Goose', 'Duck', 'Pelican', 'Puffin', 'Penguin', 'Toucan',
  'Raven', 'Magpie', 'Pigeon', 'Dove', 'Osprey', 'Condor', 'Jay', 'Stork', 'Lark', 'Emu',
  'Ostrich', 'Flamingo', 'Dolphin', 'Whale', 'Seal', 'Walrus', 'Manatee', 'Shark', 'Squid', 'Octopus',
  'Crab', 'Lobster', 'Shrimp', 'Urchin', 'Oyster', 'Clam', 'Eel', 'Salmon', 'Trout', 'Tuna',
  'Cod', 'Koi', 'Sardine', 'Marlin', 'Gecko', 'Iguana', 'Turtle', 'Frog', 'Toad', 'Newt',
  'Snail', 'Wasp', 'Cricket',
  // plants
  'Fern', 'Basil', 'Moss', 'Ivy', 'Oak', 'Maple', 'Birch', 'Cedar', 'Pine', 'Willow',
  'Aspen', 'Hazel', 'Holly', 'Laurel', 'Juniper', 'Cypress', 'Spruce', 'Sequoia', 'Bamboo', 'Cactus',
  'Aloe', 'Agave', 'Yucca', 'Lotus', 'Rose', 'Tulip', 'Daisy', 'Iris', 'Orchid', 'Poppy',
  'Violet', 'Lilac', 'Dahlia', 'Clover', 'Thistle', 'Heather', 'Jasmine', 'Lavender', 'Sage', 'Mint',
  'Oregano', 'Dill', 'Chive', 'Tarragon', 'Nettle', 'Lupin', 'Marigold', 'Zinnia', 'Magnolia', 'Azalea',
  'Primrose', 'Bluebell', 'Foxglove', 'Crocus', 'Daffodil', 'Petunia', 'Palm', 'Reed',
]

/** Longest name kept as-is; anything longer is treated as missing and replaced. */
export const NODE_NAME_MAX = 40

/** Generator format: one capitalized pool-style word, optionally a tier number >= 2 ("Mango", "Mango 2"). */
const NODE_NAME_RE = /^[A-Z][a-z]+(?: (?:[2-9]|[1-9]\d+))?$/
const NODE_NAME_RE_ANY_CASE = new RegExp(NODE_NAME_RE.source, 'i')

/** True when `s` is a name in generator format. Names reach model-facing text, so nothing else is
 *  kept. `anyCase` accepts the same shape in any letter case (a user's or Central's reference to a name). */
export function isNodeName(s: unknown, anyCase = false): s is string {
  return typeof s === 'string' && s.length <= NODE_NAME_MAX && (anyCase ? NODE_NAME_RE_ANY_CASE : NODE_NAME_RE).test(s)
}

/** FNV-1a 32-bit over UTF-16 code units: a stable start index per node id. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h
}

/** The nodes with a unique `name` each: existing well-formed names kept (earliest wins a clash), the rest
 *  picked from the pool by id hash. Unchanged nodes keep their object identity. */
export function withNodeNames<T extends { id: string; name?: string }>(nodes: readonly T[]): Array<T & { name: string }> {
  const taken = new Set<string>()
  const kept = nodes.map((n) => {
    const name = typeof n.name === 'string' ? n.name.trim() : ''
    if (!isNodeName(name) || taken.has(name.toLowerCase())) return undefined
    taken.add(name.toLowerCase())
    return name
  })
  const N = NODE_NAMES.length
  return nodes.map((n, i) => {
    let name = kept[i]
    if (name === undefined) {
      const start = fnv1a(n.id) % N
      for (let tier = 1; name === undefined; tier++) {
        for (let k = 0; k < N; k++) {
          const cand = tier === 1 ? NODE_NAMES[(start + k) % N] : `${NODE_NAMES[(start + k) % N]} ${tier}`
          if (!taken.has(cand.toLowerCase())) { name = cand; break }
        }
      }
      taken.add(name.toLowerCase())
    }
    return (name === n.name ? n : { ...n, name }) as T & { name: string }
  })
}
