/**
 * The cheat console: press ` (the backquote key) anywhere to open it, type
 * a cheat word, press Enter.
 *
 *   a garden charm  switches that charm of the planted tree on or off (if
 *                   the tree has grown enough to hold it)
 *   a hidden cheat  switches a whole-app look on or off, and is remembered
 *                   as found
 *   list            what is unlocked and found
 *   off             all looks and effects off
 *   dev             the developer panel
 *   help            this list
 *
 * The key is ignored while typing in a field.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { charmsFor } from "../data/charms";
import { SECRETS, secretForWord } from "../data/secrets";
import { useSun } from "../state/sun";
import { isSecretOn, resetLooks, toggleSecret, useUiCustom } from "../state/uiCustom";

export const CONSOLE_KEY = "Backquote";

const NOTHING = [
  "Nothing happens.",
  "The garden doesn't know that word.",
  "A leaf rustles somewhere. That's all.",
  "No charm answers to that.",
];

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;

  if (!el) return false;

  const tag = el.tagName;

  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export default function CheatConsole() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const { species, cheats, activeCheats, redeemCheat } = useSun();
  const { custom } = useUiCustom();
  const tries = useRef(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === CONSOLE_KEY && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (typing(event.target) && !open) return;

        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "Escape" && open) {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  if (!open) return null;

  const say = (...lines: string[]) => setLog((current) => [...current, ...lines].slice(-8));

  function run(raw: string) {
    const word = raw.trim().toLowerCase();

    if (!word) return;

    say(`> ${word}`);

    if (word === "help" || word === "?") {
      say(
        "Type a cheat word and press Enter. Words toggle.",
        "list: what you can use   off: all looks off   dev: developer panel",
      );

      return;
    }
    if (word === "list") {
      const charms = charmsFor(species)
        .filter((c) => cheats.includes(c.word))
        .map((c) => `${c.word}${activeCheats.includes(c.word) ? " (on)" : ""}`);
      const found = SECRETS.filter((s) => custom.discovered.includes(s.id)).map(
        (s) => `${s.word}${isSecretOn(custom, s) ? " (on)" : ""}`,
      );

      say(
        `charms: ${charms.length ? charms.join(", ") : "none unlocked yet"}`,
        `found: ${found.length ? found.join(", ") : "nothing yet"}`,
      );

      return;
    }
    if (word === "off" || word === "reset") {
      resetLooks();
      say("All looks and effects are off.");

      return;
    }
    if (word === "dev" || word === "developer") {
      setOpen(false);
      navigate("/settings?tab=dev");

      return;
    }

    const secret = secretForWord(word);

    if (secret) {
      const { on, found } = toggleSecret(secret);

      say(
        found ? `Secret found: ${secret.label}.` : `${secret.label}: ${on ? "on" : "off"}.`,
        on ? secret.blurb : "Back to normal.",
      );

      return;
    }

    const charm = charmsFor(species).find((c) => c.word === word);

    if (charm) {
      if (!cheats.includes(word)) {
        say(`The tree isn't tall enough yet: ${charm.label} grows at ${charm.height} ft.`);

        return;
      }

      const was = activeCheats.includes(word);
      const out = redeemCheat(word);

      say(out.ok ? `${charm.label}: ${was ? "off" : "on"}.` : out.text);

      return;
    }

    const other = SECRETS.length;

    tries.current += 1;
    say(NOTHING[(tries.current + other) % NOTHING.length]);
  }

  return (
    <div
      role="dialog"
      aria-label="Cheat console"
      data-cheat-console=""
      className="fixed inset-x-0 top-14 z-[95] mx-auto w-[min(34rem,calc(100vw-1.5rem))]"
    >
      <div className="wood-board rounded-lg border-[3px] border-[color:var(--gm-edge)] p-3 shadow-[6px_6px_0_rgba(0,0,0,0.35)]">
        <p className="wood-label mb-2 flex items-center justify-between font-mono text-[10px] font-bold uppercase tracking-[0.2em]">
          <span>Cheat console</span>
          <span className="opacity-80">` to close · Esc</span>
        </p>

        {log.length > 0 && (
          <ul
            aria-live="polite"
            className="wood-chip-inset mb-2 max-h-40 space-y-0.5 overflow-y-auto rounded border-[3px] px-2.5 py-2 font-mono text-[12px] leading-5"
          >
            {log.map((line, i) => (
              <li key={i} className={line.startsWith(">") ? "opacity-70" : ""}>
                {line}
              </li>
            ))}
          </ul>
        )}

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            run(text);
            setText("");
          }}
        >
          <input
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label="Cheat word"
            placeholder="type a cheat word…"
            autoComplete="off"
            spellCheck={false}
            className="wood-chip-inset min-h-9 min-w-0 flex-1 rounded border-[3px] px-2.5 font-mono text-[13px] placeholder:text-[color:var(--gm-text)]/60"
          />
          <button
            type="submit"
            className="wood-chip-lit rounded border-[3px] px-3 font-mono text-[11px] font-bold uppercase tracking-wider"
          >
            Enter
          </button>
        </form>
      </div>
    </div>
  );
}
