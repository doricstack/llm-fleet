#!/usr/bin/env python3
"""Rate-card parsing, driven through pages captured from each provider.

Each fixture is the provider's own published page as fetched on 2026-10-20,
with the characters this repository's format check refuses swapped for ASCII
(typographic dashes and quotes, a byte order mark, zero-width and no-break
spaces). The cases that matter are the ones where the page is not what the
parser expects: a model the card does not list, a table whose shape moved, a
host the card does not name, and the invisible characters a real page carries.
Each must refuse by name rather than price a model with another one's rate.

Run with: python3 tests/test_rate_cards.py -v
"""

from pathlib import Path
import json
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)

from readers import rate_cards
from readers.rate_cards import RateError


CARDS = Path(__file__).resolve().parent / "fixtures" / "rate-cards"


def page(name: str) -> str:
    return (CARDS / name).read_text(encoding="utf-8")


class AnthropicTests(unittest.TestCase):
    def test_each_generation_reads_its_own_row(self) -> None:
        text = page("anthropic.md")
        self.assertEqual(rate_cards.parse("anthropic", text, "opus-5-5"),
                         [{"input": 4.0, "cacheRead": 0.2, "output": 20.0}])
        self.assertEqual(rate_cards.parse("anthropic", text, "fable-5-1"),
                         [{"input": 10.0, "cacheRead": 0.25, "output": 50.0}])
        # The page prices Sonnet 5.5 cache hits at a twentieth of input, not a tenth.
        self.assertEqual(rate_cards.parse("anthropic", text, "sonnet-5-5"),
                         [{"input": 2.0, "cacheRead": 0.1, "output": 10.0}])

    def test_a_generation_is_not_read_from_a_longer_name(self) -> None:
        text = page("anthropic.md")
        # "Opus 5" must not take the "Opus 5.5" row, nor "Fable 5" the "Fable 5.1" one.
        self.assertEqual(rate_cards.parse("anthropic", text, "opus-5"),
                         [{"input": 5.0, "cacheRead": 0.5, "output": 25.0}])
        self.assertEqual(rate_cards.parse("anthropic", text, "fable-5"),
                         [{"input": 10.0, "cacheRead": 1.0, "output": 50.0}])

    def test_a_tiered_model_reads_its_base_tier(self) -> None:
        # Haiku 5.5 lists a row for prompts up to 100,000 tokens and one above.
        rates = rate_cards.parse("anthropic", page("anthropic.md"), "haiku-5-5")
        self.assertEqual(rates, [{"input": 0.1, "cacheRead": 0.01, "output": 0.5}])

    def test_a_model_the_card_does_not_list_is_refused(self) -> None:
        with self.assertRaisesRegex(RateError, "not on the card"):
            rate_cards.parse("anthropic", page("anthropic.md"), "opus-9-9")

    def test_a_moved_column_is_refused(self) -> None:
        text = page("anthropic.md").replace("| Output tokens ", "| Output ", 1)
        with self.assertRaisesRegex(RateError, "column"):
            rate_cards.parse("anthropic", text, "opus-5-5")


class DeepSeekTests(unittest.TestCase):
    def test_both_periods_are_read(self) -> None:
        rates = rate_cards.parse("deepseek", page("deepseek.html"), "deepseek-flash")
        self.assertEqual(rates, [{"input": 0.15, "cacheRead": 0.003, "output": 0.6},
                                 {"input": 0.3, "cacheRead": 0.006, "output": 1.2}])

    def test_the_other_column_is_its_own_model(self) -> None:
        flash = rate_cards.parse("deepseek", page("deepseek.html"), "deepseek-flash")
        pro = rate_cards.parse("deepseek", page("deepseek.html"), "deepseek-v4-pro")
        self.assertNotEqual(flash, pro)
        self.assertEqual(len(pro), 2)

    def test_invisible_characters_in_a_live_page_are_read_through(self) -> None:
        # The live page carries zero-width spaces and the fixture does not.
        text = page("deepseek.html").replace("deepseek-flash", "deepseek-\u200bflash", 1)
        text = "\ufeff" + text.replace("$0.15", "$\u00a00.15", 1)
        rates = rate_cards.parse("deepseek", text, "deepseek-flash")
        self.assertEqual(rates[0], {"input": 0.15, "cacheRead": 0.003, "output": 0.6})

    def test_a_model_the_card_does_not_list_is_refused(self) -> None:
        with self.assertRaisesRegex(RateError, "not on the card"):
            rate_cards.parse("deepseek", page("deepseek.html"), "deepseek-r9")


