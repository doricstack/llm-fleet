.PHONY: quality lint typecheck violations doc-format plugin-boundary version version-check

quality: lint doc-format violations plugin-boundary version-check ## Run the implemented scaffold quality checks

version: ## Write the pane's version constant from the manifest
	$(MAKE) script-version

version-check: ## Refuse a version written anywhere but the manifest, or generated stale from it
	$(MAKE) script-version VERSION_CHECK=1

lint: ## Check Python indentation using the standard-library linter
	$(PYTHON) -m tabnanny scripts tests config plugins

typecheck: ## Run TYPECHECK when a runtime typechecker has been configured
	@set -euo pipefail; test -n "$(TYPECHECK)" || { echo 'Unavailable: no runtime typechecker is configured; set TYPECHECK.' >&2; exit 2; }
	$(TYPECHECK)

violations: export-leak-check ## Scan exported paths and content against publication policy

doc-format: script-check-doc-format ## Check instruction paragraphs, punctuation, and root targets

plugin-boundary: script-plugin-boundary ## Refuse a plugin module that imports outside its own folder
