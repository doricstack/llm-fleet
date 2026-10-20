# Configuration

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-1 | Configuration | `plugins/llm-fleet/config/schema.json` is the versioned contract; `plugins/llm-fleet/config/loader.py` and `config/loader.ts` are the two loaders that read it. The schema and the Python loader sit in the plugin folder because an install copies that folder alone. |
| DOC6-2 | Configuration | The loaders validate, resolve, and derive source state. They read no provider data and start no process. |
| DOC6-3 | Configuration | The existing implementation mixed environment overrides, plugin-store preferences, plugin options, and source constants. |
| DOC6-4 | Configuration | The loaders replace that mixing for the loading contract and the sources-and-paths group below. The later groups remain an inventory. |

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-38 | Implemented in this pass | The loading contract, `schemaVersion`, `stateDir`, `providers`, every `sources` group, and `commands` resolve today. |
| DOC6-39 | Implemented in this pass | So do the pane, band, key, theme, alert, speech, refresh, cache, timeout, limit, history, progress, and mod groups. |
| DOC6-40 | Implemented in this pass | A field outside the schema is refused as an unknown key rather than ignored, so a typed key cannot silently do nothing. |
| DOC6-65 | Implemented in this pass | Every key in the tables below is in the schema, so this document and that file now describe the same configuration. |
| DOC6-75 | Implemented in this pass | A setting nothing read is retired from the schema rather than kept as a promise: `commands.python`, the `controller` and `labels` groups, two band reserves, two theme maps and `theme.running`, the speech sample folder, three timeouts, the worktree worker count, a progress staleness, and the `statusline` group. A document that still sets one is refused by name as an unknown key. |

## Getting started

| Step | What it does |
| --- | --- |
| `/llm-fleet setup` (or `make configure`) | Writes a starter configuration where the loader reads it: the file `$FLEET_CONFIG` names, otherwise the default place. It holds the provider homes found on this machine (the one `CLAUDE_CONFIG_DIR` names and `~/.claude`) and nothing else, with paths under the home written as `$HOME/...`. It never overwrites: a file or link already there is left as it is, and the command says so. |
| `/llm-fleet doctor` (or `make doctor`) | Says what the pane is missing: the interpreter and its version, where the configuration was read from and whether the loader took it, each provider and source with its state, and the commands the readers start. Every fix it names is a key from this document, taken from the schema's own rule for that source. |

## Plugin options

| Option | Default | What it sets |
| --- | --- | --- |
| Python interpreter (`python`) | `python3` | The interpreter every reader runs under: a name on the PATH or a full path, Python 3.11 or newer. A value the session cannot start is named by `/llm-fleet doctor` with this option. |
| Configuration file (`configPath`) | empty | A full path to the configuration, passed to every reader as `$FLEET_CONFIG`. Empty reads the default place. A relative path is refused by name. |
| Desktop notifications (`notify`) | `true` | Raises a desktop notification beside the in-session toast when a job fails or waits. |

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-76 | Plugin options | The options are the host's, set in `/config` for the plugin, and hold only what must be known before the configuration file is read: the interpreter that reads it and where it is. Everything else is in the file. |

## Resolution output

| Key | Holds |
| --- | --- |
| `schemaVersion` | The version the document declared, otherwise the default |
| `stateDir` | The resolved fleet state directory |
| `providers` | Each declared route as `id`, `label`, `home`, `enabled`, `adapter`, and `state` |
| `sources.<id>` | `enabled`, `state`, and that group's declared fields |
| `commands` | The resolved remaining keys |

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-41 | Resolution output | Resolution is pure apart from one injected path probe, so a result can be asserted without a machine that has provider homes. |
| DOC6-85 | Pause markers | `paused_when_exists` accepts `~` or `~/` expanded from `HOME` (also a backslash separator on Windows), declared environment variables, absolute paths, or paths relative to the configuration file. A disabled source stays disabled. Required target settings remain required; an existing marker is checked before probing those targets. Removing the marker resumes the next read. |
| DOC6-42 | Resolution output | `sources.jobs.providers` and `sources.interactive.providers` list ready identifiers only. |
| DOC6-43 | Resolution output | A refusal carries every error as a code and a field path, sorted by path then code. Message text is not part of the contract. |

## Source and provider states

| State | Meaning |
| --- | --- |
| `disabled` | The configuration switched the source off. No work is attempted, and no path is probed. |
| `paused` | An enabled progress or trials source has an existing pause marker. No source data is read; cached rows are replaced by a paused line. |
| `unconfigured` | The source is enabled, but no provider home is ready to read. |
| `unavailable` | The source is enabled and configured, but its target is missing or is the wrong kind. |
| `ready` | The source is enabled, configured, and present. |

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-44 | Source and provider states | Empty and failed are reader states: a reader reaching a ready source with zero rows reports empty, and a reader whose read fails reports failed. |
| DOC6-45 | Source and provider states | An unavailable source is never rendered as an empty one, and a missing provider home is unavailable rather than a failure. |
| DOC6-46 | Source and provider states | Providers use `disabled`, `unavailable`, and `ready`; `unconfigured` belongs to a source, not to a provider. |
| DOC6-71 | Source and provider states | A mod uses `disabled`, `unavailable`, and `ready`: an enabled mod whose platform binding cannot run here reads unavailable. |
| DOC6-72 | Source and provider states | An enabled group missing a required field is refused before anything else runs, and an enabled group with no ready provider reads unconfigured. |

