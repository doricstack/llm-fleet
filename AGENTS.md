# Repository instructions

## Scope

| ID | Condition | Required action |
| --- | --- | --- |
| SCOPE-1 | Working repository | Develop in `doricstack/llm-fleet-private`. |
| SCOPE-2 | Published repository | Write `doricstack/llm-fleet` only through export. |
| SCOPE-3 | Repository model | Follow the `mcp-broker-private` working / `mcp-broker` published pattern. |
| SCOPE-4 | Public checkout | Never edit by hand or copy private Git history into it. |
| SCOPE-5 | Agent instructions | Maintain AGENTS.md as the single source; Codex reads it and CLAUDE.md delegates through `@AGENTS.md`. |
| SCOPE-6 | Private checkout startup | Read PROJECT_CONTEXT.md, TODO.md, SNAPSHOT.md, and HANDOFF.md when present. |
| SCOPE-7 | Operational notes | Exclude private context, queue, snapshot, and handoff files from export. |
| SCOPE-8 | Platforms | Support macOS, Linux, and Windows: loaders, scripts, and tests use the running platform's path rules. The Make targets need a POSIX shell, which on Windows means Git Bash or WSL. |
| SCOPE-9 | Platform claims | Prove a platform in CI before describing it as supported. |

## Module layout

