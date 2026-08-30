const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { inspectProject } = require("../src/main/projects");

/** Minimal pnpm workspace with one pixi-svelte game app. */
const makeProject = (t, envSource) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sle-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDir = path.join(root, "apps", "lines");
  fs.mkdirSync(path.join(appDir, "src", "routes"), { recursive: true });
  fs.mkdirSync(path.join(appDir, "src", "game"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    "packages:\n  - apps/*\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({
      name: "lines",
      scripts: { dev: "vite dev --port 3001" },
      dependencies: { "pixi-svelte": "workspace:*" },
    }),
    "utf8",
  );
  if (envSource !== null)
    fs.writeFileSync(path.join(appDir, ".env.local"), envSource, "utf8");
  return root;
};

test("a trailing slash on VITE_RGS_URL is stripped before it reaches the game", (t) => {
  const root = makeProject(t, "VITE_RGS_URL=http://localhost:3002/\n");
  const info = inspectProject(root);

  assert.equal(info.ok, true);
  // rgs-fetcher builds `${rgsUrl}/wallet/authenticate`; a kept slash would make
  // that "//wallet/authenticate", which the RGS answers with a 404.
  assert.equal(info.env.rgsUrl, "http://localhost:3002");
});

test("repeated trailing slashes and surrounding blanks are normalized too", (t) => {
  const root = makeProject(
    t,
    "VITE_RGS_URL=https://rgsd.stake-engine.com///\n",
  );
  assert.equal(
    inspectProject(root).env.rgsUrl,
    "https://rgsd.stake-engine.com",
  );
});

test("an already clean RGS url is left untouched", (t) => {
  const root = makeProject(t, "VITE_RGS_URL=http://localhost:3002\n");
  assert.equal(inspectProject(root).env.rgsUrl, "http://localhost:3002");
});

test("the built-in default RGS url is used when .env.local has none", (t) => {
  const root = makeProject(t, null);
  assert.equal(inspectProject(root).env.rgsUrl, "http://localhost:3002");
});
