# Architecture

## Current implementation and extraction boundary

The original system is a Claude Code function-hook plugin, a Python snapshot
helper, and a separate statusline renderer. This scaffold contains their design
and publication boundary, not their runtime code. The future module locations
are listed in AGENTS.md. No component in this checkout loads an agent plugin.

```text
Provider homes -- runtime roster and job state --+
Controller store -- leases and receipts --------+
Governor files -- liveness and real counts -----+-- Snapshot reader
GitHub CLI -- open PR checks -------------------+        |
Worktrees -- preservation and live holders -----+        +-- attention band
Skill scan files -- counts and findings --------+        +-- detail pane
                                                        +-- alert decisions
Session payload + provider caches + governor files ---------- statusline
```

## Scaffold command layout

The root Makefile contains shared setup, a fragment index, generated help, and
includes. Help is its only executable target. AGENTS.md names the same layout.

| Fragment | Holds |
| --- | --- |
| `make/config.mk` | Runtime root, state directory, provider homes file, Python/Node entry points, export destination, tool overrides |
| `make/dev.mk` | Setup, Python build, install/link availability, generated-cache cleanup |
| `make/test.mk` | Unit/checker suite, export suite, engine availability, full CI verification |
| `make/quality.mk` | Indentation lint, configured typechecker, publication violations, doc-format |
| `make/export.mk` | Dry run, real export, leak check |
| `make/scripts.mk` | One target per runnable script |

`scripts/check-doc-format.py` checks instruction paragraph length, banned
punctuation, and root Makefile targets. It scans source files, including hidden
files; Git metadata and generated dependency/cache directories are excluded.
`tests/test_doc_format.py` exercises its CLI with disposable trees.

CI invokes `make test-ci`. It checks quality, runs the scaffold tests, compiles
Python, then exports to a disposable tree. That tree runs the same quality,
tests, and build before a second export dry run proves independence.

Runtime installation, Claude-home linking, and engine tests remain unavailable.
Their targets fail with an explanation. Typechecking requires an explicit
`TYPECHECK` command; it is not claimed by the scaffold quality gate.

## The host payload

`plugins/llm-fleet/readers/host.py` reads what the session host hands the statusline on
stdin: session, model, cost, context window, rate limits, prompt cache, effort,
thinking, pull request and worktree. The host is a separate program, so the payload
is untrusted input rather than a contract it keeps.

Every field the host did not send, or sent with a type this layer cannot read, is
named in `absent` instead of becoming a zero. A statusline that reports 0% of a
window nobody measured is worse than one that reports nothing, and the renderer
cannot choose what to do about a missing field if this layer quietly fills it in.

The read is bounded in bytes and taken from the configuration, and a payload one
byte over the limit is refused rather than truncated. That boundary is deliberate:
a truncated payload parses, and the fields missing from it would look exactly like
fields the host chose not to send. An empty stream is empty, not failed, because a
host that ran the command with no session behind it is a state and not an error.

The token fill is the payload's own `total_input_tokens`. Deriving it from
`remaining_percentage` rounds it, and the original statusline carried that
rounding bug for months: it showed 900,000 where the payload said 902,437, and a
second line reading the same payload disagreed with it.

### Session economics

`plugins/llm-fleet/readers/transcript.py` sums this session's own transcript, because
the statusline only runs when someone interacts with it: an accumulator folded at
render time misses every API call between two renders and undercounts badly. The
saving is what the cached tokens would have cost at the input rate, less what was
paid for them: `cache_read * (input - cache_read_rate)`, less each cache write's
premium over the input rate at its own lifetime's multiplier. Every rate is the
model family's from `sources.agents`, the group the agent cards price a session
from, so the two never disagree on a price. A write the host did not split by
lifetime is taken at the five-minute premium, which never overstates the saving,
and a model outside the configured families has no saving rather than another
family's.

A transcript is written while it is read, so a damaged record is counted and the
scan continues rather than treating it as the end of the file. A read cut short by
the byte limit drops the partial final line, reports `truncated`, and says why: a
half-written record is damage the transcript does not have, and a silent cut would
report a smaller session than the one that ran.

A cold session can show a negative saving, and this layer states it. The renderer
suppresses a negative saving from the line; it cannot do that if the number never
arrives. A price applied to zero records is not a saving of zero either, so the
money figure is absent rather than zero when no assistant record was read.

