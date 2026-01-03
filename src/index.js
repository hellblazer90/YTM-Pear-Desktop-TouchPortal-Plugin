const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const TouchPortalClient = require("./touchportalClient");
const { PearApi } = require("./pearApi");

const PLUGIN_ID = "com.hellblazer90.pear.ytm";
const CONNECTOR_PREFIX = "pc";
const RECONNECT_INTERVAL_MS = 5000;
const ACTION_DEBOUNCE_MS = 250;
const EXTRA_POLL_INTERVAL_MS = 5000;
const VOLUME_SLIDER_DEBOUNCE_MS = 120;
const VOLUME_LOCAL_HOLD_MS = 600;
const VOLUME_LOCAL_TOLERANCE = 2;
const COVER_ART_FILENAME = "pear_cover_art.jpg";
const COVER_ART_ALT_FILENAME = "pear_cover_art_alt.jpg";
const COVER_ART_TIMEOUT_MS = 8000;
const COVER_ART_BASE64_MIN_INTERVAL_MS = 1500;
const COVER_ART_DEFAULT_MAX_BASE64_LENGTH = 0;
const COVER_ART_MODES = {
  off: "off",
  memory: "memory",
  local: "local"
};
const VOLUME_SCALES = {
  percent: "percent"
};
const SETTINGS = {
  hostname: "pear.hostname",
  port: "pear.port",
  clientId: "pear.clientId",
  pollIntervalMs: "pear.pollIntervalMs",
  extendedStatesEnabled: "pear.extendedStatesEnabled",
  coverArtMode: "pear.coverArtMode"
};

const SETTINGS_LABELS = {
  hostname: "Pear API Hostname (Advanced, usually 127.0.0.1)",
  port: "Pear API Port (from Pear Desktop)",
  clientId: "Auth Client ID (Pear API server)",
  pollIntervalMs: "Poll Interval (ms) (Advanced, song refresh)",
  extendedStatesEnabled: "Extended States Enabled (True/False, volume/like/repeat/etc)",
  coverArtMode: "Cover Art Mode (Off/Memory/Local, icon source)"
};

const STATES = {
  title: "pear.title",
  artist: "pear.artist",
  album: "pear.album",
  coverUrl: "pear.coverUrl",
  coverPath: "pear.coverPath",
  coverFileUrl: "pear.coverFileUrl",
  coverBase64: "pear.coverBase64",
  coverDebug: "pear.coverDebug",
  coverBase64SendCount: "pear.coverBase64SendCount",
  hasSong: "pear.hasSong",
  isPaused: "pear.isPaused",
  isPlaying: "pear.isPlaying",
  durationSec: "pear.durationSec",
  durationText: "pear.durationText",
  elapsedSec: "pear.elapsedSec",
  elapsedText: "pear.elapsedText",
  volumePercent: "pear.volumePercent",
  volumeRaw: "pear.volumeRaw",
  volumeScale: "pear.volumeScale",
  volumeResponse: "pear.volumeResponse",
  isMuted: "pear.isMuted",
  likeState: "pear.likeState",
  repeatMode: "pear.repeatMode",
  shuffleState: "pear.shuffleState",
  url: "pear.url",
  videoId: "pear.videoId",
  playlistId: "pear.playlistId",
  mediaType: "pear.mediaType",
  connectionStatus: "pear.connectionStatus"
};

const EVENTS = {
  isPaused: "pear.event.isPaused",
  likeState: "pear.event.likeState",
  repeatMode: "pear.event.repeatMode",
  shuffleState: "pear.event.shuffleState"
};

const CONNECTORS = {
  volume: "com.hellblazer90.pear.ytm.connector.volume"
};

const defaults = {
  hostname: "127.0.0.1",
  port: 9863,
  clientId: "touchportal",
  pollIntervalMs: 500,
  extendedStatesEnabled: true,
  coverArtMode: COVER_ART_MODES.memory,
  coverArtMaxBase64Length: COVER_ART_DEFAULT_MAX_BASE64_LENGTH
};

const pearApi = new PearApi(defaults);
let currentConfig = Object.assign({}, defaults);

let pollTimer = null;
let extraPollTimer = null;
let reconnectTimer = null;
let pollInFlight = false;
let extraPollInFlight = false;
let connecting = false;
let connectionStatus = "";
let isConnected = false;
let lastExtraPollAt = 0;
let lastSongSignature = "";
const lastStateValues = new Map();
const lastActionTimes = new Map();
const lastEventValues = new Map();
let lastVolumePercent = null;
let lastVolumeSetAt = 0;
let pendingVolumeTarget = null;
let volumeStateScale = 1;
let lastMuted = null;
let volumeScale = VOLUME_SCALES.percent;
let lastConnectorVolumeSent = null;
let extendedStatesEnabled = defaults.extendedStatesEnabled;
let coverArtUrl = "";
let coverArtReadyUrl = "";
let coverArtReadyPath = "";
let coverArtSlot = 0;
let lastCoverUrl = "";
let pendingCoverUrl = "";
let coverArtInFlight = false;
let lastCoverDebug = "";
let lastCoverBase64 = "";
let coverArtMode = defaults.coverArtMode;
let coverArtMaxBase64Length = defaults.coverArtMaxBase64Length;
let lastCoverBase64SentAt = 0;
let pendingCoverBase64 = "";
let pendingCoverBase64Timer = null;
let coverBase64SendCount = 0;
let pendingVolume = null;
let volumeTimer = null;
let volumeInFlight = false;
let volumeRefreshTimer = null;

const LOG_PREFIX = "Pear Desktop YTM";

const tpClient = new TouchPortalClient({
  pluginId: PLUGIN_ID,
  autoReconnect: true
});

function log(message) {
  console.log(`[${LOG_PREFIX}] ${message}`);
}

function parseNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function parseBooleanSetting(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseCoverArtMode(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["off", "disable", "disabled", "false", "0", "no", "n"].includes(normalized)) {
    return COVER_ART_MODES.off;
  }
  if (["memory", "mem", "ram", "base64", "b64", "inline"].includes(normalized)) {
    return COVER_ART_MODES.memory;
  }
  if (["local", "file", "disk", "true", "1", "yes", "y", "on", "download"].includes(normalized)) {
    return COVER_ART_MODES.local;
  }
  return fallback;
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return value;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeChoice(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStateValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  return String(value);
}

function toFileUrl(filePath) {
  if (!filePath) {
    return "";
  }
  try {
    return pathToFileURL(filePath).href;
  } catch {
    return "";
  }
}

function getCoverArtPath(slot = 0) {
  const filename = slot === 1 ? COVER_ART_ALT_FILENAME : COVER_ART_FILENAME;
  return path.join(__dirname, "..", filename);
}

function describeCoverFile(filePath) {
  if (!filePath) {
    return "";
  }
  const name = path.basename(filePath);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return `${name} (not a file)`;
    }
    return `${name} (${stat.size} bytes)`;
  } catch {
    return `${name} (missing)`;
  }
}

function buildCoverBase64(filePath) {
  if (!filePath) {
    return "";
  }
  try {
    const buffer = fs.readFileSync(filePath);
    if (!buffer || buffer.length === 0) {
      return "";
    }
    return buffer.toString("base64");
  } catch {
    return "";
  }
}

function truncateCoverUrl(url) {
  if (!url) {
    return "";
  }
  const text = String(url);
  if (text.length <= 120) {
    return text;
  }
  return `${text.slice(0, 117)}...`;
}

function setCoverDebug(message) {
  const textValue = message ? String(message) : "";
  if (textValue === lastCoverDebug) {
    return;
  }
  lastCoverDebug = textValue;
  updateState(STATES.coverDebug, textValue);
}

function clearPendingCoverBase64() {
  if (pendingCoverBase64Timer) {
    clearTimeout(pendingCoverBase64Timer);
    pendingCoverBase64Timer = null;
  }
  pendingCoverBase64 = "";
}

function incrementCoverBase64SendCount() {
  coverBase64SendCount += 1;
  updateState(STATES.coverBase64SendCount, String(coverBase64SendCount));
}

function updateCoverBase64State(value) {
  const textValue = value || "";
  if (coverArtMaxBase64Length > 0 && textValue.length > coverArtMaxBase64Length) {
    clearPendingCoverBase64();
    lastCoverBase64 = "";
    updateState(STATES.coverBase64, "");
    lastCoverBase64SentAt = 0;
    setCoverDebug(`base64 too large (${textValue.length} > ${coverArtMaxBase64Length})`);
    return false;
  }
  if (textValue === lastCoverBase64 && !pendingCoverBase64Timer) {
    return true;
  }
  lastCoverBase64 = textValue;

  if (!textValue) {
    clearPendingCoverBase64();
    updateState(STATES.coverBase64, "");
    lastCoverBase64SentAt = 0;
    return true;
  }

  const now = Date.now();
  const elapsed = now - lastCoverBase64SentAt;
  if (elapsed >= COVER_ART_BASE64_MIN_INTERVAL_MS && !pendingCoverBase64Timer) {
    updateState(STATES.coverBase64, textValue);
    incrementCoverBase64SendCount();
    lastCoverBase64SentAt = now;
    return true;
  }

  pendingCoverBase64 = textValue;
  if (!pendingCoverBase64Timer) {
    const delay = Math.max(0, COVER_ART_BASE64_MIN_INTERVAL_MS - elapsed);
    pendingCoverBase64Timer = setTimeout(() => {
      pendingCoverBase64Timer = null;
      if (!pendingCoverBase64) {
        return;
      }
      updateState(STATES.coverBase64, pendingCoverBase64);
      incrementCoverBase64SendCount();
      lastCoverBase64SentAt = Date.now();
      pendingCoverBase64 = "";
    }, delay);
  }
  return true;
}

function updateCoverPathState(value) {
  const textValue = value || "";
  updateState(STATES.coverPath, textValue);
  updateState(STATES.coverFileUrl, toFileUrl(textValue));
}

function normalizeVolumePercent(rawValue) {
  return Math.round(clampNumber(rawValue, 0, 100));
}

function applyVolumeStateScale(rawValue) {
  if (!Number.isFinite(rawValue)) {
    return null;
  }
  const scale = Number.isFinite(volumeStateScale) && volumeStateScale > 0
    ? volumeStateScale
    : 1;
  return Math.round(clampNumber(rawValue * scale, 0, 100));
}

function formatVolumeScaleLabel(scaleValue, source) {
  const base = scaleValue || VOLUME_SCALES.percent;
  return source ? `${base} via ${source}` : base;
}

function updateVolumeDebugStates(rawValue, source) {
  if (!extendedStatesEnabled) {
    return;
  }
  const displayRaw = source === "state"
    ? applyVolumeStateScale(rawValue)
    : rawValue;
  if (Number.isFinite(displayRaw)) {
    updateState(STATES.volumeRaw, displayRaw);
  }
  updateState(STATES.volumeScale, formatVolumeScaleLabel(volumeScale, source));
}

function shouldIgnoreVolumeUpdate(apiPercent) {
  if (!Number.isFinite(apiPercent)) {
    return false;
  }
  if (!Number.isFinite(pendingVolumeTarget)) {
    return false;
  }
  const age = Date.now() - lastVolumeSetAt;
  if (age > VOLUME_LOCAL_HOLD_MS) {
    pendingVolumeTarget = null;
    return false;
  }
  if (Math.abs(apiPercent - pendingVolumeTarget) <= VOLUME_LOCAL_TOLERANCE) {
    pendingVolumeTarget = null;
    return false;
  }
  return true;
}

function setVolumePercentLocal(value, source = "local") {
  if (!Number.isFinite(value)) {
    return;
  }

  const rounded = clampNumber(Math.round(value), 0, 100);
  lastVolumePercent = rounded;
  lastVolumeSetAt = Date.now();
  pendingVolumeTarget = rounded;
  volumeScale = VOLUME_SCALES.percent;

  if (!extendedStatesEnabled) {
    return;
  }

  updateState(STATES.volumePercent, rounded);
  updateVolumeConnector(rounded);
  updateVolumeDebugStates(rounded, source);
}

