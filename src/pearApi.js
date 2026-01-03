const fetch = global.fetch ? global.fetch.bind(global) : null;
if (!fetch) {
  throw new Error("Node.js 18+ is required (fetch not available).");
}

const DEFAULTS = {
  hostname: "127.0.0.1",
  port: 9863,
  clientId: "touchportal"
};

const ENDPOINTS = {
  auth: {
    method: ["GET", "POST"],
    path: "/auth/{id}"
  },
  play: {
    method: "POST",
    path: "/api/v1/play"
  },
  pause: {
    method: "POST",
    path: "/api/v1/pause"
  },
  song: {
    method: "GET",
    path: "/api/v1/song"
  },
  playPause: {
    method: "POST",
    path: "/api/v1/toggle-play"
  },
  next: {
    method: "POST",
    path: "/api/v1/next"
  },
  prev: {
    method: "POST",
    path: "/api/v1/previous"
  },
  like: {
    method: "POST",
    path: "/api/v1/like"
  },
  dislike: {
    method: "POST",
    path: "/api/v1/dislike"
  },
  likeState: {
    method: "GET",
    path: "/api/v1/like-state"
  },
  seekTo: {
    method: "POST",
    path: "/api/v1/seek-to",
    valueIn: "body",
    valueKey: "seconds"
  },
  goBack: {
    method: "POST",
    path: "/api/v1/go-back",
    valueIn: "body",
    valueKey: "seconds"
  },
  goForward: {
    method: "POST",
    path: "/api/v1/go-forward",
    valueIn: "body",
    valueKey: "seconds"
  },
  shuffle: {
    method: "POST",
    path: "/api/v1/shuffle"
  },
  shuffleState: {
    method: "GET",
    path: "/api/v1/shuffle"
  },
  repeat: {
    method: "POST",
    path: "/api/v1/switch-repeat",
    valueIn: "body",
    valueKey: "iteration"
  },
  repeatMode: {
    method: "GET",
    path: "/api/v1/repeat-mode"
  },
  volume: {
    method: "POST",
    path: "/api/v1/volume",
    valueIn: "body",
    valueKey: "volume"
  },
  volumeState: {
    method: "GET",
    path: "/api/v1/volume"
  },
  toggleMute: {
    method: "POST",
    path: "/api/v1/toggle-mute"
  }
};

function normalizePath(path) {
  if (!path) {
    return "";
  }

  if (path.startsWith("/")) {
    return path;
  }

  return `/${path}`;
}

function sanitizeHostname(input) {
  if (!input) {
    return "";
  }

  let host = String(input).trim();
  if (!host) {
    return "";
  }

  host = host.replace(/^https?:\/\//i, "");
  host = host.replace(/\/.*$/, "");
  host = host.replace(/:\d+$/, "");

  return host.trim();
}

function isPlaceholder(path) {
  if (!path) {
    return true;
  }

  const upper = path.toUpperCase();
  return upper.includes("REPLACE_WITH") || upper.includes("...");
}

function normalizeMethods(method) {
  if (Array.isArray(method)) {
    return method.filter(Boolean).map((item) => String(item).toUpperCase());
  }

  if (method) {
    return [String(method).toUpperCase()];
  }

  return ["POST"];
}

async function readJsonSafe(res) {
  const text = await res.text().catch(() => "");
  if (!text) {
    return { data: null, text: "" };
  }

  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: null, text };
  }
}

class PearApi {
  constructor(config = {}) {
    this.token = null;
    this.updateConfig(config);
  }

  updateConfig(config = {}) {
    const hostname = sanitizeHostname(config.hostname);
    const port = Number(config.port);
    const clientId = typeof config.clientId === "string" ? config.clientId.trim() : "";

    this.hostname = hostname || DEFAULTS.hostname;
    this.port = Number.isFinite(port) && port > 0 ? port : DEFAULTS.port;
    this.clientId = clientId || DEFAULTS.clientId;
    this.baseUrl = `http://${this.hostname}:${this.port}`;
  }

