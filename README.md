# llm-fleet

![llm-fleet brand header](plugins/fleet/assets/readme-header.svg)

`llm-fleet` is a Claude Code plugin that puts every session and background job on your machine in one live pane.

Think of a departure board for your agents: one place that says what is working, what is waiting on you and what failed, before you go looking for it.

The core idea is simple: an agent session should not have to remember what the rest of the machine is doing.

## Why this exists

A machine running several agent sessions tends to accumulate the same blind spots:

- work spreads across sessions, background jobs, worktrees and pull requests, and each one reports in its own place
- a session that is waiting on you looks the same as one that is working unless you go and read it
- context use and spend are known only after a row is opened, if at all
- a failed job is found when you remember it, not when it fails
- every side project grows its own script to answer "what is running"

`llm-fleet` puts one read-only pane in front of those systems. It does not start, stop or change the work it reports; it reads what is already there, from the commands and files you point it at.

```text
Your prompt
     |
     | the band, one line above the prompt
     v
   /fleet
     |
     | one pane: sessions, background jobs, worktrees, pull requests
     v
   readers (claude, gh, git, ps, lsof, your own commands)
     |
     v
   the machine
```

## What it does

- Keeps every session and background job in one live pane, with each row's model, step, context use and cost.
- Marks a row working, waiting or failed, and keeps the figures at the top as controls that narrow the pane to those rows.
- Draws a band above the prompt carrying what needs you, with each figure opening the pane on its rows.
- Reaches you with an alert when a job fails or starts waiting.
- Folds a section by pressing its heading, and opens the rest of a row by pressing its figures.
- Lets the machine's load, pull requests, worktrees, trials, progress, skill scans and your own command-driven sections join the pane when you switch them on.
- Reads one configuration file, refuses a key it does not know by name, and leaves the machine's own details out of the repository.
- Starts outside commands with your Anthropic and provider API key variables removed from their environment.

## What the pane shows

![The llm-fleet pane, drawn from a sample machine](https://github.com/doricstack/llm-fleet/releases/download/v0.4.5/pane-demo.gif)

The figures at the top are the controls: press one and the pane narrows to those rows.

| Section | What it shows | On at install |
| --- | --- | --- |
| Sessions | every live session, with its model, step, context use and spend | yes |
| Background jobs | each job's command, pid and outcome | yes |
| Agent cards | this session's own cost, context and limits | yes |
| Pull requests | open pull requests with their checks and pages | no |
| Worktrees | each worktree with its cleanup line | no |
| Trials and progress | a run's rows and its finished steps against its total | no |
| Skill scans | each scan with its report command | no |
| Your own sections | whatever one of your commands prints as rows | no |

A source you have not configured is drawn as unconfigured, never as an empty list. A source that failed says so in its own row.

## Commands

| Command | What it does |
| --- | --- |
| `/fleet` | opens the pane, and running it again closes it |
| `/fleet close` | closes the pane without opening it |
| `/fleet setup` | writes a starter configuration holding the homes it finds |
| `/fleet doctor` | names what the pane is missing and the setting that fixes each |
| `/fleet unhide` | brings back the band items you dismissed |
| `/worktrees` | opens the pane on worktrees, with a fresh probe |
| `/keys` | opens the pane on its keys section |
| `/speak` | picks this session's voice, once you have set a speech command |

## A section of your own

A custom section is a command and a title. The pane draws its rows from what the command prints:

```json
{
  "pane": {
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

The command answers with a summary line and rows, and the pane draws each row's progress:

```json
{"summary": "1 running", "rows": [
  {"title": "web to staging", "state": "running", "detail": "migrating", "done": 3, "total": 5}
]}
```

## Install

Type this at the prompt of a Claude Code session:

```
/plugin install llm-fleet --marketplace doricstack/llm-fleet
```

Answer `y` to add the marketplace, then pick a scope. The one-step install needs Claude Code 2.1.295 or later, and Python 3.11 or newer for the readers. On Windows the interpreter is `python`, not `python3`: set the plugin's Python option to `python` if the first run says the readers could not start.

## First run

```
/fleet setup
/fleet doctor
/fleet
```

`/fleet setup` writes a starter configuration holding the Claude Code homes it finds on this machine and nothing else, and never overwrites a file that is already there. `/fleet doctor` says what the pane is missing and the setting that fixes each thing. `/fleet` opens the pane, and running it again closes it.

[The plugin's README](plugins/fleet/README.md) covers every command, the three plugin options and what the pane reads.

## Supported hosts

The plugin is proved on the versions listed in [the host table](docs/supported-hosts.md), one row per machine it was actually loaded on. A surface that is not listed there has not been tried.

## Configure

Everything the plugin reads comes from one configuration file. [The configuration reference](docs/configuration.md) is the contract, and `plugins/fleet/config/schema.json` holds it. A Python loader and a TypeScript loader read that same schema, and a shared fixture corpus fails the build when they disagree on a default, a refusal or a source state. With no file in the default place the declared defaults apply, while a file you name that is missing is refused rather than replaced by defaults.

## Repository layout

- `plugins/fleet/` is the plugin as it installs: the manifest, the hooks entry, the components the host draws, the Python readers and the schema.
- `.claude-plugin/marketplace.json` makes this repository the marketplace the install line names.
- `config/` holds the TypeScript loader, its suite and the shared fixtures.
- `components/` holds the suites and tools that run only from a checkout.
- `docs/` holds the architecture, the pane design and the configuration reference.

## Develop

You need Python 3.11 or newer, Make and a POSIX shell (Git Bash or WSL on Windows). The TypeScript suites need Node 22.6 or newer and report themselves unavailable without it rather than passing.

```
make test
make test-readers
make test-components
make test-engine
make test-ci
```

`make test-ci` is what CI runs on Linux and Windows: the quality checks, every suite, the build, and an export of this tree into a fresh directory that is built and tested again. `make plugin-validate HOST_CLI=claude` and `make test-pane HOST_CLI=claude` run the host's own validation and test kit where Claude Code is installed. `make help` lists every target.

To run your working copy instead of the installed plugin, start a session with `claude --plugin-dir plugins/fleet`.

## Versions

The version in `plugins/fleet/.claude-plugin/plugin.json` is the plugin's version, written there once. Neither marketplace entry sets one, because the host reads the manifest and a second number only earns a warning. The pane's footer constant is generated from the manifest by `make version`, and `make quality` refuses a copy that has gone stale. A change people would notice raises it, and a release is tagged `v` followed by that number.

Claude Code installs a version and keeps it rather than following this repository, so after a release run `/plugin update llm-fleet` and restart the session.

## License

MIT, 2026. See [LICENSE](LICENSE).
