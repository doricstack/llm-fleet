.PHONY: export-check export export-leak-check

export-check: ## Preview the export without writing the destination
	@$(MAKE) script-public-export EXPORT_MODE=--dry-run

export: ## Validate a preview, then write the selected export tree
	@$(MAKE) export-check
	@$(MAKE) script-public-export EXPORT_MODE=

export-leak-check: ## Validate publication policy against a disposable destination
	@set -euo pipefail; trial=$$(mktemp -d); trap 'rm -rf "$$trial"' EXIT; \
	  $(MAKE) script-public-export PUBLIC_TREE="$$trial/public" EXPORT_MODE=--dry-run > "$$trial/report" 2>&1 || { \
	    status=$$?; cat "$$trial/report" >&2; \
	    exit "$$status"; \
	  }; \
	  echo 'Export leak check passed.'