  async authenticate() {
    const endpoint = ENDPOINTS.auth;
    if (!endpoint || !endpoint.path) {
      const err = new Error("Auth endpoint is not configured.");
      err.kind = "config";
      err.userMessage = err.message;
      throw err;
    }

    const methods = normalizeMethods(endpoint.method);
    const path = normalizePath(endpoint.path).replace("{id}", encodeURIComponent(this.clientId));
    const url = `${this.baseUrl}${path}`;

    let lastError = null;
    for (const method of methods) {
      const res = await fetch(url, { method });
      const { data, text } = await readJsonSafe(res);
      const token = data && (data.access_token || data.token || data.accessToken);

      if (res.ok && token) {
        this.token = token;
        return token;
      }

      const err = new Error(`Auth failed (${res.status})`);
      err.kind = "auth";
      err.status = res.status;
      err.method = method;
      err.responseText = text;
      err.userMessage = `Auth failed (${res.status})`;
      lastError = err;
    }

    if (lastError) {
      throw lastError;
    }

    const err = new Error("Auth failed (no methods configured)");
    err.kind = "auth";
    err.userMessage = err.message;
    throw err;
  }

  async request(path, options = {}) {
    const url = `${this.baseUrl}${normalizePath(path)}`;
    const method = options.method || "GET";
    const headers = Object.assign({}, options.headers || {});
    const needsAuth = options.auth !== false;

    if (needsAuth) {
      if (!this.token) {
        await this.authenticate();
      }
      headers.Authorization = `Bearer ${this.token}`;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: options.body
    });

    if (needsAuth && (res.status === 401 || res.status === 403) && !options._retry) {
      this.token = null;
      await this.authenticate();
      return this.request(path, Object.assign({}, options, { _retry: true }));
    }

