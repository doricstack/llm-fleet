"""Rate cards: a provider's own published price page, read into per-model rates.

Each parser reads one provider's page as that provider publishes it and returns
the rates it lists for one model, in US dollars per million tokens:

    {"input": <uncached input>, "cacheRead": <cache hit>, "output": <output>}

A page can list more than one rate for a model (DeepSeek prices peak and
off-peak hours apart), so a parser returns a list. Nothing is ever inferred: a
model the page does not list, a column that moved, a cell holding two prices or
none, and a host the page does not name all raise `RateError` with the reason,
and the caller keeps the rate it had rather than price a model at another one's.

Vendor JavaScript is never evaluated: the Kimi page is read as literal text.
"""

from __future__ import annotations

from html.parser import HTMLParser
import json
import math
import re
from typing import Any, Callable


# The bounds a page's tables are read within, so a hostile or broken page
# cannot make the reader allocate without end.
SPAN_LIMIT = 128
CELL_LIMIT = 50000
ROW_LIMIT = 10000
# Characters a live page carries that change no price: a byte order mark,
# zero-width spaces and joiners, and the no-break spaces typography puts in
# "$ 0.15". Written as code points so this file holds none of them.
INVISIBLE = {0xFEFF: None, 0x200B: None, 0x200C: None, 0x200D: None, 0x2060: None}
SPACES = {0x00A0: " ", 0x202F: " ", 0x2009: " "}


class RateError(ValueError):
    """The page does not price the requested model unambiguously."""


def number(value: Any) -> float:
    """A finite, non-negative rate, or a refusal."""
    if isinstance(value, bool):
        raise RateError("a rate is not a number")
    try:
        result = float(value)
    except (ValueError, TypeError, OverflowError) as exc:
        raise RateError("a rate is missing") from exc
    if not math.isfinite(result) or result < 0:
        raise RateError("a rate is not a finite price")
    return result


def clean(text: str) -> str:
    return text.translate(INVISIBLE).translate(SPACES)


def dollars(text: str) -> list[float]:
    return [number(value) for value in re.findall(r"\$\s*([0-9]+(?:\.[0-9]+)?)", text)]


def label(text: str) -> str:
    return re.sub(r"[^a-z]", "", text.lower())


class Document(HTMLParser):
    """A page's text and its tables, with row and column spans expanded."""

    def __init__(self, source: str) -> None:
        super().__init__()
        self.text: list[str] = []
        self.tables: list[list[list[str]]] = []
        self.table: list[list[str]] | None = None
        self.row: list[str] | None = None
        self.cell: list[str] | None = None
        self.spans: dict[int, tuple[str, int]] = {}
        self.rowspan = self.colspan = 1
        self.skip = 0
        self.cells = self.rows = 0
        self.feed(source)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("script", "style"):
            self.skip += 1
        if self.skip:
            return
        values = dict(attrs)
        if tag == "table":
            self.table, self.spans = [], {}
        elif tag == "tr" and self.table is not None:
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []
            try:
                self.rowspan = int(values.get("rowspan") or 1)
                self.colspan = int(values.get("colspan") or 1)
            except ValueError as exc:
                raise RateError("a table span is not a number") from exc
            if not 1 <= self.rowspan <= SPAN_LIMIT or not 1 <= self.colspan <= SPAN_LIMIT:
                raise RateError("a table span is out of bounds")

    def handle_data(self, data: str) -> None:
        if self.skip:
            return
        self.text.append(data)
        if self.cell is not None:
            self.cell.append(data)

    def add(self, value: str) -> None:
        self.cells += 1
        if self.cells > CELL_LIMIT:
            raise RateError("the page's tables are out of bounds")
        assert self.row is not None
        self.row.append(value)

    def fill_spans(self) -> None:
        assert self.row is not None
        while len(self.row) in self.spans:
            index = len(self.row)
            value, remaining = self.spans.pop(index)
            self.add(value)
            if remaining > 1:
                self.spans[index] = (value, remaining - 1)

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self.skip:
            self.skip -= 1
            return
        if self.skip:
            return
        if tag in ("td", "th") and self.cell is not None and self.row is not None:
            self.fill_spans()
            value = " ".join(" ".join(self.cell).split()).strip("*` ")
            for _ in range(self.colspan):
                index = len(self.row)
                self.add(value)
                if self.rowspan > 1:
                    self.spans[index] = (value, self.rowspan - 1)
            self.cell = None
        elif tag == "tr" and self.row is not None and self.table is not None:
            self.fill_spans()
            self.rows += 1
            if self.rows > ROW_LIMIT:
                raise RateError("the page's tables are out of bounds")
            self.table.append(self.row)
            self.row = None
        elif tag == "table" and self.table is not None:
            self.tables.append(self.table)
            self.table = None