### The lines

`plugins/llm-fleet/components/statusline.ts` composes three lines from those two readings, and it is
pure: the lines are slots a host draws, so every rule is tested without a terminal.
The identity line carries the clock, the session, the model with its effort, the
version, and the project with its branch. The context line carries the fill and
what the cache saved. The cost line carries the session's spend, its rate against
API time rather than wall clock, and each rate limit as a percentage.

The rules are the pane's, applied to a line. A figure the host did not send is
never drawn as a zero: no window means no bar and the line says the window is
unknown, and a fill the host did not send is named while the window it does know
stays beside it. A saving of nothing is not drawn, and neither is a negative one,
because a cold session drawn as a saving is a lie. A failed read says it failed
and names what failed. A width too narrow to hold a line cuts it and marks the
cut, and a narrow host halves the bar rather than dropping the reading.

`make statusline-demo` draws the lines from a payload, so a change to them can be
looked at without living with it in a session. The preview says whether the
payload was recorded from a real session or built from the sample shape.

## The engine entry

`plugins/llm-fleet/hooks/llm-fleet.ts` is the module the engine loads. It is deliberately
thin, because everything the pane draws is decided in `plugins/llm-fleet/components/`: it registers
the `fleet` command, opens one pane, and on every render runs the read command and
hands the answer to `plugins/llm-fleet/components/surface.ts`.

The plugin is a plugin because `plugins/llm-fleet/.claude-plugin/plugin.json` names it
and `plugins/llm-fleet/hooks/hooks.json` names the module. The engine requires its
manifest directory to be called `.claude-plugin`, which is the prefix the denylist
refuses as a personal provider home, so that one reserved name is exempted in the
rule and a case proves a real home is still refused.

The engine loads the plugin as a folder. It refuses an import that resolves
outside the folder, and it evaluates what it loads without node, so a module
that reads a process or writes to standard input throws while it is being
loaded. Both rules shape the tree. Everything the entry needs lives in
`plugins/llm-fleet/components/`, never in a directory beside the plugin, because a
layout one level up compiles here and is refused there with the pane simply
never appearing. Work that belongs to a command line, the review tool that
prints the pane and the statusline command line, lives in `components/` at the
repository root, where node runs it. `make plugin-boundary` states both rules
where they can be checked without the engine: it resolves every relative import
under each plugin folder and refuses one that escapes, and it refuses a module
reaching for a node global, naming the file, the line and the specifier.
The readers are held to the same folder from the Python side: an install
copies the plugin folder and nothing beside it, so the loader and the schema
live in `plugins/llm-fleet/config/`, a reader imports `config.loader` and
`readers.<name>` from the plugin root, and a reader started by path reaches that
root through `readers/plugin_root.py`, the one module allowed to set the import
path. The plugin names the scripts it starts in one table,
`components/entries.ts`, which also builds the command, and the check refuses a
script name or an interpreter anywhere else. It reads each Python module's
syntax tree and refuses an import from outside the standard library and the
plugin, a change to the import path outside the helper, and a climb of more
than one level from `__file__`. `tests/test_plugin_standalone.py` holds the
table, the modules that run, and its own run cases to one set, and runs every
entry from a lone copy of the folder with every source on.

The engine publishes a generated declaration of its whole API. Importing it, or
copying it here, is what the host binding rule refuses, so
`plugins/llm-fleet/hooks/engine.ts` declares the narrow subset the entry calls: the
command registration, the pane open, close and list calls, the element table a
render hook resolves, the clock, the process runner, and the plugin's own root.
Adding a call means adding it to that file first, which keeps the surface this
repository depends on small enough to read.

The entry writes no JSX. The layout builds the tree as data and `mount` binds it
to the host's constructors, so the code a terminal draws is the code the review
renderer measures and the code the tests assert. It is a `.ts` module for the same
reason the sibling plugins are: the engine loads those, and plain `.ts` is what
`node --test` can drive.

Two failures are surfaced rather than swallowed. A read that exits non-zero and a
read that prints something other than JSON each draw a pane naming what happened,
because drawing an empty fleet in either case would report a quiet machine and
hide a broken reader. A read still in flight says it is reading, for the same
reason.

