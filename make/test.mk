.PHONY: test test-report test-impacted test-unit test-doc-format test-export test-config test-config-parity test-readers test-components test-components-drift test-typescript test-engine test-pane plugin-validate install-check test-ci mutants

test: test-report ## Run every implemented scaffold test

test-report: ## Run every implemented scaffold test, writing a JUnit report when JUNIT_XML is set
	$(TEST_ENV) $(PYTHON) scripts/test-report.py --directory tests --pattern 'test_*.py' $(if $(JUNIT_XML),--junit-xml "$(JUNIT_XML)",)

test-impacted: ## Run only the tests the working tree's changes affect
	.cits/test-impact.sh --tier commit --repo "$(CURDIR)"

mutants: script-mutation-check ## Run the declared mutants against their suites; every survivor fails unless declared equivalent

test-unit: test-doc-format ## Run the scaffold unit/checker suite

test-doc-format: ## Run checker behavior and failure-path tests
	$(TEST_ENV) $(PYTHON) -m unittest discover -s tests -p '$(UNIT_TEST_PATTERN)' -v

test-export: ## Run exporter safety and filesystem journeys
	$(TEST_ENV) $(PYTHON) -m unittest discover -s tests -p '$(EXPORT_TEST_PATTERN)' -v

test-config: ## Run the configuration contract, behavior, and parity suites
	$(TEST_ENV) $(PYTHON) tests/test_config_loader.py -v

test-config-parity: ## Refuse unless both loaders agree on the shared fixture corpus
	FLEET_CONFIG_REQUIRE_NODE=1 $(TEST_ENV) $(PYTHON) tests/test_config_loader.py -k FixtureParityTests -v

.PHONY: test-reader-progress test-reader-trials
test-reader-progress: ## Run progress reader behavior and pause-marker checks
	$(TEST_ENV) $(PYTHON) tests/test_reader_progress.py -v

test-reader-trials: ## Run trial reader behavior and pause-marker checks
	$(TEST_ENV) $(PYTHON) tests/test_reader_trials.py -v

test-readers: ## Run the reader suites against real stub commands, stores and files
	$(TEST_ENV) $(PYTHON) tests/test_readers.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_trials.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_progress.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_prs_skills.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_worktrees.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_snapshot.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_host.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_transcript.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_agents.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_events.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_session.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_alerts.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_custom.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_tab.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_doctor.py -v
	$(TEST_ENV) $(PYTHON) tests/test_reader_setup.py -v
	$(TEST_ENV) $(PYTHON) tests/test_sandbox.py -v

pane: ## Print the pane into this terminal, drawn to the terminal's own width
	$(PYTHON) scripts/render-review.py --print

review: ## Read the machine and write a pane review page you can open
	$(PYTHON) scripts/render-review.py $(if $(REVIEW_OUT),--out "$(REVIEW_OUT)",) $(if $(FLEET_CONFIG),--config "$(FLEET_CONFIG)",)

test-components: ## Run the shared layout, pane view model, masking, and declared binding check
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/layout.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/pressable.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/mask.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/statusline.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/surface.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/pane.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/stream.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/options.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/snapshot.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/cards.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/vector.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/palette.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/band.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/speech.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/alerts.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/sections.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/session.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/custom.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/motion.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/agents.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/review.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/tab.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/entries.test.ts
	$(TEST_ENV) $(PYTHON) tests/test_host_drift.py -v
	$(TEST_ENV) $(PYTHON) tests/test_render_review.py -v

.PHONY: test-pane-model test-motion test-snapshot test-layout
test-pane-model: ## Run the pane view model behavior suite
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/pane.test.ts

test-motion: ## Run the pane motion behavior suite
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/motion.test.ts

test-snapshot: ## Run the snapshot assembly behavior suite
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/snapshot.test.ts

test-layout: ## Run the shared layout behavior suite
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/layout.test.ts
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/pressable.test.ts

statusline-demo: script-statusline-demo ## Draw the statusline lines from a payload

test-components-drift: script-host-drift ## Refuse when the engine drops a declared primitive prop, reading the declaration it scaffolded here

test-typescript: script-typescript-suite ## Run the TypeScript loader behavior suite

test-engine: ## Run the plugin entry against a stub of the declared engine subset
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)" --suite components/llm-fleet.test.ts

test-pane: ## Draw the pane through the host's own test kit; unavailable without HOST_CLI
	@set -euo pipefail; test -n "$(HOST_CLI)" || { echo 'Unavailable: set HOST_CLI to the host command that runs a plugin suite.' >&2; exit 2; }
	$(HOST_CLI) plugin test plugins/llm-fleet

plugin-validate: ## Validate the plugin manifest, hooks, and types contract through the host; unavailable without HOST_CLI
	@set -euo pipefail; test -n "$(HOST_CLI)" || { echo 'Unavailable: set HOST_CLI to the host command that validates a plugin.' >&2; exit 2; }
	$(HOST_CLI) plugin validate plugins/llm-fleet

install-check: ## Validate the repository as the marketplace the install line names, through the host; unavailable without HOST_CLI
	@set -euo pipefail; test -n "$(HOST_CLI)" || { echo 'Unavailable: set HOST_CLI to the host command that validates a marketplace.' >&2; exit 2; }
	$(HOST_CLI) plugin validate .

test-ci: ## Run all CI checks, including an isolated exported-tree round trip
	@$(MAKE) quality
	@$(MAKE) test
	@$(MAKE) test-readers
	@$(MAKE) test-components
	@$(MAKE) test-components-drift HOST_DECLARATION_MAY_BE_ABSENT=1
	@$(MAKE) test-engine
	@$(MAKE) test-typescript
	@$(MAKE) test-config-parity
	@$(MAKE) build
	@set -euo pipefail; trial=$$(mktemp -d); trap 'rm -rf "$$trial"' EXIT; \
	  $(MAKE) export-check PUBLIC_TREE="$$trial/public" > "$$trial/preview.log"; \
	  $(MAKE) export PUBLIC_TREE="$$trial/public" > "$$trial/export.log"; \
	  FLEET_TS_JUNIT_DIR= FLEET_JUNIT_XML= $(MAKE) -C "$$trial/public" quality test test-readers test-components test-engine test-typescript test-config-parity build STATE_DIR="$$trial/state" JUNIT_XML=; \
	  $(MAKE) -C "$$trial/public" export-check PUBLIC_TREE="$$trial/roundtrip" > "$$trial/roundtrip.log"; \
	  echo 'Isolated export and round-trip validation passed.'
