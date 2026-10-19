/**
 * The voice: what `/speak` asks for, which voice is tried first, and what is
 * said back.
 *
 * Run with: node --test components/speech.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { firstName, speakRequest, speakStatus, speechInfo, voiceList, voiceOrder, voiceReply,
         voiceSetting, type SpeechInfo } from "../plugins/fleet/components/speech.ts";

const VOICES = { female: ["af_sky", "af_kore", "af_nicole"], male: ["am_michael", "am_onyx"] };
const INFO: SpeechInfo = { state: "ready", reason: null, group: "female", voice: null, voices: VOICES };

test("the helper's answer is read, and anything else is not", () => {
  const read = speechInfo(JSON.stringify(INFO));
  assert.deepEqual(read, INFO);
  for (const text of ["", "null", "[]", "{\"state\": \"maybe\", \"group\": \"female\", \"voices\": {}}",
                      "{\"state\": \"ready\", \"group\": \"other\", \"voices\": {}}"]) {
    assert.equal(speechInfo(text), null, text);
  }
  // A voice that is not a name is not offered.
  const odd = speechInfo(JSON.stringify({ ...INFO, voices: { female: ["af_sky", 3], male: null } }));
  assert.deepEqual(odd?.voices, { female: ["af_sky"], male: [] });
});

test("a stored pick is kept while the configuration still lists it", () => {
  assert.deepEqual(voiceSetting({ isOn: false, voice: "male", name: "am_onyx" }, INFO),
                   { isOn: false, voice: "male", name: "am_onyx" });
  // A voice taken off the list stops being picked; the group stays.
  assert.deepEqual(voiceSetting({ isOn: true, voice: "male", name: "am_gone" }, INFO),
                   { isOn: true, voice: "male" });
  // Nothing stored, or nothing usable, is the configuration's own choice.
  assert.deepEqual(voiceSetting(undefined, INFO), { isOn: true, voice: "female" });
  assert.deepEqual(voiceSetting("loud", { ...INFO, group: "male", voice: "am_onyx" }),
                   { isOn: true, voice: "male", name: "am_onyx" });
  assert.deepEqual(voiceSetting({ voice: "robot" }, INFO), { isOn: true, voice: "female" });
});

test("/speak reads each word it knows, and refuses what contradicts itself", () => {
  const current = { isOn: true, voice: "female" as const };
  assert.equal(speakRequest("", current, VOICES), "status");
  assert.equal(speakRequest("list", current, VOICES), "list");
  assert.deepEqual(speakRequest("off", current, VOICES), { isOn: false, voice: "female" });
  assert.deepEqual(speakRequest("male", current, VOICES), { isOn: true, voice: "male" });
  assert.deepEqual(speakRequest("AM_ONYX", current, VOICES),
                   { isOn: true, voice: "male", name: "am_onyx" });
  assert.deepEqual(speakRequest("on af_kore", { isOn: false, voice: "male" }, VOICES),
                   { isOn: true, voice: "female", name: "af_kore" });
  for (const args of ["on off", "off male", "af_sky am_onyx", "loudly", "--voice"]) {
    assert.equal(speakRequest(args, current, VOICES), null, args);
  }
});

test("the voice that spoke last is tried first, then the pick, then the rest of its group", () => {
  const setting = { isOn: true, voice: "female" as const, name: "af_nicole" };
  assert.deepEqual(voiceOrder(setting, "af_kore", VOICES), ["af_kore", "af_nicole", "af_sky"]);
  assert.deepEqual(voiceOrder(setting, null, VOICES), ["af_nicole", "af_sky", "af_kore"]);
  // A last voice from the other group is not a reason to speak in it.
  assert.deepEqual(voiceOrder(setting, "am_onyx", VOICES), ["af_nicole", "af_sky", "af_kore"]);
});

test("the list marks the current voice and says when the fleet is quiet", () => {
  assert.equal(voiceList({ isOn: true, voice: "female" }, null, VOICES),
               "Voices - female: af_sky*, af_kore, af_nicole | male: am_michael, am_onyx");
  assert.match(voiceList({ isOn: false, voice: "male" }, "am_onyx", VOICES),
               /am_onyx\*.*llm-fleet is quiet\.$/);
});

test("what /speak says back names the voice, or why none spoke", () => {
  assert.equal(firstName("af_sky"), "Sky");
  assert.equal(firstName("bm_george"), "George");
  assert.equal(voiceReply("af_sky", null), "llm-fleet speaks as af_sky now.");
  assert.match(voiceReply(null, "the synthesizer exited 3"), /^llm-fleet could not speak: the synthesizer exited 3\./);
  assert.match(speakStatus({ isOn: true, voice: "female" }, null,
                           { ...INFO, state: "unavailable", reason: "speech is off in the configuration (speech.enabled)" }),
               /^llm-fleet cannot speak: speech is off in the configuration \(speech.enabled\)\./);
  assert.match(speakStatus({ isOn: false, voice: "male" }, null, INFO), /^llm-fleet is quiet \(male voice\)\./);
  assert.match(speakStatus({ isOn: true, voice: "female" }, "af_kore", INFO), /^llm-fleet speaks as af_kore\./);
});