| Path | Responsibility | Status |
| --- | --- | --- |
| `docs/` | Architecture, planned schema, pane design, export contract | Present |
| `public-export/` | Publication allowlist and content denylist | Present |
| `scripts/public-export.py` | Text-tree export, normalization and decoding leak checks, destination lock | Present |
| `scripts/check-doc-format.py` | Instruction, punctuation, and root Makefile checks | Present |
| `scripts/test-report.py` | The Python suite, with a JUnit report when one is asked for: a gate reads a report because an exit code cannot tell a run that passed from one that selected nothing | Present |
| `.cits/test-impact.sh` | This repository's change-impact selection: the shared selection for the Python suites, and the TypeScript suites through the runner the make targets use | Present |
| `tests/test_impact_override.py` | Impact-selection contract: the plan, the refusals, and the suites a plan may name | Present |
| `tests/test_test_report.py` | Report contract: each outcome's element, the four counts, and a document that survives a message holding markup | Present |
| `tests/test_typescript_report.py` | TypeScript report contract: each file's cases in one suite named for it, a failure kept as one, and no report over a run that never started | Present |
| `tests/test_public_export.py` | Export behavior, encoded-form, identity-inventory and destination-lock tests | Present |
| `tests/test_doc_format.py` | Checker behavior and failure-path tests | Present |
| `tests/test_host_drift.py` | Declared-primitive drift refusal tests | Present |
| `tests/test_render_review.py` | Review-page leak refusal tests | Present |
| `tests/test_config_loader.py` | Config contract, resolution, state, and parity tests | Present |
| `.github/workflows/ci.yml` | Private and isolated exported-tree checks through `make test-ci` on Linux and Windows | Present |
| `plugins/llm-fleet/config/schema.json` | Versioned contract: fields, defaults, source rules, error codes; in the plugin folder because an install copies that folder alone | Present |
| `plugins/llm-fleet/config/loader.py` | Python loader: validate, resolve, derive source state | Present |
| `config/loader.ts` | TypeScript loader over the same contract, no build step | Present |
| `config/parity-runner.ts` | Runs one fixture through the TypeScript loader for the parity suite | Present |
| `config/loader.test.ts` | TypeScript loader behavior suite, run by `node --test` | Present |
| `config/fixtures/` | Shared corpus both loaders must agree on | Present |
| `config/examples/` | A custom section to copy: its configuration and a command that prints rows with bars | Present |
| `personal/` | The owner's own configuration, linked from the default config path; private, refused by the export | Present |
| `scripts/typescript-suite.py` | Node runtime check and TypeScript suite runner, writing a JUnit report into the folder a gate names | Present |
| `scripts/host-drift.py` | Check the declared primitive subset against the engine's declaration | Present |
| `scripts/host-update.py` | Check every Claude home's installed copy against this tree's version and repair it through the host's own update; a home the tree never installed is absent, not stale | Present |
| `tests/test_host_update.py` | Install-check contract: a stale home is refused with both versions, a repair is proved by reading the record again, and a repair that changes nothing fails | Present |
| `scripts/render-review.py` | Read the machine and write a pane review page | Present |
| `scripts/mutation-check.py` | Apply each mutant declared in `mutation/mutants.json` to a copy of the tree, run its suite, and fail on any survivor not declared equivalent | Present |
| `tests/test_mutation_check.py` | Harness contract: the checkout is never edited, a red suite stops the run, a mutant whose text moved is an error | Present |
| `scripts/plugin-boundary.py` | Refuse a plugin module the host cannot evaluate: one importing from outside the plugin folder, or reaching for a node global; a script name or a Python interpreter outside the entry table; and, read from each Python module's syntax tree, an import of anything but the standard library and the plugin's own packages, a change to the import path outside `readers/plugin_root.py`, a climb of more than one level from `__file__`, or a `..` segment | Present |
| `tests/paths.py` | The one place the suites put the plugin root on the import path | Present |
| `tests/test_plugin_standalone.py` | Proof the plugin folder runs alone: the entry table, the modules that run as a command or work when loaded, and the run cases are the same set, and every entry is run from a lone copy in an unrelated directory with every source on and none allowed to come back failed | Present |
| `plugins/llm-fleet/components/entries.ts` | The entry table: every Python script the plugin has, and `entryArgv`, the one way a command that starts one is built | Present |
| `plugins/llm-fleet/readers/` | The seven readers, the host statusline payload and the transcript economics, the machine surface they read through, the read command, the alerts helper (focus, the machine-wide claim, and the voice), and the custom-section reader that runs a person's own commands, the doctor that says what the pane is missing, and the setup that writes a starter configuration | Present |
| `plugins/llm-fleet/hooks/`, `plugins/llm-fleet/tests/` | The engine entry, the subset it declares, its suite, and the pane mounted through the host's own test kit | Present |
| `plugins/llm-fleet/types/` | The hand-written types contract `plugin.json` names as "types": every `$.state` key the entry reads or writes, declared in `PluginState`, and every `$.store` key, declared in `FleetStore` | Present |
| `tests/test_plugin_contract.py` | Contract test: every literal `$.state` key in the plugin's modules is declared in that contract under the manifest's own name, a key that is not a literal is refused, and the entry's store keys and `FleetStore` name the same set | Present |
| `tests/test_directory_rules.py` | Directory source reading: the hooks module gives `on`, `$`, an event or `next` no other meaning, no module reads an object's kind by reflection, and the README names every script and fixed program the plugin runs | Present |
| `.claude-plugin/marketplace.json` | The marketplace the install line names: the one plugin, at `./plugins/llm-fleet` | Present |
| `plugins/llm-fleet/README.md` | What a person installing the plugin reads: the install line, the first run, the commands and options | Present |
| `tests/test_publication.py` | Publication contract: each README's install line names the manifest and the published repository, both marketplaces list that plugin at its folder, and one version holds everywhere | Present |
| `plugins/llm-fleet/components/` | Declared primitives, shared layout, pane view model, masking, snapshot assembly, pane options, the band above the prompt, alert events, the voice, and the statusline composer: every module the host evaluates | Present |
| `components/` | Modules only this repository runs: the review tool, the statusline command line, and the TypeScript suites | Present |
| `plugins/typing/` | Independent input mod | Planned |
| `plugins/secret-shield/` | Independent masking mod | Planned |
| `plugins/context-keeper/` | Compaction mod | Planned |
| `plugins/reply-fold/` | Display mod | Planned |
| `statusline/` | Independent session renderer | Planned |

## Make layout

| Path | Holds |
| --- | --- |
| `Makefile` | Shared setup, fragment index, generated help, includes |
| `make/config.mk` | Machine/CI paths, runtime root, state, provider homes, Python/Node, export destination |
| `make/dev.mk` | Setup, build, install/link availability, cache cleanup |
| `make/test.mk` | Unit/checker, export, config contract and parity, readers, components, TypeScript suite, engine availability, whole CI verification |
| `make/quality.mk` | Indentation lint, typecheck availability, publication violations, doc-format |
| `make/export.mk` | Dry run, real export, leak check |
| `make/scripts.mk` | One target per runnable script |

