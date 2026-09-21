import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "node:fs/promises";


async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");

  /* Everything the server needs is bundled into one file, with two
     deliberate exceptions:

       better-sqlite3 - a compiled binary. It cannot be inlined into
       JavaScript and must be loaded from node_modules at runtime.

       vite - only reachable from the development branch of index.ts. The
       NODE_ENV define below folds that branch away at build time, so the
       import never survives into the bundle, but esbuild still needs to be
       told not to follow it.

     Bundling the rest means a packaged install ships one server file plus a
     single native module, instead of the entire dependency tree. The client
     packages in `dependencies` are compiled into the browser assets by Vite
     and are not required at runtime at all. */
  const externals = ["better-sqlite3", "vite"];

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
