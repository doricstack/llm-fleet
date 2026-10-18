# llm-fleet

by Doric Stack

One pane for every Claude Code session and background job on your machine. llm-fleet is a Claude Code plugin: it shows which jobs are working, waiting or failed, what each agent is doing and what it costs, and it alerts you when one needs you.

## Install

```
/plugin install llm-fleet --marketplace doricstack/llm-fleet
```

Type it at the prompt of a Claude Code session (2.1.275 or later), answer `y` to add the marketplace and pick a scope. Then run `/fleet setup`, `/fleet doctor` and `/fleet`. The [plugin's README](plugins/fleet/README.md) covers the commands, the three plugin options and what the pane reads.

## Configure

Everything the plugin reads comes from one configuration file. [The configuration reference](docs/configuration.md) is the contract, and `plugins/fleet/config/schema.json` holds it. A Python loader and a TypeScript loader read that same schema, and a shared fixture corpus fails the build when they disagree on a default, a refusal or a source state. A key the schema does not know is refused by name. With no file in the default place the declared defaults apply, while a file you name that is missing is refused rather than replaced by defaults.

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

## License

MIT, 2026. See [LICENSE](LICENSE).
