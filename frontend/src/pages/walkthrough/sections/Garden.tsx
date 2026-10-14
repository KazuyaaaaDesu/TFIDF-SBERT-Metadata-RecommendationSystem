import { Chip, WikiCite, WikiSection, WikiSub, WikiTable } from "../wiki";
import { P, WikiGallery, WikiNote, WikiSteps, WikiThumb } from "../wikiMedia";

const CHARMS: [string, string, string, string][] = [
  ["Crimson Maple", "keys · creeper · squirrel", "blaze · syrup", "Maple Keys, Scarlet Creeper, Red Squirrel, Autumn Blaze, Sap Bucket"],
  ["Royal Oak", "mast · daisies · jay", "dapple · hollow", "Acorn Mast, Oxeye Daisies, Blue Jay, Dappled Light, Owl Hollow"],
  ["Silver Birch", "catkins · anemone · woodpecker", "moonbeam · ribbons", "Catkins, Wood Anemones, Woodpecker, Moonbeam, Bark Ribbons"],
  ["American Elm", "coins · wisteria · oriole", "shade · lantern", "Seed Coins, Wisteria Swags, Oriole's Nest, Avenue Shade, Avenue Lamp"],
  ["Giant Redwood", "drip · ferns · slug", "mist · grove", "Fog Drip, Sword Ferns, Banana Slug, Coastal Mist, Family Grove"],
  ["Giant Beanstalk", "pods · beans · hen", "gleam · harp", "Bean Pods, Magic Beans, Golden Hen, Golden Gleam, Golden Harp"],
  ["Rose Supervine", "petals · brambles · butterfly", "blush · rapier", "Rose Petals, Thorn Brambles, Blue Butterfly, Rose Blush, Rose Rapier"],
];