function updateVolumeResponseState(data) {
  if (!extendedStatesEnabled) {
    return;
  }
  if (!data || typeof data !== "object") {
    return;
  }
  let responseData = data;
  const rawState = Number(data.state);
  if (Number.isFinite(rawState)) {
    const scaledState = applyVolumeStateScale(rawState);
    if (Number.isFinite(scaledState)) {
      responseData = Object.assign({}, data, { state: scaledState });
    }
  }
  let text = "";
  try {
    text = JSON.stringify(responseData);
  } catch {
    text = String(responseData);
  }
  if (text.length > 600) {
    text = `${text.slice(0, 597)}...`;
  }
  updateState(STATES.volumeResponse, text);
}

async function ensureVolumeScale() {
  volumeScale = VOLUME_SCALES.percent;
}

function buildVolumePayload(percent) {
  return clampNumber(Math.round(percent), 0, 100);
}

function resolveVolumeData(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const percentKeys = ["percent", "percentage", "volumePercent"];
  for (const key of percentKeys) {
    if (data[key] !== undefined) {
      const raw = Number(data[key]);
      if (Number.isFinite(raw)) {
        return { raw, scale: VOLUME_SCALES.percent, source: key };
      }
    }
  }

  const rawKeys = ["volume", "state", "value"];
  for (const key of rawKeys) {
    if (data[key] !== undefined) {
      const raw = Number(data[key]);
      if (Number.isFinite(raw)) {
        return { raw, scale: VOLUME_SCALES.percent, source: key };
      }
    }
  }

  return null;
}

function scheduleVolumeRefresh() {
  if (volumeRefreshTimer || !extendedStatesEnabled) {
    return;
  }
  volumeRefreshTimer = setTimeout(() => {
    volumeRefreshTimer = null;
    refreshVolumeState();
  }, 300);
}

async function refreshVolumeState() {
  try {
    const data = await pearApi.getVolume();
    if (data) {
      updateVolumeState(data);
    }
  } catch (err) {
    handleConnectionFailure(err);
  }
}
function applyCoverArtMode(mode) {
  pendingCoverUrl = "";
  coverArtUrl = "";
  coverArtReadyUrl = "";
  coverArtReadyPath = "";
  lastCoverUrl = "";
  clearPendingCoverBase64();
  coverBase64SendCount = 0;
  updateCoverPathState("");
  updateCoverBase64State("");
  updateState(STATES.coverBase64SendCount, "");

  if (mode === COVER_ART_MODES.memory) {
    setCoverDebug("cover art mode: memory");
    return;
  }
  if (mode === COVER_ART_MODES.local) {
    setCoverDebug("cover art mode: local");
    return;
  }
  setCoverDebug("cover art mode: off");
}

