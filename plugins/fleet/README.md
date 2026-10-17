# llm-fleet

llm-fleet is a Claude Code plugin that keeps every session and background job on your machine in one live pane. You see which jobs are working, which wait for you and which failed, with each agent's model, step, context use and cost. A band above the prompt carries what needs you, and an alert reaches you when a job fails or starts waiting.

The machine's load, pull requests, worktrees, skill scans and your own sections can join the pane when you switch them on. Everything it reads comes from one configuration file, so nothing about your machine is written into the plugin.

## Install

Type this at the prompt of a Claude Code session:

```
/plugin install llm-fleet --marketplace doricstack/llm-fleet
```

Answer `y` to add the marketplace, then pick a scope. The one-step install needs Claude Code 2.1.275 or later. The readers are Python scripts, so you also need Python 3.11 or newer.

## First run

```
/fleet setup
/fleet doctor
/fleet
```

`/fleet setup` writes a starter configuration holding the Claude Code homes it finds on this machine and nothing else. It never overwrites a file that is already there. The default place is `$XDG_CONFIG_HOME/llm-fleet/config.json`, then `%APPDATA%\llm-fleet\config.json` on Windows, then `~/.config/llm-fleet/config.json`.

`/fleet doctor` tells you what the pane is missing and the setting that fixes each thing: the interpreter, where the configuration was read from, each home and source with its state, and the commands the readers start. `/fleet` opens the pane, and running it again closes it.

## Commands

- `/fleet` opens or closes the pane, and `/fleet close` only closes it.
- `/fleet unhide` brings back the band items you dismissed.
- `/fleet doctor` and `/fleet setup` are the two commands from the first run.
- `/worktrees` opens the pane on its worktrees section with a fresh probe.
- `/keys` opens the pane on its keys section, and `/keys tips off` turns off the key tip under the prompt.
- `/speak` picks this session's voice or switches speech on or off in every running session, once you have configured a speech command. Every session starts with speech off, and off stops the line playing and every line waiting.

## Settings

Three options live in `/config` under the plugin, because they are needed before the configuration file can be read:

- **Python interpreter**: the interpreter the readers run under, `python3` by default.
- **Configuration file**: a full path to your configuration when it is not in the default place.
- **Desktop notifications**: on by default; adds a desktop notification to the in-session toast.

Everything else is in the configuration file. Sessions, background jobs, agent cards and this session's own cost, context and limits are on from the start. Pull requests, worktrees, trials, progress, skill scans and a recorded statusline payload are sources you switch on, and the doctor names the key each one needs. Speech is off until you set `speech.enabled` and a speech command. A key the schema does not know is refused by name rather than ignored. The full list of settings, with defaults, is in [the configuration reference](https://github.com/doricstack/llm-fleet/blob/main/docs/configuration.md).

## What it reads

The plugin reads the session roster through the `claude` command, transcripts and task lists under the homes you configure, and, when you switch it on, pull requests through the `gh` command. The outside commands the readers start (`claude`, `gh`, `git`, `ps`, `lsof`, the speech command and your own sections' commands) run with your Anthropic variables and the common provider API key variables removed from their environment, and the configuration can add to that list but never shorten it.

## License

MIT.