    return res;
  }

  async requestJson(path, options = {}) {
    const res = await this.request(path, options);
    const text = await res.text();

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.kind = res.status === 401 || res.status === 403 ? "auth" : "http";
      err.status = res.status;
      err.userMessage = err.kind === "auth" ? `Auth failed (${res.status})` : `Error (${res.status})`;
      err.responseText = text;
      throw err;
    }

    return data;
  }

  async getSong() {
    const endpoint = ENDPOINTS.song;
    if (!endpoint || !endpoint.path) {
      const err = new Error("Song endpoint is not configured.");
      err.kind = "config";
      err.userMessage = err.message;
      throw err;
    }

    return this.requestJson(endpoint.path, { method: endpoint.method || "GET" });
  }

  async callEndpoint(name) {
    const endpoint = ENDPOINTS[name];

    if (!endpoint || !endpoint.path || isPlaceholder(endpoint.path)) {
      const err = new Error(
        `Endpoint for ${name} is not configured. Update ENDPOINTS.${name}.path in pearApi.js from Swagger.`
      );
      err.kind = "config";
      err.userMessage = err.message;
      throw err;
    }

    await this.requestJson(endpoint.path, { method: endpoint.method || "POST" });
    return true;
  }

  async callEndpointWithValue(name, value) {
    const endpoint = ENDPOINTS[name];

    if (!endpoint || !endpoint.path || isPlaceholder(endpoint.path)) {
      const err = new Error(
        `Endpoint for ${name} is not configured. Update ENDPOINTS.${name} in pearApi.js from Swagger.`
      );
      err.kind = "config";
      err.userMessage = err.message;
      throw err;
    }

    let path = endpoint.path;
    let body = null;
    const headers = {};
    const method = endpoint.method || "POST";

    if (value !== undefined && value !== null) {
      if (path.includes("{value}")) {
        path = path.replace("{value}", encodeURIComponent(value));
      } else if (endpoint.valueIn === "query") {
        const key = endpoint.valueKey || "value";
        const sep = path.includes("?") ? "&" : "?";
        path = `${path}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      } else if (endpoint.valueIn === "body") {
        const key = endpoint.valueKey || "value";
        headers["Content-Type"] = "application/json";
        body = JSON.stringify({ [key]: value });
      } else {
        const err = new Error(
          `Endpoint for ${name} requires a {value} placeholder or valueIn configuration in pearApi.js.`
        );
        err.kind = "config";
        err.userMessage = err.message;
        throw err;
      }
    }

    await this.requestJson(path, { method, headers, body });
    return true;
  }

  async play() {
    return this.callEndpoint("play");
  }

  async pause() {
    return this.callEndpoint("pause");
  }

  async playPause() {
    return this.callEndpoint("playPause");
  }

  async next() {
    return this.callEndpoint("next");
  }

  async previous() {
    return this.callEndpoint("prev");
  }

  async like() {
    return this.callEndpoint("like");
  }

  async dislike() {
    return this.callEndpoint("dislike");
  }

  async getLikeState() {
    const endpoint = ENDPOINTS.likeState;
    return this.requestJson(endpoint.path, { method: endpoint.method || "GET" });
  }

  async seekTo(seconds) {
    return this.callEndpointWithValue("seekTo", seconds);
  }

  async goBack(seconds) {
    return this.callEndpointWithValue("goBack", seconds);
  }

  async goForward(seconds) {
    return this.callEndpointWithValue("goForward", seconds);
  }

  async shuffle() {
    return this.callEndpoint("shuffle");
  }

  async getShuffleState() {
    const endpoint = ENDPOINTS.shuffleState;
    return this.requestJson(endpoint.path, { method: endpoint.method || "GET" });
  }

  async switchRepeat(iteration = 1) {
    return this.callEndpointWithValue("repeat", iteration);
  }

  async getRepeatMode() {
    const endpoint = ENDPOINTS.repeatMode;
    return this.requestJson(endpoint.path, { method: endpoint.method || "GET" });
  }

  async setVolume(value) {
    const endpoint = ENDPOINTS.volume;
    if (!endpoint || !endpoint.path) {
      const err = new Error("Volume endpoint is not configured.");
      err.kind = "config";
      err.userMessage = err.message;
      throw err;
    }

    const method = endpoint.method || "POST";
    if (endpoint.valueIn === "query") {
      return this.callEndpointWithValue("volume", value);
    }

    if (endpoint.valueIn === "body" || !endpoint.valueIn) {
      let percent = null;
      if (value && typeof value === "object") {
        if (value.volume !== undefined) {
          percent = Number(value.volume);
        } else if (value.percent !== undefined) {
          percent = Number(value.percent);
        } else if (value.value !== undefined) {
          percent = Number(value.value);
        }
      } else {
        const num = Number(value);
        if (Number.isFinite(num)) {
          percent = num;
        }
      }

      if (!Number.isFinite(percent)) {
        const err = new Error("Volume must be a number between 0 and 100.");
        err.kind = "config";
        err.userMessage = err.message;
        throw err;
      }

      const payload = { volume: percent };

      const body = JSON.stringify(payload);
      return this.requestJson(endpoint.path, {
        method,
        headers: { "Content-Type": "application/json" },
        body
      });
    }

    return this.callEndpointWithValue("volume", value);
  }

  async getVolume() {
    const endpoint = ENDPOINTS.volumeState;
    return this.requestJson(endpoint.path, { method: endpoint.method || "GET" });
  }

  async toggleMute() {
    return this.callEndpoint("toggleMute");
  }

  async setQueueIndex(index) {
    const body = JSON.stringify({ index });
    return this.requestJson("/api/v1/queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body
    });
  }

  async addToQueue(videoId, insertPosition) {
    const payload = { videoId };
    if (insertPosition) {
      payload.insertPosition = insertPosition;
    }
    const body = JSON.stringify(payload);
    return this.requestJson("/api/v1/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
  }
}

module.exports = {
  PearApi,
  ENDPOINTS
};
