# llm-fleet

![llm-fleet](assets/logo-horizontal-color-on-light.svg)

llm-fleet is a Claude Code plugin that keeps every session and background job on your machine in one live pane. You see which jobs are working, which wait for you and which failed, with each agent's model, step, context use and cost. A band above the prompt carries what needs you, and an alert reaches you when a job fails or starts waiting.

The machine's load, pull requests, worktrees, skill scans and your own sections can join the pane when you switch them on. Everything it reads comes from one configuration file, so nothing about your machine is written into the plugin.

## Install

Type this at the prompt of a Claude Code session:

```
/plugin install llm-fleet --marketplace doricstack/llm-fleet
```

Answer `y` to add the marketplace, then pick a scope. The one-step install needs Claude Code 2.1.295 or later. The readers are Python scripts, so you also need Python 3.11 or newer. On Windows the interpreter is `python`, not `python3`: set the plugin's Python option to `python` when the first `/llm-fleet` says the readers could not start.

## Upgrade

Claude Code installs a version and keeps it: it does not follow the plugin's source, and a session that is already open keeps what it loaded when it started. After a new release, update the plugin and restart:

```
/plugin update llm-fleet
```

A session started before the update has no pane until it restarts. From a checkout of this repository, `make host-update` does the same for every Claude home on the machine and reads each one back to prove it took.

## First run

```
/llm-fleet setup
/llm-fleet doctor
/llm-fleet
```

`/llm-fleet setup` writes a starter configuration holding the Claude Code homes it finds on this machine and nothing else. It never overwrites a file that is already there. The default place is `$XDG_CONFIG_HOME/llm-fleet/config.json`, then `%APPDATA%\llm-fleet\config.json` on Windows, then `~/.config/llm-fleet/config.json`.

`/llm-fleet doctor` tells you what the pane is missing and the setting that fixes each thing: the interpreter, where the configuration was read from, each home and source with its state, and the commands the readers start. `/llm-fleet` opens the pane, and running it again closes it.

## Using the pane

- The figures at the top are controls. Press **Working sessions**, **Waiting on you** or **Failed outcomes** to narrow the pane to those rows; a line under the controls says what is shown, with **Show all** to widen it again.
- A row that holds more than its two lines says so on its figures: press them to open the rest (path, provider, cleanup line, check list), and press again to close it.
- A section heading folds it, and the keys section lists every binding the pane draws.
- On the band above the prompt, the figures open the pane narrowed to their state, and the item the band leads with opens the pane where its row lives.
- What a row offers is copied or opened from its title: a job's attach line, a worktree's cleanup line, a pull request's page, a skill report command.

## Commands

- `/llm-fleet` opens or closes the pane, and `/llm-fleet close` only closes it.
- `/llm-fleet unhide` brings back the band items you dismissed.
- `/llm-fleet doctor` and `/llm-fleet setup` are the two commands from the first run.
- `/worktrees` opens the pane on its worktrees section with a fresh probe.
- `/keys` opens the pane on its keys section, and `/keys tips off` turns off the key tip under the prompt.
- `/speak` picks this session's voice or switches speech on or off in every running session, once you have configured a speech command. A session started later joins speech as it stands: on when it is on in any session, off when it is off everywhere. Off stops the line playing and every line waiting.

## Settings

Three options live in `/config` under the plugin, because they are needed before the configuration file can be read:

- **Python interpreter**: the interpreter the readers run under, `python3` by default.
- **Configuration file**: a full path to your configuration when it is not in the default place.
- **Desktop notifications**: on by default; adds a desktop notification to the in-session toast.

Everything else is in the configuration file. Each section can be shown or hidden (`pane.sections.<name>.visible`), folded at the start (`collapsed`), and capped at a row count (`maxRows`), and the order is the one you set. Sessions, background jobs, agent cards and this session's own cost, context and limits are on from the start. Pull requests, worktrees, trials, progress, skill scans and a recorded statusline payload are sources you switch on, and the doctor names the key each one needs. Speech is off until you set `speech.enabled` and a speech command. A key the schema does not know is refused by name rather than ignored. The full list of settings, with defaults, is in [the configuration reference](https://github.com/doricstack/llm-fleet/blob/main/docs/configuration.md).

## What it reads

To follow an external system's off switch, set `sources.progress.paused_when_exists` or `sources.trials.paused_when_exists` to its marker path. Both are optional and default to `null` (never paused). An existing marker replaces that source's rows with one paused line and prevents data reads; removing it resumes reads on the next refresh. `~/` expands from `HOME`, relative paths resolve beside the configuration file, and absolute paths follow the running platform. A disabled source stays disabled.

