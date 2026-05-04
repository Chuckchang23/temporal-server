require("dotenv").config();
const OBSWebSocket = require("obs-websocket-js").default;

const obs = new OBSWebSocket();

let connected = false;
let connecting = null;

const OBS_HOST = process.env.OBS_HOST || process.env.OBS_IP || "127.0.0.1";
const OBS_PORT = process.env.OBS_PORT || "4455";
const OBS_PASSWORD = process.env.OBS_PASSWORD || "";

const SCENES = {
  elevator: "elevator",
  opening: "opening",
  control: "1 - Control Room",
  portal: "1.5 - Portal",
  minecraft: "2 - Minecraft Room",
  mirror: "3 - Mirror Wall",
  tron: "4 - Tron room",
  bgMusic: "Audio - BG Music",
  asteroid: "~~~~Asteroid Overlay-----",
  portalVideo: "~~~ns~~~ Portal Video",
};

function obsUrl() {
  return `ws://${OBS_HOST}:${OBS_PORT}`;
}

async function connectOBS() {
  if (connected) return obs;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      if (!OBS_PASSWORD) {
        throw new Error(
          "OBS_PASSWORD is missing. Add OBS_PASSWORD=your_password to .env and restart the Node server."
        );
      }

      await obs.connect(obsUrl(), OBS_PASSWORD);

      connected = true;
      console.log(`✅ Connected to OBS at ${obsUrl()}`);
      return obs;
    } catch (err) {
      connected = false;

      console.error("❌ OBS connection failed:");
      console.error(`URL: ${obsUrl()}`);
      console.error(`Password set: ${OBS_PASSWORD ? "YES" : "NO"}`);
      console.error(`Error: ${err.message}`);

      throw err;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

obs.on("ConnectionClosed", () => {
  connected = false;
  console.log("⚠️ OBS WebSocket disconnected");
});

obs.on("ConnectionError", (err) => {
  connected = false;
  console.error("❌ OBS WebSocket connection error:", err.message);
});

async function callOBS(requestType, requestData = {}) {
  await connectOBS();
  return obs.call(requestType, requestData);
}

async function switchScene(sceneName) {
  if (!sceneName) {
    throw new Error("sceneName is required");
  }

  await callOBS("SetCurrentProgramScene", { sceneName });
  console.log(`🎬 Program scene switched to: ${sceneName}`);

  return {
    ok: true,
    sceneName,
  };
}

async function getSceneItem(sceneName, sourceName) {
  const { sceneItems } = await callOBS("GetSceneItemList", { sceneName });
  const item = sceneItems.find((i) => i.sourceName === sourceName);

  if (!item) {
    const available = sceneItems.map((i) => i.sourceName).join(", ");
    throw new Error(
      `Source "${sourceName}" not found in "${sceneName}". Available: ${available}`
    );
  }

  return item;
}

async function setSourceVisible(sceneName, sourceName, visible) {
  const item = await getSceneItem(sceneName, sourceName);

  await callOBS("SetSceneItemEnabled", {
    sceneName,
    sceneItemId: item.sceneItemId,
    sceneItemEnabled: visible,
  });

  console.log(`${visible ? "👁️ Shown" : "🙈 Hidden"}: ${sourceName} in ${sceneName}`);

  return {
    ok: true,
    sceneName,
    sourceName,
    visible,
  };
}

async function toggleSourceVisible(sceneName, sourceName) {
  const item = await getSceneItem(sceneName, sourceName);
  const next = !item.sceneItemEnabled;

  await callOBS("SetSceneItemEnabled", {
    sceneName,
    sceneItemId: item.sceneItemId,
    sceneItemEnabled: next,
  });

  console.log(`🔁 Toggled ${sourceName} in ${sceneName}: ${next}`);

  return {
    ok: true,
    sceneName,
    sourceName,
    visible: next,
  };
}

async function safeStudioTransition() {
  try {
    const { studioModeEnabled } = await callOBS("GetStudioModeEnabled");

    if (studioModeEnabled) {
      await callOBS("TriggerStudioModeTransition");
      console.log("🎚️ Studio transition triggered");
      return true;
    }

    return false;
  } catch (err) {
    console.log("Studio transition skipped:", err.message);
    return false;
  }
}

// Convenience scene switches
const goElevator = () => switchScene(SCENES.elevator);
const goOpening = () => switchScene(SCENES.opening);
const goControl = () => switchScene(SCENES.control);
const goPortal = () => switchScene(SCENES.portal);
const goMinecraft = () => switchScene(SCENES.minecraft);
const goMirror = () => switchScene(SCENES.mirror);
const goTron = () => switchScene(SCENES.tron);
const goAsteroid = () => switchScene(SCENES.asteroid);
const goPortalVideo = () => switchScene(SCENES.portalVideo);

// Mirror Wall helpers
async function showMirrorWallControl() {
  const result = await setSourceVisible(SCENES.mirror, "Mirror Wall Control", true);
  await safeStudioTransition();
  return result;
}

async function hideMirrorWallControl() {
  const result = await setSourceVisible(SCENES.mirror, "Mirror Wall Control", false);
  await safeStudioTransition();
  return result;
}

async function showMirrorPanels() {
  await setSourceVisible(SCENES.mirror, "Mirror 1st", true);
  await setSourceVisible(SCENES.mirror, "Mirror 2L", true);
  await setSourceVisible(SCENES.mirror, "Mirror 3rd", true);
  await safeStudioTransition();

  return {
    ok: true,
    sceneName: SCENES.mirror,
    action: "showMirrorPanels",
  };
}

async function hideMirrorPanels() {
  await setSourceVisible(SCENES.mirror, "Mirror 1st", false);
  await setSourceVisible(SCENES.mirror, "Mirror 2L", false);
  await setSourceVisible(SCENES.mirror, "Mirror 3rd", false);
  await safeStudioTransition();

  return {
    ok: true,
    sceneName: SCENES.mirror,
    action: "hideMirrorPanels",
  };
}

// Minecraft helpers
async function showMinecraftChecklist() {
  const result = await setSourceVisible(SCENES.minecraft, "2 - p1 chceklist", true);
  await safeStudioTransition();
  return result;
}

async function hideMinecraftChecklist() {
  const result = await setSourceVisible(SCENES.minecraft, "2 - p1 chceklist", false);
  await safeStudioTransition();
  return result;
}

// Control Room helpers
async function setControlOverlay(name, visible) {
  const result = await setSourceVisible(SCENES.control, name, visible);
  await safeStudioTransition();
  return result;
}

async function resetControlRoom() {
  await setSourceVisible(SCENES.control, "Cipher", true);
  await setSourceVisible(SCENES.control, "Portal Mask", true);
  await setSourceVisible(SCENES.control, "1 - 3rd panel", true);
  await setSourceVisible(SCENES.control, "1 - control panel mid", true);
  await setSourceVisible(SCENES.control, "text block", true);
  await setSourceVisible(SCENES.control, "Yellow Scanner", true);
  await safeStudioTransition();

  return {
    ok: true,
    sceneName: SCENES.control,
    action: "resetControlRoom",
  };
}

// Keep audio untouched.
// This avoids your earlier issue where hiding a media/video source kills its attached audio.
async function hideVisualOnly(sceneName, sourceName) {
  const result = await setSourceVisible(sceneName, sourceName, false);
  await safeStudioTransition();
  return result;
}

async function showVisualOnly(sceneName, sourceName) {
  const result = await setSourceVisible(sceneName, sourceName, true);
  await safeStudioTransition();
  return result;
}

module.exports = {
  obs,
  connectOBS,
  callOBS,

  SCENES,

  switchScene,
  setSourceVisible,
  toggleSourceVisible,
  safeStudioTransition,

  goElevator,
  goOpening,
  goControl,
  goPortal,
  goMinecraft,
  goMirror,
  goTron,
  goAsteroid,
  goPortalVideo,

  showMirrorWallControl,
  hideMirrorWallControl,
  showMirrorPanels,
  hideMirrorPanels,

  showMinecraftChecklist,
  hideMinecraftChecklist,

  setControlOverlay,
  resetControlRoom,

  hideVisualOnly,
  showVisualOnly,
};