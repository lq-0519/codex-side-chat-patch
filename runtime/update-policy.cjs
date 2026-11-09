/**
 * Select the native updater gate before Electron bootstrap runs.
 * The durable preference affects the next process only: Sparkle exposes no shutdown API.
 * No watcher, polling timer, subprocess, network request or application restart is introduced.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/** Share one versioned preference with the Python CLI, outside the replaceable application. */
const POLICY_PATH = path.join(os.homedir(), "Library/Application Support/CodexSideChatPatch/update-policy.json");

/** Create an isolated policy owner; injected paths and filesystem support offline verification. */
function createPolicy({ policyPath = POLICY_PATH, environment = process.env, filesystem = fs } = {}) {
  /** Freeze the effective native gate for this process even when the saved preference changes. */
  let launchEnabled;

  /** Missing, unreadable or invalid configuration always disables native software updates. */
  function read() {
    try {
      const value = JSON.parse(filesystem.readFileSync(policyPath, "utf8"));
      if (value?.version !== 1 || typeof value.enabled !== "boolean") {
        throw Error("Invalid update policy; expected version 1 and a boolean enabled");
      }
      return { enabled: value.enabled, error: null };
    } catch (error) {
      return { enabled: false, error: error.code === "ENOENT" ? null : String(error.message) };
    }
  }

  /** Apply the exact native gate once, before any updater, IPC or recovery initialization. */
  function initialize() {
    if (launchEnabled === undefined) {
      launchEnabled = read().enabled;
      environment.CODEX_SPARKLE_ENABLED = launchEnabled ? "true" : "false";
    }
    return launchEnabled;
  }

  /** Persist explicit consent atomically; a failed write must leave the previous policy intact. */
  function setEnabled(enabled) {
    if (typeof enabled !== "boolean") throw TypeError("enabled must be a boolean");
    const directory = path.dirname(policyPath);
    filesystem.mkdirSync(directory, { recursive: true });
    const temporary = policyPath + "." + randomUUID() + ".temporary";
    let descriptor;
    try {
      descriptor = filesystem.openSync(temporary, "wx", 0o600);
      filesystem.writeFileSync(descriptor, JSON.stringify({ version: 1, enabled }) + "\n", "utf8");
      filesystem.fsyncSync(descriptor);
      filesystem.closeSync(descriptor);
      descriptor = undefined;
      filesystem.renameSync(temporary, policyPath);
    } finally {
      if (descriptor !== undefined) filesystem.closeSync(descriptor);
      try { filesystem.unlinkSync(temporary); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return enabled;
  }

  /** Offer a durable checkbox without attempting unsafe live updater cancellation or a restart. */
  function menuItem(dialog) {
    return {
      label: "允许 CodeX 软件更新（下次启动生效）",
      type: "checkbox",
      checked: read().enabled,
      async click(item) {
        const previous = read().enabled;
        try {
          setEnabled(item.checked);
        } catch (error) {
          item.checked = previous;
          await dialog.showMessageBox({
            type: "error", title: "无法保存更新开关",
            message: "更新开关未保存，请重试。", detail: String(error.message),
          });
          return;
        }
        await dialog.showMessageBox({
          type: "info", title: "CodeX 软件更新",
          message: item.checked ? "已允许软件更新，下次启动生效。" : "已关闭软件更新，下次启动生效。",
          detail: launchEnabled
            ? "当前进程的更新组件仍在运行。请自行完全退出并重新启动 CodeX，让新设置生效。"
            : "当前进程的更新组件已关闭。请自行完全退出并重新启动 CodeX，让新设置生效。",
        });
      },
    };
  }

  return { initialize, read, setEnabled, menuItem };
}

/** Both bootstrap and the native menu use Node's cached singleton, with one gate per process. */
module.exports = { ...createPolicy(), createPolicy, POLICY_PATH };
