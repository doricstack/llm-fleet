# Private-to-public export

## Two repositories, one project

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC7-1 | Two repositories, one project | `doricstack/llm-fleet-private` is the working repository. |
| DOC7-2 | Two repositories, one project | Development, review, planning, and extraction happen there. |
| DOC7-3 | Two repositories, one project | `doricstack/llm-fleet` is the published repository, written only by export. |
| DOC7-4 | Two repositories, one project | Never edit the public checkout by hand. |
| DOC7-5 | Two repositories, one project | This follows the sibling project's `mcp-broker-private` working repository and `mcp-broker` published repository naming pattern. |
| DOC7-6 | Two repositories, one project | A local checkout folder name does not establish which role it serves. |
| DOC7-7 | Two repositories, one project | Private Git history stays private; never mirror-push it or change the private repository's visibility to publish. |

## Publication policy

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC7-8 | Publication policy | `public-export/allowlist.txt` contains exact relative paths or case-sensitive Python fnmatch patterns. |
| DOC7-9 | Publication policy | Only matched files are selected. |
| DOC7-10 | Publication policy | Every entry must match at least one file; an empty or stale policy is an error. |
| DOC7-11 | Publication policy | Globs can match slash characters, so review broad patterns with care. |
| DOC7-12 | Publication policy | Runtime directories have no allowlist entry until their extraction is complete. |
| DOC7-13 | Publication policy | AGENTS.md, CLAUDE.md, and the four design/runbook docs are publishable. |
| DOC7-14 | Publication policy | The operational PROJECT_CONTEXT.md, TODO.md, SNAPSHOT.md, HANDOFF.md, and any local session context are excluded. |
| DOC7-15 | Publication policy | Public instructions and docs contain shapes, not the owner's personal directories, hostnames, accounts, or repository names. |
| DOC7-16 | Publication policy | The documented project repository pairs are intentional identifiers. |
| DOC7-17 | Publication policy | `public-export/denylist.txt` is a content policy, not a list of excluded paths. |
| DOC7-18 | Publication policy | Each noncomment line is a case-insensitive Python regular expression. |
| DOC7-19 | Publication policy | The exporter scans both relative filenames and every selected file's UTF-8 content. |
| DOC7-20 | Publication policy | Shapes cover local usernames in paths, machine hostnames, personal provider homes, internal repository families, secret-store paths, and common key formats. |
| DOC7-21 | Publication policy | Real owner strings never belong in this public file. |
| DOC7-22 | Publication policy | No file is exempt, including the policy files, exporter, tests, and CI. |
| DOC7-23 | Publication policy | Do not print a matched secret in errors. |
| DOC7-24 | Publication policy | Shape matching cannot identify an arbitrary bare username, an opaque hostname, or every encoded secret. |
| DOC7-25 | Publication policy | Release hardening must add an ignored exact-identity inventory and more encoded-secret cases. |
| DOC7-26 | Publication policy | Review remains necessary. |
| DOC7-27 | Publication policy | Binary files are refused in this scaffold, so screenshots need an explicit asset policy first. |

## Commands

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC7-28 | Commands | Run from the private working tree: |

| Item | Value |
| --- | --- |
| 1 | `make test` |
| 2 | `make build` |
| 3 | `make export-check PUBLIC_TREE=/tmp/fleet-public-preview` |
| 4 | `make export PUBLIC_TREE=/tmp/fleet-public-tree` |

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC7-29 | Commands | The equivalent script interface is: |

| Item | Value |
| --- | --- |
| 1 | `python3 scripts/public-export.py --destination /tmp/fleet-public-preview --dry-run` |
| 2 | `python3 scripts/public-export.py --destination /tmp/fleet-public-tree` |

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC7-30 | Commands | `--source` can select a different source tree. |
| DOC7-31 | Commands | Without it, the script uses the repository containing itself, not the caller's working directory. |
| DOC7-32 | Commands | There are no dependencies outside the Python standard library and no Git commands. |
| DOC7-33 | Commands | Dry-run validates both lists, scans all selected files, prints the entire file list, and shows a unified content diff. |
| DOC7-34 | Commands | It does not create the destination, change files, write a manifest, or modify Git metadata. |
| DOC7-35 | Commands | Previous destination content matching the denylist is redacted from the diff. |
| DOC7-36 | Commands | A dry-run exit of zero means validation passed; it does not mean the trees were identical. |
| DOC7-37 | Commands | Read the diff or the explicit "No changes" message. |

