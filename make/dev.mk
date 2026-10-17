.PHONY: setup build install link clean configure doctor

configure: ## Write a starter configuration where the plugin reads it; one already there is left as it is
	@$(PYTHON) plugins/fleet/readers/setup.py || test $$? -eq 3
	@echo 'Run make doctor to see what the pane is still missing.'

doctor: ## Say what the pane is missing on this machine, and the setting that fixes each
	$(PYTHON) plugins/fleet/readers/doctor.py

setup: ## Verify the scaffold's Python 3.11+ prerequisite
	@$(PYTHON) -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else "Python 3.11+ required")'

build: ## Compile scaffold Python into the configured build cache
	PYTHONPYCACHEPREFIX="$(BUILD_CACHE)" $(PYTHON) -m compileall -q scripts tests config plugins

install: ## Report runtime installation availability
	@set -euo pipefail; echo 'Unavailable: runtime extraction and packaging are not implemented.' >&2; exit 2

link: ## Report Claude-home trial linking availability
	@set -euo pipefail; echo 'Unavailable: no installable plugin or verified engine link contract exists.' >&2; exit 2

clean: ## Remove only the scaffold-generated build cache
	@$(PYTHON) -c 'from pathlib import Path; import shutil; p = Path("$(BUILD_CACHE)"); state = Path("$(STATE_DIR)"); assert p.name == "build" and p.parent == state and not p.is_symlink() and not state.is_symlink(), "Unsafe build cache"; shutil.rmtree(p) if p.exists() else None'
