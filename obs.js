require("dotenv").config();
const OBSWebSocket = require("obs-websocket-js").default;

const obs = new OBSWebSocket();

let connected = false;
const OBS_IP = process.env.OBS_IP;
const OBS_PORT = parseInt(process.env.OBS_PORT , 10);
const OBS_PASSWORD = process.env.OBS_PASSWORD;


async function connectOBS() {
  if (connected) return;

  try {
    await obs.connect(
      "ws://127.0.0.1:4455",   // OBS machine IP
      process.env.OBS_PASSWORD || "6cfFyyzyp8R6m5f7"
    );
    connected = true;
    console.log("✅ Connected to OBS");
  } catch (e) {
    console.error("❌ OBS connection failed:", e.message);
  }
}

async function hideSoleilInScene3() {
  await connectOBS();
  
  // 1️⃣ Get scene item ID for "SOLEIL" in "Scene 3"
  const { sceneItems } = await obs.call("GetSceneItemList", {
    sceneName: "Scene 2",
  });

  const soleil = sceneItems.find(i => i.sourceName === "SOLEIL");
  if (!soleil) throw new Error("SOLEIL source not found");

  // 2️⃣ Toggle visibility OFF
  await obs.call("SetSceneItemEnabled", {
    sceneName: "Scene 2",
    sceneItemId: soleil.sceneItemId,
    sceneItemEnabled: !soleil.sceneItemEnabled,
  });
  sceneName = soleil.sceneItemEnabled == true ? "Scene 2" : "Scene";

  // 🔥 PUSH Preview → Program
  await obs.call("TriggerStudioModeTransition");
  
  console.log("🎬 SOLEIL hidden in Scene 2");
  await obs.call("SetCurrentProgramScene", { sceneName });
  return true;
}

module.exports = {
  hideSoleilInScene3,
};