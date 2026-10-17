# llm-fleet: shared setup, generated help, and fragment includes only.
# make/config.mk   Machine and CI paths, state, provider homes, and tool entry points.
# make/dev.mk      Setup, build, install/link availability, and generated-cache cleanup.
# make/test.mk     Unit, engine, export, and complete CI verification suites.
# make/quality.mk  Lint, typecheck availability, violations, and doc-format checks.
# make/export.mk   Export preview, application, and leak validation.
# make/scripts.mk  One entry point per runnable script under scripts/.

# A POSIX shell runs every recipe. On Windows that shell comes from PATH, because
# an absolute /bin/bash is not a path the operating system can resolve.
ifeq ($(OS),Windows_NT)
SHELL := bash
else
SHELL := /bin/bash
endif
# GNU Make 3.81 ignores .SHELLFLAGS; chained recipes set shell options explicitly.
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
.DEFAULT_GOAL := help

.PHONY: help
help: ## List available commands from every fragment
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-24s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

include make/config.mk
include make/dev.mk
include make/test.mk
include make/quality.mk
include make/export.mk
include make/scripts.mk
