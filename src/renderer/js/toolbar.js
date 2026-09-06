/** Top toolbar wiring: project/preview controls, resolution, mode, menus. */
import { state, on, emit, toast } from "./state.js";
import { PRESETS } from "./resolutions.js";
import { bridgeSend, flushBridgeEdits, sendEditorMode } from "./bridge.js";
import { openProject, startPreview, saveOverrides } from "./project.js";
import {
  undo,
  redo,
  resetElement,
  resetProfile,
  revertProfile,
  revertAll,
  copyProfile,
  activeScopeProfile,
  unsavedCount,
  PROFILES,
} from "./overrides.js";
import { setPreset, setResolution, toggleOrientation } from "./viewport.js";
import { showMenu, showSaveSummary, confirmDialog } from "./dialogs.js";
import { showAddElementDialog } from "./addElement.js";
import { setupMenu } from "./setup.js";
import { toggleLogPanel } from "./statusbar.js";

const $ = (id) => document.getElementById(id);

export function setMode(mode) {
  state.mode = mode;
  $("btn-mode-edit").classList.toggle("active", mode === "edit");
  $("btn-mode-preview").classList.toggle("active", mode === "preview");
  sendEditorMode(mode);
  emit("mode");
}

export async function doSave() {
  if (!state.project) return toast("Open a project first.");
  try {
    await flushBridgeEdits();
  } catch (error) {
    toast(
      `Cannot save yet: the game has not confirmed its latest layout edit (${error.message ?? error}).`,
      "error",
      7000,
    );
    return;
  }
  const confirmed = await showSaveSummary();
  if (confirmed) await saveOverrides({ flush: false });
}

function guidesMenu(anchor) {
  const g = state.guides;
  const sendGuides = () => bridgeSend("guides", g);
  const checkboxRow = (labelText, checked, onChange) => {
    const row = document.createElement("div");
    row.className = "mrow";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => {
      onChange(input.checked);
      sendGuides();
    });
    const label = document.createElement("label");
    label.textContent = labelText;
    row.appendChild(input);
    row.appendChild(label);
    return { custom: row, input };
  };
  const numberRow = (labelText, value, onChange) => {
    const row = document.createElement("div");
    row.className = "mrow";
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.value = value;
    input.addEventListener("change", () => {
      onChange(Number(input.value) || 0);
      sendGuides();
    });
    row.appendChild(label);
    row.appendChild(input);
    return { custom: row };
  };
  showMenu(anchor, [
    { header: "Guides" },
    checkboxRow("Center lines", g.centers, (v) => (g.centers = v)),
    checkboxRow(
      "Safe area",
      g.safeArea.enabled,
      (v) => (g.safeArea.enabled = v),
    ),
    numberRow("Safe top %", g.safeArea.top, (v) => (g.safeArea.top = v)),
    numberRow(
      "Safe bottom %",
      g.safeArea.bottom,
      (v) => (g.safeArea.bottom = v),
    ),
    numberRow("Safe left %", g.safeArea.left, (v) => (g.safeArea.left = v)),
    numberRow("Safe right %", g.safeArea.right, (v) => (g.safeArea.right = v)),
    { sep: true },
    checkboxRow("Grid", g.grid.enabled, (v) => (g.grid.enabled = v)),
    numberRow("Grid size", g.grid.size, (v) => (g.grid.size = Math.max(4, v))),
    { sep: true },
    checkboxRow("Snapping", g.snap, (v) => (g.snap = v)),
    checkboxRow("Show all bounds", g.boundsAll, (v) => (g.boundsAll = v)),
  ]);
}

function resetMenu(anchor) {
  const profile = activeScopeProfile();
  const selection = state.selection;
  showMenu(anchor, [
    { header: `Reset (edit target: ${profile})` },
    {
      label: `Reset selected element in "${profile}"`,
      disabled: !selection,
      onClick: () => resetElement(selection, [profile]),
    },
    {
      label: "Reset selected element in all profiles",
      disabled: !selection,
      onClick: () => resetElement(selection, PROFILES),
    },
    {
      label: `Reset ALL overrides in "${profile}"`,
      danger: true,
      onClick: async () => {
        if (
          await confirmDialog(
            "Reset layout",
            `Remove every override in the "${profile}" layout?`,
          )
        )
          resetProfile(profile);
      },
    },
    { sep: true },
    { header: "Revert to last saved" },
    {
      label: `Revert "${profile}" layout to saved`,
      onClick: () => revertProfile(profile),
    },
    {
      label: "Revert ALL unsaved changes",
      danger: true,
      onClick: async () => {
        if (
          await confirmDialog(
            "Revert all",
            "Discard every unsaved layout change?",
          )
        )
          revertAll();
      },
    },
  ]);
}

