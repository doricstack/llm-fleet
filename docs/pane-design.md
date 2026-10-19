# Pane design

Use quiet spacing, semantic colors, and stable alignment. Color reinforces words;
it never carries a state alone, and every color-only mark sits beside the word it
repeats. Avoid decorative gauges. Density is allowed where every figure is one a
source recorded, as on an agent card; it is never filled with figures nobody
measured.

## Structure

Every section is a card: a rounded rule the surface draws, with the section's
name, its fold arrow, and its count on the heading, and its rows held inside.
The headline figures are a row of cards under the title, each a quiet label over
a bold value. Each figure is also a control: a press narrows the pane to the rows
that figure counted, and a line under the controls says so and carries the press
that widens it again. The figures keep counting the whole machine while a filter
is on, so a narrowed pane never reads as a small fleet. A row carries a dot in its state's color beside its name, the
state word in its right slot, and a rate bar across the card under any item that
has a total.

The marks are the surface's own: a border the host draws, a theme color, and the
heavy and light line characters a bar is made of. The layout names the element
and the token and lets the surface draw them, so the same tree is a rounded card
in a terminal and a rounded card on the desktop.

```text
llm-fleet                     3 working  1 waiting  1 failed

+----------------------------------------------------------+
| v  Trials                                        1 running |
|   . Test export boundaries                        42 / 80  |
|     project / feature-a | 2m elapsed | 1 failed            |
|     =====================                                 |
+----------------------------------------------------------+
| >  Background sessions                           1 waiting |
|   o Review adapter behavior                   Waiting for you|
|     Provider A | session 1234abcd | session age 8m         |
|     Question: Which source should this adapter read?       |
+----------------------------------------------------------+
+----------------------------------------------------------+
| v  Pull requests                                  0 open   |
|   No open pull requests in the configured repositories.    |
+----------------------------------------------------------+
```

The rules above are drawn as ASCII here because a design document is read as
text. What the pane draws is the surface's rounded rule, its theme colors, and
its own bar characters.

A bar is drawn only where a real denominator exists, and never for counts that
cannot both be true: a bar is the one mark that shows progress as a proportion,
and a proportion of an impossible pair means nothing. A row in that state states
both numbers and lets them be read.

The header counts distinct observed entities in each named category. Do not sum
the same trial twice because it also appears under Still running. Counts remain
scoped: a PR check failure and a failed test are different denominators. If a
source fails, say "observed" or "unknown" and show the warning next to the count.

Each group is a card: a rounded rule, a title, a real summary, and a fold arrow
that is itself the control. Each row has a dot in its state's color, a title, a
meta line, and a right-aligned slot for state, measured counts, or a single
action. The dot repeats the state the slot names, so nothing on a row is carried
by color alone. Long titles wrap before they collide with the slot. At narrow
widths the slot moves to its own line while preserving reading order. Truncation
must not hide a failed state, source error, or the denominator.

A section whose items belong to a project draws them as a tree. The project root
is printed once, in the theme's accent with the count of items under it, and its
items hang one rail deeper under a rail that runs on while another project
follows it. The row then keeps only what tells it from its siblings: the project
is drawn where it changes, not on every line that shares it. An item whose
project nobody could read sits under a root that says so, never attached to
another project and never dropped.

A section whose rows carry figures in two aligned columns names them once, in a
dim line above the rows, in the same widths as the columns. The load section is
that case: a percentage and a byte count side by side say nothing about which is
which until they are named.

Under the last card the pane draws one dim line naming the plugin, its version and
its license. It sits at the bottom, never in the head: the head reports this
machine, and a product line there competes with what the pane exists to say. It
is drawn in every state, including while the first read runs and after a
refusal, so the version a person quotes is always on the pane they are reading.

## The band above the prompt

The band is the pane's switch, and it is always drawn: a command typed while a
turn runs waits for the turn to end, and a press on the band runs at once. The
switch leads and says which way a press goes, Open fleet or Close fleet. After
it come the figures on chips, a figure at zero left out, then the worst thing
that needs a person in its own color with the rest counted, and Dismiss at the
right when there is something to dismiss. Errors sort ahead of waits. This
session's own job is left out. A dismissal holds across sessions until the item
changes, and `/llm-fleet unhide` brings everything back.

```text
[ Close fleet ]  2 working  2 waiting  1 failed  Trial failed on repo feat/a: 3 failed . 2 more waiting   [ Dismiss ]
```

