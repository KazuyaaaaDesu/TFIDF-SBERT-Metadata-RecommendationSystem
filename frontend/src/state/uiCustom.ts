/**
 * The player's UI customizations, shared live between the cheat console, the
 * developer panels and the app itself. The source of truth is local storage;
 * every change is written there and announced, and the theme provider
 * re-applies the document.
 */

import { useCallback, useSyncExternalStore } from "react";

import { SECRETS, secretForWord, type Secret } from "../data/secrets";
import {
  DEFAULT_UI_CUSTOM,
  UI_CUSTOM_EVENT,
  UI_CUSTOM_KEY,
  normalize,
  readUiCustom,
  writeUiCustom,
  type LiveBackground,
  type SkinId,
  type UiCustom,
} from "../utils/uiCustom";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(UI_CUSTOM_EVENT, onChange);
  window.addEventListener("storage", onChange);

  return () => {
    window.removeEventListener(UI_CUSTOM_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** A string snapshot, so React only re-renders when something changed. */
const snapshot = () => {
  try {
    return window.localStorage.getItem(UI_CUSTOM_KEY) ?? "";
  } catch {
    return "";
  }
};

export function setUiCustom(patch: (current: UiCustom) => UiCustom) {
  writeUiCustom(patch(readUiCustom()));
}

export function isSecretOn(custom: UiCustom, secret: Secret): boolean {
  switch (secret.kind) {
    case "skin":
      return custom.skin === secret.skin;
    case "crt":
      return custom.crt;
    case "pixelFont":
      return custom.pixelFont;
    case "live":
      return custom.live.on;
  }
}

/** Turn a secret on or off, and remember that it has been found. */
export function toggleSecret(secret: Secret, force?: boolean): { on: boolean; found: boolean } {
  const before = readUiCustom();
  const found = !before.discovered.includes(secret.id);
  const on = force ?? !isSecretOn(before, secret);

  setUiCustom((c) => {
    const next: UiCustom = {
      ...c,
      discovered: c.discovered.includes(secret.id) ? c.discovered : [...c.discovered, secret.id],
    };

    switch (secret.kind) {
      case "skin":
        next.skin = on ? (secret.skin as SkinId) : null;
        break;
      case "crt":
        next.crt = on;
        break;
      case "pixelFont":
        next.pixelFont = on;
        break;
      case "live":
        next.live = { ...c.live, on };
        break;
    }

    return next;
  });

  return { on, found };
}

/** Switch every look and effect off (keeps what has been found). */
export function resetLooks() {
  setUiCustom((c) => ({
    ...DEFAULT_UI_CUSTOM,
    live: { ...DEFAULT_UI_CUSTOM.live, scene: c.live.scene, dim: c.live.dim },
    wallpaper: c.wallpaper,
    type: c.type,
    discovered: c.discovered,
  }));
}

export function useUiCustom() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "");
  let custom = DEFAULT_UI_CUSTOM;

  try {
    custom = normalize(raw ? JSON.parse(raw) : null);
  } catch {
    custom = DEFAULT_UI_CUSTOM;
  }

  const setLive = useCallback((patch: Partial<LiveBackground>) => {
    setUiCustom((c) => ({ ...c, live: { ...c.live, ...patch } }));
  }, []);

  return { custom, setLive, SECRETS, secretForWord };
}
