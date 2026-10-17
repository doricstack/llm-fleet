# Machine-dependent values live here; no runtime installation is implied.
# Unix installs expose python3; Windows installs usually expose python only.
PYTHON ?= $(shell command -v python3 >/dev/null 2>&1 && echo python3 || echo python)
NODE ?= node
RUNTIME_ROOT ?= $(ROOT)
STATE_DIR ?= $(ROOT)/.state
PROVIDER_HOMES_FILE ?=
CLAUDE_HOME ?=
PUBLIC_TREE ?=
# Set an explicit checker command after selecting the runtime type toolchain.
TYPECHECK ?=
EXPORT_MODE ?= --dry-run

# Derived paths and shared invocation defaults.
BUILD_CACHE := $(STATE_DIR)/build
TEST_ENV := PYTHONDONTWRITEBYTECODE=1
UNIT_TEST_PATTERN := test_doc_format.py
EXPORT_TEST_PATTERN := test_public_export.py

# The engine's generated declaration, for the drift check. Empty until named, and
# empty is the usual case: the host scaffolds its own declaration into the plugin
# folder when it loads the plugin, so the check reads that one without being told
# where it is. Name a path to read another engine's.
HOST_DECLARATION ?=
# Set when the caller runs where no engine exists and the check's absence report
# is the answer rather than a failure. CI sets it: the runner has no engine, and a
# check that could not run must not end the build, but it must say so in the log.
HOST_DECLARATION_MAY_BE_ABSENT ?=

# The host command that runs a plugin's own tests. Empty until named, because
# the host is the person's tool and not a dependency of this repository.
HOST_CLI ?=

# Where a review page is written. Defaults to a directory on the desktop.
REVIEW_OUT ?=
# A payload recorded from a real session, and the width the preview draws into.
STATUSLINE_PAYLOAD ?=
STATUSLINE_WIDTH ?= 120