The band above the prompt, the alerts and toasts, and the voice are built on the
same reading; the parity ledger in TODO.md names what the older plugin did that
this one does not do yet. The switch advice was a separate plugin and stays out
of this one.

The tab color is kept and written by a helper (`readers/tab.py`), because a
plugin's own output is not the terminal, and because sessions in one tab (tmux
panes in one iTerm tab) share it. The plugin tells the helper only this session's
level, and only where iTerm draws a tab color, inside tmux only when
`allow-passthrough` is on: when the level moves, and on a heartbeat of its own
timer every third of `alerts.tabTint.staleSeconds` (at least 30) whatever it
holds, so with tinting on a session at none still speaks and the helper can let go
of a failure whose session died. A
paint the helper says failed is asked once more; after that the session only
keeps its entry alive until the level moves, and its end is told once whatever it
gave up on.

The helper keeps one record per tab in a private `tabs` directory under the state
directory, named by a hash of the tab's identity (the tmux client's terminal, else
iTerm's session identifier): each session's level with when it said it, and what
the tab was last painted. It reads, merges, paints and writes that record while
holding one exclusive lock shared by every tab (`tabs/.lock`), so two sessions take
turns rather than deciding from a copy the other changed. Under the same lock it
sweeps up to 16 other records, picked at random so a run that must stay cannot hide
the rest, and removes one whose entries are all past the staleness and whose tab is
its own color; one painted a color, or unknown, stays until its own tab speaks and
is given its color back. Before a paint the
record is written saying the color is unknown, and the color only after the paint
lands, so a helper that dies or cannot write in between leaves the next session to
paint again. The tab shows the highest level still within the staleness; an entry
past it is dropped, and a record left with nobody at the tab's own color is
removed. A record that is a link, cannot be read, or does not parse field by field
is never taken as an empty tab: nothing is painted and nothing replaced, and the
helper exits 3 saying why. Every lock sits in a folder the plugin makes (`tabs/`,
`claims/`, `locks/`), refused when it is a link or another user's, and closed to
others (0o700 for a folder, 0o600 for a lock) when this user's own is left open.
A folder's mode is changed through a handle opened without following a link, so
one swapped for a link after the check is refused and its target left alone. On
Windows, which has neither that handle nor mode bits to close, the link refusal
stands and the mode is left as it is.
The configured state directory itself is the owner's own setting: it is resolved
to its real path once and never checked, so one given as a link, or owned
otherwise, keeps tinting and claiming.

The escape goes to the helper's controlling terminal, else to the terminal of the
nearest parent that has one, walking up only through this user's processes, since
the host may start the helper in a session of its own with no terminal. A parent's
terminal is written only when the device opened by its name is a character device
this user owns with the same device number as the parent's terminal, opened to
write only, without becoming the helper's terminal, without waiting on a reader,
and without following a link; anything else writes nothing and says why.

A `-p` run or an SDK host has nobody at the prompt, so it starts no timer, reads
nothing on its own, and a prompt it submits runs no helper and writes no key.

## Sources

The helper's default roster targets three Claude Code homes: Claude, DeepSeek,
and Kimi. Each runs `claude agents --json --all` with its own `CLAUDE_CONFIG_DIR`.
The provider is the route into Claude Code, not a separate pane host. Environment
overrides can supply more homes. The roster reader builds each job's attach
command from the same provider home it read the job from, so the line a press
copies cannot name a different home. No native Codex roster adapter is
implemented by this helper.

The runtime roster distinguishes interactive sessions from background jobs.
Interactive rows contribute counts; background rows retain job identity, session
identity, state, activity, and timestamps. The helper augments those rows from
`$PROVIDER_HOME/jobs/$JOB_ID/state.json`: questions, suggested replies, detail,
and unfinished fan entries. State reads are bounded regular-file reads; job IDs
are validated before constructing paths. A failed roster call enters the errors
list, rather than proving there are zero sessions.

The controller SQLite store is opened read-only. Live trial leases establish
running work and session-to-branch association. Latest receipts per branch carry
outcomes. Separate governor run records and adjacent progress files carry actual
done/total counts, failures, and the first failure. The reader checks PID liveness,
run age, count validity, and whether a count file belongs to the current run.
Ambiguous association is labeled unlinked instead of borrowing another branch.

