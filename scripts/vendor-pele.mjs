// Copies the parts of pele the site uses (the core and the xychart diagram,
// plus every chunk they import) from node_modules into public/vendor/pele,
// so the site stays plain static files with no bundler.
//
//   bun run vendor
//
// Run it again after upgrading pele.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/pele/dist/esm");
const out = join(root, "public/vendor/pele");
const entries = ["core.js", "diagrams/xychart.js"];

if (!existsSync(src)) {
  console.error("node_modules/pele is missing: run bun install first.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
const seen = new Set();
const queue = entries.map((entry) => join(src, entry));
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const code = readFileSync(file, "utf8");
  for (const [, spec] of code.matchAll(/(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    queue.push(resolve(dirname(file), spec));
  }
  const dest = join(out, relative(src, file));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(file, dest);
}

const pkg = JSON.parse(readFileSync(join(root, "node_modules/pele/package.json"), "utf8"));
cpSync(join(root, "node_modules/pele/LICENSE"), join(out, "LICENSE"));
writeFileSync(join(out, "VERSION"), `${pkg.version}\n`);
console.log(`Vendored pele ${pkg.version}: ${seen.size} modules into ${relative(root, out)}`);