## Recorded decisions

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-47 | Recorded decisions | An absent file at the default location uses the declared defaults. |
| DOC6-48 | Recorded decisions | A file named by the selector that is absent, unreadable, or not a regular file is an error, never a silent fall back to defaults. |
| DOC6-49 | Recorded decisions | Legacy environment overrides are recorded in the schema and never read: their precedence is undecided, so setting one changes nothing. |
| DOC6-50 | Recorded decisions | A value may reference `HOME` and the declared XDG variables. Tilde expansion is allowed only for `paused_when_exists`; other fields refuse it. Shell expressions, undeclared names, and unset variables are refused. |
| DOC6-51 | Recorded decisions | Paths resolve lexically against the config file's directory. Nothing is required to exist, and no symlink is followed. |
| DOC6-52 | Recorded decisions | `commands.cleanup` and `commands.skillReport` entries are literal argv; no variable expansion is applied to them. |
| DOC6-53 | Recorded decisions | An enabled source missing a required field is refused at load time, before any reader runs. |
| DOC6-54 | Recorded decisions | A provider enabled without a home is refused; a provider whose declared home is absent reads unavailable. |
| DOC6-61 | Recorded decisions | The default location is the XDG variable when it is set, otherwise the user directory the platform defines, otherwise the home-based location: `$LOCALAPPDATA/llm-fleet` for state and `$APPDATA/llm-fleet/config.json` on Windows. |
| DOC6-62 | Recorded decisions | Paths use the running platform's separator and drive rules, so a document written on one platform resolves on the other only when it names paths that exist there. |
| DOC6-63 | Recorded decisions | A value may reference a variable as `$NAME` or `${NAME}`. The percent form used on Windows is refused rather than taken as a literal directory name, so a name that looks like an expansion can never become a folder. |
| DOC6-73 | Recorded decisions | A cross-field check is declared in the schema as a rule and implemented once per loader, so neither language layer decides policy on its own. |
| DOC6-74 | Recorded decisions | `mods.secretShield.minimumLengths` has no default: an enabled mod with no threshold supplied is refused rather than given a number this contract cannot support. |
| DOC6-78 | Recorded decisions | `cache.rosterSeconds` defaults to 0, which keeps nothing: the roster is one command per provider home and there is no cheaper way to ask, so the window is the only lever on what a steady read costs, and how late a waiting job may reach a person is theirs to set rather than a number this repository picks. An answer kept within the window stands in for the read; only a ready or empty answer is kept, because a failure kept for a minute tells a session its machine is broken long after it stopped being, and an answer dated after the read that finds it is not fresh, so a clock that stepped back reads again. |

## Loading contract

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-5 | Loading contract | Proposed location: `$XDG_CONFIG_HOME/llm-fleet/config.json`, falling back to `$HOME/.config/llm-fleet/config.json`. |
| DOC6-6 | Loading contract | `FLEET_CONFIG` will select another file. |
| DOC6-7 | Loading contract | An absent file uses the defaults below. |
| DOC6-8 | Loading contract | A malformed file or invalid field must produce a configuration error; never silently substitute a personal setup. |
| DOC6-9 | Loading contract | Resolve relative paths against the config file's directory. |
| DOC6-10 | Loading contract | Expand `$HOME` and the declared variables only; never evaluate a shell expression. |
| DOC6-11 | Loading contract | Unless a row says otherwise, an absent field takes its proposed default. |
| DOC6-12 | Loading contract | An empty list means none, not discover everything. |
| DOC6-13 | Loading contract | Unknown fields are errors. |
| DOC6-14 | Loading contract | Source settings and UI preferences are separate: explicit config provides fresh defaults; validated plugin-store preferences can override collapse, tips, hide, and voice choices. |
| DOC6-15 | Loading contract | No secret values belong in this JSON. |
| DOC6-64 | Loading contract | The declared variables are `HOME`, the four XDG variables, `LOCALAPPDATA`, and `APPDATA`. |

## Sources and paths

