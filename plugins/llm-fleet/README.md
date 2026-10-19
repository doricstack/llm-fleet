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
- `/speak` picks this session's voice or switches speech on or off in every running session, once you have configured a speech command. Every session starts with speech off, and off stops the line playing and every line waiting.

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

The plugin makes no network request of its own. Every fact in the pane is read on this machine and printed to it, and the only messages it sends are `$.session.send` notes to the other Claude sessions on the same machine, which carry a job identifier and a short line such as a speech reply. The one reader that reaches out is the pull-request one, through the `gh` command and your own GitHub login; leave that source off and no pull-request query is made. A custom section runs whatever command you give it, so a command that reaches the network does so because you configured it. It reads the conversation only through the transcripts and events the host hands it, and it never changes one.

Every hook it registers either answers its own command or drawing and returns, or passes the event on unchanged with `next(event)`. It registers no permission event and never decides whether a tool call may run; that stays with you and your settings.

It runs two kinds of program. The first are its own Python entries, started through the interpreter you set in the plugin's options: `readers/read.py` for the reading, and the doctor and setup commands. The second are the commands your configuration or the pane's fixed set name, listed above. Both kinds run as your user, with no credentials of their own: the plugin's options hold no key, and the outside commands the readers start get the provider variables stripped, as above.

The paint recolors the element tree it was given by walking that tree's props and rewriting the color values in it (`components/palette.ts`). It reads nothing else and draws nothing new.

## License

MIT.
