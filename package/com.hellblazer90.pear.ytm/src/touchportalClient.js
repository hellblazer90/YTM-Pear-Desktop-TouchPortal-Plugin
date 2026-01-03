const net = require("net");
const EventEmitter = require("events");

const SOCKET_IP = "127.0.0.1";
const SOCKET_PORT = 12136;
const DEFAULT_RECONNECT_MS = 3000;
const CONNECTOR_PREFIX = "pc";

class TouchPortalClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pluginId = options.pluginId || "UNK";
    this.autoReconnect = options.autoReconnect !== false;
    this.reconnectIntervalMs = Number.isFinite(options.reconnectIntervalMs)
      ? options.reconnectIntervalMs
      : DEFAULT_RECONNECT_MS;
    this.socket = null;
    this._reconnectTimer = null;
  }

  connect(options = {}) {
    if (options.pluginId) {
      this.pluginId = options.pluginId;
    }
    if (typeof options.autoReconnect === "boolean") {
      this.autoReconnect = options.autoReconnect;
    }
    if (Number.isFinite(options.reconnectIntervalMs)) {
      this.reconnectIntervalMs = options.reconnectIntervalMs;
    }

    this._clearReconnectTimer();
    this._createSocket();
  }

  _createSocket() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
    }

    const socket = new net.Socket();
    this.socket = socket;
    socket.setEncoding("utf8");

    socket.connect(SOCKET_PORT, SOCKET_IP, () => {
      this.emit("connected");
      this.send({ type: "pair", id: this.pluginId });
    });

    socket.on("data", (data) => {
      const lines = data.toString().split(/(?:\r\n|\r|\n)/);
      lines.forEach((line) => {
        if (!line) {
          return;
        }

        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }

        switch (message.type) {
          case "closePlugin":
            if (message.pluginId === this.pluginId) {
              this.emit("close", message);
              socket.end();
            }
            break;
          case "info":
            this.emit("info", message);
            if (message.settings) {
              this.emit("settings", message.settings);
            }
            break;
          case "settings":
            this.emit("settings", message.values);
            break;
          case "action":
            this.emit("action", message);
            break;
          case "connectorChange":
            this.emit("connectorChange", message);
            break;
          case "up":
          case "down":
            this.emit(message.type, message);
            break;
          default:
            this.emit("message", message);
            break;
        }
      });
    });

    socket.on("error", (err) => {
      this.emit("error", err);
      this._scheduleReconnect();
    });

    socket.on("close", () => {
      this.emit("close");
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (!this.autoReconnect || this._reconnectTimer) {
      return;
    }

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, this.reconnectIntervalMs);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  send(data) {
    if (!this.socket || !this.socket.writable) {
      return;
    }
    this.socket.write(`${JSON.stringify(data)}\n`);
  }

  stateUpdate(id, value) {
    this.send({ type: "stateUpdate", id, value });
  }

  setState(id, value) {
    this.stateUpdate(id, value);
  }

  triggerEvent(id, value) {
    this.send({ type: "triggerEvent", id, value });
  }

  connectorUpdate(id, value, data, isShortId = false) {
    const numericValue = Number.parseInt(value, 10);
    if (!Number.isFinite(numericValue)) {
      return;
    }

    const payload = {
      type: "connectorUpdate",
      value: numericValue
    };

    if (isShortId) {
      payload.shortId = id;
    } else {
      let dataStr = "";
      if (Array.isArray(data)) {
        data.forEach((item) => {
          if (!item || item.id === undefined) {
            return;
          }
          dataStr = dataStr.concat("|", item.id, "=", item.value);
        });
      }
      payload.connectorId = `${CONNECTOR_PREFIX}_${this.pluginId}_${id}${dataStr}`;
    }

    this.send(payload);
  }
}

module.exports = TouchPortalClient;