class KimiTests(unittest.TestCase):
    def test_the_model_row_is_read(self) -> None:
        self.assertEqual(rate_cards.parse("kimi", page("kimi.md"), "kimi-k2.7-code"),
                         [{"input": 0.95, "cacheRead": 0.19, "output": 4.0}])

    def test_a_model_the_card_does_not_list_is_refused(self) -> None:
        with self.assertRaisesRegex(RateError, "not on the card"):
            rate_cards.parse("kimi", page("kimi.md"), "kimi-k9")


class MimoTests(unittest.TestCase):
    def test_the_realtime_row_is_read(self) -> None:
        self.assertEqual(rate_cards.parse("mimo", page("mimo.md"), "mimo-v2.6-flash"),
                         [{"input": 0.14, "cacheRead": 0.0028, "output": 0.28}])

    def test_a_page_without_the_overseas_section_is_refused(self) -> None:
        text = page("mimo.md").replace("### Overseas Pricing of the Model", "### Pricing")
        with self.assertRaisesRegex(RateError, "section"):
            rate_cards.parse("mimo", text, "mimo-v2.6-flash")


class OpenRouterTests(unittest.TestCase):
    def test_the_named_host_is_read(self) -> None:
        rates = rate_cards.parse("openrouter", page("openrouter.json"),
                                 "deepseek/deepseek-v4.1-flash", host="Together")
        self.assertEqual(rates, [{"input": 0.3, "cacheRead": 0.006, "output": 1.2}])

    def test_a_card_without_a_host_is_refused(self) -> None:
        # One model, many hosts, many prices: which one served the session is
        # not on the page, and the highest of thirty is nobody's bill.
        with self.assertRaisesRegex(RateError, "host"):
            rate_cards.parse("openrouter", page("openrouter.json"), "deepseek/deepseek-v4.1-flash")

    def test_a_host_the_model_does_not_run_on_is_refused(self) -> None:
        with self.assertRaisesRegex(RateError, "host"):
            rate_cards.parse("openrouter", page("openrouter.json"),
                             "deepseek/deepseek-v4.1-flash", host="Nobody")

    def test_another_model_answer_is_refused(self) -> None:
        with self.assertRaisesRegex(RateError, "model"):
            rate_cards.parse("openrouter", page("openrouter.json"), "z-ai/glm-5.3",
                             host="Together")

    def test_a_host_with_an_unknown_cache_price_is_refused(self) -> None:
        document = json.loads(page("openrouter.json"))
        for endpoint in document["data"]["endpoints"]:
            if endpoint["provider_name"] == "Together":
                endpoint["pricing"].pop("input_cache_read", None)
                endpoint["supports_implicit_caching"] = True
        with self.assertRaisesRegex(RateError, "incomplete"):
            rate_cards.parse("openrouter", json.dumps(document), "deepseek/deepseek-v4.1-flash",
                             host="Together")


class ParserTests(unittest.TestCase):
    def test_an_unknown_parser_is_refused(self) -> None:
        with self.assertRaisesRegex(RateError, "no parser"):
            rate_cards.parse("guesswork", "anything", "opus-5-5")

    def test_a_negative_or_missing_rate_is_refused(self) -> None:
        text = page("kimi.md").replace('{"$"}0.95', '{"$"}-0.95', 1)
        self.assertNotEqual(text, page("kimi.md"))
        with self.assertRaises(RateError):
            rate_cards.parse("kimi", text, "kimi-k2.7-code")

    def test_the_parsers_named_are_the_ones_that_run(self) -> None:
        self.assertEqual(set(rate_cards.PARSERS),
                         {"anthropic", "deepseek", "kimi", "mimo", "openrouter"})


if __name__ == "__main__":
    unittest.main()
