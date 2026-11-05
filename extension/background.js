// Schedule Send CLI v0.6.1
// Own scheduler — no Send Later required.
//
// Flow:
//   JSON job in queue/ → process
//   - no datetime  → silent draft only
//   - datetime now/past → send immediately
//   - datetime future → store schedule + optional draft, send when due
//
// Thunderbird must be running at send time.

// Queue root is NOT hard-coded. Loaded from:
//   %APPDATA%\schedule-send-cli\config.json  (written by send_job.py)
// Fallback: browser.storage.local.queueRoot
let QUEUE_ROOT = null;
let QUEUE_DIR = null;
let DONE_DIR = null;
let ERROR_DIR = null;
let SCHEDULED_DIR = null;
const POLL_QUEUE_SECONDS = 10;
const POLL_SCHEDULE_SECONDS = 20;
const ALARM_PREFIX = "ssend-";

let processingQueue = false;
let sendingIds = new Set();
let pathsReady = false;

function applyQueueRoot(root) {
  if (!root) return false;
  // normalize slashes for Windows
  root = String(root).replace(/[/\\]+$/, "");
  QUEUE_ROOT = root;
  QUEUE_DIR = root + "\\queue";
  DONE_DIR = root + "\\done";
  ERROR_DIR = root + "\\error";
  SCHEDULED_DIR = root + "\\scheduled";
  pathsReady = true;
  console.log("[ScheduleSend] Queue root =", QUEUE_ROOT);
  return true;
}

async function resolveQueuePaths() {
  // 1) Config written by send_job.py
  const candidates = [];
  try {
    // Windows APPDATA via env is not available in WebExt; try common path via fileio
    // Experiment can expand env — try explicit patterns
    const homeGuesses = [];
    // From previous job storage
    const stored = await browser.storage.local.get(["queueRoot"]);
    if (stored.queueRoot) {
      candidates.push(stored.queueRoot);
    }
  } catch (_) {}

  // Try to read %APPDATA%\schedule-send-cli\config.json via fileio helper
  try {
    const cfg = await browser.fileio.readAppConfig();
    if (cfg && cfg.queueRoot) {
      candidates.unshift(cfg.queueRoot);
    }
  } catch (e) {
    console.warn("[ScheduleSend] readAppConfig:", e);
  }

  for (const c of candidates) {
    if (applyQueueRoot(c)) {
      try {
        await browser.storage.local.set({ queueRoot: QUEUE_ROOT });
      } catch (_) {}
      return true;
    }
  }

  console.warn(
    "[ScheduleSend] Queue path unknown. Run: python send_job.py where  (or add once) so config.json is created."
  );
  return false;
}

function encodeUtf8Base64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === "function") return btoa(binary);
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < binary.length; i += 3) {
    const c1 = binary.charCodeAt(i) & 0xff;
    const c2 = i + 1 < binary.length ? binary.charCodeAt(i + 1) & 0xff : 0;
    const c3 = i + 2 < binary.length ? binary.charCodeAt(i + 2) & 0xff : 0;
    const e1 = c1 >> 2;
    const e2 = ((c1 & 3) << 4) | (c2 >> 4);
    const e3 = ((c2 & 15) << 2) | (c3 >> 6);
    const e4 = c3 & 63;
    if (i + 1 >= binary.length) {
      out += chars.charAt(e1) + chars.charAt(e2) + "==";
    } else if (i + 2 >= binary.length) {
      out += chars.charAt(e1) + chars.charAt(e2) + chars.charAt(e3) + "=";
    } else {
      out +=
        chars.charAt(e1) +
        chars.charAt(e2) +
        chars.charAt(e3) +
        chars.charAt(e4);
    }
  }
  return out;
}

function encodeHeaderUtf8(value) {
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return "=?UTF-8?B?" + encodeUtf8Base64(value) + "?=";
}