## Agent cards

Each background session is drawn as a card, the way the host's own agents panel
draws one: its title, then one line of what it runs on and what it has spent,
then a bar, then the step in hand. The figures run from cost to elapsed time,
because a line too long for its card is cut from the end. The section heading carries the strip: what
the shown sessions spent together, the tokens they moved, and the longest any of
them has run.

```text
v  Background sessions     1 waiting  2 working  |  ~$7.75  18.9M tokens  3h 4m longest
   . Agent cards                                                         Working
     Claude | opus 5.5 | high | ~$6.63 | 27% context | 17.4M tokens | 12m 40s
     =====------------
     2 / 5 steps
     Now: Writing the card
   . Benchmark review                                                  Waiting for you
     Provider B | model-x | high | cost not priced | 293k in context | at least 149.5M tokens
     Totals are a floor: the transcript is longer than 16777216 bytes.
     Which source should the comparison read?
```

The figures come from the session's own transcript, the subagent transcripts
beside it and the session's task list, and each one is drawn in the words its
source allows:

- A cost the host recorded when the session ended is drawn as it is. A live
  session's cost is usage at the configured rates and is drawn with `~`. A model
  outside the priced families has no cost, and the card says it is not priced.
- Every subagent a session runs writes its turns to `<session id>/subagents/`
  beside the session's transcript, and the host counts them in the cost it
  records. They are summed into the card's totals, priced once per response
  across all of them, so a live card is not short by what its subagents spent.
- A transcript longer than the configured bound is read from its tail. Its
  token and cost totals are then floors, drawn with "at least", and the card says
  why. A subagent transcript the read cannot cover whole floors them the same
  way and is named: the figure drawn is what was read, said to be at least,
  never a smaller number drawn as the session's spend.
- The context share is the last turn's input against the window configured for
  the model's family. Without a window the context is drawn in tokens, with no
  share.
- Steps are drawn only from the session's own task list. A session that keeps
  none has no step count, and its bar is the context share, labeled as that.
- The strip is as exact as its least exact card: one estimate makes it an
  estimate, and one floor or one unpriced card makes it a floor.

A card whose figures could not be read keeps its row and says why. A roster read
without the agents source draws the rows as before.

Under its bar each card draws its timeline: one line across the card from the
session's first recorded stretch to now, each cell in the state that covered most
of it. Work is a heavy line in the healthy color, idle a light line, and the
stretch since the last record is the row's own state when the row knows it:
waiting on the person in the warning color, mid-turn as work, between turns as
idle. Time nothing covers is drawn dashed and dim, as unknown. A finished card's
line ends at its last record. The sessions heading draws the roster's spend over
the window as a line of block glyphs, scaled to the busiest bucket and to nothing
else, with its total; a series the reader could not complete says "at least" and
"incomplete", and an empty bucket is the lowest glyph drawn dim.

## What needs you, and what happened

A section holding something that needs the person moves above the calm ones: a
failing check, a job waiting on input, a failed trial, a governor run with
failures, or a custom row its command called failed or waiting. The move is a
stable split of the configured order, so sections keep their order within each
half, and a section moves only when what it holds changed. A folded section moves
folded, its heading carrying the count. Failing warnings still lead.

A pull request row draws a small dot per check at its right, in the check's
color, capped to the room the row has: failing checks are kept first, then
pending ones, and every check left out is counted as `+N` beside the dots. The
first failing check is named where the verdict would be.

Under the controls the pane draws "Since you left": the events newer than the
person's last look, newest first, five lines at most and the rest counted. The
last look is the newest event a digest drew, and it moves only when the pane
closes, by its key, its control, `/llm-fleet`, or Escape, which the band finds on its
next paint. A digest left open is not yet read, so it stays. Each session keeps
its own look in the host's state, written only at the version it read, so two
loads of one session never move it back; a close the band finds while it draws
is written at the next tick, or at the next prompt or the session's end when no
tick has come, since the host refuses a write a paint makes. Every
session also shares one in the
store under `digest-seen`, which a new session starts from; the store has no
compare-and-set, so two sessions closing in the same moment can leave the earlier
look there, and another session's next digest shows a few events again. Nothing new draws nothing. Events that could not be
read say so and never read as a quiet stretch, and a source the events could not
see is named under what they did see. The session's end waits for the folds and
the last look still being written, for two seconds at most, so a press made just
before it closes lands and a host that stopped answering does not hold the end.

## Measured progress only

