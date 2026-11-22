// Client bundle for the standalone (Vercel) deployment.
//
// Bun.build with the HTML entrypoint: Bun follows the `<script>` and CSS
// references in client/index.html, bundles main.tsx + theme.css (Tailwind
// v4 is handled by bun-plugin-tailwind), and emits hashed assets into
// client/dist. NODE_ENV=production so React ships its production build.

import tailwindPlugin from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["./client/index.html"],
  outdir: "./client/dist",
  target: "browser",
  minify: true,
  plugins: [tailwindPlugin],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("client build failed");
}
console.log(`client build ok: ${result.outputs.length} outputs -> client/dist`);