## Commands

| Command | Result |
| --- | --- |
| `make help` | List every documented target |
| `make setup` | Verify Python 3.11+ |
| `make test` | Run every implemented scaffold test |
| `make test-report JUNIT_XML=<path>` | The same suite, with the result written as a JUnit report |
| `make test-impacted` | Run only the tests the working tree's changes affect |
| `make test-unit` | Run checker tests |
| `make test-export` | Run exporter tests |
| `make test-config` | Run the config contract, resolution, and state suites |
| `make test-readers` | Run the reader suites against real stub commands and job files |
| `make test-config-parity` | Refuse unless both loaders agree on the shared fixture corpus |
| `make test-components` | Run the shared layout, pane view model, band, masking, snapshot, and review suites, plus the declared binding check |
| `make test-components-drift` | Refuse when the engine drops a prop this layout writes; reads the declaration the engine scaffolded into the plugin folder, and takes another engine with `HOST_DECLARATION=<path>` |
| `make review` | Read the machine and write a pane review page; name its place with `REVIEW_OUT` |
| `make statusline-demo` | Draw the statusline lines from a payload; point at a recorded one with `STATUSLINE_PAYLOAD` |
| `make configure` | Write a starter configuration where the plugin reads it; one already there is left as it is |
| `make doctor` | Say what the pane is missing on this machine, and the setting that fixes each |
| `make host-update` | Bring every Claude home's installed copy up to this tree's version through the host's own update, and prove it took; `HOST_UPDATE_CHECK=1` only reports drift |
| `make test-typescript` | Run the TypeScript loader suite; report unavailable without Node 22.6+ |
| `make test-ci` | Run quality, tests, readers, components, the engine-declaration check, TypeScript suite, config parity, build, isolated export checks, and exported-tree round trip |
| `make build` | Compile Python; not a plugin package build |
| `make quality` | Run indentation lint, doc-format, and publication-policy checks |
| `make doc-format` | Enforce FMT-1 through FMT-3 |
| `make export-check PUBLIC_TREE=/tmp/fleet-public-preview` | Validate and preview without writing |
| `make export PUBLIC_TREE=/tmp/fleet-public-tree` | Preview, validate, and write the selected export |
| `make clean` | Remove the configured generated build cache |
| `make test-engine` | Run the plugin entry against a stub of the declared engine subset |
| `make test-pane HOST_CLI='<command>'` | Draw the pane through the host's own test kit; unavailable without a command |
| `make plugin-boundary` | Refuse a plugin module that imports outside its own folder |
| `make plugin-validate HOST_CLI='<command>'` | Validate the manifest, hooks, and types contract through the host; unavailable without a command |
| `make install-check HOST_CLI='<command>'` | Validate the repository as the marketplace the install line names, through the host; unavailable without a command |
| `make mutants` | Run the declared mutants against their suites; pick some with `MUTANTS='<id> <id>'` |
| `make install`, `make link` | Fail with unavailable status until runtime extraction |
| `make typecheck TYPECHECK='<command>'` | Run an explicitly configured checker; fail if unset |

## Development and testing rules