A row without a real denominator shows no bar and no percentage, ever.

A run with a finite positive published total may draw one slim bar across the
card's width, beneath its count line. The bar is drawn with the surface's own
heavy line for the counted part and its light line for the rest. Its count label states completed/total and its
failure count. The bar represents counted outcomes, not task success. A full bar
can still be failed. Elapsed time, session age, queue position, and inferred work
steps are not denominators for task completion.

```text
Measured:  Test suite                              42 / 80
           2m elapsed | 1 failed
           =====================

Unknown:   Test suite                           Starting
           No counts yet

Stopped:   Test suite                             42 / 80
           Stopped early | 38 outcomes not observed
           =====================
```

Keep the original total after interruption. Never turn 42/80 into 42/42, and
never label a run complete because it stopped. Unknown counters, zero totals,
negative values, nonfinite values, or incompatible scopes produce a textual state.
If done exceeds total, flag inconsistent counts instead of presenting success.
ETA is an estimate and needs measured progress; do not invent one for a job.

## Empty, disabled, failed, and stale

```text
Healthy empty:  No background jobs in the configured homes.
Disabled:       Background jobs are disabled in configuration.
Failed:         Could not read Provider A. Job count unknown.
Stale:          2 observed jobs, as of 3m ago. Refresh failed.
```

Only a successful read can produce a healthy empty state. A failure before the
first successful read must leave a visible error and a retry path, not an endless
loading label. Never hide source errors inside a collapsed group alone.

## Shared rendering

The same structure must render on terminal and desktop, which is why shared
components are built from Box and Text. Box owns flow, spacing, flex sizing, and the
right slot. Text owns titles, metadata, state labels, and the slim bar's cells.
Do not use Raster or Image: they are terminal-only in the inspected declarations.
A bar, a history strip and a tile also carry a vector drawing of themselves,
built from the same counts and words. The mount draws it as an Svg on a surface
that draws vectors, in the slot the cells take, and the terminal keeps the cells.
The layout never asks for an Svg itself. Interaction adapters may use the common
Button, Input, and Link components around the shared layout without changing its
structure.

A row that holds more than its two lines says so on its figures: a press there
opens the rest of what the row knows, in dim lines under it, and the same press
closes it. The band's figures and the item it leads with are presses too: a
figure opens the pane narrowed to the state it counted, and the item opens the
pane where the row it names is drawn.

A row that offers something is pressed on its title. A background job's title
copies the line that opens it, `CLAUDE_CONFIG_DIR=<home> claude attach <id>`,
quoted for a POSIX shell by the reader that knows the home; a worktree's copies
its cleanup line or says why it has none, and one the reader could offer no
safe line for draws the reader's note to do it by hand on its next-step line,
with no press; the skills section's scan line copies
the report command when one is configured and says so when not. A copy says so
in a toast for `alerts.copyToastMs`. A pull request's title is a Link to its
page, an OSC 8 span on the terminal, on its chip when the row is failing. A
waiting job draws the reply it suggests and, where the surface draws a field
(terminal, desktop, editor), an Input that sends what was typed, exactly as
typed, or the suggestion for a blank field, to the job's own session once the
job is asked again what it asks now. A reply longer than `pane.replyMaxChars` is
refused with a toast that names the limit, never cut. The phone draws no field,
so there the suggestion is the control and a press copies it. The last
`pane.repliedLimit` replies are kept in the store every session reads, each by
its job, its session and the hash of the whole question, so a job answered from
one pane is not offered the field again in any until it asks something new. A
reply the machine recorded as sent reads as replied in every pane; one on its
way reads so, with no field; and one on its way past `pane.replyPendingSeconds`
reads "your reply may not have been sent", with a Send again press that clears
it and offers the field. A reply whose record is there but does not read
reads "this reply's record could not be read" in every pane, with no field and
a press that clears only that record and then offers the field. When the helper refuses replies for the whole machine,
each waiting row reads "replies are paused" with the masked reason: too many held
replies offers Clear answered replies and no field, and a lock it will not use
names its fix and keeps the field for the retry. Every toast is
masked as the pane masks; the clipboard gets the real line.

Use error for failures, warning for input or incomplete data, success for working
or passed states with labels, accent for measured activity, and subtle for idle
or historical metadata. Config owns the palette. Render tests must cover both
surfaces, narrow widths, long names, zero totals, early stops, failed full counts,
source errors, stale data, collapsed groups, and healthy empty results.
