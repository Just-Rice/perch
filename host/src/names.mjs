// Mac names like "amber-otter-4821": easy to read aloud and type, unique enough that two Macs won't collide, and
// not guessable at scale (256 × 256 × 9000 ≈ 590 million names). The name is the username for backup sign-in.
import { randomInt } from 'node:crypto';

export const ADJECTIVES = (
  'amber azure bold brave breezy bright brisk calm candid cedar cheery chill civic clever cloudy cobalt cool coral ' +
  'cosmic cozy crisp curious daring dawn deep dewy dreamy dusky eager early easy elder ember even fair fancy ' +
  'fern fiery fleet floral foggy fond frank free fresh frosty gentle giant gilded glad gleaming golden grand ' +
  'grassy green hardy hazel hazy hearty honey humble icy indigo ivory jade jolly jovial keen kind lapis lavish ' +
  'leafy lemon level light lilac lively lofty loyal lucky lunar maple marble mellow merry mighty milky minty ' +
  'misty modest mossy noble north nimble oaken ocean olive opal orchid pale patient peach pearl pebble peppy ' +
  'pine plucky plum polar polished prairie prime proud quick quiet radiant rainy rapid ready regal rich river ' +
  'robust rocky rosy royal ruby rugged russet rustic sable sage salty sandy scarlet serene shady sharp shiny ' +
  'silent silky silver simple sleek slim smooth snowy soft solar sonic south spare sparkly speedy spicy spring ' +
  'starry steady stellar stony stormy sturdy sunny super swift tall tame tawny teal tender tidal tidy timber ' +
  'tiny topaz tranquil tropic true trusty tulip umber upbeat urban valiant velvet verdant vivid warm wavy ' +
  'west wild willow windy wise witty woody young zany zealous zesty brassy cinder copper dapper downy fizzy ' +
  'frothy glossy hushed inky jaunty kindly lanky mirthful nutty perky quaint rowdy snug spry thrifty twinkly ' +
  'wiry zippy balmy bubbly chipper dainty elfin feisty gusty jumpy lush agile airy alpine ample ashen aspen ' +
  'autumn barley basil beige birch blissful bonny boreal briny burly buttery candied caramel cashew celestial ' +
  'chalky charming cherry chestnut cider citrus clover cocoa comet crimson crystal cyan dandy dapple denim dusty ' +
  'electric emerald fable feathered fennel festive flint frisky fudge garnet ginger glacier glowing granite grape ' +
  'heather helpful hickory honest jasmine juniper lagoon lemony linen lucid magic mango meadow mild navy nectar ' +
  'nova nutmeg onyx orange paisley pastel peaceful pepper plush poppy pumpkin quartz quill reef ripple rosewood ' +
  'saffron satin sepia sienna slate sorrel spruce sugar tangy thistle toasty twilight vanilla violet walnut wheat ' +
  'wintry').split(' ');

export const ANIMALS = (
  'otter falcon heron badger beaver bison bobcat camel caribou cheetah chipmunk cobra condor cougar coyote crane ' +
  'cricket dingo dolphin donkey dove eagle egret elk ermine ferret finch flamingo fox gazelle gecko gibbon ' +
  'giraffe goose gopher gorilla grouse hamster hare hawk hedgehog hippo hornet husky ibex iguana impala jackal ' +
  'jaguar jay kestrel kiwi koala lark lemur leopard lion llama lobster lynx macaw magpie mallard manatee ' +
  'marmot marten meerkat mink mole moose moth narwhal newt ocelot octopus okapi oriole osprey ostrich owl ' +
  'oyster panda panther parrot pelican penguin perch pheasant pigeon plover pony porcupine possum puffin puma ' +
  'quail rabbit raccoon raven robin salmon seal shark sheep shrew skunk sloth snail sparrow squid squirrel ' +
  'starling stork swallow swan tapir tern tiger toad toucan trout tuna turkey turtle viper vole walrus ' +
  'warbler weasel whale wolf wombat wren yak zebra albatross anchovy antelope armadillo baboon barracuda bat ' +
  'beetle bluebird boar buffalo bulldog butterfly canary cardinal catfish chameleon chickadee clam cockatoo ' +
  'cod crab crow cuckoo deer duck eel emu firefly flounder frog gannet gerbil goldfish grasshopper gull ' +
  'haddock halibut herring hummingbird jellyfish kangaroo kingfisher koi ladybug lamb limpet loon mackerel ' +
  'mantis minnow mongoose monkey mouse mule mussel nightingale orca panther pike piranha platypus pufferfish ' +
  'rattler reindeer rhino roadrunner rooster sandpiper sardine scorpion seahorse shrimp snapper spider ' +
  'stingray sunfish tadpole termite thrush tortoise toucan unicorn urchin vulture wallaby wasp woodpecker yeti ' +
  'aardvark alpaca anteater axolotl barnacle bass bear bee bluejay bongo budgie bunny capybara carp cat catbird ' +
  'chicken chinchilla cicada civet cormorant cow crayfish curlew dodo dormouse dragonfly drake dunlin eland fawn ' +
  'flicker gadwall gator gnu goat goby gosling grebe greyhound grizzly guppy hornbill hound hyena jackrabbit ' +
  'jerboa junco kakapo katydid kinkajou kite kudu lapwing lionfish lizard locust lorikeet lovebird mandrill marlin ' +
  'merlin mockingbird moorhen mustang nuthatch opossum orangutan parakeet partridge peacock petrel piglet polecat ' +
  'poodle prawn pug python quokka quetzal ram redstart retriever rook salamander scallop serval shrike siskin ' +
  'skylark smelt snipe spaniel springbok stallion stoat sturgeon tamarin tanager terrier thrasher titmouse towhee ' +
  'tuatara turbot vicuna wagtail warthog waxwing whippet wigeon wildcat wolverine yellowtail zebu').split(' ');

const unique = (list, n) => [...new Set(list)].filter(w => /^[a-z]{2,12}$/.test(w)).slice(0, n);
const ADJ = unique(ADJECTIVES, 256);
const ANI = unique(ANIMALS, 256);

export function newMacName() {
  return `${ADJ[randomInt(ADJ.length)]}-${ANI[randomInt(ANI.length)]}-${randomInt(1000, 10000)}`;
}

// Suggested backup passwords: five random words, about 50 bits from these lists alone.
export function suggestPassword() {
  const pick = () => (randomInt(2) ? ADJ : ANI)[randomInt(256)];
  return Array.from({ length: 5 }, pick).join('-');
}

export const wordCounts = () => ({ adjectives: ADJ.length, animals: ANI.length });