| ID | Condition | Required action |
| --- | --- | --- |
| DEV-1 | Scaffold development | Require Python 3.11+, Make, and a POSIX shell (Git Bash or WSL on Windows); require Node 22.6+ to run the TypeScript loader tests. |
| DEV-2 | Planned runtime directories | Do not add placeholder plugin source to imply implementation. |
| DEV-3 | Repository phase | The scaffold phase is over: commits are expected, under the Concurrency and Git section. |
| TEST-1 | Changed behavior | Test behavior and error paths. |
| TEST-2 | Reader extraction | Cover source failure, interrupted runs, missing counts, and malformed data. |
| TEST-3 | Export changes | Require leak, dry-run immutability, and path-safety tests. |
| TEST-4 | Export verification | Build and test the isolated exported tree. |
| TEST-5 | Plugin extraction | Require matching engine declarations, and a pane mounted through the host's own test kit so a tree the surface will not draw fails outside a session: `make test-pane HOST_CLI='<command>'`, which reports itself unavailable without a command rather than passing quietly. |
| TEST-15 | Test report | Write the result as a JUnit report when a caller asks for one, from the result object unittest produces rather than from a new dependency: a gate reads a report because an exit code cannot tell a run that passed from one that selected nothing. Each outcome keeps its own element, the four counts are reported together, and the document stays parseable when a message holds markup. |
| TEST-14 | Affected-test selection | Run the changed side of the repository, never the whole of it: `.cits/test-impact.sh` runs the Python suite for a Python change and each TypeScript suite through `scripts/typescript-suite.py` for a TypeScript change, and it passes a report destination, when the caller names one, to the Python run through `FLEET_JUNIT_XML`, to every TypeScript suite through `FLEET_TS_JUNIT_DIR` so each make target that starts one writes a report named for its suite, and no path is ever spliced into a command a shell or make would expand, and to the whole run at the blanket tier, because the gate that called it reads a report and a run with no report is one it cannot count. The exported tree inside the whole run is handed no destination for either side, so its copy never overwrites the report of the repository the gate asked about. One layer runs whole rather than partly, because a selection that names a suite it cannot run is the failure this exists to fix. The suite mounted through the host's test kit is named as covered by CI rather than dropped in silence, and the selection reads no path from the machine it runs on. |
| TEST-16 | Host declaration | Check the declared subset against the declaration the engine scaffolds into the plugin folder, and refuse a declaration this repository committed: a branch can change such a file in the same commit as the subset, and a check that reads it agrees with the change instead of checking it. The test is what git lists, not what the checkout ignores, because a tree delivered without a repository, an exported tree or a downloaded archive, holds nothing a branch committed and its files are read. A run with no declaration says the subset was not checked against an engine rather than passing quietly; CI runs it with that report allowed, because the runner has no engine and a check that cannot run here must not end the build. |
| TEST-13 | Plugin folder boundary | Keep every module the host evaluates inside the plugin folder and free of node globals, and let `make plugin-boundary` refuse one that breaks either rule: the host compiles the folder without node, so a shared directory beside the plugin or a module reading `process.argv` reads as working source here and loads as nothing there. A Python module under the folder imports from the plugin root (`config.loader`, `readers.<name>`) and never climbs above it, because an install copies the folder alone; a reader started by path reaches that root only through `readers/plugin_root.py`, and the plugin starts a script only through `components/entries.ts`. |
| TEST-18 | Plugin state contract | Declare every `$.state` key in `plugins/llm-fleet/types/index.d.ts`, the contract `plugin.json` names as "types", in the change that first reads or writes it, and spell it once, as a const reference holding the literal plugin name and key `as const`, which every call names: the host refuses a plugin that uses an undeclared key, and a name spelled in one place cannot drift in another. `tests/test_plugin_contract.py` holds the rule in CI, which has no host CLI, and `make plugin-validate HOST_CLI='<command>'` runs the host's own check where one is installed. |
| TEST-19 | Directory submission | Keep the hooks module readable by the directory, which `claude plugin validate` does not reproduce: never declare, destructure or take as a parameter a name the module binds for `on`, `$`, an event or `next`; read no object's kind by reflection; and add a line to the README's programs table in the change that adds a script or a fixed program. `tests/test_directory_rules.py` holds it in CI; the shared plugin directory rule governs the rest. |
| TEST-17 | Mutation evidence | State a mutation result only from `make mutants`: declare each mutant in `mutation/mutants.json` with the suite that must notice it, and declare a survivor equivalent only with the reason it cannot be observed. |
| TEST-6 | Reporting checks | Report actual failures and skips. |
| TEST-7 | Passing scaffold suite | Make no claim about runtime behavior that has not moved here. |
| TEST-8 | Configuration changes | Cover the success path, each refusal class, and every source state; keep the fixture corpus in step with the schema. |
| TEST-10 | Review surface | Every change that alters what the pane shows writes a review page through `make review`, so it can be read before anything mounts it. |
| TEST-12 | Statusline composition | Draw the lines from readings, not from a session: an absent model is named, a missing window draws no bar, a saving of nothing and a negative saving are both undrawn, a failed read is never rendered as an empty session, and a width too narrow to hold a line cuts it and marks the cut. |
| TEST-11 | Host payload | Read the statusline payload as untrusted input: name every field the host did not send instead of zeroing it, refuse a payload one byte over the configured limit rather than truncating it, and land an empty stream as empty rather than failed. |
| TEST-9 | Reader behavior | Drive the reader through a real command and real files on disk, including refusal paths: absent command, failing command, non-JSON output, an overrun timeout, an unreadable or oversized job file, and an identifier that could climb out of its home. |

