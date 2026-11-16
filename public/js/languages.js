// Maps a changed file's path to a language by its extension (or, for files
// like Makefile and Dockerfile, its name). Files that aren't code are not
// counted: data and config formats (JSON, YAML, TOML, XML, CSV), prose
// (Markdown, text), lockfiles, images and other binaries, and files that are
// generated or vendored (minified bundles, node_modules/, vendor/, dist/ …).

const EXTENSIONS = {
  // Python
  py: "Python", pyi: "Python", pyw: "Python", pyx: "Cython", pxd: "Cython",
  ipynb: "Jupyter Notebook",
  // JavaScript, TypeScript and JS framework components, counted together.
  js: "JS/TS", mjs: "JS/TS", cjs: "JS/TS", jsx: "JS/TS",
  ts: "JS/TS", mts: "JS/TS", cts: "JS/TS", tsx: "JS/TS",
  vue: "JS/TS", svelte: "JS/TS", astro: "JS/TS", marko: "JS/TS", riot: "JS/TS",
  // Web
  html: "HTML", htm: "HTML", xhtml: "HTML",
  // CSS and the languages that compile to it, counted together.
  css: "CSS", scss: "CSS", sass: "CSS", less: "CSS", styl: "CSS", stylus: "CSS", pcss: "CSS", postcss: "CSS", sss: "CSS",
  // JVM
  java: "Java", kt: "Kotlin", kts: "Kotlin", scala: "Scala", sc: "Scala", groovy: "Groovy", gradle: "Groovy", clj: "Clojure", cljs: "Clojure", cljc: "Clojure", edn: "Clojure",
  // C family
  c: "C", h: "C",
  cc: "C++", cpp: "C++", cxx: "C++", "c++": "C++", hh: "C++", hpp: "C++", hxx: "C++", "h++": "C++", ipp: "C++", tpp: "C++", ino: "C++",
  m: "Objective-C", mm: "Objective-C++",
  cs: "C#", csx: "C#", fs: "F#", fsi: "F#", fsx: "F#", vb: "Visual Basic",
  cu: "CUDA", cuh: "CUDA", metal: "Metal", glsl: "GLSL", vert: "GLSL", frag: "GLSL", hlsl: "HLSL", wgsl: "WGSL",
  // Systems
  go: "Go", rs: "Rust", zig: "Zig", nim: "Nim", d: "D", odin: "Odin", cr: "Crystal",
  swift: "Swift", dart: "Dart",
  asm: "Assembly", s: "Assembly", nasm: "Assembly",
  // Scripting
  rb: "Ruby", erb: "Ruby", rake: "Ruby", gemspec: "Ruby",
  php: "PHP", phtml: "PHP",
  pl: "Perl", pm: "Perl", t: "Perl", raku: "Raku", rakumod: "Raku",
  lua: "Lua", tcl: "Tcl",
  sh: "Shell", bash: "Shell", zsh: "Shell", fish: "Shell", ksh: "Shell",
  ps1: "PowerShell", psm1: "PowerShell", psd1: "PowerShell",
  bat: "Batchfile", cmd: "Batchfile",
  // Functional
  hs: "Haskell", lhs: "Haskell", elm: "Elm", ml: "OCaml", mli: "OCaml", re: "Reason", res: "ReScript",
  ex: "Elixir", exs: "Elixir", heex: "Elixir", erl: "Erlang", hrl: "Erlang", gleam: "Gleam",
  lisp: "Common Lisp", lsp: "Common Lisp", cl: "Common Lisp", el: "Emacs Lisp", scm: "Scheme", ss: "Scheme", rkt: "Racket",
  purs: "PureScript", idr: "Idris", agda: "Agda", lean: "Lean",
  // Data science & numeric
  r: "R", rmd: "R", jl: "Julia", sas: "SAS", stan: "Stan",
  f: "Fortran", for: "Fortran", f77: "Fortran", f90: "Fortran", f95: "Fortran", f03: "Fortran", f08: "Fortran",
  // Databases & infra
  sql: "SQL", psql: "SQL", plsql: "PL/SQL", prisma: "Prisma", graphql: "GraphQL", gql: "GraphQL", proto: "Protocol Buffers",
  tf: "HCL", tfvars: "HCL", hcl: "HCL", nix: "Nix", bicep: "Bicep",
  sol: "Solidity", move: "Move", cairo: "Cairo",
  // Templates
  hbs: "Handlebars", handlebars: "Handlebars", mustache: "Mustache", jinja: "Jinja", j2: "Jinja", liquid: "Liquid", twig: "Twig", pug: "Pug", ejs: "EJS", njk: "Nunjucks", haml: "Haml", slim: "Slim", razor: "C#", cshtml: "C#",
  // Other languages
  pas: "Pascal", dpr: "Pascal", pp: "Puppet", adb: "Ada", ads: "Ada", cob: "COBOL", cbl: "COBOL",
  ahk: "AutoHotkey", applescript: "AppleScript", vim: "Vim Script", awk: "Awk", sed: "sed",
  hx: "Haxe", gd: "GDScript", mojo: "Mojo", wat: "WebAssembly", wast: "WebAssembly",
  v: "Verilog", vhd: "VHDL", vhdl: "VHDL", sv: "SystemVerilog", svh: "SystemVerilog",
  tex: "TeX", sty: "TeX", cls: "TeX",
  qml: "QML", ly: "LilyPond",
};