PRs come from `gh pr list` for explicitly selected repositories. Worktree probes
use controller preservation helpers, Git, and bounded live-holder checks. Skill
findings come from a scan summary, progress, and notices. These integrations have
dependencies on the original tooling repository today; standalone adapters have
not been extracted.

## Readers as built

The roster and job readers are extracted, and they are the shape every later
reader copies. Three things are structural rather than stylistic.

A reader does not touch the machine itself; it calls the surface in
`plugins/llm-fleet/readers/runtime.py`. That module owns command resolution, the
bounded run, the bounded file read, text sanitizing, and job-identifier
validation, and it holds the three invariants a configuration file may not
weaken: a child process never inherits a provider credential, a job identifier
is validated before it names a path, and every read is bounded in time and in
bytes. The credential sets themselves are configuration, declared as
`runtime.childEnvironment.stripPrefixes` and `runtime.childEnvironment.stripNames`.
Both carry a `mustInclude` baseline in the schema, so a document may add a name
to strip and may not remove one; removing a baseline entry is `E_CONFIG_RULE`.

The read command is run by path, from a working directory that belongs to
whoever called it, so it puts the tree root on its own path before its imports:
that root is where `config` and `plugins` live, and a command that leaned on the
caller's directory would die with an import error while the pane reported a
machine it could not read. The suite drives the command from a directory outside
the tree for that reason, since running it from the repository root hides the
fault. A reader installed away from its tree, with no `config` beside it, is a
deployment this does not cover yet; the publication step owns it.

A reader reports what happened rather than what it hoped. `read_providers`
returns a state of ready, empty, failed, unavailable, or disabled, plus an entry
per configured provider, so a home that failed to answer is visible next to a
home that did. An empty read is empty only when every enabled home answered; a
failed read is failed even when it found no rows. A source switched off in
configuration is never probed at all.

A job row carries no invented progress. The registry supplies identity, state,
working directory, and activity; the job's own state file supplies the question,
the suggested reply, the detail, and its fan entries. A read that fails leaves
those fields absent. Finished jobs stay for the configured window and are capped
and newest-first; a state that held since the previous snapshot keeps the time it
had, which is what lets the pane say how long a job has been blocked.

The roster command is configuration, not a literal: `commands.claude` is an argv
array holding an executable and any fixed leading arguments, and the reader
appends its own arguments. A bare name resolves on the PATH the child actually
receives, so a resolution that succeeds cannot fail inside the child.

The other readers follow the same pattern, one module each. The trial reader
opens the change controller's store read-only and never migrates it: a live lease
is a running trial, a recent receipt is a verdict, and only the newest receipt
per branch is kept. A run counts as green only when its own evidence says nothing
failed, nothing errored, the selector succeeded, and it executed what it
selected. An unreadable store is an error with a reason, never a claim about
work.

The progress reader trusts nothing on its own. A run must have a live process, a
record inside its age ceiling, and a count file newer than the run that wrote it
before any number is reported; a count above its total is clamped, a run that
already finished is dropped instead of shown as a stopped bar, and an estimate
appears only after the configured number of outcomes. A branch is named only
when exactly one live lease claims the run, because an ambiguous association is
worse than none.

The pull-request reader runs one command per configured repository and each
repository answers for itself: the rows from the ones that answered are kept, the
ones that failed are named, and only the answers are cached, so a failed read is
retried rather than served as a result for the rest of the window. A check state
the reader does not recognize leaves the row pending rather than calling it a
pass. The skill reader reads a scan folder another tool writes and treats every document in
it as untrusted: the notice file is read bounded and from its newest bytes like any other
file, a malformed line is skipped, a malformed row is refused, a notice is matched against
the target the scan wrote rather than the shortened path a row displays, a progress figure
needs both halves of its count while its file is fresh, and a folder that is missing is
unavailable rather than an error.

An inspection lock records when it was taken, so a reader that died holding one does not
stop every later inspection, and a probe that has spent its declared budget ends with a
refusal rather than running long. The worktree reader asks each folder a question a probe
can answer: the branch
checked out there, whether that branch is contained in the declared base ref,
whether an archive ref preserves it, and whether a live process holds it. A
detached checkout has no cleanup branch, a base ref that is not present is
reported rather than assumed, and a platform that cannot list live holders says
the folder is unknown instead of calling it free. The change store answers only
when the worktree path matches, so a change belonging to another checkout of the
same branch is never reported as this one's. A failed probe does not erase the
row this reader last published: the row is kept with its own timestamp and a note
saying it was not rechecked. Cleanup is an action the row carries, built from the
configured command, and a row whose cleanup command is unset offers none.