| Proposed key | Type | Existing value or behavior | Proposed default / absence |
| --- | --- | --- | --- |
| `schemaVersion` | integer | No unified schema | `1`; unsupported version is an error |
| `stateDir` | path | llm-fleet cache under the user's local state directory; `FLEET_STATE_DIR` override | `$XDG_STATE_HOME/llm-fleet`, else `$HOME/.local/state/llm-fleet` |
| `providers` | array of objects | Three hardcoded routes, with `FLEET_HOMES` override | `[]`; show setup-needed, not zero jobs |
| `providers[].id` | nonempty string | Route key duplicated between helper and UI | Required; duplicate IDs rejected |
| `providers[].label` | string | Claude, DeepSeek, Kimi | ID if absent |
| `providers[].home` | path | Route-specific directories under the user's home | Required for enabled provider; no personal fallback |
| `providers[].enabled` | boolean | Existing directories are read | `true`; missing enabled home is unavailable |
| `providers[].adapter` | enum | Claude Code roster command | `claude-code`; other adapters remain future work |
| `sources.jobs.enabled` | boolean | Always attempts roster | `true`; no configured providers means unconfigured |
| `sources.interactive.enabled` | boolean | Interactive counts from same roster | `true`; shares roster read |
| `sources.prs.enabled` | boolean | Always attempts configured repository list | `false`; disabled until enabled |
| `sources.prs.repositories` | string array | Two personal repository defaults; `FLEET_REPOS` override | `[]`; enabled with no repositories is a config error. `@me` adds every repository holding an open pull request the signed-in account authored, found by search and read for that author's pull requests only |
| `sources.prs.limit` | positive integer | 30 open pull requests per repository | 30; the cap on rows one repository may contribute |
| `sources.prs.checkRunLimit` | integer, 0 to 100 | Not present | 12; the checks a pull request row lists one by one in `check_runs`. Past it the failing checks are kept first, then the pending ones, and `check_runs_more` counts the rest |
| `sources.trials.enabled` | boolean | Reads controller store when present | `false`; optional adapter |
| `sources.trials.database` | path or null | Local controller database; `FLEET_CHANGE_DB` override | `null`; required when trials enabled |
| `sources.trials.paused_when_exists` | path or null | Optional pause marker | `null`; absent means never paused. Checked on every read before opening the database, including lease lookups. |
| `sources.trials.stages` | string array | Not present | `NEW,PLANNED,TRIALED,PUSHED,MERGED,PUBLISHED,VERIFIED,CLEANUP_ELIGIBLE,CLEANED`: the controller's stage path. A change not at the last stage that moved within `history.trialsSeconds` is drawn in flight with a bar of its place on the path; a state the path does not name keeps its row without a bar |
| `sources.trials.offSwitch` | path or null | Not present | `null`: the older marker, whose presence switches the change controller off. Read only when no governance switch path is configured; with one, the controller's boolean in that document decides |
| `sources.progress.enabled` | boolean | Reads shared governor files | `false` |
| `sources.progress.directory` | path or null | Personal tooling state path; `FLEET_PROGRESS_DIR` override | `null`; required when progress enabled |
| `sources.progress.offSwitch` | path or null | Not present | `null`: the older marker for the governor, on the same terms as `sources.trials.offSwitch`; the governance document's governor boolean decides when one is configured |
| `sources.progress.paused_when_exists` | path or null | Optional pause marker | `null`; absent means never paused. Checked on every read before inspecting the run directory. |
| `sources.worktrees.enabled` | boolean | Cached rows, fresh probe on section opening | `false` |
| `sources.worktrees.roots` | path array | One personal worktree root; `FLEET_WORKTREES_DIR` override | `[]`; required when enabled |
| `sources.worktrees.baseRef` | non-empty string | A personal branch name, hardcoded in the preserved-branch helper | `origin/main`; the reference a worktree branch is compared with |
| `sources.skills.enabled` | boolean | Reads scan files if present | `false` |
| `sources.skills.directory` | path or null | Local scan state; `FLEET_SKILL_SCAN_DIR` override | `null`; required when skills enabled |
| `sources.load.enabled` | boolean | None | `false`; reads the process table and the working directory of each drawn process |
| `sources.load.top` | integer, 1 to 50 | None | `6`; how many processes are drawn from the top of the CPU list and how many from the top of the memory list, once each |
| `sources.load.command` | argv array or null | The platform's own listing (`ps` on macOS and Linux) | `null`; a command printing pid, CPU percent, resident kilobytes, elapsed time and command per line, in place of the platform's own |
| `sources.agents.enabled` | boolean | None; a background session row carried no figures of its own | `true`; each roster session's transcript and task list are read for its card, and no ready provider means unconfigured |
| `sources.governance.enabled` | boolean | Not present | `false`; draws the machine's governor and controller switch, and the band button that moves both |
| `sources.governance.switchPath` | path or null | Not present | `null`; the switch document the tooling writes. A machine with no path reads `unconfigured` and draws nothing |
| `sources.governance.switchCommand` | argv array or null | Not present | `null`; the command a press runs, given the word `on` or `off` and then the scope. With none, the section is read-only |
| `sources.pacer.enabled` | boolean | Not present | `false`; read the machine's run slots through pacer. Switched on, it needs `sources.pacer.command`, and is refused by name without one |
| `sources.pacer.command` | argv array or null | Not present | `null`; pacer's own command. The read runs it with `status --json` and draws what it prints: the switch, each slot and the repository holding it, and, from the pacer version that records them, the callers waiting for a slot (`waiting`) and the runs that finished (`recent`). A field pacer did not send is drawn as not reported, never as nobody. The band's gear runs it with `on` or `off` and reads the status again. A command that is not on the PATH is unavailable; one that exits nonzero, overruns `timeouts.commandSeconds`, prints more than `limits.jobStateBytes` or prints anything but that object is failed and names why |
| `sources.statusline.enabled` | boolean | Separate renderer installed through host settings | `false`; switches the session's own figures on, which the pane reads from the payload the renderer last wrote |
| `sources.statusline.payload` | path | None; the renderer had nowhere to record what the host handed it | `null`; read rather than written by this repository. A path holding `{session}` is filled with this session's identifier, so one renderer serving many sessions writes a file each and a pane reads its own; with no identifier that path reads `unavailable` rather than another session's figures. A source with none of this, `sessionCosts` or `codexSessions` reads `unavailable` |
| `sources.statusline.sessionCosts` | path or null | None | `null`: the folder where the status line keeps one priced-spend file per routed session (`<provider>-session-<identifier>.json`). Read for a session whose model is not Claude, whose cost the host's own table does not describe; the file's `usage.cost` is drawn and marked as priced from the transcript |
| `sources.statusline.spendSeconds` | integer, at least 60 | None | `86400`: how far back, in seconds, the priced session files are summed for the machine-wide spend drawn beside the session's own cost. A file written before the window is not counted, and a file that cannot be read or priced is counted as skipped rather than drawn as spend. A folder that does not exist reads unavailable, never `$0.00` |
| `sources.statusline.codexSessions` | path or null | `~/.codex/sessions` | `null`: the folder Codex writes its rollout files beneath, one `rollout-*.jsonl` per session. Read only for a session whose model is Codex's: the newest rollout's last `token_count` event supplies the five-hour and weekly windows, with the percentage used and the reset, in place of the payload's own windows. A missing folder or a rollout with no parseable limits is unavailable, never zero |
| `sources.statusline.claudeLimits` | path or null | `claude-rate-limits.json` inside the `sessionCosts` folder | `null`: the file the status line writes the account's Claude five-hour and weekly windows to. Read only for a session whose model is Claude's and whose payload carried no windows of its own, so a payload that did carry them is never second-guessed. A file that is not there, cannot be read, or holds no window is unavailable, never zero, and with no place configured nothing is reported rather than a state |
| `commands.claude` | argv array | `claude` on PATH, with the roster arguments appended by the reader | `["claude"]`; a wrapper command carries its own fixed leading arguments |
| `commands.github` | argv array | `gh` on PATH, with the pull-request arguments appended by the reader | `["gh"]`; a wrapper command carries its own fixed leading arguments |
| `commands.cleanup`, `commands.skillReport` | argv array or null | Commands inside personal tooling checkout | `null`; hide copy action and explain unavailable integration |
| `commands.cleanupArgs` | argv array or null | Not present | `null`, which offers `cleanup --worktree {path} --branch {branch}` after the cleanup command. Otherwise the words that follow it, where a word that is exactly `{path}` or `{branch}` is the worktree's folder or its branch, so a closer that takes the folder alone is `["{path}"]`. A template that never names `{path}` offers no line, and one that names `{branch}` offers none for a worktree with no branch |
| `runtime.childEnvironment.stripPrefixes` | string array | `ANTHROPIC_`: no child inherits an Anthropic variable | `["ANTHROPIC_"]`; the baseline entries must remain present |
| `runtime.childEnvironment.stripNames` | string array | Named DeepSeek, Kimi, and OpenAI key variables | The three baseline names; must remain present |

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-16 | Sources and paths | Provider homes must drive both roster reads and attach commands. |
| DOC6-17 | Sources and paths | No separate hardcoded UI map. |
| DOC6-18 | Sources and paths | The legacy colon-separated `FLEET_HOMES` format cannot safely represent every platform path; the JSON array replaces it. |
| DOC6-19 | Sources and paths | Migration must define precedence for the existing environment overrides before enabling compatibility. |

