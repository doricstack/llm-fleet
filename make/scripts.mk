.PHONY: script-public-export script-check-doc-format script-typescript-suite script-host-drift script-render-review script-statusline-demo script-plugin-boundary script-mutation-check script-version

script-version: ## Write the pane's version constant from the manifest; --check refuses drift
	$(PYTHON) scripts/version.py $(if $(VERSION_CHECK),--check,)

script-public-export: ## Invoke public-export.py with PUBLIC_TREE and EXPORT_MODE
	@set -euo pipefail; test -n "$(PUBLIC_TREE)" || { echo 'Set PUBLIC_TREE to a separate output directory'; exit 2; }
	$(PYTHON) scripts/public-export.py --destination "$(PUBLIC_TREE)" $(EXPORT_MODE)

script-check-doc-format: ## Invoke check-doc-format.py on this source tree
	$(PYTHON) scripts/check-doc-format.py --root "$(ROOT)"

script-typescript-suite: ## Invoke typescript-suite.py with the configured Node
	$(PYTHON) scripts/typescript-suite.py --node "$(NODE)"

script-host-drift: ## Invoke host-drift.py against the configured declaration
	$(PYTHON) scripts/host-drift.py --declaration "$(HOST_DECLARATION)" $(if $(HOST_DECLARATION_MAY_BE_ABSENT),--allow-unavailable,)

script-render-review: ## Invoke render-review.py with the configured output
	$(PYTHON) scripts/render-review.py --out "$(REVIEW_OUT)"

script-statusline-demo: ## Invoke statusline-demo.py, with a recorded payload via STATUSLINE_PAYLOAD
	$(PYTHON) scripts/statusline-demo.py $(if $(STATUSLINE_PAYLOAD),--payload "$(STATUSLINE_PAYLOAD)",) --width "$(STATUSLINE_WIDTH)"

script-plugin-boundary: ## Invoke plugin-boundary.py on this source tree
	$(PYTHON) scripts/plugin-boundary.py --plugins "$(ROOT)/plugins"

script-mutation-check: ## Invoke mutation-check.py on a copy of this tree; pick mutants with MUTANTS
	$(PYTHON) scripts/mutation-check.py --root "$(ROOT)" --node "$(NODE)" $(foreach id,$(MUTANTS),--only $(id))