Read the commands as configuration in the same way. `commands.claude`,
`commands.github` and `commands.cleanup` are argv arrays holding an executable
and any fixed leading arguments; a reader appends its own arguments to them.

## Shared layout

The rendering layers share one layout, built from two primitives and nothing
else. `plugins/llm-fleet/components/host.ts` declares the subset this repository uses, `layout.ts`
turns a description of the pane into a tree of Box and Text nodes, and
`mount.ts` is the single boundary where those nodes become the host's own
elements. Nothing draws a raster, which is the terminal's alone. A bar, a strip
and a tile carry a vector drawing of themselves beside their cells, built in
`vector.ts` from the same counts; the mount draws that as an Svg on the desktop,
the editor and the phone, and the cells on the terminal. It picks by the
surface's name, because the engine completes every surface's table with every
element name and the terminal's Svg draws nothing.

The host ships a generated declaration of its whole surface. That file is not
published here. A generated declaration is not reviewable through an allowlist,
it is another project's file, and a frozen copy would become the contract while
drifting silently. What is published instead is the declared subset, and
`make test-components-drift` fails by name when the engine stops declaring a
prop this repository writes.

The declaration that check reads is the engine's own. The host scaffolds it into
the plugin folder when it loads the plugin, so it is written into the tree after
the checkout and no commit carries it. A declaration this repository did commit
is refused, because a branch can edit such a file in the same commit that edits
the subset, and a check that reads it can only agree with whatever the branch
wrote. The test is what git lists rather than what the checkout ignores, which
matters for a tree delivered without a repository at all: an exported tree or a
downloaded archive holds nothing a branch committed, so a declaration inside one
is read rather than refused for living inside a checkout. Naming another engine
with `HOST_DECLARATION=<path>` is how a caller checks against a build other than
the one installed here.

Where no engine has written a declaration, there is nothing to check against and
the run says so: the subset was not checked against an engine. CI is that case,
since the runner has no engine, so `make test-ci` runs the check with that report
allowed and carries the line in its log.

`tests/test_host_drift.py` measures the subset against that same declaration and
pins the number it is at today, 31 props and 12 colors. The two failures are
separate and both are wanted: a subset that grows past what the engine carries is
refused by name, and one that grows within it moves the number, so the change is
visible in the open rather than absorbed.

Two rules are structural rather than cosmetic, and the layout suite holds them:
a bar is drawn only against a real denominator, and a count that contradicts
itself is reported instead of drawn; and a failure stays visible even inside a
collapsed group. The suite asserts structure, which is what a test can honestly
prove without a host. It does not claim to prove how either surface paints.

## Reading, and looking at what was read

`plugins/llm-fleet/readers/snapshot.py` is the command a view layer calls: it resolves
the configuration, runs the seven readers once, and prints one object. A reader
that raises does not remove its document; the slot is filled with a failed source
that names the reason, because a missing key reads downstream as a source nobody
asked about, and a source that failed is not the same thing.

Nothing draws the pane on a surface yet, so `components/review.ts` renders the
layout's own tree as text and `make review` puts it on a page: read the machine,
render the tree, write a file a person can open. The renderer decides nothing the
layout has not already decided. The pane masks every field a person wrote, and
the renderer checks that it did: a shape that identifies an account or a
credential still present in the rendered text means the masker missed a field, so
the run stops, names the shape and writes nothing. Hiding it in the renderer
would erase the evidence that the pane let it through.

## The pane view model

`plugins/llm-fleet/components/pane.ts` turns reader output into the descriptions the layout draws.
It is a pure function, so every rule the design cares about is tested without a
terminal.

A group that was never read is not an empty group. A source that failed reports
its count as unknown and says which source it was; a failure that still holds rows
from an earlier read is stale, and those rows carry the age of the read they came
from rather than the time of the failed one. A healthy empty source is the only
thing allowed to produce the sentence that says there is nothing there.

A count is never invented and never double-counted. The header counts jobs, while
failed test outcomes get their own number and pull-request check failures stay in
their own group, because a failing check and a failing test are different
denominators. A group's primary count is stated even at zero, since zero observed
is a reading; the legend entries after it omit the states nothing is in.

