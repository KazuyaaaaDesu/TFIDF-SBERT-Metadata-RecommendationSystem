import { Chip, WikiSection, WikiSub, WikiTable } from "../wiki";
import { P, WikiGallery, WikiHatnote, WikiNote, WikiSteps, WikiThumb } from "../wikiMedia";

export function GettingStarted() {
  return (
      <WikiSection id="getting-started" title="Getting started">
        <WikiSub id="sign-in" title="Signing in and the boot screen">
          <WikiThumb id="login" width={300} />
          <P>
            Re:Search runs as a single-user local application, so the sign-in card accepts any
            well-formed email and any password; nothing is sent to a server and the choice is
            remembered in this browser (tick <Chip>Remember me</Chip> to keep it between
            sessions). <Chip>Create an account</Chip> asks for a name, an email and a password
            of at least eight characters and then behaves exactly like a sign-in.{" "}
            <Chip>Forgot password?</Chip> only explains what a hosted deployment would do.
          </P>
          <P>
            The first time you open the app in a browser session the arcade boot screen plays:
            the title <Chip>RE:SEARCH · BULSU BSMCS THESIS RECOMMENDATION SYSTEM</Chip> types
            itself out, then <Chip>PRESS START</Chip> blinks. Click anywhere or press any key to
            go in. The screen is shown once per session, never again until you close the tab.
          </P>
          <WikiGallery
            cols={4}
            ids={["register", "forgot-password", "boot-typing", "boot-press-start"]}
          />
        </WikiSub>

        <WikiSub id="home" title="The home page">
          <WikiThumb id="home-researcher" width={340} />
          <P>
            <Chip>/home</Chip> is the front desk. A search box at the top sends whatever you type
            straight to the Repository's Recommend scope, so a first query is one Enter away. Below
            it the library staff's <Chip>Announcements</Chip> are posted (editable from the site
            editor at <Chip>/admin</Chip>), and <Chip>Start here</Chip> offers four cards: Search,
            Repository, My Library and FAQ. In Library mode a banner at the bottom offers the
            switch to Researcher mode.
          </P>
        </WikiSub>

        <WikiSub id="nav" title="The top bar">
          <P>
            Everything after sign-in shares one top bar. From the left: the logo (the slime's face
            and the glitching <Chip>RE:SEARCH</Chip> title), then the page tabs, then at the right
            the <Chip>NERD</Chip> switch and the theme button. Under it an arcade attract ticker
            scrolls status lines such as the active pipeline.
          </P>
          <WikiTable
            headers={["Tab", "Opens", "Where it is covered"]}
            rows={[
              ["Repository", "The three-pane workspace: browse, search, recommend, web", "Repository, Recommending"],
              ["Upload", "Add papers by PDF, BibTeX, RIS, EndNote, DOI or arXiv id", "Upload"],
              ["My Library", "The personal shortlist and its four Pro tabs", "My Library"],
              ["Arena", "All six pipelines on one query, side by side", "Arena"],
              ["Lab", "The recipe bench and the Garden", "Lab, Garden"],
              ["Walkthrough", "This manual", "—"],
              ["Engine", "Every formula the system computes", "Engine page"],
              ["FAQ", "Short answers", "Reference"],
              ["Settings", "Site mode, labels, citation style, developer panel", "Customizing"],
              ["Changelog", "Release notes", "Reference"],
            ]}
          />
          <WikiNote kind="tip">
            Hold the pointer on any tab or labeled control for about two and a half seconds: the
            pixel pet shows a progress ring and then explains what it is. Settings → Interface can
            hide the tab labels and leave an icon-only bar; the labels stay as tooltips.
          </WikiNote>
        </WikiSub>

        <WikiSub id="mobile" title="On a phone">
          <P>
            The whole app works at phone width (shown here at 390 × 844). The top bar drops its
            tab labels and keeps icons only; the bar scrolls sideways for the last tabs
            (Settings, Changelog). Pages stack into one column: the Repository table folds into
            two-line rows (and the ranked results keep just title and score), the inspector opens
            below the list, and the Arena and Lab panels fill the width. The Garden's stage is a
            short 16:9 strip on a phone, so its Tree info card starts folded; the full-screen
            button gives the tree the whole screen. Dragging a citation link onto the Upload box
            shows the same <Chip>DROP HERE</Chip> prompt.
          </P>
          <WikiGallery
            title="Mobile view"
            cols={4}
            ids={[
              "mobile-boot",
              "mobile-login",
              "mobile-home",
              "mobile-nav",
              "mobile-repository",
              "mobile-repository-inspector",
              "mobile-recommend",
              "mobile-library",
              "mobile-upload",
              "mobile-upload-link-drop",
              "mobile-lab",
              "mobile-garden",
              "mobile-garden-fullscreen",
              "mobile-arena",
              "mobile-settings",
            ]}
          />
        </WikiSub>
      </WikiSection>
  );
}

