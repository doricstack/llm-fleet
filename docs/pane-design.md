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
that figure counted, and a line under the controls says which state it shows and
how many rows, and carries the press that widens it again. The figures keep
counting the whole machine while a filter is on, so a narrowed pane never reads
as a small fleet.

A pane opened while something failed opens on it: that is what a person opening
it came for. The sections holding a failure are drawn open on those rows, and
every other section is folded where it stands. No section leaves the pane for
this: the section picker names every section, and a heading the pane drops is a
place the picker promises and the pane does not draw. It is worked out from the
reading being drawn rather than kept, so a failure that cleared while the pane
was shut does not reopen anything on nothing. A fold the person pressed
outranks it and stands on the next paint. A press on a figure narrows the pane
to that state and that choice is the person's from then on: a press on a figure,
or on Show all, stands for the rest of the session, and the pane works out no
open of its own again. An open that names a place is never narrowed: a command
that opens one section, and the band's item, which names a row, draw what they
name. A press on the figure of the state already drawn widens the pane, because
the figure is a toggle of what is drawn, not of the choice stored behind it. A
job whose provider says error is one of the rows it keeps. A row carries a dot in its state's color beside its name, the
state word in its right slot, and a rate bar across the card under any item that
has a total.

The marks are the surface's own: a border the host draws, a theme color, and the
heavy and light line characters a bar is made of. The layout names the element
and the token and lets the surface draw them, so the same tree is a rounded card
in a terminal and a rounded card on the desktop.

```text
llm-fleet                     3 working  1 waiting  1 failed

+----------------------------------------------------------+
| v  Pacer                                      1 of 2 busy |
|   o Settings                          2 slots, 4 per run   |
|     qos utility, nice 10                                   |
|   o Slot 1                                     my-project  |
|     running 2m                                             |
|   . Slot 2                                          free   |
|   o Outside pacer                  12% cpu, pytest, ollama |
|     3 processes                                            |
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

The header counts distinct observed entities in each named category. Do not
count the same job twice because it also appears on a session card. Counts remain
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

The load section states the machine on its heading, in two figures: the share of
the processor and the share of memory, coloured by the same rule a row is green,
amber and red at seventy and ninety percent. They are stated once, on the
heading, and the section's rows are the processes that make them up, each with
its own share and its own bytes under the CPU and MEM names. A platform that
states nothing draws no figure rather than a machine at nought.

Under the last card the pane draws one dim line naming the plugin, its version and
its license. It sits at the bottom, never in the head: the head reports this
machine, and a product line there competes with what the pane exists to say. It
is drawn in every state, including while the first read runs and after a
refusal, so the version a person quotes is always on the pane they are reading.

## The band above the prompt

The band is the pane's switch, and it is always drawn: a command typed while a
turn runs waits for the turn to end, and a press on the band runs at once. The
switch leads and says which way a press goes, Open fleet or Close fleet. After
it come the figures on chips, a figure at zero left out, and what this session
has spent on a chip, stated by the pane's own rule so both surfaces name the
same money. The band names no item: the figures count what is running, each is a
press that opens the pane narrowed to the rows it counted, and the same press
again widens the pane. Beside them one dim count, `N need you`, says how many
things need a person, drawn at every roster state because a failure can sit
outside every figure; with nothing needing a person and every figure at zero
the line reads `Nothing running`. A long line gives the spend
chip up first, then the switch's short word, and never a figure while there is
room for one. This session's own job is left out.

Keys dismissed by an earlier version, when the band still carried one item in a
sentence with a Dismiss button, keep quieting their alerts until `/llm-fleet
unhide` clears them; nothing on this band writes one.

```text
[ Close fleet ]  2 working  2 waiting  1 failed
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

A section holding something that needs the person says so where it sits: a
failing check, a job waiting on input, a pacer run that was refused or failed, a
slot still held while another caller waits, or a custom row its command called
failed or waiting. It keeps its place in the configured order, because a section
that moved would take the hotkey someone learned with it; the heading's tone and
count carry the need, and the band above the prompt carries the worst of it. A
folded section stays folded, its heading carrying the count. Failing warnings
lead whenever they hold anything.

