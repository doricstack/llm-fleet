/**
 * Whether the module at `moduleUrl` is the one Node was started on.
 *
 * Node names the started file by path in `process.argv[1]` and the module by
 * URL in `import.meta.url`. The two cannot be compared as strings: a Windows
 * path is `D:\...` where the URL is `file:///D:/...`, a space is `%20` in the
 * URL only, and the URL names the file's real location while the path may pass
 * through a link. Both are brought to the real path on disk and compared there.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function startedDirectly(moduleUrl: string, started: string | undefined = process.argv[1]): boolean {
  if (started === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(started);
  } catch {
    // `node -e '...' word` starts no file and passes `word` here, and a URL may
    // name no file at all: neither is this module, and an import must not throw.
    return false;
  }
}