## Sections, layout, and keys

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-55 | Sections, layout, and keys | Every group from here down is in the schema, with the defaults this document proposes. |
| DOC6-56 | Sections, layout, and keys | `pane.sections` is a record per section, so a document can set one section without restating the other seven. |
| DOC6-66 | Sections, layout, and keys | `pane.sectionOrder` accepts any subset of the twelve section identifiers, rejects one that is not declared, and rejects a repeat. |
| DOC6-67 | Sections, layout, and keys | `keys.close`, `keys.collapse`, and `keys.expand` must differ from one another and may not be a digit, because the pane folds its sections with the digits. |
| DOC6-68 | Sections, layout, and keys | A color is a declared token, and an alert tint is three bytes from 0 to 255. |
| DOC6-70 | Sections, layout, and keys | The pane draws the order and the folds `pane.sectionOrder` and `pane.sections` resolve to, which the read command prints as a `pane` document with the reading: a plugin has no file of its own to read, so this is how an edited file reaches it. An empty `sectionOrder` is a pane with no sections rather than all ten. A document that is not a resolved configuration, or that names a section whose choice is not two booleans, is refused whole and the packaged default stands. A press outranks the configuration, is kept on the host's session state so a hot reload survives it, and in the plugin's store so the next session opens with the folds the person left; a session's own folds outrank the stored ones, and a store that refuses the save is said once in a toast. A press writes only the sections it named, over what the session and the store hold, so one load of a session never writes its whole picture over another's press; the store has no compare-and-set, so two sessions saving in the same moment can leave the earlier fold for the next session. `/worktrees` and `/keys` open the pane on that one section with every other folded, and a second run closes it; `/worktrees` also has the next look probe every worktree now (`--refresh-worktrees`). The key tip after the hint line rotates through `keys.tips` every `refresh.keyTipMs` while a draft is typed, and `/keys tips off` or `on` keeps the person's own word in the store; either that word or `keys.tipsEnabled` off is off. |

| Proposed key | Type | Existing value | Proposed default / absence |
| --- | --- | --- | --- |
| `pane.sectionOrder` | section ID array | `sessions,session,trials,prs,warnings,worktrees,skills,running,load,keys,governance` | `load,prs,sessions,trials,running,session,pacer,worktrees,skills,warnings,governance,keys`: the machine's load first, then pull requests and the rest by how much each needs a person, with pacer's run slots directly below this session, with the machine's switches just above the keys; reject duplicates and unknown IDs |
| `pane.sections.<id>.title` | non-empty string | Section names as the pane draws them | Packaged names; a section the document renames carries the new name on its heading |
| `pane.sections.<id>.visible` | boolean | All ten rendered | `true`; hidden source failures still reach header |
| `pane.sections.<id>.collapsed` | boolean | Worktrees, skills, keys collapsed | Same per-section defaults |
| `pane.sections.<id>.legend` | string | Fixed explanations of state and automatic behavior | Packaged neutral legends; no claims about unconfigured cleanup |
| `pane.sections.<id>.hideWhenEmpty` | boolean | Not present | `false`, and `true` for warnings: the section is left out while it has no rows and its source is not failed, unavailable or stale |
| `pane.sections.<id>.maxRows` | positive integer | Not present | `8`: a section draws at most this many rows and counts the rest beside its heading, so one long section cannot push the others off the pane |
| `pane.custom` | map of section records | Not present | `{}`: a person's own sections, none shipped. Each key names a section as `custom:<key>`, lowercase letters, digits and hyphens, up to 32 characters |
| `pane.custom.<key>.command` | argv array | Not present | Required. Run with no extra arguments; its standard output is the section, in the shape under Custom sections |
| `pane.custom.<key>.title` | non-empty string | Not present | `Custom section` |
| `pane.custom.<key>.legend` | non-empty string | Not present | `No legend configured.` |
| `pane.custom.<key>.timeoutSeconds` | integer, at least 1 | Not present | `8`; a command that overruns reads as failed |
| `pane.custom.<key>.visible`, `.collapsed`, `.hideWhenEmpty` | boolean | Not present | `true`, `false`, `false`, as for the built-in sections |
| `pane.custom.<key>.maxRows` | positive integer | Not present | `8`, as for the built-in sections |
| `pane.minimumColumns` | positive integer | 20 | `20` |
| `pane.horizontalReserve` | nonnegative integer | 0 columns | `0`; the host already counts the pane body inside its frame, so any reserve narrows the cards short of the edge |
| `pane.progressCells` | positive integer | Fixed 16-cell text bar | `16`; the cell count of a row meter that states its counts beside it, capped by the width of the card it is drawn in. Agent cards and this session's bars run the card's full width with their figures on the line above, as the host's Agents panel draws them |
| `pane.skillRows` | positive integer | At most 5 shown | `5`; the rows beyond it are counted beside the heading rather than dropped in silence |
| `band.hiddenLimit` | positive integer | 200 retained attention keys | `200` |
| `pane.repliedLimit` | positive integer | Last 50 reply keys retained | `50`; a reply is remembered by its job and the hash of the whole question, so a new question offers the field again |
| `pane.replyMaxChars` | positive integer | Not present | `4000`; a longer reply is refused with a toast naming the limit, never cut |
| `pane.replyPendingSeconds` | positive integer | Not present | `120`; how long a reply recorded as on its way but never confirmed sent waits before its row says it may not have been sent and offers Send again; the alerts helper refuses to clear one younger than this |
| `pane.fanLines` | nonnegative integer | Not present | `4`; a working job's open subagent tasks listed under it, the rest counted; `0` counts them all |
| `keys.tipsEnabled` | boolean | `true`, persisted | `true` |
| `keys.tips` | string array | Five editing and diff tips | Same actions in portable wording; empty disables rotation |
| `keys.close`, `keys.collapse`, `keys.expand` | key strings | `x`, `c`, `e`; Escape closes | Same keys; reject conflicting bindings and digits |

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-20 | Sections, layout, and keys | The five tips cover Ctrl+U, Ctrl+K, Option+Delete / Ctrl+W, Escape twice / Ctrl+_ / Ctrl+Y, and `/diff`. |
| DOC6-21 | Sections, layout, and keys | Host-dependent key labels need a platform mapping. |
| DOC6-22 | Sections, layout, and keys | Visibility is not source enablement: disabling a reader prevents its work; hiding a section changes presentation only. |