The plugin reads the session roster through the `claude` command, transcripts and task lists under the homes you configure, and, when you switch it on, pull requests through the `gh` command. The outside commands the readers start (`claude`, `gh`, `git`, `ps`, `lsof`, the speech command and your own sections' commands) run with your Anthropic variables and the common provider API key variables removed from their environment, and the configuration can add to that list but never shorten it.

The pane draws in the terminal, the Claude desktop app and the VS Code extension, on the same render site each app provides.

## What it sends, and what it runs

Nothing about you or your sessions leaves your machine through the plugin. It holds no key and reads no credential to send anywhere. Every fact in the pane is read on this machine and drawn on it. A desktop notification (`$.ui.notify`) is shown by Claude Code on this machine and goes nowhere else, and the only messages it sends are `$.session.send` notes to the other Claude sessions on the same machine, each holding a job identifier and a short line such as a speech reply. It reads the conversation only through the transcripts and events the host hands it, never sends that text anywhere, and never changes it.

The plugin makes one network request of its own, on by default: once a day it reads each model's public rate card from the page its provider publishes (Anthropic's pricing page for Claude, and the DeepSeek, Kimi and MiMo pricing pages for theirs), so a session's cost is priced at the rate the host it ran on charges. Each is a plain HTTPS GET for a public page, sent with no credential, cookie, session text, model usage or identifier of yours, from a background `readers/rates.py --refresh` that the pane's read starts and never waits on. `sources.rates.enabled: false` turns it off, and the pane then prices from the starter table it ships with; `sources.rates.cards` names the pages, so you can point a model at the host you use or drop one.

Two more things reach the network, and only because you turn them on: the pull-request source asks GitHub through your own `gh` login, and a custom section runs whatever command you give it. The one web address in the pane is a pull request's page on github.com, opened only when you press its row.

### The hooks, and what each decides

Every hook either answers its own command or drawing and returns, or passes the event on unchanged with `next(event)`. It registers no permission event and never decides whether a tool call may run; that stays with you and your settings. Its `command.run` hooks are matched to the four commands it registers, so no other command passes through it.

| Hook | What it does |
| --- | --- |
| `session.start` | Registers `/llm-fleet`, `/speak`, `/worktrees` and `/keys`, and reads this session's identity. |
| `command.run` | Answers those four commands and nothing else. |
| `ui.render` | Draws the pane, the band above the prompt and the key tip under it. |
| `ui.close` | Records that the pane shut and, for Escape, marks the digest it showed as seen. |
| `prompt.submit` | Records this session as the one you are typing in, so alerts reach you here, and lands any write a paint left waiting. It hands the prompt on unchanged and never reads, edits or drops its text. |
| `session.end` | Stops the timers this session started. |

### The programs it runs, and why

Every program runs as your user, from the list below, with its arguments built by the plugin and never through a shell.

| Program | Why |
| --- | --- |
| Your Python interpreter (the plugin option, `python3` by default) on the plugin's own scripts: `readers/snapshot.py`, `readers/alerts.py`, `readers/tab.py`, `readers/doctor.py`, `readers/setup.py`, `readers/governance.py`, `readers/pacer.py` and `readers/rates.py` | The reading behind the pane, alerts and speech, the terminal tab's color, the two first-run commands, the governance and pacer switches, and the daily rate-card refresh, started detached after a read when a card is older than a day. The statusline scripts (`readers/host.py`, `readers/session.py`, `readers/transcript.py`) run only when your statusline starts them. |
| `tmux show-options -gqv allow-passthrough` and `tmux display-message -p #{client_tty}` | Inside tmux only: whether the tab can be colored, and which terminal to color. |
| `claude` | The session roster. |
| `ps` | The machine's load, and which terminal a session runs in. |
| `git` and `lsof` | A worktree's branch and state, and which process holds it, when the worktrees source is on. |
| `gh` | Pull requests, when that source is on. |
| Commands your configuration names | The speech command, your custom sections, the governance switch, pacer (asked for its status, and given on or off when you press its switch), and the cleanup, skill report and process-list commands. None runs until you configure it. |

The outside commands run with your Anthropic variables and the common provider API key variables removed from their environment, and the configuration can add to that list but never shorten it.

### The files it writes

- The starter configuration, once, from `/llm-fleet setup`, and never over a file already there.
- Small records under its state directory (`$XDG_STATE_HOME/llm-fleet`, `%LOCALAPPDATA%\llm-fleet` or `~/.local/state/llm-fleet`): which alert was claimed, which reply was sent, whose turn the voice is, each terminal tab's color, and the rate cards last read with the time each was read (`records/rate-cards.json`).
- Speech clips in the system temporary folder while speech is on, each removed once played.
- Your folds, focus and speech choice, in Claude Code's own plugin store.

### The environment it reads

The hooks module reads terminal identity only: `TERM_PROGRAM`, `TMUX`, `ITERM_SESSION_ID` and `LC_TERMINAL`. The Python scripts read `FLEET_CONFIG`, `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR`, `PATH`, `TMPDIR` and the XDG and Windows folder variables to find your configuration, homes and commands, and hand the rest of the environment, minus the removed variables above, to the commands they start. None of it is sent anywhere.

### Calls from Claude Code

Every mods API call it makes is part of Claude Code's own surface, `$.ui.notify` included; it adds no namespace and calls no method another plugin adds. The paint recolors the element tree it was handed by walking that tree's props and rewriting the color values in it (`components/palette.ts`); it reads nothing else and draws nothing new.

## Privacy

The plugin collects nothing about you and sends nothing to Doric Stack: everything it reads stays on your machine, as the sections above set out. Doric Stack's [Privacy Policy](https://doricstack.com/privacy) covers the company's own site and support requests.

## License

MIT.