function layoutMenu(anchor) {
  const from = activeScopeProfile();
  const items = [{ header: `Copy layout (from: ${from})` }];
  for (const to of PROFILES) {
    if (to === from) continue;
    items.push({
      label: `Copy complete "${from}" layout → ${to}`,
      onClick: async () => {
        if (
          await confirmDialog(
            "Copy layout",
            `Copy all "${from}" overrides to "${to}"? Existing "${to}" overrides are replaced.`,
          )
        )
          copyProfile(from, to);
      },
    });
  }
  items.push({ sep: true });
  items.push({ header: "Profiles with overrides" });
  for (const profile of PROFILES) {
    const count = Object.keys(
      state.overrides.working.profiles[profile] ?? {},
    ).length;
    items.push({ label: `${profile}: ${count} element(s)`, disabled: true });
  }
  showMenu(anchor, items);
}

export function initToolbar() {
  // presets
  const presetSel = $("sel-preset");
  let currentGroup = "";
  presetSel.innerHTML = "";
  const customOpt = document.createElement("option");
  customOpt.value = "-1";
  customOpt.textContent = "Custom";
  presetSel.appendChild(customOpt);
  PRESETS.forEach((preset, index) => {
    if (preset.group !== currentGroup) {
      currentGroup = preset.group;
      const group = document.createElement("optgroup");
      group.label = currentGroup;
      group.dataset.group = currentGroup;
      presetSel.appendChild(group);
    }
    const opt = document.createElement("option");
    opt.value = String(index);
    opt.textContent = `${preset.name} (${preset.w}×${preset.h})`;
    presetSel.lastElementChild.appendChild(opt);
  });
  presetSel.addEventListener("change", () => {
    const index = Number(presetSel.value);
    if (index >= 0) setPreset(index, false);
  });

  $("in-width").addEventListener("change", () =>
    setResolution(Number($("in-width").value), state.resolution.height),
  );
  $("in-height").addEventListener("change", () =>
    setResolution(state.resolution.width, Number($("in-height").value)),
  );
  $("btn-orient").addEventListener("click", toggleOrientation);

  // keep inputs in sync
  const syncInputs = () => {
    $("in-width").value = state.resolution.width;
    $("in-height").value = state.resolution.height;
    presetSel.value = String(state.resolution.presetIndex);
  };
  syncInputs();
  on("resolution", syncInputs);

  // project / preview
  $("btn-open").addEventListener("click", () => openProject());
  $("btn-preview").addEventListener("click", startPreview);

  // scope
  $("sel-scope").addEventListener("change", () => {
    state.scope = $("sel-scope").value;
    bridgeSend("scope", { scope: state.scope });
    emit("scope");
    emit("overrides");
  });

  // mode
  $("btn-mode-edit").addEventListener("click", () => setMode("edit"));
  $("btn-mode-preview").addEventListener("click", () => setMode("preview"));

  // edit ops
  $("btn-save").addEventListener("click", doSave);
  $("btn-add").addEventListener("click", () => showAddElementDialog());
  $("btn-menu-setup").addEventListener("click", (event) =>
    setupMenu(event.currentTarget),
  );

  // menus
  $("btn-menu-guides").addEventListener("click", (event) =>
    guidesMenu(event.currentTarget),
  );
  $("btn-menu-reset").addEventListener("click", (event) =>
    resetMenu(event.currentTarget),
  );
  $("btn-menu-layout").addEventListener("click", (event) =>
    layoutMenu(event.currentTarget),
  );

  // misc
  $("btn-shot").addEventListener("click", async () => {
    const result = await window.editorHost.capture();
    toast(`Screenshot saved: ${result.path}`, "ok");
  });
  $("btn-logs").addEventListener("click", () => toggleLogPanel());

  setMode(state.mode);
}
