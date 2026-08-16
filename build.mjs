import * as esbuild from "esbuild";
import fs from "node:fs";

const watch = process.argv.includes("--watch");
fs.mkdirSync("public/dist", { recursive: true });

const options = {
  entryPoints: ["src/main.jsx"],
  bundle: true,
  outfile: "public/dist/app.js",
  minify: !watch,
  sourcemap: watch,
  target: ["es2019"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching…");
} else {
  await esbuild.build(options);
  console.log("build complete → public/dist/app.js + app.css");
}