export function SiteModes() {
  return (
      <WikiSection id="modes" title="Site modes">
        <P>
          One switch decides how much of the product you see. It lives in Settings → Site mode (and
          in the Library home banner) and is remembered per browser. Switching plays a short
          loading screen while the feature list refreshes.
        </P>
        <WikiTable
          headers={["Mode", "Who it is for", "What shows"]}
          rows={[
            [
              <Chip key="l">Library</Chip>,
              "Visitors: the \"smarter librarian\".",
              "Only the features the site editor has enabled. By default Search, Repository, My Library, FAQ, Settings and Changelog; the others are hidden or shown locked. A larger type scale makes everything friendlier.",
            ],
            [
              <Chip key="r">Researcher</Chip>,
              "The developers and the thesis panel: the full tool.",
              "Every tab, every control, Pro unlocked once the garden is grown (or by the developer override). Feature states are ignored.",
            ],
            [
              <Chip key="p">Presentation</Chip>,
              "The shipped, free version.",
              "A clean build: no developer controls, formal pipeline names, Pro locked, and only the study's own features. See below.",
            ],
          ]}
        />
        <WikiGallery
          title="Library mode"
          cols={4}
          ids={["mode-library-home", "mode-library-repository", "mode-library-locked-pro", "mode-library-gate"]}
        />

        <WikiSub id="presentation" title="Presentation mode, the build that ships">
          <WikiThumb id="mode-presentation-repository" width={340} />
          <P>
            Presentation mode hosts the product as it would be delivered. Entering it sets every
            local preference aside (skins, cheats, garden progress, layout choices, the Pro
            override) so the site opens exactly as a first-time visitor sees it; nothing is
            deleted, and leaving restores your own settings. Your sign-in is never touched.
          </P>
          <P>
            Inside it the Stats button, theme picker, layout switcher, Stats for Nerds, the pet,
            the cheat console, the garden, the ticker, scanlines and the boot screen are gone. What
            remains is what the study delivers: <Chip>Repository</Chip>, <Chip>Upload</Chip>,{" "}
            <Chip>My Library</Chip> (free tabs only), <Chip>Arena</Chip>, <Chip>Engine</Chip>,{" "}
            <Chip>FAQ</Chip> and <Chip>Settings</Chip>. Settings here is a plain account page, not
            the developer one: your name and email with <Chip>Sign out</Chip>, the interface
            labels, citation style, copy behavior, the similar-papers scope, and an About panel.
            It has a mode switch (Presentation, Library, Researcher) and no Developer tab. Pipelines carry their formal names (TF-IDF, S-BERT + Metadata) in
            place of the arcade codenames, and the Arena says <Chip>Run Arena</Chip> and{" "}
            <Chip>Win tally</Chip>. Any route outside this lineup sends you back to the Repository.
            The demo Pro purchase, made from the locked tabs of My Library, then opens the{" "}
            <Chip>Lab</Chip> as a beta (the recipe bench and the duel), the pixel pet and the tree
            of knowledge, all without their developer controls. Library mode gets the same Pro
            unlocks.
          </P>
          <WikiSteps
            steps={[
              <>Enter it from Settings → Site mode → <Chip>PRESENTATION</Chip>, or open any page with <Chip>?mode=presentation</Chip> on the address.</>,
              <>To leave, hold <Chip>P</Chip> + <Chip>R</Chip> + <Chip>O</Chip> together. A pop-up asks for the password; the right word switches to Researcher mode and puts your settings back. <Chip>?mode=researcher</Chip> also works.</>,
            ]}
          />
          <WikiGallery
            cols={4}
            ids={["mode-presentation-arena", "mode-presentation-library", "mode-presentation-engine", "mode-presentation-unlock"]}
          />
          <WikiHatnote>
            The password prompt is a door latch, not security: the site runs in the browser, so
            anything it checks can be read there.
          </WikiHatnote>
        </WikiSub>
      </WikiSection>
  );
}