The six reader documents arrive as parsed JSON from another process, so
`plugins/llm-fleet/components/snapshot.ts` checks every field before it is used. An absent document
is a source nothing was claimed for, which reads as empty; a document that is
present and unreadable, or that names a state this layer does not know, reads as
failed, because reading it as empty would claim nothing is running when nothing
could be read.

A bar is drawn only for a run with a published total, and a run with no total
says so instead. A waiting job carries what it is asking and the reply it
suggests; a worktree carries whether cleanup is available and, when a probe did
not answer, that it was not rechecked.

## Masking

`plugins/llm-fleet/components/mask.ts` runs over every field the pane prints that a person wrote:
session names, questions, branch names, worktree names, pull-request titles,
skill findings and failure reasons. The pane is a display surface, so it masks
before it renders rather than trusting the text it was handed.

The rules are the shapes that identify an account or a credential: an
organization or location identifier, a merchant identifier carrying digits, an
account or card number, a sign-in, key material, a key carrying its vendor
prefix, a private key block, and a credential inside a URL. A value is replaced,
never echoed, and the rule that fired is named so a caller can say what was
hidden without repeating it.

Every rule is narrow on purpose, and each one has a case proving it leaves
ordinary text alone. A word followed by a colon is not proof of a credential, so
`high secret: looks like a key` keeps its sentence while `secret: abc123def456`
does not. The masker hides only what it can defend hiding, because a masker that
eats ordinary words makes the pane lie about what it is showing.

This is the masker the `plugins/secret-shield/` mod will own. It lives in
`plugins/llm-fleet/components/` for now because the pane needs it before that mod is extracted; the
mod keeps its own thresholds, and this one only has to be honest about what it
hides.

## The export gate

`scripts/public-export.py` writes the public tree from an allowlist, and refuses
the whole export when the denylist reads in any selected file. A rule that reads
only the text as written is a rule anyone can walk past, so every rule is also
checked against the text normalized to its compatibility form, with invisible and
text-reordering characters removed, and against its percent and base64 decodings.
Decoding goes one level deep on purpose: a file cannot turn one rule check into
an unbounded search, and a decoded form is read but never decoded again.

Ordinary content survives. A commit hash, a long word and a paragraph with
punctuation decode into binary or into text no rule describes, so they are left
alone; the suite carries that case beside every one it refuses.

An owner-specific identity is a literal rather than a shape, so it lives in
`public-export/owner-identity.txt`: ignored by Git, refused as an exportable path
even when a pattern selects it, and checked in the same cited forms. The refusal
names nothing, because a refusal that echoes the term publishes it.

The plan is written for a person to read, and a Windows console cannot encode
every character a source file may hold. The stream is opened with a replacing
error handler, so a preview that cannot draw a character does not refuse an
export that is safe. The format checker rejects invisible characters in source
outright, which is where the character should never have been.

A real write holds the destination from before the first removal to after the
manifest, so two exports cannot interleave into one tree. The lock is a file
naming its holder, and one left behind by a run that died is taken over after
fifteen minutes: the bound is time, because asking a process whether it is alive
is safe on POSIX and not on Windows. A dry run takes no lock.

## Polling and state



Every session draws one reading, kept in the plugin store. Each session looks
at it every 3 seconds and draws it when it is newer than what it holds; a look
that finds nothing new draws nothing. When the reading is older than 20 seconds,
the first session to find it so claims the read in the store, reads the machine,
writes the reading back and lets the claim go; the others draw what it wrote.
A claim older than a read could take belongs to a session that died mid-read
and is taken over; a session lets go only a claim that is still its own. A
reading or claim dated up to 2 seconds ahead of a session's clock is current,
since another session may write it during a look. While a pane is open on a
live governor run, that run's counts are read on their own every second the
same way, a read of the progress files alone, dated when the look decided to
read them. They are kept under their own key and drawn over the whole
reading's own counts when newer, so a count read never writes the whole
reading and cannot put an older fleet over a newer one. The two reads do not
wait for each other: the counts keep moving while the machine is read, and a
whole read that lands keeps counts read since it began. Neither kind of read
is written over a newer one of its kind. A count read that failed leaves the
counts it would replace standing. A paint while this session reads the whole
machine does not look at the store again; the read's landing redraws the
pane. A reading from a build before the shared reading carries a 30-second
look interval, which is ignored.
PR data has a separate 120-second cache. Worktree inspection has its own
300-second cache; opening that section requests a fresh probe.