## Custom sections

A custom section is a command the read runs once per reading. It prints one JSON object, and the pane draws it like any built-in section: a heading with its summary, one row per entry, and a bar wherever a row gives both `done` and `total`. `pane.sectionOrder` places it as `custom:<key>`; a visible custom section the order does not name is drawn after the sections it does.

| Output field | Type | Meaning |
| --- | --- | --- |
| `summary` | string, optional | Drawn beside the heading, such as `3 running` |
| `rows` | array, at most 50 drawn | One entry per row |
| `rows[].title` | string | The row's name; a row without one is skipped |
| `rows[].state` | string, optional | `working`, `running`, `active`, `waiting`, `blocked`, `failed`, `error`, `passed` or `done` color the row; anything else draws it plain |
| `rows[].detail` | string, optional | The line under the title |
| `rows[].slot` | string, optional | The text at the right edge |
| `rows[].done`, `rows[].total` | non-negative integers, optional | Drawn as a bar only when both are present and `total` is above zero; never invented |
| `rows[].failed` | non-negative integer, optional | Drawn in the bar as failures |

A command that is not on the PATH reads as unavailable; one that exits nonzero, overruns its timeout, or prints anything but such an object reads as failed and names why; one that prints no rows reads as empty. Text is cut to the configured lengths and masked before it is drawn. A private checkout keeps its owner's configuration in `personal/config.json`, linked from the default path; the export refuses that folder, so the published repository carries only the defaults and the example. `config/examples/` holds one to copy: `custom-section.json` declares a Disk section, and `disk_section.py` is the command it names, which draws each disk the session writes to with a bar of the space used. The command runs without the provider credentials the reader strips from every child. Its first item is a name looked up on that child's PATH, or a path when it holds a separator; no variable in it is expanded. Sections run in parallel, each bounded by its own timeout, and their output is read up to `limits.jobStateBytes`.

```json
{
  "pane": {
    "sectionOrder": ["prs", "custom:deploys", "sessions", "trials", "running", "session",
                     "worktrees", "skills", "warnings", "keys"],
    "custom": {
      "deploys": {
        "title": "Deploys",
        "command": ["deploy-status", "--json"],
        "legend": "Deploys in progress, with the steps each has finished."
      }
    }
  }
}
```

```json
{"summary": "1 running", "rows": [
  {"title": "web to staging", "state": "running", "detail": "migrating", "done": 3, "total": 5}
]}
```

## Colors, tones, and speech