export function GardenPage() {
  return (
      <WikiSection id="garden" title="The Garden and the Tree of Knowledge">
        <WikiThumb id="garden-card" width={460} />
        <P>
          The Lab's <Chip>Garden</Chip> tab grows a pixel-art tree from a winged seed to an ancient giant. It is
          the system's playful layer, and it is also functional: the tree teaches one fact about the
          system per question, and growing it past its Young stage unlocks the Pro tabs of My Library.
          A demo Pro Pack in the Sun Shop ($4.99, nothing is charged) unlocks them too, with a bundle of fertilizer, tree tokens and a seed pack; the secret quests, Pet and Garden, are still yours to finish.
          Everything in the garden is drawn procedurally on a small canvas and scaled by whole
          pixels, so the art stays crisp at any window size.
        </P>
        <P>
          The garden card is built from a carved menu at the top (wood, slate stone, parchment, midnight, meadow or blossom: pick the frame from the Frame menu at its top right; the Dev switch sits beside it), the meadow with the tree and, under
          it, an action bar (<Chip>Ask the tree</Chip>, <Chip>Buy fertilizer</Chip>, <Chip>Reset progress</Chip>).
          A <Chip>Tree info</Chip> panel at the lower left carries the species' dossier, and a button at
          the lower right paints the tree in an alternative color scheme.
        </P>

        <WikiSub id="garden-menu" title="The carved menu">
          <WikiThumb id="garden-menu" float="center" width={820} />
          <WikiTable
            headers={["Group", "Contents"]}
            rows={[
              [<Chip key="t">Seed bank</Chip>, "Seven species as trading cards: rarity pips and price on top, the tree in an art window, a name banner and a footer. The planted card is lit and raised; locked cards are dashed with a padlock and a price in growth tokens until you buy their skin."],
              [<Chip key="f">Feed</Chip>, "The growth counter (packets fed so far), your fertilizer in hand and a multiplier (1×, 2×, 10×) for how many packets one click feeds."],
              [<Chip key="a">Almanac</Chip>, "Charms (n of 5 unlocked), Scene (free scenery switches) and Earn (how to get more sun)."],
              [<Chip key="s">Shop</Chip>, "Sun shop, Skins, Themes and a Developer tab."],
            ]}
          />
          <P>
            The line beside the title names the tree's current stage, its true height and how
            many of its facts it has taught you so far ("Elder tree · 1000 ft · 0/55 learned").
          </P>
        </WikiSub>

        <WikiSub id="garden-growth" title="Growth: seven stages in 3,000 packets">
          <P>
            Sun is the currency. You earn it by visiting each day, petting the pet, asking help
            questions, finding treasures, unlocking achievements and discovering tips, and you spend it
            in the Sun shop on fertilizer, which is fed to the tree packet by packet. 3,000 packets take
            a seed to the top of the climb. The stages are equally spaced: Seed, Seedling, Sapling,
            Young, Mature, Giant and Ancient. Every height label is the tree's actual painted height,
            measured against the ancient crown, so 1,000 ft is always a fully grown tree.
          </P>
          <WikiGallery
            title="One maple, seed to ancient (fertilizer 0, 400, 900, 1,450, 2,000, 2,580 and 3,000)"
            cols={4}
            ids={[
              "garden-stage-seed", "garden-stage-seedling", "garden-stage-sapling", "garden-stage-young",
              "garden-stage-mature", "garden-stage-ancient", "garden-stage-summit",
            ]}
          />
          <WikiGallery
            title="The same climb, animated: press a stage chip and the tree morphs up the stages"
            cols={1}
            ids={["garden-growth"]}
          />
          <P>
            The garden opens at your real progress. The stage chip at the top of the meadow is a
            dropdown: you can preview any stage you have already conquered, and the tree morphs between
            them quickly in both directions (the roots and trunk grow as transitions). You can never
            preview a stage you have not reached. Once the tree is taller than the window, a viewer
            unlocks: drag, scroll or use the arrows at the bottom right to climb up and down the trunk,
            and the button at the top right makes the card full screen.
          </P>
        </WikiSub>

        <WikiSub id="garden-species" title="Seven species, each from its own reference">
          <P>
            Each species has its own leaf shape, bark texture, growth curve, stage lines and charms, drawn
            from its real botany: the maple's palmate five-lobed leaf, the oak's rounded lobes, the
            birch's toothed, pointed oval on white peeling bark, the elm's lopsided leaf and netted
            ridges, the redwood's flat needle sprays on a red fibrous trunk. Two more come from stories:
            Jack's beanstalk, a slim stalk of broad heart-shaped leaves that sways a little and climbs
            into banks of cloud (at the very top of its climb stands the giant's cloud castle, paler than the sleeper's, with a huge door and a golden harp in its window, with fireflies and drifting sparks of magic instead of sylphs), and the rose
            supervine, a rose shrub thickened into a thorny vine, with scalloped crimson and pink
            blooms among sprigs of leaves and, at the top of its climb, the briar rose castle where the
            sleeper lies (grey brick, a rose window, a door ajar on her bed, and canes that keep creeping up the towers).
            Branches fork like a binary tree, slightly outward, so every crown is different. Higher up the trunk the view
            shows hanging vines, sylphs and sun shafts, and at the summit clouds, twigs and many leaves.
          </P>
          <WikiGallery cols={3} ids={["garden-species-oak", "garden-species-birch", "garden-species-elm", "garden-species-redwood", "garden-species-beanstalk", "garden-species-rosevine"]} />
          <WikiGallery
            title="Five more species growing, seed to summit"
            cols={2}
            ids={["garden-growth-birch", "garden-growth-elm", "garden-growth-redwood", "garden-growth-beanstalk", "garden-growth-rosevine"]}
          />
          <P>
            Each tree can also be painted in three alternative color schemes (plus its original), chosen
            with the button at the bottom right of the meadow: for the maple Golden Hour, Spring Green and
            Plum Dusk; for the oak Autumn Russet, Frosted Blue and Cherry Blossom; and so on. The choice
            is remembered per species.
          </P>
        </WikiSub>

        <WikiSub id="garden-knowledge" title="The Tree of Knowledge">
          <WikiThumb id="garden-ask" width={420} />
          <P>
            Press <Chip>Ask the tree</Chip> and it answers with one fact about the system, in the speech
            bubble beside the crown. Facts unlock with height, so a young tree knows little; later asks
            repeat the facts you already hold. The first three questions in half a minute are always
            answered; ask more and the tree grows impatient and sometimes just says a grumpy line
            ("Don't bother me") instead. The counter in the menu shows how many facts you have learned
            of the species' total. The tree also comments on every purchase and every milestone, with
            lines specific to its species and stage.
          </P>
          <WikiThumb id="garden-tree-info" float="left" width={420} />
          <P>
            <Chip>Tree info</Chip> shows the species dossier (its Latin name, a fact and the research on it);{" "}
            <Chip>Get info</Chip> adds what you have learned, grouped by topic.
          </P>
        </WikiSub>

        <WikiSub id="garden-charms" title="Charms: five per tree">
          <WikiThumb id="garden-almanac-charms" width={420} />
          <P>
            As the tree grows it unlocks five <Chip>charms</Chip>: living parts of the garden that you can
            switch on and off, at 250, 450, 650, 850 and 1,000 ft. Each has a name, a kind (foliage,
            plant, creature, light and weather, relic) and a cheat word. Open <Chip>Almanac → Charms</Chip>
            and flip a peg, or type the word into the cheat console; a pop-up confirms every switch and
            closes itself after ten seconds. A charm that is still locked shows how many feet remain.
            A feeding always announces the word at the height it just crossed.
          </P>
          <WikiCite ids={["garden-charm-word-pairing"]} />
          <WikiTable
            headers={["Species", "250 / 450 / 650 ft", "850 / 1,000 ft", "Names"]}
            rows={CHARMS}
          />
          <WikiThumb id="garden-charms-on" float="center" width={640} />
          <P>
            The creatures are interactive: click or tap the squirrel, the jay, the woodpecker, the
            oriole, the slug, the golden hen or the blue butterfly and they react (a chatter, a hop and a
            flight, a drum roll, a song, a curl, a golden egg, a new bloom to land on). The trunk
            creatures live on the bare part of the trunk that is on screen: the squirrel runs on the
            ground, climbs up when the tree grows and comes down when it shrinks (or when you step back
            to an earlier stage), always facing the tree. The scarlet creeper grows up the trunk as the
            tree grows.
          </P>
        </WikiSub>

        <WikiSub id="garden-scene" title="Scene switches and shops">
          <WikiThumb id="garden-almanac-scene" width={380} />
          <P>
            <Chip>Almanac → Scene</Chip> is never locked. Twenty switches in four groups (Sky and ground,
            The tree, The climb, Particles) turn clouds, fireflies, the fence and house, tumbling leaves,
            birds, trunk vines, sap glow, hanging vines, sylphs, sun shafts, the crown shadow and the
            summit clouds on and off, with All on and All off buttons. The Particles group (falling
            leaves, pollen, motes of light, haze, specks drifting over the pages) is off by default;
            the treasure glints of the scavenger hunt are on.
          </P>
          <WikiGallery cols={3} ids={["garden-earn", "garden-sun-shop", "garden-skins", "garden-themes", "garden-dev"]} />
          <WikiTable
            headers={["Shop", "What it sells"]}
            rows={[
              ["Sun shop", "Fertilizer in bundles, paid in sun or growth tokens; a purchase lands in your hand, ready to feed to the tree."],
              ["Tree skins", "The other four species (the maple is free). A skin is bought once, with growth tokens, and planted from the Tree row."],
              ["Theme shop", "Seven backdrop scenes: Meadow, Winter, Desert, Shore, Violet Keep, Rose Ruins and Frost Spire. The scene follows your local time of day."],
              ["Developer", "A test wallet, the Pro override and the list of every hidden look, found or not."],
            ]}
          />
          <WikiNote kind="warn">
            The developer tools are for testing. They are hidden in Presentation mode, and the Pro
            override is "temporary" by name: remove it once the real unlock is final.
          </WikiNote>
        </WikiSub>
      </WikiSection>
  );
}