The helper stores snapshots, PRs, worktrees, focus, locks, and event claims under
the fleet state directory. UI preferences such as collapsed sections, hidden
attention items, key tips, and voice choice live in the engine plugin store.
These are distinct stores; neither belongs in the exported source tree.

## Band, pane, and statusline

The attention band ranks failures ahead of requests for input. It suppresses
the current session's own job and dismissed attention keys. The pane opens on
request and groups background sessions, this session's own spend and parameters,
trials, PRs, warnings, worktrees, skills, running work, and key help. Section
expansion choices persist. A job row can copy an
attach command; a waiting job can receive a message after a fresh question check.
Message delivery does not establish that an approval was granted.

A reply is checked against the job as it stands, not as the reading drew it,
and a question gets at most one send unless the person asks to send again. The
pane refuses a second submit of its own while one is out. The helper then reads
the job's own file, checks the session it names and a SHA-256 of the whole
question against what the reading carried, and records a reply to that question
as pending: a marker file in the state directory holding the pane's token, its
session, the job, the job's session, the hash and the time. The whole body is
written and flushed to a file of its own first, then published under the
marker's name with a hard link, which fails on any name already there and never
replaces it, so a marker is there whole or not at all: a helper killed before the
link leaves the question answerable and a stray file that the next reply sweeps
once it is older than `pane.replyPendingSeconds`, and one killed after it leaves
a whole pending marker. Reading, checking and publishing happen under one lock.
Only the pane whose link landed is told it holds the reply. A marker already
there is a reply sent or on its way, so a second pane, a pane a reading behind,
and the same pane asking again are all refused. A new question
has a new hash and is free, and so is a job restarted into another session that
asks the same words again, since the marker names the job's session. The store
is not used for this because it has no compare-and-set, so two panes could both
find a key free and both send.

Once the host takes the message, the pane asks the helper to record the reply
as sent, which only its holder may do. A send the host refused, one the pane's
own check stopped, and a question the helper never answered each have the pane
give the marker back as failed, again only for its holder, so the person can
try again. A sent marker is never given back. When a give-back or a record
fails, a toast names it, and the row shows what stands: the roster carries each
waiting job's marker, so a pending reply reads as on its way, and one pending
past `pane.replyPendingSeconds` reads as maybe not sent, with a Send again press
that has the helper clear it (refused while younger than that, and always for a
sent one) and reopens the field. A marker that is there but does not read, cut
short by a disk, left by a helper from before markers were published whole, or a
link, holds the question like any other: the roster carries it as unreadable,
the row says the reply's record could not be read and draws no field, and its
press has the helper remove that marker, which it does only when the marker is
there and does not read. Nothing else takes a marker back, so a pane that died
mid-send leaves the question held until a person presses.

Markers of jobs no longer in their provider's home are removed when the next
reply is recorded. No other marker is: past 256 live ones a new reply is refused
rather than a live one forgotten, and every waiting row then reads "replies are
paused" with how many are held and a press that clears answered replies: sent
markers of jobs that left their home or moved to another question or session,
never a pending one. A lock the helper will not use pauses replies the same way,
naming the lock beneath the state directory and its fix, with no press; the
next reply that goes ends the pause. The configured state directory
is the owner's own setting and is trusted as given, a link included: it is
resolved to its real path once, and the checks apply to what the helper makes
beneath it. Every folder it makes there is made for this user alone; one already
there may not be a link, and is opened from the state directory's own descriptor
without following one, checked through that descriptor to be this user's folder,
and tightened through it to this user alone when it is open to others. The
descriptor is then held: the lock, the listing, every marker, claim, focus,
voice and tab record and the job-state record are opened, published, replaced,
removed and listed through it by bare name, so no path is walked again once the
folder was checked, and a folder swapped for a link afterwards changes nothing
the helper touches. Every lock is opened without following a link, must be a
regular file this user owns, and is tightened through the same descriptor; every
marker, cache and record the readers write there is made for this user alone and
replaced rather than written through a link. Focus and the voice's hold live in
their own folder, and the roster's job-state record in its own, so each has a
folder to check. Windows has no open relative to a folder, no link-refusing open,
file owner or mode here: there the folder and each file are refused by name when
they are a link or a reparse point just before each use, ownership is not
checked, and a folder swapped for a junction between its check and a later use
is followed. That window is the platform's.