## Configuration rules

| ID | Condition | Required action |
| --- | --- | --- |
| CFG-1 | Runtime configuration | Every setting in docs/configuration.md is implemented; the schema and that document describe the same configuration. |
| CFG-2 | Deployable defaults | Keep one canonical config source read by both language layers. |
| CFG-3 | Source configuration | Exclude personal paths, provider aliases, account IDs, and hostnames. |
| CFG-4 | Source configuration | Exclude repository defaults, secret stores, voice binaries, and timing policy. |
| CFG-5 | Reader states | Distinguish disabled, unconfigured, unavailable, ready, stale, and empty; never render a missing target as an empty result. |
| CFG-6 | Progress | Never invent a denominator or call an interrupted run complete. |
| CFG-7 | Shared visual primitives | Use Box and Text for what is drawn, Button for a press, Link for a page, and Input for a reply; never Raster or Image. Svg reaches the pane only through a node's `vector`, and Input only where `mount.ts` binds a surface by name as one that draws fields. |
| CFG-8 | Contract changes | Change `plugins/llm-fleet/config/schema.json` first, with the field's default, its source-state rule when it gates a source, and its test in the same change. |
| CFG-9 | Loader parity | Put no per-key logic in a single loader: both read the schema, and the shared fixture corpus fails when they disagree. |
| CFG-10 | Cross-field checks | Declare the check in the schema rules and implement it once per loader; never decide policy inside a language layer. |
| CFG-11 | Security invariants | Keep the credential, path-identifier, and read-bound invariants outside configuration: a document may extend the stripped variable sets and may never remove a baseline entry. |
| CFG-12 | Command configuration | Configure a command as an argv array when a reader appends its own arguments; resolve a bare name on the PATH the child receives. |
| CFG-14 | Read command | Run every reader once and print one object; a reader that raises keeps its slot as a failed source rather than removing a document. `--only <source>` runs that reader alone, for a part the pane folds into the reading it holds, and refuses a source no reader reads. `--settings` runs no reader and prints the configuration's parts alone, for a session that has held no reading and so does not yet know its read times. |
| CFG-15 | Custom sections | Keep the owner's configuration and sections in `personal/` of the private checkout, which the export refuses by path; ship only the documented example, and draw a section's rows from its command's output with nothing filled in. |
| CFG-13 | Host binding | Declare the subset of host primitives this repository writes; never publish another project's generated declaration, and gate the subset with a check that fails by name. |

## Concurrency and Git

| ID | Condition | Required action |
| --- | --- | --- |
| CONC-1 | Repository class | Treat this as a code repository, not an authoring surface: worktree isolation applies. |
| CONC-2 | Before any repository mutation | Read the shared-repository concurrency rules that govern this machine, then work only from an owned worktree on a task branch. |
| CONC-3 | Before creating a worktree | Pass the lane admission check. Close a merged lane instead of opening past the ceiling. |
| CONC-4 | Before the first edit, and before every commit or merge | Fetch origin, inspect task-file changes on `origin/main`, integrate main into the owned worktree, and rerun the affected gates. |
| CONC-5 | Sharing the repository | One task per worktree and one branch per task. Never edit another session's worktree; coordinate on file or behavior overlap only. |
| CONC-6 | Finishing a task | Merge to main, push main, verify the commit is on remote main, then remove the completed worktree and its branch. |
| CONC-7 | Reporting the repository clean | Prove it with counts, never from memory: no paths in `git status --porcelain --untracked-files=all`, local HEAD equal to `origin/main`, nothing but the default branch and branches checked out elsewhere in `git branch --merged origin/main`, and no merged worktree in `git worktree list`. |
| CONC-8 | Before a push | Write the push plan for that exact commit first; the gate refuses a push without one. |
| CONC-9 | Commit and PR text | No AI attribution, no co-author trailer, no generated-with line. The owner is the sole author. |
| CONC-10 | Public repository | Never push to `doricstack/llm-fleet` by hand; only the export writes it. |