const FILENAMES = {
  makefile: "Makefile", gnumakefile: "Makefile",
  dockerfile: "Dockerfile", containerfile: "Dockerfile",
  "cmakelists.txt": "CMake",
  rakefile: "Ruby", gemfile: "Ruby", podfile: "Ruby", vagrantfile: "Ruby", brewfile: "Ruby",
  justfile: "Just",
  "build.bazel": "Starlark", build: "Starlark", workspace: "Starlark",
};

// Extensions handled by more specific rules elsewhere.
const EXTENSION_RULES = [
  [/\.cmake$/i, "CMake"],
  [/\.mk$/i, "Makefile"],
  [/\.dockerfile$/i, "Dockerfile"],
  [/(^|\/)dockerfile\.[^/]+$/i, "Dockerfile"],
  [/\.(bzl|star)$/i, "Starlark"],
];

// Generated or vendored code, which the person didn't write line by line.
const IGNORED_PATHS = [
  /(^|\/)(node_modules|bower_components|jspm_packages|vendor|vendors|third_party|third-party|thirdparty|external|externals|deps|_deps)\//i,
  /(^|\/)(dist|build|out|target|bin|obj|coverage|htmlcov|site-packages|\.venv|venv|env|__pycache__|\.next|\.nuxt|\.svelte-kit|\.output|\.cache|Pods|Carthage|DerivedData)\//i,
  /\.min\.(js|css|mjs)$/i,
  /[-.](bundle|chunk)\.[a-z0-9]+\.js$/i,
  /\.(pb|pb2|pb2_grpc)\.(go|py|cc|h)$/i,
  /_pb2(_grpc)?\.py$/i,
  /\.generated\.[a-z]+$/i,
  /\.g\.dart$/i,
  /\.designer\.cs$/i,
  /(^|\/)migrations\/\d{4}_[^/]*\.py$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|go\.sum|mix\.lock|flake\.lock|uv\.lock|pubspec\.lock|Podfile\.lock)$/i,
];

// Own keys only: a file named "x.constructor" or "toString" must not match
// the built-in properties every JavaScript object has.
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : null);

/**
 * The language of a changed file, or null when the file isn't counted
 * (not code, or generated/vendored). Headers (.h) come back as "C"; see
 * headerLanguage for working out whether a commit's headers are C++.
 */
export function languageOf(path) {
  if (!path) return null;
  if (IGNORED_PATHS.some((re) => re.test(path))) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  const byName = own(FILENAMES, lower);
  if (byName) return byName;
  for (const [re, lang] of EXTENSION_RULES) if (re.test(path)) return lang;
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;
  return own(EXTENSIONS, lower.slice(dot + 1));
}

/** A C-family header whose language depends on the code around it. */
export function isHeader(path) {
  return /\.h$/i.test(path ?? "");
}

const CPP_SIGNS = /\b(class|namespace|template\s*<|typename|constexpr|nullptr|std::|public:|private:|protected:|virtual|operator\s*[^\s\w])/;

/**
 * The language of a commit's .h files: whichever of C and C++ the commit's
 * other files are mostly in, and otherwise (a commit of only headers) C++ if
 * the headers' changed lines look like C++, else C.
 */
export function headerLanguage(cLines, cppLines, patches = []) {
  if (cppLines > cLines) return "C++";
  if (cLines > cppLines) return "C";
  return patches.some((p) => CPP_SIGNS.test(p ?? "")) ? "C++" : "C";
}