| Proposed key | Type | Existing value | Proposed default / absence |
| --- | --- | --- | --- |
| `theme.failure`, `theme.waiting`, `theme.working`, `theme.idle` | host color tokens: `text`, `subtle`, `inactive`, `success`, `error`, `warning`, `merged`, `claude`, `suggestion`, `planMode` | `error`, `warning`, `success`, `subtle` | Same; each is what the pane and the band draw that tone as, everywhere the tone appears, desktop drawings included. The tones are levels, not single states: `failure` is anything alarming (a failed run, a context nearly full), `waiting` anything that wants attention (a job waiting on you, a stale source, context running low), `working` anything healthy and live, and `idle` everything quiet, from an idle job to a card's resting border and a low-effort label. Swapping `failure` and `working` for a red-green palette is one edit. Running work draws as `working` |
| `theme.worktrees` | state-to-tone map: `failure`, `waiting`, `working`, `idle` | Active success; held/unknown warning; merged/preserved subtle | Active `working`; held and unknown `waiting`; merged and preserved `idle`. The tone colors the words under a worktree's title, and the four tone settings decide how that tone looks |
| `alerts.notify` | boolean | Plugin option defaults true | `true`; terminal native notifications only until host capability verified |
| `alerts.toast` | boolean | Focused-session toasts | `true` |
| `alerts.tones` | event-to-asset map or null | No tone asset list implemented | `null`; silence, no fabricated asset path |
| `alerts.tabTint.enabled` | boolean | iTerm only, tmux passthrough required | `true` on supported terminal; otherwise no tint |
| `alerts.tabTint.failureRgb` | three byte integers | `[220,50,47]` | Same; read by the tab helper from the configuration, not carried in the reading |
| `alerts.tabTint.waitingRgb` | three byte integers | `[255,176,0]` | Same; read by the tab helper from the configuration, not carried in the reading |
| `alerts.tabTint.staleSeconds` | integer, at least 30 | None; each session kept its own tint | `120`; read by the tab helper: a session sharing a tab whose entry in the tab's locked record is older than this no longer counts toward the tab's color, and each session says its level again every third of it, none included while tinting is on, so a failure whose session died is let go |
| `speech.enabled` | boolean | On | `false` until user opts in and supplies synthesis |
| `speech.backend` | enum | Local Kokoro WAV generation | `kokoro`; no system-voice fallback |
| `speech.command` | executable path or null | Home-relative local synthesis binary | `null`; explain unavailable when speech requested |
| `speech.group` | enum | Female | `female` |
| `speech.voice` | string or null | Stored pick, otherwise first usable voice | `null`; use group order |
| `speech.voices.female` | string array | `af_sky,af_kore,af_nicole` | Same initial list; validate selected voice membership |
| `speech.voices.male` | string array | `am_michael,am_onyx,am_adam,am_echo,am_eric,bm_george,jm_kumo` | Same initial list |
| `speech.tempDirectory` | path | `TMPDIR`, else `/tmp` | Operating-system temporary directory |

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-23 | Colors, tones, and speech | Voice samples do not drive discovery in the inspected implementation: the voice array is static. |
| DOC6-24 | Colors, tones, and speech | A comment suggesting removal of a sample changes the list is not an implemented file watcher. |
| DOC6-25 | Colors, tones, and speech | The new loader must keep that distinction clear. |

## Time, bounds, and retention

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-26 | Time, bounds, and retention | All durations below are positive integers in the unit named. |
| DOC6-27 | Time, bounds, and retention | Missing fields use the proposed default, which matches the inspected value unless stated otherwise. |