## Publication boundary

| ID | Condition | Required action |
| --- | --- | --- |
| PUB-1 | Allowlisted files | Exclude user-specific content from instructions, docs, tests, comments, examples, and CI. |
| PUB-2 | Portable examples | Use shapes such as `$PROVIDER_HOME`, `$STATE_DIR`, and `owner/project`. |
| PUB-3 | Repository identifiers | Allow only the two intentional working/published pairs in Scope; keep other internal names private. |
| PUB-4 | Public denylist | Describe shapes; never store real identity strings. A rule is checked against the text as written, its normalized form, and its percent and base64 decodings, so an invisible character or an encoding cannot walk a credential past it. |
| PUB-5 | Exact-identity inventory | Keep it private and consume it in release checks without export: `public-export/owner-identity.txt` is ignored by Git, refused as an exportable path, and its terms are refused in any cited form without being echoed. |
| PUB-6 | Unknown files | Exclude them from publication. |
| PUB-7 | New allowlist entries | Review content and dependencies before adding explicit entries. |
| PUB-8 | Public imports | Never import the private tooling repository. |
| PUB-9 | Export destination | Require a separate tree that is empty, Git-metadata-only, or owned by a prior export. |
| PUB-10 | Export writes | Use dry-run before a write. A real write holds the destination for its whole duration, and a lock abandoned by a run that died is taken over after fifteen minutes. |
| PUB-11 | Session scope | Preserve peer files and respect the requested Git scope. |
| PUB-12 | Scaffolding authorization | Do not infer permission to commit, push, install, or release. |
| PUB-13 | Personal folder | Refuse any export path under `personal/`, whatever the allowlist says. |
| PUB-14 | Plugin version | Raise the version in `plugins/llm-fleet/.claude-plugin/plugin.json` with any change a person installing the plugin would notice, set both marketplace entries to the same number in that change, and tag a release `v<version>`; `tests/test_publication.py` fails when they drift. |
| PUB-16 | Installed copy | Run `make host-update` in the change that raises the version. The host installs a version and does not follow the tree: a home that installed an earlier one keeps loading it, or nothing, until the host's own update runs there, and a session already started does not pick it up. `make host-update` repairs every home and reads each record back; a release that skips it leaves the machine on the last build. |
| PUB-15 | Plugin name | Keep the plugin named `llm-fleet` in the manifest, both marketplaces, every install line and every `$.state` reference; a rename moves the host's per-plugin state and store, so it is recorded in HANDOFF with the step that moves an installed copy. |

## Format rules

| ID | Condition | Required action |
| --- | --- | --- |
| FMT-1 | LLM-facing documents | Use tables and short labeled rows; checker rejects paragraphs over three lines in the five operational files. |
| FMT-2 | Source files | Do not use em/en dashes, smart single/double quotes, or invisible characters: soft hyphens, zero-width and word-joiner characters, bidirectional marks and embeddings, or a byte order mark. Write one as a code point where a file must name it. |
| FMT-3 | Root Makefile | Keep only help as an executable target; place all other targets under make/. |
| FMT-4 | Rule tables | Give each rule a stable ID, condition, and required action on one physical line. |
| FMT-5 | Human design documents | Allow short prose only in docs/architecture.md and docs/pane-design.md. |
| FMT-6 | CLAUDE.md | Keep exactly `@AGENTS.md`. |
| FMT-7 | Make targets | Give every target a `##` help comment. |

## Measurement

| Check | Passing result |
| --- | --- |
| `make doc-format` | Nonempty source scope; zero violations |
| `make test-impacted` | The commands it will run, or a stated empty selection |
| `make plugin-boundary` | The configured plugin tree holds at least one module per folder; zero imports from outside a folder |
| `make test-ci` | Scaffold and exported-tree checks pass |
| `make test-components-drift` | A declaration was read: the engine's own, scaffolded into the plugin folder. Where no engine has written one the run says the subset was not checked against an engine, and CI passes with that line in its log |
| Scan boundary | Git metadata and generated dependency/cache directories are excluded; hidden source files are scanned |