A pull request row draws a small dot per check at its right, in the check's
color, capped to the room the row has: failing checks are kept first, then
pending ones, and every check left out is counted as `+N` beside the dots. The
first failing check is named where the verdict would be.

The pane draws no list of what happened while the person was away. A section
that gathered the day's events was read once and then passed over, and the
sections below it already state what needs a person now: a failed run, a job
waiting on input, a pull request whose checks fail.

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

## Who owns a fold

The configuration is the only fold that lasts. `pane.sections.<id>.collapsed`
says whether a section starts folded and `pane.sections.<id>.off` whether it
starts switched off, and every new session opens on exactly those, whatever an
earlier session pressed. Nothing about a fold or a switch is written to the
plugin's store, so two sessions never race over one, and a person who wants a
different start edits the configuration (Navin, 2026-11-24: "my default is
always the ones we choose first time in config").

This session's presses are held in the host's state, presses only, so a hot
reload keeps them and nothing else reads them. A heading press records the one
section it names; Collapse all and Expand all record one press per drawn
section; a press in the section picker records that section's switch. A press
is never written anywhere else, and a press in one session changes nothing in
another. The store keys older builds wrote, `folds` and `folds-written`, are
neither read nor written.

A switched-off section is not drawn. Its name stays in the section picker,
dimmed, and a press on it switches it on for this session; a second press
switches it off again. `visible: false` is different: that section is never
drawn and is not in the picker.

Views are the session's choices about what to look at. A one-section open
(`/worktrees`, `/keys`) names a section; a band figure or Show all names a
filter. A view is held in the load's memory and is never written to the store or
to the host's state. A view changes no fold and no switch, so ending it puts
nothing back: the drawing simply stops reading it. Every change to a view goes
through one function that runs to the end without waiting, and anything that
finishes later checks the view's generation before it acts, so a band open that
lands after Escape changes nothing. The second press of the same one-section
command, a fold press on any heading, Show all and a second press of the same
figure end a view; closing the pane or Escape end none, so a filter is still
there when the pane is opened again. A view on a section the configuration does
not draw is ignored by the paint.

The open on what failed is not a view and is never held. It is worked out on
each paint from the reading being drawn, so a failure that cleared while the
pane was shut opens nothing. It only opens: a section holding a failure is
drawn open, and every other section keeps its press or its configured fold,
so a section the configuration opens stays open.

An explicit ask draws a section even when it is empty and set to hide while
empty: a one-section view, and a switch press that turned the section on in
this session. One press on a dim name in the picker always draws its card. A
standing filter still narrows what is drawn.

The drawing is derived, and nothing derived is stored. Whether a section is
drawn: a one-section view draws its section even when it is switched off; else
this session's switch press; else the configuration's `off`. Whether a drawn
section is open, the strongest of these wins: a one-section view (its section
open, every other folded); this session's fold press; a filter forcing open the
sections holding its rows; the open on what failed; the configuration's
`collapsed`.

These follow from it and are held by tests: no press, view or paint writes the
store; a new load with no session state draws the configuration exactly, even
over a store an older build filled; a reload draws this session's presses;
ending a view draws what was drawn before it without reading anything; a late
band result after Escape changes nothing; a switched-off section is dimmed in
the picker and drawn after one press; and the drawing for every mix of the
inputs is one table the suite enumerates.

The host's own documentation settles the rest. It says a read followed by a
write races across sessions; this design has no cross-session write at all.
Whether one command reaches two live loads at once is not documented; a reload
replaces the module, and a view in one load's memory makes the answer
irrelevant, because each load ends or keeps its own view. Presses are written
to the host's state as the load's whole map, so if two loads of one session
were ever live together, a press in one could replace a press the other made
on another section; that is the one limit this design accepts.

The configuration reaches a session through a reading. A new session draws
the newest reading in the store, which carries the configuration as it stood
when that reading was taken, so an edit to the configuration shows on the
next read rather than at once.

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