## Destination safety

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC7-38 | Destination safety | Use a fresh destination or a checkout containing only Git metadata. |
| DOC7-39 | Destination safety | After an export, `.fleet-export.json` records the paths managed by the exporter. |
| DOC7-40 | Destination safety | That generated sidecar is ignored by Git and is not itself a published source file. |
| DOC7-41 | Destination safety | Later exports update selected files and remove only stale paths recorded by a prior manifest. |
| DOC7-42 | Destination safety | Unknown destination files cause refusal, not deletion. |
| DOC7-43 | Destination safety | Existing public history without the sidecar needs a fresh export directory; do not invent a manifest to claim ownership of files. |
| DOC7-44 | Destination safety | Source and destination cannot be identical or nested. |
| DOC7-45 | Destination safety | Selected symlinks, symlinked roots or destination parents, nonregular files, malformed manifests, invalid policy, binary data, and path traversal are refused. |
| DOC7-46 | Destination safety | Git metadata is excluded from scanning and copying and is never changed. |
| DOC7-47 | Destination safety | All selected bytes and destination paths are checked before the first content write. |
| DOC7-48 | Destination safety | The root-owned macOS `/tmp` and `/var` aliases into `/private` are accepted; user-created symlinks remain refused. |
| DOC7-49 | Destination safety | Exports require quiescent source and destination trees. |
| DOC7-50 | Destination safety | Whole-tree replacement is not transactional and there is no concurrent-writer lock yet. |
| DOC7-51 | Destination safety | An I/O failure during apply can leave a partial output; discard that disposable output and repeat into a fresh directory. |
| DOC7-52 | Destination safety | Do not publish after a failed export. |
| DOC7-53 | Destination safety | Executable mode preservation is not implemented; the current commands invoke Python files through the interpreter. |
| DOC7-54 | Destination safety | Add mode handling before exporting executable launchers. |

## Improvements over the sibling exporter

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC7-55 | Improvements over the sibling exporter | The inspected sibling implementation already selects allowed paths, excludes denied paths, scans private/secret markers, and provides a comparison-only `--verify`. |
| DOC7-56 | Improvements over the sibling exporter | It also deletes stale destination files and has marker exemptions. |
| DOC7-57 | Improvements over the sibling exporter | Its release workflow distributes an already prepared project; that workflow is not proof that a fresh private-to-public export builds independently. |
| DOC7-58 | Improvements over the sibling exporter | This scaffold adds a dry-run with file list and content diff, moves forbidden content expressions into the denylist, and scans every selected file without exemptions. |
| DOC7-59 | Improvements over the sibling exporter | Leak tests inject forbidden content and filenames and assert refusal before writes. |
| DOC7-60 | Improvements over the sibling exporter | Destination ownership limits stale-file deletion, and symlink and overlap checks constrain where the exporter can write. |
| DOC7-61 | Improvements over the sibling exporter | CI runs the exporter suite, builds the private scaffold, validates and writes a fresh export, then builds and tests from the exported directory. |
| DOC7-62 | Improvements over the sibling exporter | A further dry-run from that directory proves its export tooling does not require private files. |
| DOC7-63 | Improvements over the sibling exporter | The current build compiles Python tooling only. |
| DOC7-64 | Improvements over the sibling exporter | Once runtime code is extracted, the build and tests must include the actual plugin package; a Python-only pass must never count as a plugin release gate. |

## Publishing later

| ID | Context | Statement or required action |
| --- | --- | --- |
| DOC7-65 | Publishing later | The workflow has read-only repository permissions and performs no publication. |
| DOC7-66 | Publishing later | This scaffolding pass does not run hosted CI, install plugins, commit, or push. |
| DOC7-67 | Publishing later | Before a later authorized publication, resolve the release-hardening queue, inspect the dry-run, build and test the exported tree, and initialize or update only the separate public history. |
| DOC7-68 | Publishing later | The exporter writes files; approval and Git publication remain outside its responsibilities. |