def one_price(cell: str) -> float:
    values = dollars(cell)
    if len(values) != 1:
        raise RateError("a price cell holds {0} prices".format(len(values)))
    return values[0]


def columns(header: list[str], titles: dict[str, str]) -> dict[str, int]:
    """Each field's column, found by its title, or a refusal when one moved."""
    found = {}
    for field, title in titles.items():
        matches = [index for index, cell in enumerate(header) if label(cell) == label(title)]
        if len(matches) != 1:
            raise RateError("the {0} column moved".format(title))
        found[field] = matches[0]
    return found


def anthropic(source: str, model: str) -> list[dict[str, float]]:
    """The Markdown pricing page; a row's name, "Claude Opus 5.5", is generation "opus-5-5".

    A model priced in tiers by prompt length (Haiku 5.5) lists its base tier
    first, and the first row of a generation is the one read.
    """
    header: list[str] | None = None
    for line in source.splitlines():
        if not line.lstrip().startswith("|"):
            header = None
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if header is None:
            header = cells
            continue
        if set("".join(cells)) <= set(":- "):
            continue
        if "model" not in label(header[0]) or not any("Claude" in cell for cell in cells[:1]):
            continue
        name = re.sub(r"\(.*", "", cells[0]).strip()
        generation = re.sub(r"[\s.]+", "-", name.lower().removeprefix("claude ").strip())
        if generation != model:
            continue
        where = columns(header, {"input": "Base input tokens",
                                 "cacheRead": "Cache hits and refreshes",
                                 "output": "Output tokens"})
        return [{field: one_price(re.sub(r"<sup>.*?</sup>", "", cells[index]))
                 for field, index in where.items()}]
    raise RateError("{0} is not on the card".format(model))


def deepseek(source: str, model: str) -> list[dict[str, float]]:
    """The HTML pricing table, one column per model and a row per price and period."""
    for table in Document(source).tables:
        header = next((row for row in table if row and row[0] == "MODEL"), [])
        matches = [index for index, cell in enumerate(header)
                   if re.match(re.escape(model) + r"(?:\s|\(|$)", cell)]
        if len(matches) != 1:
            continue
        priced = [index for index, cell in enumerate(header) if cell != "MODEL"]
        periods: dict[str, dict[str, float]] = {"OFF-PEAK": {}, "PEAK": {}}
        for row in table:
            joined = " ".join(row).upper()
            field = ("cacheRead" if "CACHE HIT" in joined else "input" if "CACHE MISS" in joined
                     else "output" if "OUTPUT TOKENS" in joined else None)
            if field is None:
                continue
            for period, rates in periods.items():
                if period not in row:
                    continue
                values = [dollars(cell) for cell in row if dollars(cell)]
                if len(values) != len(priced) or any(len(value) != 1 for value in values):
                    raise RateError("the pricing table changed shape")
                rates[field] = values[priced.index(matches[0])][0]
        if all(set(rates) == {"input", "cacheRead", "output"} for rates in periods.values()):
            return list(periods.values())
        raise RateError("the pricing table changed shape")
    raise RateError("{0} is not on the card".format(model))