async function downloadCoverArt(url) {
  if (coverArtMode === COVER_ART_MODES.off) {
    setCoverDebug("cover art mode: off");
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COVER_ART_TIMEOUT_MS);

  try {
    setCoverDebug(`downloading: ${truncateCoverUrl(url)}`);
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const mode = coverArtMode;
    if (mode === COVER_ART_MODES.off) {
      setCoverDebug("cover art mode: off");
      return;
    }
    if (pendingCoverUrl && pendingCoverUrl !== url) {
      setCoverDebug("download superseded");
      return;
    }

    const base64Length = buffer && buffer.length ? Math.ceil(buffer.length / 3) * 4 : 0;
    const contentType = res.headers.get("content-type") || "";
    const typeInfo = contentType ? ` type=${contentType}` : "";
    const base64Info = base64Length ? ` base64=${base64Length}` : " base64=0";
    const base64TooLarge =
      coverArtMaxBase64Length > 0 && base64Length > coverArtMaxBase64Length;

    if (mode === COVER_ART_MODES.memory) {
      coverArtReadyUrl = url;
      coverArtReadyPath = "";
      updateCoverPathState("");
      if (base64TooLarge) {
        updateCoverBase64State("");
        setCoverDebug(
          `base64 too large (${base64Length} > ${coverArtMaxBase64Length})${typeInfo}`
        );
        return;
      }
      const base64Value = buffer && buffer.length ? buffer.toString("base64") : "";
      updateCoverBase64State(base64Value);
      setCoverDebug(`ready: memory${typeInfo}${base64Info}`);
      return;
    }

    const outputPath = getCoverArtPath(coverArtSlot);
    fs.writeFileSync(outputPath, buffer);
    coverArtReadyUrl = url;
    coverArtReadyPath = outputPath;
    coverArtSlot = coverArtSlot === 0 ? 1 : 0;
    updateCoverPathState(outputPath);
    if (base64TooLarge) {
      updateCoverBase64State("");
      setCoverDebug(
        `ready: ${describeCoverFile(outputPath)}${typeInfo} base64 too large (${base64Length} > ${coverArtMaxBase64Length})`
      );
      return;
    }
    const base64Value = buffer && buffer.length ? buffer.toString("base64") : "";
    updateCoverBase64State(base64Value);
    setCoverDebug(`ready: ${describeCoverFile(outputPath)}${typeInfo}${base64Info}`);
  } catch (err) {
    log(`Cover art download failed: ${err.message}`);
    coverArtReadyUrl = "";
    coverArtReadyPath = "";
    updateCoverPathState("");
    updateCoverBase64State("");
    setCoverDebug(`download failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function flushCoverArtQueue() {
  if (coverArtInFlight) {
    return;
  }

  if (!pendingCoverUrl) {
    return;
  }

  const nextUrl = pendingCoverUrl;
  pendingCoverUrl = "";
  coverArtInFlight = true;
  coverArtUrl = nextUrl;

  await downloadCoverArt(nextUrl);

  coverArtInFlight = false;
  if (pendingCoverUrl && pendingCoverUrl !== coverArtUrl) {
    flushCoverArtQueue();
  }
}

function queueCoverArt(url) {
  if (coverArtMode === COVER_ART_MODES.off) {
    return;
  }
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
    coverArtUrl = "";
    coverArtReadyUrl = "";
    coverArtReadyPath = "";
    pendingCoverUrl = "";
    updateCoverPathState("");
    updateCoverBase64State("");
    setCoverDebug(trimmed ? "cover url invalid" : "cover url empty");
    return;
  }

  if (trimmed === coverArtReadyUrl) {
    if (
      coverArtMode === COVER_ART_MODES.local &&
      coverArtReadyPath &&
      fs.existsSync(coverArtReadyPath)
    ) {
      updateCoverPathState(coverArtReadyPath);
      const accepted = updateCoverBase64State(buildCoverBase64(coverArtReadyPath));
      if (accepted) {
        setCoverDebug(`ready: ${describeCoverFile(coverArtReadyPath)}`);
      }
      return;
    }
    if (coverArtMode === COVER_ART_MODES.memory && lastCoverBase64) {
      updateCoverPathState("");
      const accepted = updateCoverBase64State(lastCoverBase64);
      if (accepted) {
        setCoverDebug(`ready: memory base64=${lastCoverBase64.length}`);
      }
      return;
    }
  }

  if (trimmed !== coverArtReadyUrl) {
    coverArtReadyUrl = "";
    coverArtReadyPath = "";
    updateCoverPathState("");
    updateCoverBase64State("");
  }

  pendingCoverUrl = trimmed;
  flushCoverArtQueue();
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) {
    return "";
  }

  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function shouldDebounce(actionId) {
  if (!actionId) {
    return false;
  }

  const now = Date.now();
  const last = lastActionTimes.get(actionId);
  if (last && now - last < ACTION_DEBOUNCE_MS) {
    return true;
  }

  lastActionTimes.set(actionId, now);
  return false;
}

function arrayToSettings(entries) {
  const settings = {};

  if (!Array.isArray(entries)) {
    return settings;
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    let id = entry.id || entry.key || entry.name;
    let value = entry.value !== undefined ? entry.value : entry.default;

    if (!id) {
      const keys = Object.keys(entry);
      if (keys.length === 1) {
        id = keys[0];
        value = entry[id];
      }
    }

    if (id) {
      settings[id] = value;
    }
  }

  return settings;
}

function extractSettings(data) {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (data.values && typeof data.values === "object" && !Array.isArray(data.values)) {
      return data.values;
    }
    if (data.settings && typeof data.settings === "object" && !Array.isArray(data.settings)) {
      return data.settings;
    }
    const keys = Object.keys(data);
    if (
      keys.some((key) => Object.values(SETTINGS).includes(key)) ||
      keys.some((key) => Object.values(SETTINGS_LABELS).includes(key))
    ) {
      return data;
    }
  }

  if (Array.isArray(data)) {
    return arrayToSettings(data);
  }

  if (data && Array.isArray(data.settings)) {
    return arrayToSettings(data.settings);
  }

  if (data && data.payload && Array.isArray(data.payload.settings)) {
    return arrayToSettings(data.payload.settings);
  }

  if (data && Array.isArray(data.values)) {
    return arrayToSettings(data.values);
  }

  return {};
}

function extractActionData(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  if (Array.isArray(payload.data)) {
    return arrayToSettings(payload.data);
  }

  if (payload.data && typeof payload.data === "object") {
    return payload.data;
  }

  if (Array.isArray(payload.values)) {
    return arrayToSettings(payload.values);
  }

  if (payload.values && typeof payload.values === "object") {
    return payload.values;
  }

  return {};
}

function getActionValue(values, idKey, nameKey) {
  if (!values || typeof values !== "object") {
    return undefined;
  }

  if (values[idKey] !== undefined) {
    return values[idKey];
  }
  if (values[nameKey] !== undefined) {
    return values[nameKey];
  }
  const keys = Object.keys(values);
  for (const key of keys) {
    if (key.endsWith(`.${idKey}`) || key.endsWith(`.${nameKey}`)) {
      return values[key];
    }
  }
  return undefined;
}

function getSetting(settings, idKey, nameKey) {
  if (settings[idKey] !== undefined) {
    return settings[idKey];
  }
  if (settings[nameKey] !== undefined) {
    return settings[nameKey];
  }
  return undefined;
}

function applySettings(settings) {
  const hostnameRaw = getSetting(settings, SETTINGS.hostname, SETTINGS_LABELS.hostname);
  const clientRaw = getSetting(settings, SETTINGS.clientId, SETTINGS_LABELS.clientId);
  const portRaw = getSetting(settings, SETTINGS.port, SETTINGS_LABELS.port);
  const pollRaw = getSetting(settings, SETTINGS.pollIntervalMs, SETTINGS_LABELS.pollIntervalMs);
  const extendedRaw = getSetting(
    settings,
    SETTINGS.extendedStatesEnabled,
    SETTINGS_LABELS.extendedStatesEnabled
  );
  const coverModeRaw = getSetting(
    settings,
    SETTINGS.coverArtMode,
    SETTINGS_LABELS.coverArtMode
  );

  const hostnameValue = typeof hostnameRaw === "string" ? hostnameRaw.trim() : "";
  const clientValue = typeof clientRaw === "string" ? clientRaw.trim() : "";

  const nextConfig = {
    hostname: hostnameValue || currentConfig.hostname,
    port: parseNumber(portRaw, currentConfig.port),
    clientId: clientValue || currentConfig.clientId,
    pollIntervalMs: parseNumber(pollRaw, currentConfig.pollIntervalMs)
  };

  const nextExtendedStatesEnabled = parseBooleanSetting(
    extendedRaw,
    extendedStatesEnabled
  );
  if (nextExtendedStatesEnabled !== extendedStatesEnabled) {
    extendedStatesEnabled = nextExtendedStatesEnabled;
    if (!extendedStatesEnabled) {
      lastVolumePercent = null;
      volumeScale = VOLUME_SCALES.percent;
      lastConnectorVolumeSent = null;
      clearExtendedStates();
    }
    stopExtraPolling();
    startExtraPolling();
  }

  const nextCoverArtMode = parseCoverArtMode(coverModeRaw, coverArtMode);
  if (nextCoverArtMode !== coverArtMode) {
    coverArtMode = nextCoverArtMode;
    applyCoverArtMode(coverArtMode);
    if (coverArtMode !== COVER_ART_MODES.off && lastCoverUrl) {
      queueCoverArt(lastCoverUrl);
    }
  }

  const changed =
    nextConfig.hostname !== currentConfig.hostname ||
    Number(nextConfig.port) !== Number(currentConfig.port) ||
    nextConfig.clientId !== currentConfig.clientId ||
    Number(nextConfig.pollIntervalMs) !== Number(currentConfig.pollIntervalMs);

  if (!changed) {
    return;
  }

  currentConfig = Object.assign({}, currentConfig, nextConfig);
  pearApi.updateConfig(currentConfig);
  pearApi.token = null;
  lastSongSignature = "";
  lastExtraPollAt = 0;

  log(`Config updated: ${pearApi.baseUrl} (clientId=${pearApi.clientId}, poll=${currentConfig.pollIntervalMs}ms)`);

  stopPolling();
  stopReconnectLoop();
  setConnectionStatus("Disconnected");
  checkConnection();
}

function updateState(id, value) {
  const textValue = normalizeStateValue(value);
  if (lastStateValues.get(id) === textValue) {
    return;
  }
  lastStateValues.set(id, textValue);

  if (typeof tpClient.stateUpdate === "function") {
    tpClient.stateUpdate(id, textValue);
    return;
  }

  if (typeof tpClient.setState === "function") {
    tpClient.setState(id, textValue);
    return;
  }

  if (typeof tpClient.send === "function") {
    tpClient.send({ type: "stateUpdate", id, value: textValue });
  }
}

function buildConnectorId(connectorId) {
  if (!connectorId) {
    return "";
  }
  return `${CONNECTOR_PREFIX}_${PLUGIN_ID}_${connectorId}`;
}

function updateVolumeConnector(value) {
  if (!Number.isFinite(value)) {
    return;
  }
  if (!extendedStatesEnabled) {
    return;
  }
  const rounded = clampNumber(Math.round(value), 0, 100);
  if (lastConnectorVolumeSent === rounded) {
    return;
  }
  lastConnectorVolumeSent = rounded;

  if (typeof tpClient.connectorUpdate === "function") {
    tpClient.connectorUpdate(CONNECTORS.volume, rounded);
    return;
  }

  if (typeof tpClient.send === "function") {
    tpClient.send({
      type: "connectorUpdate",
      connectorId: buildConnectorId(CONNECTORS.volume),
      value: rounded
    });
  }
}

function scheduleVolumeSend(value) {
  if (!Number.isFinite(value)) {
    return;
  }

  const safe = clampNumber(Math.round(value), 0, 100);
  pendingVolume = safe;

  if (volumeTimer || volumeInFlight) {
    return;
  }

  volumeTimer = setTimeout(() => {
    flushVolumeSend();
  }, VOLUME_SLIDER_DEBOUNCE_MS);
}

async function flushVolumeSend() {
  if (volumeInFlight) {
    return;
  }

  if (!Number.isFinite(pendingVolume)) {
    pendingVolume = null;
    return;
  }

  const target = pendingVolume;
  pendingVolume = null;
  volumeTimer = null;
  volumeInFlight = true;
  try {
    await ensureVolumeScale();
    await pearApi.setVolume(buildVolumePayload(target));
    setVolumePercentLocal(target, "slider");
    scheduleVolumeRefresh();
  } catch (err) {
    handleConnectionFailure(err);
  } finally {
    volumeInFlight = false;
    if (Number.isFinite(pendingVolume)) {
      volumeTimer = setTimeout(() => {
        flushVolumeSend();
      }, VOLUME_SLIDER_DEBOUNCE_MS);
    }
  }
}

function triggerEvent(id, value) {
  const textValue = normalizeStateValue(value);

  if (typeof tpClient.triggerEvent === "function") {
    tpClient.triggerEvent(id, textValue);
    return;
  }

  if (typeof tpClient.send === "function") {
    tpClient.send({ type: "triggerEvent", id, value: textValue });
  }
}

function updateEvent(eventId, value) {
  if (!eventId) {
    return;
  }

  const textValue = normalizeStateValue(value);
  if (textValue === "") {
    return;
  }

  const lastValue = lastEventValues.get(eventId);
  if (lastValue === textValue) {
    return;
  }

  lastEventValues.set(eventId, textValue);
  triggerEvent(eventId, textValue);
}

function setConnectionStatus(status) {
  const textValue = status || "";
  if (textValue === connectionStatus) {
    return false;
  }

  connectionStatus = textValue;
  isConnected = textValue === "Connected";
  updateState(STATES.connectionStatus, textValue);
  return true;
}

function isConnectionError(err) {
  if (!err) {
    return false;
  }

  const code = err.code || err.errno;
  const causeCode = err.cause && (err.cause.code || err.cause.errno);
  if (code && ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "ETIMEDOUT"].includes(code)) {
    return true;
  }
  if (causeCode && ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "ETIMEDOUT"].includes(causeCode)) {
    return true;
  }

  const message = String(err.message || "").toLowerCase();
  return message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("timed out") ||
    message.includes("failed to fetch") ||
    message.includes("fetch failed");
}

function formatConnectionStatus(err) {
  if (!err) {
    return "Connected";
  }

  if (err.userMessage) {
    return err.userMessage;
  }

  if (isConnectionError(err)) {
    return "Disconnected";
  }

  if (err.kind === "auth") {
    return `Auth failed: ${err.message}`;
  }

  return `Error: ${err.message}`;
}

function handleConnectionFailure(err) {
  const status = formatConnectionStatus(err);
  const changed = setConnectionStatus(status);

  if (changed) {
    log(`Connection status: ${status}`);
  }

  stopPolling();
  stopExtraPolling();
  startReconnectLoop();
}

function updateSongStates(song) {
  if (!song || typeof song !== "object") {
    return;
  }

  const title = song.title || song.songTitle || song.track || "";
  let artist = song.artist || song.artistName || "";

  if (Array.isArray(artist)) {
    artist = artist.join(", ");
  } else if (!artist && Array.isArray(song.artists)) {
    artist = song.artists.map((item) => item && item.name).filter(Boolean).join(", ");
  }

  const album = song.album || "";
  const coverUrl = song.imageSrc || song.cover || "";
  const rawVideoId = song.videoId || "";
  const rawPlaylistId = song.playlistId || "";
  const rawUrl = song.url || "";
  const rawMediaType = song.mediaType || "";
  const sendExtended = extendedStatesEnabled;
  const url = sendExtended ? rawUrl : "";
  const videoId = sendExtended ? rawVideoId : "";
  const playlistId = sendExtended ? rawPlaylistId : "";
  const mediaType = sendExtended ? rawMediaType : "";

  const durationSec = Number.isFinite(song.songDuration) ? song.songDuration : null;
  const elapsedSec = Number.isFinite(song.elapsedSeconds) ? song.elapsedSeconds : null;

  const isPaused = typeof song.isPaused === "boolean"
    ? song.isPaused
    : typeof song.paused === "boolean"
      ? song.paused
      : null;

  const isPlaying = isPaused === null
    ? (typeof song.isPlaying === "boolean" ? song.isPlaying : null)
    : !isPaused;

  const hasSong = Boolean(title || rawVideoId);

  updateState(STATES.title, title);
  updateState(STATES.artist, artist);
  updateState(STATES.album, album);
  updateState(STATES.coverUrl, coverUrl);
  lastCoverUrl = coverUrl;
  if (coverArtMode !== COVER_ART_MODES.off) {
    queueCoverArt(coverUrl);
  }
  updateState(STATES.url, url);
  updateState(STATES.videoId, videoId);
  updateState(STATES.playlistId, playlistId);
  updateState(STATES.mediaType, mediaType);
  updateState(STATES.hasSong, hasSong);

  if (isPaused !== null) {
    updateState(STATES.isPaused, isPaused);
    updateEvent(EVENTS.isPaused, isPaused);
  }

  if (isPlaying !== null) {
    updateState(STATES.isPlaying, isPlaying);
  }

  if (durationSec !== null) {
    updateState(STATES.durationSec, Math.round(durationSec));
    updateState(STATES.durationText, formatTime(durationSec));
  }

  if (elapsedSec !== null) {
    updateState(STATES.elapsedSec, Math.round(elapsedSec));
    updateState(STATES.elapsedText, formatTime(elapsedSec));
  }

  const signature = [rawVideoId, title, artist, album, durationSec || ""].join("|");
  const changed = signature !== lastSongSignature;
  lastSongSignature = signature;
  return changed;
}

function updateLikeState(data) {
  if (!extendedStatesEnabled) {
    return;
  }
  if (!data || typeof data !== "object") {
    return;
  }

  const state = data.state || "";
  if (state) {
    updateState(STATES.likeState, state);
    updateEvent(EVENTS.likeState, state);
  }
}

function updateRepeatMode(data) {
  if (!extendedStatesEnabled) {
    return;
  }
  if (!data || typeof data !== "object") {
    return;
  }

  const mode = data.mode || "";
  if (mode) {
    updateState(STATES.repeatMode, mode);
    updateEvent(EVENTS.repeatMode, mode);
  }
}

function updateShuffleState(data) {
  if (!extendedStatesEnabled) {
    return;
  }
  if (!data || typeof data !== "object") {
    return;
  }

  if (typeof data.state === "boolean") {
    updateState(STATES.shuffleState, data.state);
    updateEvent(EVENTS.shuffleState, data.state);
  }
}

function updateVolumeState(data) {
  if (!extendedStatesEnabled) {
    return;
  }
  if (!data || typeof data !== "object") {
    return;
  }

  updateVolumeResponseState(data);

  const resolved = resolveVolumeData(data);
  if (resolved) {
    const rawValue = resolved.raw;
    volumeScale = VOLUME_SCALES.percent;
    if (
      resolved.source === "state" &&
      Number.isFinite(pendingVolumeTarget) &&
      rawValue > 0 &&
      Date.now() - lastVolumeSetAt <= VOLUME_LOCAL_HOLD_MS
    ) {
      const nextScale = pendingVolumeTarget / rawValue;
      if (Number.isFinite(nextScale) && nextScale >= 0.2 && nextScale <= 5) {
        volumeStateScale = nextScale;
      }
    }

    const apiPercent = resolved.source === "state"
      ? applyVolumeStateScale(rawValue)
      : normalizeVolumePercent(rawValue);
    const ignoreUpdate = Number.isFinite(apiPercent) && shouldIgnoreVolumeUpdate(apiPercent);

    if (Number.isFinite(apiPercent) && !ignoreUpdate) {
      lastVolumePercent = apiPercent;
      updateState(STATES.volumePercent, apiPercent);
      updateVolumeConnector(apiPercent);
    }
    if (!ignoreUpdate) {
      updateVolumeDebugStates(rawValue, resolved.source);
    }
  }

  if (typeof data.isMuted === "boolean") {
    lastMuted = data.isMuted;
    updateState(STATES.isMuted, data.isMuted);
  }
}

function clearExtendedStates() {
  const ids = [
    STATES.volumePercent,
    STATES.volumeRaw,
    STATES.volumeScale,
    STATES.volumeResponse,
    STATES.isMuted,
    STATES.likeState,
    STATES.repeatMode,
    STATES.shuffleState,
    STATES.url,
    STATES.videoId,
    STATES.playlistId,
    STATES.mediaType
  ];

  for (const id of ids) {
    updateState(id, "");
  }

  lastMuted = null;
  volumeScale = VOLUME_SCALES.percent;
  pendingVolumeTarget = null;
  lastVolumeSetAt = 0;
  volumeStateScale = 1;
}

async function changeVolume(direction, step) {
  let current = Number.isFinite(lastVolumePercent) ? lastVolumePercent : null;
  if (!Number.isFinite(current)) {
    const data = await pearApi.getVolume();
    const resolved = resolveVolumeData(data);
    if (resolved) {
      volumeScale = VOLUME_SCALES.percent;
      const apiPercent = normalizeVolumePercent(resolved.raw);
      if (Number.isFinite(apiPercent)) {
        current = apiPercent;
      }
    }
  }
  if (!Number.isFinite(current)) {
    throw new Error("Volume state unavailable.");
  }

  const delta = direction === "down" ? -step : step;
  const next = clampNumber(current + delta, 0, 100);
  await ensureVolumeScale();
  await pearApi.setVolume(buildVolumePayload(next));
  setVolumePercentLocal(next, "local");
  scheduleVolumeRefresh();
}

async function setMuteState(targetState) {
  let current = typeof lastMuted === "boolean" ? lastMuted : null;
  if (typeof current !== "boolean") {
    const data = await pearApi.getVolume();
    current = data && typeof data.isMuted === "boolean" ? data.isMuted : null;
  }

  if (typeof current !== "boolean") {
    await pearApi.toggleMute();
    return;
  }

  if (current === targetState) {
    return;
  }

  await pearApi.toggleMute();
  lastMuted = targetState;
  if (extendedStatesEnabled) {
    updateState(STATES.isMuted, lastMuted);
  }
}

async function setRepeatMode(targetMode) {
  const modes = ["NONE", "ALL", "ONE"];
  const currentData = await pearApi.getRepeatMode();
  const current = currentData && currentData.mode;
  const target = targetMode || "NONE";

  const currentIndex = modes.indexOf(current);
  const targetIndex = modes.indexOf(target);

  if (currentIndex === -1 || targetIndex === -1) {
    await pearApi.switchRepeat(1);
    return;
  }

  const iterations = (targetIndex - currentIndex + modes.length) % modes.length;
  if (iterations === 0) {
    return;
  }

  await pearApi.switchRepeat(iterations);
}

async function setShuffleState(targetState) {
  const data = await pearApi.getShuffleState();
  const current = data && data.state;

  if (typeof current !== "boolean") {
    await pearApi.shuffle();
    return;
  }

  if (current === targetState) {
    return;
  }

  await pearApi.shuffle();
}

async function pollSong() {
  if (pollInFlight || !currentConfig.pollIntervalMs) {
    return;
  }

  pollInFlight = true;

  try {
    const song = await pearApi.getSong();
    setConnectionStatus("Connected");
    const changed = updateSongStates(song);
    if (extendedStatesEnabled) {
      pollExtras(Boolean(changed));
    }
  } catch (err) {
    handleConnectionFailure(err);
  } finally {
    pollInFlight = false;
  }
}

async function pollExtras(force = false) {
  if (!extendedStatesEnabled || extraPollInFlight) {
    return;
  }
  const now = Date.now();
  if (!force && now - lastExtraPollAt < EXTRA_POLL_INTERVAL_MS) {
    return;
  }

  extraPollInFlight = true;
  lastExtraPollAt = now;

  try {
    const extraResults = await Promise.allSettled([
      pearApi.getLikeState(),
      pearApi.getRepeatMode(),
      pearApi.getShuffleState(),
      pearApi.getVolume()
    ]);

    if (extraResults[0].status === "fulfilled") {
      updateLikeState(extraResults[0].value);
    }
    if (extraResults[1].status === "fulfilled") {
      updateRepeatMode(extraResults[1].value);
    }
    if (extraResults[2].status === "fulfilled") {
      updateShuffleState(extraResults[2].value);
    }
    if (extraResults[3].status === "fulfilled") {
      updateVolumeState(extraResults[3].value);
    }
  } finally {
    extraPollInFlight = false;
  }
}

function startPolling() {
  const interval = parseNumber(currentConfig.pollIntervalMs, defaults.pollIntervalMs);
  if (interval <= 0) {
    return;
  }

  if (pollTimer) {
    clearInterval(pollTimer);
  }

  pollTimer = setInterval(() => {
    pollSong();
  }, interval);

  pollSong();
  startExtraPolling();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  stopExtraPolling();
}

function startExtraPolling() {
  if (extraPollTimer || !extendedStatesEnabled) {
    return;
  }
  extraPollTimer = setInterval(() => {
    pollExtras(false);
  }, EXTRA_POLL_INTERVAL_MS);
  pollExtras(true);
}

function stopExtraPolling() {
  if (extraPollTimer) {
    clearInterval(extraPollTimer);
    extraPollTimer = null;
  }
}

function startReconnectLoop() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setInterval(() => {
    checkConnection();
  }, RECONNECT_INTERVAL_MS);
}

function stopReconnectLoop() {
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
}

async function checkConnection() {
  if (connecting) {
    return;
  }

  connecting = true;

  try {
    const song = await pearApi.getSong();
    setConnectionStatus("Connected");
    updateSongStates(song);
    if (extendedStatesEnabled) {
      pollExtras(true);
    }
    startPolling();
    stopReconnectLoop();
  } catch (err) {
    handleConnectionFailure(err);
  } finally {
    connecting = false;
  }
}

async function handleAction(data) {
  const actionId = data.actionId || data.id;
  const actionData = extractActionData(data);

  if (shouldDebounce(actionId)) {
    return;
  }

  switch (actionId) {
    case "pear.playPauseChoice": {
      const choice = normalizeChoice(getActionValue(actionData, "choice", "Choice"));
      if (choice === "play") {
        await pearApi.play();
      } else if (choice === "pause") {
        await pearApi.pause();
      } else {
        await pearApi.playPause();
      }
      return;
    }
    case "pear.nextPrevChoice": {
      const choice = normalizeChoice(getActionValue(actionData, "direction", "Direction"));
      if (choice === "previous") {
        await pearApi.previous();
      } else {
        await pearApi.next();
      }
      return;
    }
    case "pear.likeDislikeChoice": {
      const choice = normalizeChoice(getActionValue(actionData, "choice", "Choice"));
      if (choice === "dislike") {
        await pearApi.dislike();
      } else {
        await pearApi.like();
      }
      return;
    }
    case "pear.play":
      await pearApi.play();
      return;
    case "pear.pause":
      await pearApi.pause();
      return;
    case "pear.playpause":
      await pearApi.playPause();
      return;
    case "pear.next":
      await pearApi.next();
      return;
    case "pear.prev":
      await pearApi.previous();
      return;
    case "pear.like":
      await pearApi.like();
      return;
    case "pear.dislike":
      await pearApi.dislike();
      return;
    case "pear.volumeStep": {
      const direction = normalizeChoice(getActionValue(actionData, "direction", "Direction"));
      const stepRaw = getActionValue(actionData, "step", "Step");
      const step = parseOptionalNumber(stepRaw) ?? 5;
      await changeVolume(direction === "down" ? "down" : "up", step);
      return;
    }
    case "pear.seekTo": {
      const raw = getActionValue(actionData, "seconds", "Seconds");
      const seconds = parseOptionalNumber(raw);
      if (seconds === null) {
        throw new Error("Seek To requires seconds.");
      }
      await pearApi.seekTo(seconds);
      return;
    }
    case "pear.goBack": {
      const raw = getActionValue(actionData, "seconds", "Seconds");
      const seconds = parseOptionalNumber(raw);
      await pearApi.goBack(seconds === null ? 10 : seconds);
      return;
    }
    case "pear.goForward": {
      const raw = getActionValue(actionData, "seconds", "Seconds");
      const seconds = parseOptionalNumber(raw);
      await pearApi.goForward(seconds === null ? 10 : seconds);
      return;
    }
    case "pear.seekRelativeChoice": {
      const direction = normalizeChoice(getActionValue(actionData, "direction", "Direction"));
      const raw = getActionValue(actionData, "seconds", "Seconds");
      const seconds = parseOptionalNumber(raw) ?? 10;
      if (direction === "rewind") {
        await pearApi.goBack(seconds);
      } else {
        await pearApi.goForward(seconds);
      }
      return;
    }
    case "pear.shuffle":
      await pearApi.shuffle();
      return;
    case "pear.shuffleStateChoice": {
      const state = normalizeChoice(getActionValue(actionData, "state", "State"));
      if (state === "toggle") {
        await pearApi.shuffle();
        return;
      }
      const target = state === "on";
      await setShuffleState(target);
      return;
    }
    case "pear.repeat":
    {
      const raw = getActionValue(actionData, "iterations", "Iterations");
      const iterations = parseOptionalNumber(raw);
      await pearApi.switchRepeat(iterations === null ? 1 : iterations);
      return;
    }
    case "pear.repeatModeChoice": {
      const mode = normalizeChoice(getActionValue(actionData, "mode", "Mode"));
      if (mode === "toggle") {
        await pearApi.switchRepeat(1);
        return;
      }
      const target = mode === "off" ? "NONE" : mode === "one" ? "ONE" : "ALL";
      await setRepeatMode(target);
      return;
    }
    case "pear.volume": {
      const raw = getActionValue(actionData, "percent", "Percent");
      const percent = parseOptionalNumber(raw);
      if (percent === null) {
        throw new Error("Set Volume requires a percent value.");
      }
      const safePercent = clampNumber(Math.round(percent), 0, 100);
      await ensureVolumeScale();
      await pearApi.setVolume(buildVolumePayload(safePercent));
      setVolumePercentLocal(safePercent, "local");
      scheduleVolumeRefresh();
      return;
    }
    case "pear.toggleMute":
    {
      const choice = normalizeChoice(getActionValue(actionData, "choice", "Choice"));
      if (choice === "mute") {
        await setMuteState(true);
      } else if (choice === "unmute") {
        await setMuteState(false);
      } else {
        await pearApi.toggleMute();
      }
      return;
    }
    case "pear.queuePlayIndex": {
      const raw = getActionValue(actionData, "index", "Index");
      const index = parseOptionalNumber(raw);
      if (index === null || index < 0) {
        throw new Error("Queue index must be 0 or higher.");
      }
      await pearApi.setQueueIndex(Math.floor(index));
      return;
    }
    case "pear.queueAddVideo": {
      const videoId = getActionValue(actionData, "videoId", "Video ID");
      const insertPosition = getActionValue(actionData, "insertPosition", "Insert Position");
      if (!videoId) {
        throw new Error("Video ID is required.");
      }
      await pearApi.addToQueue(String(videoId).trim(), insertPosition);
      return;
    }
    case "pear.token":
      await pearApi.authenticate();
      setConnectionStatus("Connected");
      return;
    case "pear.refresh":
      await pollSong();
      if (extendedStatesEnabled) {
        pollExtras(true);
      }
      return;
    default:
      return;
  }
}

tpClient.on("connected", () => {
  log("Connected to TouchPortal");
  lastStateValues.clear();
  lastConnectorVolumeSent = null;
  volumeScale = VOLUME_SCALES.percent;
  pendingVolumeTarget = null;
  lastVolumeSetAt = 0;
  volumeStateScale = 1;
  setConnectionStatus("Disconnected");
  checkConnection();
});

tpClient.on("info", (data) => {
  log("TouchPortal info received.");
  const settings = extractSettings(data);
  applySettings(settings);
});

tpClient.on("settings", (data) => {
  log("TouchPortal settings received.");
  const settings = extractSettings(data);
  applySettings(settings);
});

tpClient.on("action", (data) => {
  const actionId = data.actionId || data.id;

  handleAction(data).catch((err) => {
    const status = formatConnectionStatus(err);
    setConnectionStatus(status);
    const cause = err.cause && (err.cause.code || err.cause.message);
    const suffix = cause ? ` (${cause})` : "";
    log(`Action ${actionId || "unknown"} failed: ${err.message}${suffix}`);

    if (!isConnected) {
      startReconnectLoop();
    }
  });
});

tpClient.on("connectorChange", (data) => {
  const connectorId = data && (data.connectorId || data.shortId || data.id);
  if (!connectorId) {
    return;
  }
  const expectedId = buildConnectorId(CONNECTORS.volume);
  const connectorText = String(connectorId);
  const matches =
    connectorId === expectedId ||
    connectorId === CONNECTORS.volume ||
    connectorText.endsWith(`_${CONNECTORS.volume}`) ||
    connectorText === CONNECTORS.volume;

  if (!matches) {
    return;
  }

  const percent = parseOptionalNumber(data.value);
  if (percent === null) {
    return;
  }

  const safePercent = clampNumber(Math.round(percent), 0, 100);
  scheduleVolumeSend(safePercent);
});

tpClient.on("close", () => {
  log("Disconnected from TouchPortal");
  lastStateValues.clear();
  lastConnectorVolumeSent = null;
  pendingVolumeTarget = null;
  lastVolumeSetAt = 0;
  volumeStateScale = 1;
});

tpClient.on("error", (err) => {
  log(`TouchPortal error: ${err.message}`);
});

try {
  tpClient.connect();
} catch (err) {
  log(`Failed to connect: ${err.message}`);
}

