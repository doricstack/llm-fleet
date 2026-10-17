# Configuration fixtures

One directory per case. The same corpus is loaded by the Python loader and by
the TypeScript loader, so a behavior that drifts between the two language layers
fails a test rather than reaching a runtime.

| File | Holds |
| --- | --- |
| `env.json` | The environment the loader sees, the paths that exist, the platform to resolve for, and which config file to select |
| `config.json` | The document under test; absent when the case is about a missing file |
| `expected.json` | Either what the case changes, or the refusal list |

## `env.json`

| Key | Meaning |
| --- | --- |
| `environment` | Variable names and values. A value starting with `./` resolves against the fixture directory; any other value is passed through for the loader to expand |
| `paths` | Path to kind, where kind is `directory`, `file`, or `missing`. Anything absent from this map reports `missing` |
| `configFile` | A file name inside the fixture directory, or `null`. A name sets the selector variable, which is how an explicit file selection is exercised |
| `platform` | The platform name the loader resolves platform rules against, or absent for the running one |

Path kinds are injected rather than created on disk, so a case never depends on
the machine it runs on and no fixture needs a real provider home. The config
file itself is read from the real filesystem, which is what makes the
missing-file and not-a-regular-file cases real.

## `expected.json`

| Key | Meaning |
| --- | --- |
| `config` | Only what this case changes. The harness merges it onto the defaults the schema declares, then requires an exact match |
| `errors` | The refusal list as `code` and `path` pairs. Message text is not compared |

A default that depends on another value, such as the state directory or the
platform temporary directory, is left out of the harness baseline, so a success
case states it rather than inheriting a guess.

| Token | Stands for |
| --- | --- |
| `<FIXTURE>` | The fixture directory, because a relative path resolves against the directory holding the config file and that directory differs by checkout |
| `<TEMP>` | The platform temporary directory as the running machine resolves it |

Comparison ignores key order, and it compares paths in the running platform's
shape: the schema says which fields hold a path, so the harness normalizes
exactly those values on both sides. A fixture therefore states one form of a
path and still passes on Windows, where the loader returns backslashes. Both
loaders must also agree with each other, not only with the expectation.