| Proposed key | Type | Existing value / proposed default |
| --- | --- | --- |
| `refresh.snapshotMs` | milliseconds | 3000: how often each session looks at the reading every session shares; the machine is read only when that reading is older than `cache.snapshotSeconds` |
| `refresh.progressMs` | milliseconds | 1000: how old a live governor run's counts may get while a pane shows them |
| `refresh.clockMs` | milliseconds | 1000: how often an open pane is drawn with nothing new, so its ages and run times count up between readings |
| `refresh.streamStepMs` | milliseconds | 150: how far apart the sections a new reading changed land on the pane; the first lands at once and the rest follow it down |
| `refresh.keyTipMs` | milliseconds | 30000, only with prompt text |
| `cache.snapshotSeconds`, `cache.prSeconds`, `cache.worktreeSeconds`, `cache.rosterSeconds` | seconds | 20, 120, 300, 0 |
| `timeouts.helperMs`, `timeouts.worktreeHelperMs` | milliseconds | 25000, 60000: how long a session waits for one read of the machine, and for one that also probes every worktree; both travel in the reading's `alerts` part, so a session that has not loaded the configuration waits as long as the one that read it. A session that has held no reading asks the read command for its settings alone first (`--settings`, no reader run, 10 seconds), so its first read already waits the configured time |
| `timeouts.commandSeconds` | seconds | 8 |
| `timeouts.worktreeProbeSeconds`, `timeouts.liveHoldersSeconds` | seconds | 8, 5 |
| `timeouts.gitSeconds` | seconds | 2 |
| `timeouts.trialDatabaseSeconds`, `timeouts.leaseDatabaseSeconds` | seconds | 5, 1 |
| `timeouts.synthesisMs`, `timeouts.tabCommandMs` | milliseconds | 30000, 5000 |
| `history.trialsSeconds`, `history.cleanedSeconds` | seconds | 43200, 604800 |
| `history.finishedJobSeconds`, `history.finishedJobLimit` | seconds, integer | 86400, 8 |
| `history.spendWindowHours`, `history.spendBucketMinutes` | hours 1 to 168, minutes 1 to 1440 | 24, 60; the stretch the roster's `spend_series` and each agent's `timeline` cover, and the minutes one spend bucket holds. The series is the window rounded up to whole buckets |
| `history.timelineIdleMinutes`, `history.timelineSegmentLimit` | positive integers | 5, 48; a gap between two transcript records longer than the first ends a working segment, and past the second the oldest segments are merged into one working segment |
| `history.eventLimit` | positive integer | 50; the events the reading's `events` document keeps, newest first |
| `band.waitingJobSeconds` | seconds | 86400 since blocking, not session start |
| `alerts.claimRetentionSeconds`, `alerts.focusSeconds` | seconds | 172800, 1800 |
| `alerts.toastMs`, `alerts.copyToastMs` | milliseconds | 8000, 6000 |
| `limits.jobStateBytes`, `limits.questionCharacters` | integers, at least 1024 and 1 | 65536, 200; the byte bound holds at least an empty job-state record |
| `limits.jobStateClockSkewSeconds` | seconds, at least 0 | 300; how far ahead of a read a kept job time may be after the clock steps back, refused beyond it |
| `limits.hostPayloadBytes` | positive integer | 1048576; the statusline payload is refused, never truncated, above this |
| `limits.agentTranscriptBytes` | positive integer | 16777216; a longer transcript is read from its tail, and its token and cost totals are drawn as lower bounds. It bounds each of a session's subagent transcripts as well; a subagent transcript the bound cuts, one that cannot be read, or more of them than one read opens is named on the card and leaves its totals a floor |
| `sources.agents.inputPricePerMTok`, `sources.agents.outputPricePerMTok`, `sources.agents.cacheReadPricePerMTok` | open maps of model generation to a number | `fable-5-1` 10, 50, 0.25; `opus-5-5` 4, 20, 0.2; `opus-5` 5, 25, 0.5; `opus-4-8` 5, 25, 0.5; `opus-4-7` 5, 25, 0.5; `sonnet-5-5` 2, 10, 0.1; `sonnet-5` 2, 10, 0.2; `haiku-5-5` 0.1, 0.5, 0.01; `haiku-4-5` 1, 5, 0.1; `deepseek-flash` 0.3, 1.2, 0.006; `deepseek-v4-pro` 1.32, 3.96, 0.044; `kimi-k2.7-code` 0.95, 4, 0.19; `mimo-v2.6-flash` 0.14, 0.28, 0.0028; no `other` entry, so a model no key names shows no cost rather than another generation's. Each key names a whole generation, not a family: what follows the key must be the end of the identifier, or the eight-digit release date the host stamps on with nothing after it, and the context marker the host appends is not part of the generation. The longest of the keys that name one identifier wins, whatever order the map holds them in. So a generation nobody checked never borrows the rates of the one beside it. Starter rates in dollars per million tokens, used to estimate a session's cost turn by turn at the rate of the model that ran each turn; a live rate card fetched for a generation replaces its row (`sources.rates`). A finished session's own recorded cost outranks them, except where the host says it could not price a model and a model the session ran is not Claude: the host's figure is then its own table applied to another vendor's tokens, and the estimate stands. The session section prices its cache saving from the same rates and multipliers; the statusline group has no prices of its own |
| `sources.agents.contextWindowTokens` | open map of model generation to an integer | 1000000 for each Claude generation the rate maps name, and none for the others, whose windows depend on the host that serves them; no `other` entry, so a model no key names draws its context in tokens with no share. These keys name generations as the rate maps do, because a model's window is read by the same rule that reads its rates |
| `sources.agents.cacheWrite5mMultiplier`, `sources.agents.cacheWrite1hMultiplier` | non-negative numbers | 1.25, 2; the input rate a cache write is priced at, by the cache's lifetime |
| `sources.rates.enabled` | boolean | `true`; each generation's rate card is fetched from the page its provider publishes and laid over the starter rates. `false` makes no network request and prices from the table alone. A fetch never runs inside a read: the pane's read starts one detached `rates.py --refresh` after it prints, which fetches only the cards older than `maxAgeSeconds`, holds a lock so two sessions never fetch at once, and sends nothing but a plain GET for a public page, with no credentials, cookies or session data |
| `sources.rates.cards` | open map of model generation to a string | Every Claude generation reads `anthropic https://platform.claude.com/docs/en/about-claude/pricing.md`; `deepseek-flash` and `deepseek-v4-pro` read `deepseek https://api-docs.deepseek.com/quick_start/pricing/`; `kimi-k2.7-code` reads `kimi https://platform.kimi.ai/docs/pricing/chat.md`; `mimo-v2.6-flash` reads `mimo https://mimo.mi.com/static/docs/price/pay-as-you-go.md`. Grammar: `<parser> <https url> [model=<name on the page>] [host=<provider>]`. Parsers: `anthropic`, `deepseek`, `kimi`, `mimo`, `openrouter`. A card prices the host the model runs on, so the same model served by two hosts takes two cards; an `openrouter` card must name its `host=`, since each OpenRouter provider charges its own rate. A page that moved, a model the page no longer lists or a host that does not serve it is a failed card: the last fetched rate stays, dated, and with none the starter row prices it, and the card says `table rates` |
| `sources.rates.maxAgeSeconds`, `sources.rates.retrySeconds` | seconds, at least 3600 and 60 | 86400, 3600; how long a fetched rate is used before its page is read again, and how long a page that failed waits before it is asked again |
| `timeouts.rateCardSeconds`, `limits.rateCardBytes` | seconds 1 to 30, bytes at least 65536 | 4, 4000000; one deadline covers every card of a refresh, and a page larger than the bound is refused rather than cut |
| Rate record | `<stateDir>/records/rate-cards.json` | Each generation's fetched rates with the time they were read, and each failed try with its reason. Written by the refresh alone; a read only opens it |
| `runtime.childEnvironment.stripPrefixes`, `runtime.childEnvironment.stripNames` | non-empty string arrays | Credential baseline; configuration may add entries, never remove one |
| `limits.skillItems`, `history.skillNoticeDays` | positive integers | 10, 7 |
| `limits.skillScanBytes` | positive integer | 16777216; a scan summary larger than this, or one that is not JSON, is named in the warnings rather than drawn as a scan that found nothing |
| `refresh.skillStaleSeconds` | seconds | 900 |
| `progress.etaMinimumOutcomes` | positive integer | 20 |
| `progress.runCeilingSeconds`, `progress.waitStaleSeconds` | seconds | 21600, 75 |

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-28 | Time, bounds, and retention | Provider child credential stripping is a security invariant, not an off switch. |
| DOC6-29 | Time, bounds, and retention | The present helper strips the Anthropic prefix and named DeepSeek, Kimi, and OpenAI key variables. |
| DOC6-30 | Time, bounds, and retention | Extraction must use an explicit child-environment policy covering every configured adapter. |
| DOC6-31 | Time, bounds, and retention | Job ID validation, bounded reads, truthful outcomes, and rejecting missing denominators are also invariants, not preferences. |
| DOC6-77 | Time, bounds, and retention | A rate map is open and names a model's generation: it ships an entry per generation whose rates were checked against the host, takes any other key, and still seeds the shipped entries into a partial map. A key prices a model only where it is the whole generation that identifier holds: what follows the key must be the end of the identifier, or the eight-digit release date the host stamps on with nothing after it, and the context marker the host appends is not part of the generation. Two keys can name one identifier whole, and the longest wins whatever order the map holds them in, so a more particular key is never shadowed by a broader one. A prefix is not a fit: `claude-opus-5-1` holds `opus-5`, and a key naming one generation must never answer for the next one, which nobody priced. So a key naming only a vendor, with no generation, prices no model of that vendor rather than all of them, and a model whose generation no key names reads unpriced, never at another generation's rate and never as a cost of zero. The window map is open the same way and names generations too, because a model's window is read by the rule that reads its rates. A person adds another vendor's model or another generation by naming it with its rates, and it reaches both readers. |