def kimi(source: str, model: str) -> list[dict[str, float]]:
    """The MDX pricing page's literal table rows."""
    for block in re.findall(r"<DocTable\b(.*?)\]\}\s*/>", source, re.S):
        titles = [title for title in re.findall(r'title:\s*"([^"]+)"', block) if "Price" in title]
        for line in block.splitlines():
            if not re.match(r'\s*\["' + re.escape(model) + r'"\s*,', line):
                continue
            if any("Cache Write" in title for title in titles):
                raise RateError("the card prices cache writes, which this reads no rate for")
            values = re.findall(r'\{"\$"\}\s*([^<\s,]+)', line)
            if len(values) != len(titles):
                raise RateError("the price cells changed shape")
            where = columns(titles, {"cacheRead": "Input Price (Cache Hit)",
                                     "input": "Input Price (Cache Miss)",
                                     "output": "Output Price"})
            return [{field: number(values[index]) for field, index in where.items()}]
    raise RateError("{0} is not on the card".format(model))


def mimo(source: str, model: str) -> list[dict[str, float]]:
    """The Markdown page's overseas real-time table, in US dollars."""
    parts = source.split("### Overseas Pricing of the Model", 1)
    if len(parts) != 2:
        raise RateError("the overseas pricing section is not on the page")
    for table in Document(parts[1]).tables:
        if not table or not table[0] or label(table[0][0]) != "inferencetype":
            continue
        header = table[0]
        name = next((index for index, cell in enumerate(header) if label(cell) == "modelname"), None)
        if name is None:
            raise RateError("the model column moved")
        for row in table[1:]:
            if not row or "Real-time API" not in row[0] or len(row) != len(header):
                continue
            if re.match(r"`?" + re.escape(model) + r"`?(?:\s|$|\()", row[name]):
                where = columns(header, {"cacheRead": "Input (Cache Hit)",
                                         "input": "Input (Cache Miss)", "output": "Output"})
                return [{field: one_price(row[index]) for field, index in where.items()}]
    raise RateError("{0} is not on the card".format(model))


def openrouter(source: str, model: str, host: str) -> list[dict[str, float]]:
    """The endpoints answer for one model, read for the host the card names.

    One model runs on many hosts at many prices, and which served a session is
    not on the page, so a card names its host and an unnamed one is refused.
    """
    if not host:
        raise RateError("an OpenRouter card must name its host")
    try:
        data = json.loads(source)["data"]
    except (ValueError, KeyError, TypeError) as exc:
        raise RateError("the answer is not the endpoints document") from exc
    if not isinstance(data, dict) or data.get("id") != model:
        raise RateError("the answer is for another model")
    hosts = {name.strip().casefold() for name in host.split(",") if name.strip()}
    rates = []
    for endpoint in data.get("endpoints") or []:
        if not isinstance(endpoint, dict) or str(endpoint.get("provider_name", "")).casefold() not in hosts:
            continue
        prices = endpoint.get("pricing") or {}
        # A missing cache price is unknown, unless the host says it has no cache.
        hit = prices.get("input_cache_read")
        if hit is None and endpoint.get("supports_implicit_caching") is False:
            hit = prices.get("prompt")
        try:
            rates.append({"input": number(prices.get("prompt")) * 1e6,
                          "cacheRead": number(hit) * 1e6,
                          "output": number(prices.get("completion")) * 1e6})
        except RateError as exc:
            raise RateError("the host's rates are incomplete") from exc
    if not rates:
        raise RateError("the model does not run on host {0}".format(host))
    return [{field: round(value, 6) for field, value in rate.items()} for rate in rates]


PARSERS: dict[str, Callable[..., list[dict[str, float]]]] = {
    "anthropic": anthropic, "deepseek": deepseek, "kimi": kimi, "mimo": mimo,
    "openrouter": openrouter,
}


def parse(parser: str, source: str, model: str, host: str = "") -> list[dict[str, float]]:
    """The rates a page lists for a model, through the named parser."""
    read = PARSERS.get(parser)
    if read is None:
        raise RateError("no parser is named {0}".format(parser))
    text = clean(source)
    if parser == "openrouter":
        return openrouter(text, model, host)
    return read(text, model)
