/**
 * Masking behavior, including what it must leave alone.
 *
 * Every rule is tested twice: once on the shape it exists to hide, and once on
 * ordinary text that must survive it. A masker that hides the wrong thing is
 * worse than none, because the pane then lies about what it is showing.
 *
 * The values here are invented. A real one written into a test would be a real
 * one published by this repository.
 *
 * Run with: node --test plugins/fleet/components/mask.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { hides, MASK, mask } from "../plugins/fleet/components/mask.ts";

function didMask(value: string): boolean {
  return mask(value).rules.length > 0;
}

test("an organization or location identifier is hidden", () => {
  assert.equal(didMask("key for the MID behind org_300382"), true);
  assert.equal(didMask("located at loc_173185"), true);
  assert.equal(mask("org_300382 and loc_173185").text, MASK + " and " + MASK);
});

test("a merchant identifier and an account number are hidden", () => {
  assert.equal(mask("MID 1234567").text, MASK);
  assert.equal(mask("MID: 1234567890").text, MASK);
  assert.equal(mask("account 1234567890").text, MASK);
  assert.equal(mask("card 4111111111111111").text, MASK);
});

test("a sign-in written with a separator is hidden", () => {
  assert.equal(mask("login: someone@example.invalid").text, MASK);
  assert.equal(mask("password=hunter2").text, MASK);
  assert.equal(mask("username = operator").text, MASK);
});

test("a sign-in written as a value that carries a digit is hidden", () => {
  assert.equal(mask("login y1avJp1mg").text, "login " + MASK);
  assert.equal(mask("(login y1avJp1mg)").text, "(login " + MASK + ")");
});

test("key material is hidden", () => {
  assert.equal(mask("token: abc123def456").text, MASK);
  assert.equal(mask("secure_key = 9f8e7d6c").text, MASK);
});

/**
 * A value in the shape of a key, joined from parts.
 *
 * The shape is what these cases test, and a key-shaped literal in this file is a
 * key-shaped literal the export would have to carry. Joining the parts keeps the
 * file publishable while the masker still sees the whole value.
 */
function shapedKey(...parts: string[]): string {
  return parts.join("");
}

test("a key carrying its vendor prefix is hidden", () => {
  const anthropic = shapedKey("sk-", "ant-", "api03-", "a".repeat(20));
  const hub = shapedKey("ghp", "_", "b".repeat(24));
  const aws = shapedKey("AKIA", "C".repeat(16));
  assert.equal(mask("key " + anthropic).text, "key " + MASK);
  assert.equal(mask("token " + hub).text, "token " + MASK);
  assert.equal(mask("id " + aws).text, "id " + MASK);
});

test("a private key block is hidden whole", () => {
  const block = shapedKey("-----BEGIN ", "RSA ", "PRIVATE KEY-----", "\n",
                          "d".repeat(40), "\n-----END ", "RSA ", "PRIVATE KEY-----");
  assert.equal(mask("here: " + block).text, "here: " + MASK);
  assert.equal(mask("here: " + block).text.includes("d".repeat(40)), false);
});

test("a credential inside a url is hidden and the url survives", () => {
  const url = "https://" + shapedKey("operator", ":", "hunter2") + "@example.invalid/path";
  assert.equal(mask(url).text, "https://" + MASK + "@example.invalid/path");
});

test("a colon after a word is not proof of a credential", () => {
  const prose = "high secret: looks like a key (a.py:4)";
  assert.deepEqual(mask(prose), { text: prose, rules: [] });
  // The same word with a value that is material is hidden.
  assert.equal(mask("secret: abc123def456").text, MASK);
  assert.equal(mask("token=9f8e7d6c1a2b").text, MASK);
});

test("ordinary text is left exactly as it was", () => {
  const ordinary = [
    "Review adapter behavior",
    "waiting 5m",
    "mid-turn",
    "the key is here",
    "login failed",
    "MID-Atlantic region",
    "org chart for the quarter",
    "the location of the file",
    "a monkey and a keyboard",
    "3 working, 1 waiting, 2 failed",
    "Which source should this adapter read?",
    "test_a_leak_is_refused",
    "task/pane-view",
    "~/skills/two/v1.2.0",
  ];
  for (const value of ordinary) {
    assert.deepEqual(mask(value), { text: value, rules: [] }, value);
  }
});

test("a hidden value is replaced, never repeated", () => {
  const secret = "org_300382";
  const masked = mask("behind " + secret);
  assert.equal(masked.text.includes(secret), false);
  assert.equal(masked.text.includes(MASK), true);
});

test("what fired is named rather than counted", () => {
  assert.deepEqual(mask("org_1 loc_2").rules, ["organization", "location"]);
  assert.deepEqual(mask("nothing to hide").rules, []);
});

test("several shapes in one line are all hidden", () => {
  const text = "Secure Transaction Key for the MID behind org_300382 / loc_173185 (login y1avJp1mg)";
  const masked = mask(text);
  assert.equal(masked.text.includes("org_300382"), false);
  assert.equal(masked.text.includes("loc_173185"), false);
  assert.equal(masked.text.includes("y1avJp1mg"), false);
  // The words around them survive, and so does the bracket that closed the value.
  assert.equal(masked.text.includes("Secure Transaction Key"), true);
  assert.equal(masked.text.endsWith(")"), true);
  // A merchant identifier with no value beside it is prose about one, not one.
  assert.deepEqual(masked.rules, ["organization", "location", "sign-in"]);
});

test("a merchant identifier with its value is hidden with it", () => {
  const masked = mask("MID behind org_300382, MID 1234567");
  assert.equal(masked.text.includes("1234567"), false);
  assert.equal(masked.rules.includes("merchant identifier"), true);
});

test("text that is not a string is nothing to mask", () => {
  for (const value of [null, undefined, 7, true, {}, []]) {
    assert.deepEqual(mask(value), { text: "", rules: [] });
  }
  assert.equal(mask("").text, "");
  assert.equal(hides(""), false);
  assert.equal(hides("org_1"), true);
});
