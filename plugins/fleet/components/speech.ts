/**
 * The voice: which one speaks, and what `/speak` asks for.
 *
 * The voices come from the configuration, through the helper that resolves it,
 * because a plugin has no configuration file of its own to read. What a person
 * picks with `/speak` is theirs, kept in the plugin's store across sessions:
 * on or off, a group, and optionally one voice by name.
 *
 * Every voice is a local synthesized one that writes a file the engine plays.
 * The platform's own synthesizer is never used: asked for a voice it does not
 * have, it speaks in its default without saying so, and a person who picked a
 * natural voice would hear a robotic one instead.
 */

export type VoiceKind = "female" | "male";
export type Voices = Record<VoiceKind, string[]>;

/** What a person picked: whether the fleet speaks, which group, and which voice in it. */
export type VoiceSetting = { isOn: boolean; voice: VoiceKind; name?: string };

/** What the helper says about speech on this machine. */
export type SpeechInfo = {
  state: "ready" | "unavailable";
  reason: string | null;
  group: VoiceKind;
  voice: string | null;
  voices: Voices;
};

export const SPEAK_USAGE = "/speak on, off, female, male, list, or a voice name.";

const KINDS: VoiceKind[] = ["female", "male"];

function isKind(value: unknown): value is VoiceKind {
  return value === "female" || value === "male";
}

/** The helper's answer, or null for anything that is not one. */
export function speechInfo(stdout: string): SpeechInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const info = value as Record<string, unknown>;
  const raw = info.voices as Record<string, unknown> | undefined;
  if ((info.state !== "ready" && info.state !== "unavailable") || !isKind(info.group)
      || typeof raw !== "object" || raw === null) {
    return null;
  }
  const voices: Voices = { female: [], male: [] };
  for (const kind of KINDS) {
    const list = raw[kind];
    voices[kind] = Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : [];
  }
  return {
    state: info.state,
    reason: typeof info.reason === "string" ? info.reason : null,
    group: info.group,
    voice: typeof info.voice === "string" ? info.voice : null,
    voices,
  };
}

/**
 * What a stored value says, or the configuration's own choice for anything it
 * cannot be. A voice the configuration no longer lists is dropped, so a sample
 * removed from the list stops being picked.
 */
export function voiceSetting(stored: unknown, info: SpeechInfo): VoiceSetting {
  const fallback: VoiceSetting = {
    isOn: true, voice: info.group,
    ...(info.voice !== null && info.voices[info.group].includes(info.voice) ? { name: info.voice } : {}),
  };
  if (typeof stored !== "object" || stored === null) {
    return fallback;
  }
  const value = stored as { isOn?: unknown; voice?: unknown; name?: unknown };
  const voice = isKind(value.voice) ? value.voice : fallback.voice;
  const name = typeof value.name === "string" && info.voices[voice].includes(value.name)
    ? value.name : voice === fallback.voice ? fallback.name : undefined;
  return {
    isOn: typeof value.isOn === "boolean" ? value.isOn : fallback.isOn,
    voice,
    ...(name !== undefined ? { name } : {}),
  };
}

/** What `/speak <args>` asks for: a new setting, the status, the list, or nothing it knows. */
export function speakRequest(args: string, current: VoiceSetting,
                             voices: Voices): VoiceSetting | "status" | "list" | null {
  const text = args.trim().toLowerCase();
  if (text === "") {
    return "status";
  }
  let isOn: boolean | undefined;
  let selection: VoiceSetting | undefined;
  let selectedWord: string | undefined;
  let list = false;
  for (const word of text.split(/\s+/)) {
    if (word === "list") {
      list = true;
    } else if (word === "on" || word === "off") {
      const requested = word === "on";
      // Refused rather than last-word-wins, which would make the meaning hang
      // on the order the words were typed in.
      if (isOn !== undefined && isOn !== requested) {
        return null;
      }
      isOn = requested;
    } else {
      const voice = KINDS.find((kind) => word === kind || voices[kind].includes(word));
      if (voice === undefined) {
        return null;
      }
      if (selectedWord !== undefined && selectedWord !== word) {
        return null;
      }
      selectedWord = word;
      selection = { isOn: true, voice, ...(word === voice ? {} : { name: word }) };
    }
  }
  // Picking a voice switches speech on, so off with a pick asks for both.
  if (isOn === false && selection !== undefined) {
    return null;
  }
  if (list) {
    return "list";
  }
  const setting = selection ?? current;
  return { ...setting, isOn: isOn ?? setting.isOn };
}

/** The voices to try, in order: the one that spoke last, the pick, then the rest of the group. */
export function voiceOrder(setting: VoiceSetting, last: string | null, voices: Voices): string[] {
  const group = voices[setting.voice];
  const first = [last, setting.name].filter(
    (name): name is string => typeof name === "string" && group.includes(name));
  return [...new Set([...first, ...group])];
}

/** The configured voices, the current one marked, and a note when the fleet is quiet. */
export function voiceList(setting: VoiceSetting, current: string | null, voices: Voices): string {
  const selected = current ?? setting.name ?? voices[setting.voice][0];
  const groups = KINDS.map((kind) => kind + ": "
    + voices[kind].map((voice) => voice + (voice === selected ? "*" : "")).join(", "));
  return "Voices - " + groups.join(" | ") + (setting.isOn ? "" : " | Fleet is quiet.");
}

/** How a voice introduces itself: `af_sky` says Sky. */
export function firstName(voice: string): string {
  const name = voice.includes("_") ? voice.slice(voice.indexOf("_") + 1) : voice;
  return name ? name[0]!.toUpperCase() + name.slice(1) : voice;
}

/** The reply once a voice has been tried: the one that spoke, or why none did. */
export function voiceReply(spoke: string | null, reason: string | null): string {
  if (spoke === null) {
    return "Fleet could not speak: " + (reason ?? "no configured voice answered") + ". "
      + SPEAK_USAGE;
  }
  return "Fleet speaks as " + spoke + " now.";
}

/** What `/speak` says when asked how things stand. */
export function speakStatus(setting: VoiceSetting, current: string | null,
                            info: SpeechInfo | null): string {
  if (info !== null && info.state !== "ready") {
    return "Fleet cannot speak: " + (info.reason ?? "speech is unavailable") + ". " + SPEAK_USAGE;
  }
  const voice = current ?? setting.name ?? setting.voice + " voice";
  return (setting.isOn ? "Fleet speaks as " + voice + ". "
    : "Fleet is quiet (" + setting.voice + " voice). ") + SPEAK_USAGE;
}