function parseDatetime(str) {
  if (!str) return null;
  const s = String(str).trim();
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/
  );
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function foldBase64(b64) {
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

function generateId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function generateMessageId(email) {
  const domain = (email || "localhost").split("@")[1] || "localhost";
  const rnd = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `<${rnd}@${domain}>`;
}

function formatRfc5322(date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  const d = date;
  const H = String(d.getHours()).padStart(2, "0");
  const M = String(d.getMinutes()).padStart(2, "0");
  const S = String(d.getSeconds()).padStart(2, "0");
  const offset = d.getTimezoneOffset();
  const sign = offset > 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const tzH = String(Math.trunc(abs / 60)).padStart(2, "0");
  const tzM = String(abs % 60).padStart(2, "0");
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${H}:${M}:${S} ${sign}${tzH}${tzM}`;
}

async function findIdentityAndAccount(job) {
  const accounts = await browser.accounts.list(true);
  if (job.identityId) {
    for (const acc of accounts) {
      for (const id of acc.identities || []) {
        if (id.id === job.identityId) return { identity: id, account: acc };
      }
    }
  }
  const fromEmail = (job.from || "").toLowerCase().trim();
  if (fromEmail) {
    for (const acc of accounts) {
      for (const id of acc.identities || []) {
        if ((id.email || "").toLowerCase() === fromEmail) {
          return { identity: id, account: acc };
        }
      }
    }
  }
  for (const acc of accounts) {
    if ((acc.type || "").toLowerCase() === "none") continue;
    if (acc.identities && acc.identities.length) {
      return { identity: acc.identities[0], account: acc };
    }
  }
  for (const acc of accounts) {
    if (acc.identities && acc.identities.length) {
      return { identity: acc.identities[0], account: acc };
    }
  }
  return { identity: null, account: null };
}

function findDraftsInAccount(account) {
  if (!account) return null;
  const walk = (folders) => {
    if (!folders) return null;
    for (const f of folders) {
      if (f.type === "drafts") return f;
      const sub = walk(f.subFolders);
      if (sub) return sub;
    }
    return null;
  };
  return walk(account.folders);
}

async function findLocalFoldersDrafts() {
  const accounts = await browser.accounts.list(true);
  for (const acc of accounts) {
    if ((acc.type || "").toLowerCase() !== "none") continue;
    const drafts = findDraftsInAccount(acc);
    if (drafts) return { account: acc, drafts };
  }
  return { account: null, drafts: null };
}

async function buildEml(job, identity) {
  const boundary = "----=_ScheduleSend_" + Date.now().toString(36);
  const from =
    (identity &&
      (identity.name
        ? `"${identity.name}" <${identity.email}>`
        : identity.email)) ||
    "unknown@localhost";
  const subject = encodeHeaderUtf8(job.subject || "");
  const bodyText = job.body || "";
  const emailForId = (identity && identity.email) || "localhost";

  const fileList = job.files || job.attachments || [];
  const attachments = [];
  for (const path of fileList) {
    attachments.push(await browser.fileio.readFileBase64(path));
  }

  const headers = [
    "MIME-Version: 1.0",
    `From: ${from}`,
    `To: ${job.to}`,
    `Subject: ${subject}`,
    `Message-ID: ${generateMessageId(emailForId)}`,
    `Date: ${formatRfc5322(job.datetime ? (parseDatetime(job.datetime) || new Date()) : new Date())}`,
    "X-Schedule-Send-CLI: 1"
  ];
  if (job.cc) headers.push(`Cc: ${job.cc}`);
  if (job.bcc) headers.push(`Bcc: ${job.bcc}`);
  if (job.datetime) headers.push(`X-Schedule-Send-At: ${job.datetime}`);
  if (job._scheduleId) {
    headers.push(`X-Schedule-Send-Id: ${job._scheduleId}`);
  }

  let body;
  if (attachments.length === 0) {
    headers.push("Content-Type: text/plain; charset=UTF-8");
    headers.push("Content-Transfer-Encoding: base64");
    body = foldBase64(encodeUtf8Base64(bodyText));
  } else {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [];
    parts.push(
      `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n` +
        foldBase64(encodeUtf8Base64(bodyText))
    );
    for (const att of attachments) {
      const safeName = att.name.replace(/"/g, "");
      parts.push(
        `--${boundary}\r\n` +
          `Content-Type: application/octet-stream; name="${safeName}"\r\n` +
          `Content-Transfer-Encoding: base64\r\n` +
          `Content-Disposition: attachment; filename="${safeName}"\r\n\r\n` +
          foldBase64(att.contentBase64)
      );
    }
    parts.push(`--${boundary}--`);
    body = parts.join("\r\n");
  }
  return headers.join("\r\n") + "\r\n\r\n" + body + "\r\n";
}

async function createDraftSilent(job) {
  const { identity, account } = await findIdentityAndAccount(job);
  console.log(
    "[ScheduleSend] Draft identity:",
    identity && identity.email,
    "account:",
    account && account.id
  );

  let draftsUri = "";
  let accountKey = account ? account.id : "";
  const local = await findLocalFoldersDrafts();
  if (local.drafts) {
    draftsUri = local.drafts.id || "";
    accountKey = local.account ? local.account.id : "";
  } else {
    const drafts = findDraftsInAccount(account);
    if (drafts) draftsUri = drafts.id || "";
  }

  const eml = await buildEml(job, identity);
  const result = await browser.fileio.createDraftFromMime(
    accountKey,
    eml,
    draftsUri
  );
  console.log("[ScheduleSend] Draft created:", JSON.stringify(result));
  return result;
}

async function sendJobNow(job) {
  const { identity, account } = await findIdentityAndAccount(job);
  console.log(
    "[ScheduleSend] SILENT send →",
    job.to,
    "/",
    job.subject,
    "as",
    identity && identity.email
  );

  const fileList = job.files || job.attachments || [];

  // ONLY silent XPCOM path — no compose window ever
  // Pass empty accountKey — resolve purely by identity email (correct SMTP)
  const result = await browser.fileio.sendJob(
    identity ? identity.email : (job.from || ""),
    "",
    job.to,
    job.subject || "",
    job.body || "",
    job.cc || "",
    job.bcc || "",
    fileList
  );
  console.log("[ScheduleSend] SILENT OK:", JSON.stringify(result));
  return result;
}


async function loadScheduled() {
  try {
    const data = await browser.storage.local.get("scheduled");
    return Array.isArray(data.scheduled) ? data.scheduled : [];
  } catch (e) {
    return [];
  }
}

async function saveScheduled(list) {
  await browser.storage.local.set({ scheduled: list });
}

async function persistScheduledFile(entry) {
  try {
    await browser.fileio.ensureDir(SCHEDULED_DIR);
    const path = SCHEDULED_DIR + "\\" + entry.id + ".json";
    await browser.fileio.writeTextFile(path, JSON.stringify(entry, null, 2));
  } catch (e) {
    console.warn("[ScheduleSend] persist file failed:", e);
  }
}

async function removeScheduledFile(id) {
  try {
    await browser.fileio.moveFile(
      SCHEDULED_DIR + "\\" + id + ".json",
      DONE_DIR + "\\scheduled-" + id + ".json"
    );
  } catch (e) {}
}

async function restoreScheduledFromDisk() {
  try {
    await browser.fileio.ensureDir(SCHEDULED_DIR);
    const names = await browser.fileio.listDir(SCHEDULED_DIR);
    const jsons = names.filter((n) => n.toLowerCase().endsWith(".json"));
    if (!jsons.length) return;

    let list = await loadScheduled();
    const byId = new Map(list.map((e) => [e.id, e]));

    for (const name of jsons) {
      try {
        const data = await browser.fileio.readFileBase64(
          SCHEDULED_DIR + "\\" + name
        );
        const binary = atob(data.contentBase64);
        const text = new TextDecoder("utf-8").decode(
          Uint8Array.from(binary, (c) => c.charCodeAt(0))
        );
        const entry = JSON.parse(text);
        if (entry && entry.id && entry.job && entry.whenMs) {
          if (!byId.has(entry.id) && entry.status !== "sent") {
            byId.set(entry.id, entry);
            console.log("[ScheduleSend] Restored from disk:", entry.id);
          }
        }
      } catch (e) {
        console.warn("[ScheduleSend] Bad scheduled file", name, e);
      }
    }
    list = Array.from(byId.values());
    await saveScheduled(list);
  } catch (e) {
    console.warn("[ScheduleSend] restoreScheduledFromDisk:", e);
  }
}

async function scheduleJob(job, jobName) {
  const when = parseDatetime(job.datetime);
  if (!when) throw new Error("Invalid datetime: " + job.datetime);

  const entry = {
    id: generateId(),
    jobName: jobName || null,
    job: job,
    whenMs: when.getTime(),
    whenLocal: job.datetime,
    status: "pending",
    createdAt: new Date().toISOString()
  };

  const list = await loadScheduled();
  list.push(entry);
  await saveScheduled(list);
  await persistScheduledFile(entry);
  await armAlarm(entry);

  console.log(
    "[ScheduleSend] Scheduled",
    entry.id,
    "for",
    when.toString(),
    "(",
    entry.whenLocal,
    ")"
  );

  try {
    await browser.notifications.create({
      type: "basic",
      title: "Schedule Send",
      message: `Запланировано на ${entry.whenLocal}: ${job.subject || job.to}`
    });
  } catch (_) {}

  // Create draft so user can see/manage scheduled mail
  try {
    const jobWithId = Object.assign({}, job, { _scheduleId: entry.id });
    await createDraftSilent(jobWithId);
    entry.draftCreated = true;
    await saveScheduled(await loadScheduled().then((list) => {
      return list.map((e) => (e.id === entry.id ? entry : e));
    }));
    // re-read and update entry in storage properly
    let list = await loadScheduled();
    list = list.map((e) => (e.id === entry.id ? { ...e, draftCreated: true } : e));
    await saveScheduled(list);
    await persistScheduledFile({ ...entry, draftCreated: true });
    console.log("[ScheduleSend] Draft created for schedule", entry.id);
  } catch (e) {
    console.warn("[ScheduleSend] Draft create failed (will still send):", e);
    try {
      await browser.notifications.create({
        type: "basic",
        title: "Schedule Send — черновик не создан",
        message:
          "Письмо запланировано, но черновик не появился: " +
          String(e && e.message ? e.message : e)
      });
    } catch (_) {}
  }

  return entry;
}

async function armAlarm(entry) {
  const name = ALARM_PREFIX + entry.id;
  const delayMs = entry.whenMs - Date.now();
  try {
    await browser.alarms.clear(name);
  } catch (_) {}
  if (delayMs <= 0) return;
  try {
    await browser.alarms.create(name, { when: entry.whenMs });
    console.log(
      "[ScheduleSend] Alarm set:",
      name,
      "in",
      Math.round(delayMs / 1000),
      "s"
    );
  } catch (e) {
    console.warn("[ScheduleSend] alarms.create failed, relying on poll:", e);
  }
}

async function armAllAlarms() {
  const list = await loadScheduled();
  for (const entry of list) {
    if (entry.status === "pending") await armAlarm(entry);
  }
}

async function markSent(entryId, info) {
  let list = await loadScheduled();
  list = list.map((e) => {
    if (e.id === entryId) {
      return {
        ...e,
        status: "sent",
        sentAt: new Date().toISOString(),
        sendInfo: info || null
      };
    }
    return e;
  });
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  list = list.filter(
    (e) => e.status === "pending" || (e.whenMs && e.whenMs > cutoff)
  );
  await saveScheduled(list);
  await removeScheduledFile(entryId);
  try {
    await browser.alarms.clear(ALARM_PREFIX + entryId);
  } catch (_) {}
}

async function markFailed(entryId, err) {
  let list = await loadScheduled();
  list = list.map((e) => {
    if (e.id === entryId) {
      return {
        ...e,
        status: "error",
        error: String(err && err.message ? err.message : err),
        failedAt: new Date().toISOString()
      };
    }
    return e;
  });
  await saveScheduled(list);
  try {
    await browser.fileio.writeTextFile(
      ERROR_DIR + "\\scheduled-" + entryId + ".error.txt",
      String(err && err.message ? err.message : err) +
        "\n" +
        (err && err.stack ? err.stack : "")
    );
  } catch (_) {}
}


async function findAndDeleteDrafts(scheduleId, job) {
  if (!scheduleId && !job) return 0;
  let deleted = 0;
  try {
    const accounts = await browser.accounts.list(true);
    const draftFolders = [];
    const walk = (folders) => {
      if (!folders) return;
      for (const f of folders) {
        if (f.type === "drafts") draftFolders.push(f);
        if (f.subFolders) walk(f.subFolders);
      }
    };
    for (const acc of accounts) walk(acc.folders);

    for (const folder of draftFolders) {
      let page;
      try {
        page = await browser.messages.list(folder);
      } catch (e) {
        continue;
      }
      const all = [...(page.messages || [])];
      while (page.id) {
        page = await browser.messages.continueList(page.id);
        all.push(...(page.messages || []));
      }

      for (const msg of all) {
        let match = false;
        // Strict match ONLY by unique X-Schedule-Send-Id header.
        // Old subject fallback deleted ALL drafts with the same subject.
        try {
          const full = await browser.messages.getFull(msg.id);
          const headers = full.headers || {};
          const ids = headers["x-schedule-send-id"] || headers["X-Schedule-Send-Id"] || [];
          const idList = Array.isArray(ids) ? ids : [ids];
          if (
            scheduleId &&
            idList.some((v) => {
              const s = String(v).trim();
              return s === String(scheduleId).trim() || s.includes(String(scheduleId));
            })
          ) {
            match = true;
          }
        } catch (e) {}

        // Conservative fallback only when scheduleId was not provided
        if (!match && !scheduleId && job) {
          const subj = (msg.subject || "").trim();
          const jobSubj = (job.subject || "").trim();
          if (jobSubj && subj === jobSubj) {
            const recipients = (msg.recipients || []).join(",").toLowerCase();
            if (
              !job.to ||
              recipients.includes(String(job.to).toLowerCase().split("@")[0])
            ) {
              match = true;
            }
          }
        }

        if (match) {
          try {
            await browser.messages.delete([msg.id], true); // skipTrash? true = permanent if supported
            deleted++;
            console.log(
              "[ScheduleSend] Deleted draft msg",
              msg.id,
              msg.subject
            );
          } catch (e1) {
            try {
              await browser.messages.delete([msg.id]);
              deleted++;
              console.log("[ScheduleSend] Deleted draft (trash)", msg.id);
            } catch (e2) {
              console.warn("[ScheduleSend] Could not delete draft", msg.id, e2);
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("[ScheduleSend] findAndDeleteDrafts error:", e);
  }
  return deleted;
}

async function processDueScheduled() {
  if (!pathsReady) return;
  const list = await loadScheduled();
  const now = Date.now();
  const due = list.filter(
    (e) => e.status === "pending" && e.whenMs <= now + 5000
  );
  if (!due.length) return;

  for (const entry of due) {
    if (sendingIds.has(entry.id)) continue;
    sendingIds.add(entry.id);
    try {
      console.log("[ScheduleSend] Due — sending", entry.id, entry.whenLocal);
      const info = await sendJobNow(entry.job);
      // Remove draft from Drafts after successful send
      try {
        const n = await findAndDeleteDrafts(entry.id, entry.job);
        console.log("[ScheduleSend] Drafts removed:", n);
      } catch (e) {
        console.warn("[ScheduleSend] Draft cleanup failed:", e);
      }
      await markSent(entry.id, info);
      try {
        await browser.notifications.create({
          type: "basic",
          title: "Schedule Send",
          message: `Отправлено: ${entry.job.subject || entry.job.to}`
        });
      } catch (_) {}
    } catch (e) {
      console.error("[ScheduleSend] Send failed:", entry.id, e);
      await markFailed(entry.id, e);
      try {
        await browser.notifications.create({
          type: "basic",
          title: "Schedule Send — ошибка",
          message: String(e.message || e)
        });
      } catch (_) {}
    } finally {
      sendingIds.delete(entry.id);
    }
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name || !alarm.name.startsWith(ALARM_PREFIX)) return;
  console.log("[ScheduleSend] Alarm fired:", alarm.name);
  processDueScheduled().catch((e) =>
    console.error("[ScheduleSend] processDue on alarm:", e)
  );
});

async function ensureFolders() {
  try {
    await browser.fileio.ensureDir(QUEUE_DIR);
    await browser.fileio.ensureDir(DONE_DIR);
    await browser.fileio.ensureDir(ERROR_DIR);
    await browser.fileio.ensureDir(SCHEDULED_DIR);
  } catch (e) {
    console.error("[ScheduleSend] ensureFolders:", e);
  }
}

async function processOneJob(jobPath, name) {
  console.log("[ScheduleSend] Processing queue file", name);

  const fileData = await browser.fileio.readFileBase64(jobPath);
  const jsonText = atob(fileData.contentBase64);
  const bytes = Uint8Array.from(jsonText, (c) => c.charCodeAt(0));
  const text = new TextDecoder("utf-8").decode(bytes);
  const job = JSON.parse(text);

  if (!job.to || !String(job.to).trim()) {
    throw new Error("Не указан получатель (поле to)");
  }
  if (job.datetime) {
    const parsed = parseDatetime(job.datetime);
    if (!parsed) {
      throw new Error(
        "Неверный формат даты/времени: «" +
          job.datetime +
          "». Нужно ГГГГ-ММ-ДД ЧЧ:ММ"
      );
    }
  }

  // Проверка вложений до отправки/черновика
  const fileList = job.files || job.attachments || [];
  for (const fpath of fileList) {
    try {
      await browser.fileio.readFileBase64(fpath);
    } catch (e) {
      throw new Error(
        "Файл вложения не найден или недоступен: «" +
          fpath +
          "». " +
          (e && e.message ? e.message : e)
      );
    }
  }

  const when = job.datetime ? parseDatetime(job.datetime) : null;
  const now = Date.now();

  if (when && when.getTime() > now + 15000) {
    await scheduleJob(job, name);
  } else if (when) {
    console.log("[ScheduleSend] datetime is now/past — send immediately");
    await sendJobNow(job);
  } else {
    await createDraftSilent(job);
  }

  await browser.fileio.moveFile(jobPath, DONE_DIR + "\\" + name);

  const result = {
    status:
      when && when.getTime() > now + 15000
        ? "scheduled"
        : when
          ? "sent"
          : "draft",
    job: name,
    to: job.to,
    subject: job.subject || "",
    datetime: job.datetime || null,
    attachments: (job.files || job.attachments || []).length,
    saved_at: new Date().toISOString()
  };
  await browser.fileio.writeTextFile(
    DONE_DIR + "\\" + name + ".result.json",
    JSON.stringify(result, null, 2)
  );

  if (!when || when.getTime() <= now + 15000) {
    try {
      await browser.notifications.create({
        type: "basic",
        title: "Schedule Send",
        message:
          result.status === "sent"
            ? `Отправлено: ${job.subject || job.to}`
            : `Черновик: ${job.subject || job.to}`
      });
    } catch (_) {}
  }
}

async function processQueue() {
  if (processingQueue) return;
  if (!pathsReady) {
    const ok = await resolveQueuePaths();
    if (!ok) return;
  }
  processingQueue = true;
  try {
    await ensureFolders();
    const files = await browser.fileio.listDir(QUEUE_DIR);
    const jobs = files.filter((n) => n.toLowerCase().endsWith(".json"));
    if (jobs.length) console.log("[ScheduleSend] Found jobs:", jobs);
    for (const name of jobs) {
      const jobPath = QUEUE_DIR + "\\" + name;
      try {
        await processOneJob(jobPath, name);
      } catch (e) {
        console.error("[ScheduleSend] Job failed:", name, e);
        try {
          await browser.fileio.moveFile(jobPath, ERROR_DIR + "\\" + name);
          await browser.fileio.writeTextFile(
            ERROR_DIR + "\\" + name + ".error.txt",
            String(e.message || e) + "\n" + (e.stack || "")
          );
        } catch (moveErr) {
          console.error("[ScheduleSend] move failed job:", moveErr);
        }
        try {
          await browser.notifications.create({
            type: "basic",
            title: "Schedule Send — ошибка",
            message: String(e.message || e).slice(0, 200)
          });
        } catch (_) {}
      }
    }
  } catch (e) {
    console.error("[ScheduleSend] processQueue:", e);
  } finally {
    processingQueue = false;
  }
}

async function start() {
  const ok = await resolveQueuePaths();
  console.log(
    "[ScheduleSend] v0.6.1 — portable queue. root =",
    QUEUE_ROOT || "(not set — run: python send_job.py where)"
  );
  if (!ok) {
    console.warn(
      "[ScheduleSend] Waiting for config. Run send_job.py once from your folder."
    );
  } else {
    await ensureFolders();
    await restoreScheduledFromDisk();
    await armAllAlarms();
  }

  setTimeout(() => {
    processDueScheduled().catch((e) =>
      console.error("[ScheduleSend] startup due:", e)
    );
  }, 3000);

  setTimeout(processQueue, 2000);
  setInterval(processQueue, POLL_QUEUE_SECONDS * 1000);
  setInterval(() => {
    resolveQueuePaths().catch(() => {});
  }, 60000);
  setInterval(() => {
    processDueScheduled().catch((e) =>
      console.error("[ScheduleSend] poll due:", e)
    );
  }, POLL_SCHEDULE_SECONDS * 1000);
}


start();
