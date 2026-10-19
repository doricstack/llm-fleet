# Brand files

The vector marks live in `plugins/fleet/assets/`: the symbol, the horizontal logo and the mono ink mark, each with its light and dark pairing. Those are what the README and the desktop surfaces draw.

A terminal draws no images, so the same mark travels as text:

| File | What it is |
| --- | --- |
| `ascii-mark.txt` | The symbol alone, three bars and a dot, in pure ASCII |
| `ascii-logo.txt` | The symbol over the wordmark and the owner |

The pane's own header uses the mark inline, two cells: the bar and the dot. Pure ASCII is the rule for these files; a block glyph that a terminal font lacks renders as a box.

Colors, taken from the vector marks: ink `#0B0911`, paper `#F5F1E8`, accent `#C4F06A`.