## Sibling mod settings to extract

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-32 | Sibling mod settings to extract | These modules remain separate. |
| DOC6-33 | Sibling mod settings to extract | The proposed `mods` namespace selects their defaults; implementation must preserve each mod's independent install path. |

| Proposed key or group | Type | Existing value | Proposed default / absence |
| --- | --- | --- | --- |
| `mods.typing.enabled`, `mods.secretShield.enabled`, `mods.contextKeeper.enabled`, `mods.replyFold.enabled` | boolean | Host plugin registration | `false`; opt in per mod |
| `mods.typing.stateDir` | path | Separate local typing state | `$STATE_DIR/typing` |
| `mods.typing.speller` | adapter | macOS Swift/AppKit process and Unix socket | `macos`; unavailable platforms pass typing through |
| `mods.typing.spellTimeoutMs` | integer | 150 | Same |
| `mods.typing.compileTimeoutMs`, `mods.typing.vocabBuildTimeoutMs`, `mods.typing.daemonIdleSeconds` | integers | 300000, 600000, 7200 | Same |
| `mods.typing.typeaheadMin`, `mods.typing.typeaheadRows`, `mods.typing.extraCheckLimit` | integers | 4, 2, 12 | Same |
| `mods.typing.transcriptRoots` | path array | Personal provider project directories | `[]`; no prompt mining without explicit roots |
| `mods.typing.vocab` | object | Bigram limit 20000, minimum count 2, unknown-word minimum 15 | Same; move existing config into canonical schema |
| `mods.typing.wordMin`, `mods.typing.wordMax`, `mods.typing.maxScanBytes` | integers | 3, 30, 2000000000 | Same, bounded by explicit scan scope |
| `mods.typing.typoRatio`, `mods.typing.rareBelow`, `mods.typing.frequentRatio` | integers | 20, 10, 200 | Same |
| `mods.typing.secretCollector` | argv array or null | Calls original shield collector | `null`; no vocabulary export until privacy dependency resolved |
| `mods.secretShield.storePaths`, `mods.secretShield.projectRoots` | path arrays | Personal shell/store files and project search root | `[]`; explicit private paths required for value collection |
| `mods.secretShield.refreshMs`, `mods.secretShield.retryMs`, `mods.secretShield.collectTimeoutMs` | integers | 600000, 30000, 20000 | Same |
| `mods.secretShield.projectDepth`, `mods.secretShield.continuationLimit` | integers | 6, 20 | Same |
| `mods.secretShield.minimumLengths` | object | Collector 8, URL passwords 6, masker 6; README says 10 | Unresolved; reconcile before extraction, never claim one threshold today |
| `mods.contextKeeper.scorer` | enum | Hook defaults to `haiku`, with `jev` alternative | `haiku` once explicitly enabled and scoped |
| `mods.contextKeeper.allowedRoots` | path array | Separate compaction policy | `[]`; no compaction interception outside configured roots |
| `mods.contextKeeper.keepThreshold`, `mods.contextKeeper.minReductionRatio` | numbers | 0.5, 0.25 | Same |
| `mods.contextKeeper.preserveRecentMessages`, `mods.contextKeeper.truncateHeadChars` | integers | 6, 300 | Same |
| `mods.contextKeeper.maxStateTokens`, `mods.contextKeeper.maxRequestTokens` | integers | 25000, 30000 | Same |
| `mods.contextKeeper.model`, `mods.contextKeeper.goal`, `mods.contextKeeper.scorerTimeoutMs` | string, string, integer | `jev-latest`, empty goal, Haiku timeout 60000 | Same where applicable to selected scorer |
| `mods.replyFold.enabled`, `mods.replyFold.words`, `mods.replyFold.previewLines` | boolean, integers | true, 220, 6 inside installed mod | Outer mod opt-in false; once enabled, same folding defaults |

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-34 | Sibling mod settings to extract | The broader statusline loads separate pricing, provider, routing, and compaction policies. |
| DOC6-35 | Sibling mod settings to extract | Their values are not established by the fleet constants and must not be guessed. |
| DOC6-36 | Sibling mod settings to extract | Complete that inventory, archive-retention policy, platform executable mapping, and scorer-specific settings before moving those modules. |
| DOC6-37 | Sibling mod settings to extract | The queue records these remaining boundaries; the schema above is a design inventory, not a claim that every transitive personal integration has been extracted. |

## Fixture corpus and contract tests

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC6-57 | Fixture corpus and contract tests | `config/fixtures` holds one directory per case: the environment, the document, and the statement of what changes. |
| DOC6-58 | Fixture corpus and contract tests | Both loaders run the corpus and their outputs must agree with each other and with the expected result; `config/fixtures/README.md` gives the format. |
| DOC6-59 | Fixture corpus and contract tests | The contract is tested as a contract: field paths, defaults, bounds, states, error codes, and documentation coverage are asserted against the schema itself. |
| DOC6-60 | Fixture corpus and contract tests | A test supplies an extended schema to both loaders, which proves the keys come from the contract rather than from code. |
| DOC6-69 | Fixture corpus and contract tests | A success case states only what it changes; the harness supplies the rest from the defaults the schema declares, so a schema addition does not rewrite every expectation. |
| DOC6-70 | Fixture corpus and contract tests | A default that depends on another value is stated by the case rather than guessed by the harness, and a default that depends on a value that already failed is skipped so the cause is reported once. |
