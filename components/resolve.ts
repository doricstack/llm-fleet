/**
 * Lets Node run the plugin's modules the way the host loads them.
 *
 * The plugin's modules import one another as `./name.js`, the form the host's
 * strict check accepts: it type-checks every module with its own settings and
 * refuses an import that ends in `.ts`. The host finds `name.ts` behind that
 * name; Node does not, so every command here that runs those modules starts
 * Node with this file under `--import`. A `.js` file that exists is still the
 * one imported, and nothing outside a relative import changes.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (relative && context.parentURL !== undefined) {
      // Read the path from the URL, not the specifier, so a query or a hash
      // after `.js` neither hides the extension nor is lost from the import.
      const written = new URL(specifier, context.parentURL);
      if (written.pathname.endsWith(".js")) {
        const source = new URL(written.href);
        source.pathname = written.pathname.slice(0, -".js".length) + ".ts";
        if (!existsSync(fileURLToPath(written)) && existsSync(fileURLToPath(source))) {
          return nextResolve(source.href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
