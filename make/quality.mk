.PHONY: quality lint typecheck violations doc-format plugin-boundary

quality: lint doc-format violations plugin-boundary ## Run the implemented scaffold quality checks

lint: ## Check Python indentation using the standard-library linter
	$(PYTHON) -m tabnanny scripts tests config plugins

typecheck: ## Run TYPECHECK when a runtime typechecker has been configured
	@set -euo pipefail; test -n "$(TYPECHECK)" || { echo 'Unavailable: no runtime typechecker is configured; set TYPECHECK.' >&2; exit 2; }
	$(TYPECHECK)

violations: export-leak-check ## Scan exported paths and content against publication policy

doc-format: script-check-doc-format ## Check instruction paragraphs, punctuation, and root targets

plugin-boundary: script-plugin-boundary ## Refuse a plugin module that imports outside its own folder