The provider home is opened by its real
path, and the jobs folder, the job's folder and the state file are each opened
through the one before without following a link, the file read through the
descriptor that opened it, so a folder swapped for a link mid-read changes
nothing. Windows cannot open a folder relative to another, so there each part
is checked by name, the real path is checked to lie inside the home, and the
file is opened by name: a folder swapped for a link after those checks is
followed on that platform. The pane sends only when the helper says it holds
the reply, only to that session and that hash, with nothing awaited between the
answer and the send. The residual race is the job itself: it can move on to another
question between the helper's read and the message landing, and no check from
outside the job can close that window. The message then waits in the job's
queue and is read as an answer to whatever it asks next.

The statusline remains separate: branch, context, cost, rate limits, provider
balances, and governor activity belong there. The personal renderer also has
weather, network, disk, routing, and model-policy integrations. Their standalone
scope needs a separate inventory. The pane must not duplicate these fields.

## Surfaces

The inspected engine declarations define terminal Box, Text, Button, Input,
Select, Link, Code, Markdown, Client, Raster, and Image. Desktop provides the
same list except Raster and Image, and adds Svg. A tree built from Box, Text,
Button, Link, Code, and Markdown can render unchanged on both surfaces.

The current fleet pane resolves Box, Text, Button, Link, and optional Input;
it does not use Raster. The redesigned shared visual layer will use only Box
and Text. Actions can wrap that layer using components shared by both hosts.
The same layout must not depend on a terminal raster. The desktop's Svg is
drawn only through a node's vector, beside cells the terminal draws instead.
Engine test fixtures already cover terminal and desktop; those tests must move
with the runtime. This is declaration and test-source evidence, not a claim that
a live desktop session was exercised during scaffolding.

## Alerts and speech

The first snapshot establishes a baseline without replaying old events. New job
completion or blocking, trial receipts, failing PR checks, and skill findings
can raise alerts. Toasts go to the session with the last submitted prompt for
30 minutes. A machine-wide event claim deduplicates native notifications.
Only a terminal session claims native notifications in the current implementation.
Waiting-job alerts can also speak if speech is enabled.

Speech now invokes a local Kokoro synthesizer, reads its WAV, and plays the bytes
through the engine. Failed synthesis tries the next configured voice, and output
files are removed afterward. `/speak list` exposes a pick list. This replaced
system-voice selection whose silent fallback could misidentify the voice that
spoke.

Speech has one switch for the whole machine, kept in the plugin store under
`speech.on` and off until someone turns it on. The band's Speak button, or
`/speak on` and `/speak off`, in any session flips it for every session; each
session reads it every 1.5 seconds and before each clip, and a session that
finds it off stops the clip it is playing. The voice is each session's own,
kept under `voice:<session>`, so `/speak male` in one session leaves the others
as they were and turning speech back on speaks in the voice that session picked.
One clip plays at a time: a session queues its own lines, and the helper holds
the machine's voice for the length of each clip, so a clip from another session
waits for it to end and is dropped after 60 seconds rather than said late. iTerm tab tint is a separate terminal behavior;
tmux requires passthrough, and tint is restored when attention clears or the
session ends. There is no configurable notification-tone asset system yet.

## Controller boundary and truthful states

llm-fleet observes the controller; it is not the controller. Worktree rows copy a
cleanup command, not execute cleanup. Trial execution, preservation, cleanup
authorization, and scheduling remain external. An optional controller adapter
must allow fleet to run without that personal workflow.

Keep stale rows with their age and source failure when a refresh fails. Incomplete
reads must not become "nothing running". Process disappearance alone cannot mean
success. Preserve a stopped run's measured count and final outcome; never replace
its denominator with completed work to manufacture 100%.

The existing Still running view handles incomplete source reads, and its jobs
have no invented progress. The Trials formatter still constructs an empty bar
when total is zero. Removing that bar and proving interrupted-run behavior across
the extracted controller and governor adapters are explicit work-queue items.
