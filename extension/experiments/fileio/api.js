/* global ExtensionAPI, ChromeUtils, Cc, Ci, Cu */

"use strict";

function getFile(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
}



function delayMs(ms) {
  return new Promise((resolve) => {
    const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.initWithCallback(
      {
        notify() {
          resolve();
        },
      },
      ms,
      Ci.nsITimer.TYPE_ONE_SHOT
    );
  });
}

function scheduleMs(ms, fn) {
  const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.initWithCallback(
    {
      notify() {
        try {
          fn();
        } catch (e) {
          Cu.reportError(e);
        }
      },
    },
    ms,
    Ci.nsITimer.TYPE_ONE_SHOT
  );
  return timer;
}

function utf8ToBinaryString(str) {
  // XPCOM experiment scope has no TextEncoder — use Unicode converter
  try {
    const converter = Cc[
      "@mozilla.org/intl/scriptableunicodeconverter"
    ].createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";
    return converter.ConvertFromUnicode(str) + converter.Finish();
  } catch (e) {
    // fallback: only ASCII-safe
    let out = "";
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 128) out += str.charAt(i);
      else {
        // encode as UTF-8 bytes manually
        if (c < 0x800) {
          out += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
          const c2 = str.charCodeAt(++i);
          const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
          out += String.fromCharCode(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f)
          );
        } else {
          out += String.fromCharCode(
            0xe0 | (c >> 12),
            0x80 | ((c >> 6) & 0x3f),
            0x80 | (c & 0x3f)
          );
        }
      }
    }
    return out;
  }
}

function binaryStringToBase64(binary) {
  if (typeof btoa === "function") {
    try {
      return btoa(binary);
    } catch (_) {}
  }
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  const len = binary.length;
  for (let i = 0; i < len; i += 3) {
    const c1 = binary.charCodeAt(i) & 0xff;
    const c2 = i + 1 < len ? binary.charCodeAt(i + 1) & 0xff : 0;
    const c3 = i + 2 < len ? binary.charCodeAt(i + 2) & 0xff : 0;
    const e1 = c1 >> 2;
    const e2 = ((c1 & 3) << 4) | (c2 >> 4);
    const e3 = ((c2 & 15) << 2) | (c3 >> 6);
    const e4 = c3 & 63;
    if (i + 1 >= len) {
      out += chars.charAt(e1) + chars.charAt(e2) + "==";
    } else if (i + 2 >= len) {
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


function bytesToBase64(binary) {
  // binary is a binary string from nsIBinaryInputStream.readBytes
  if (typeof btoa === "function") {
    return btoa(binary);
  }

  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  const len = binary.length;
  for (let i = 0; i < len; i += 3) {
    const c1 = binary.charCodeAt(i) & 0xff;
    const c2 = i + 1 < len ? binary.charCodeAt(i + 1) & 0xff : 0;
    const c3 = i + 2 < len ? binary.charCodeAt(i + 2) & 0xff : 0;
    const e1 = c1 >> 2;
    const e2 = ((c1 & 3) << 4) | (c2 >> 4);
    const e3 = ((c2 & 15) << 2) | (c3 >> 6);
    const e4 = c3 & 63;
    if (i + 1 >= len) {
      out += chars.charAt(e1) + chars.charAt(e2) + "==";
    } else if (i + 2 >= len) {
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

function fileToBase64(file) {
  const fstream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
    Ci.nsIFileInputStream
  );
  fstream.init(file, -1, 0, 0);

  const bstream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
    Ci.nsIBinaryInputStream
  );
  bstream.setInputStream(fstream);

  const size = file.fileSize;
  const bytes = bstream.readBytes(size);
  fstream.close();

  return bytesToBase64(bytes);
}

function fail(e) {
  try {
    Cu.reportError(e);
  } catch (_) {}
  throw new Error(String(e && e.message ? e.message : e));
}

this.fileio = class extends ExtensionAPI {
  getAPI(context) {
    return {
      fileio: {
        async listDir(path) {
          try {
            const dir = getFile(path);
            if (!dir.exists() || !dir.isDirectory()) {
              return [];
            }
            const entries = [];
            const enumerator = dir.directoryEntries;
            while (enumerator.hasMoreElements()) {
              const entry = enumerator.getNext().QueryInterface(Ci.nsIFile);
              if (entry.isFile()) {
                entries.push(entry.leafName);
              }
            }
            return entries;
          } catch (e) {
            fail(e);
          }
        },

        async readFileBase64(path) {
          try {
            const file = getFile(path);
            if (!file.exists() || !file.isFile()) {
              throw new Error("File not found: " + path);
            }
            const contentBase64 = fileToBase64(file);
            return {
              name: file.leafName,
              size: file.fileSize,
              contentBase64
            };
          } catch (e) {
            fail(e);
          }
        },

        async moveFile(fromPath, toPath) {
          try {
            const src = getFile(fromPath);
            if (!src.exists()) {
              throw new Error("Source not found: " + fromPath);
            }
            const dest = getFile(toPath);
            const destDir = dest.parent;
            if (destDir && !destDir.exists()) {
              destDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
            }
            if (dest.exists()) {
              dest.remove(false);
            }
            src.moveTo(dest.parent, dest.leafName);
            return true;
          } catch (e) {
            fail(e);
          }
        },

        async writeTextFile(path, content) {
          try {
            const file = getFile(path);
            const parent = file.parent;
            if (parent && !parent.exists()) {
              parent.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
            }
            const fos = Cc[
              "@mozilla.org/network/file-output-stream;1"
            ].createInstance(Ci.nsIFileOutputStream);
            fos.init(file, 0x02 | 0x08 | 0x20, 0o644, 0);
            const converter = Cc[
              "@mozilla.org/intl/converter-output-stream;1"
            ].createInstance(Ci.nsIConverterOutputStream);
            converter.init(fos, "UTF-8", 0, 0);
            converter.writeString(content);
            converter.close();
            return true;
          } catch (e) {
            fail(e);
          }
        },

        async ensureDir(path) {
          try {
            const dir = getFile(path);
            if (!dir.exists()) {
              dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
            }
            return true;
          } catch (e) {
            fail(e);
          }
        },

        async createDraftFromMime(accountKey, mimeContent, draftsUri) {
          try {
            let MailServices;
            try {
              ({ MailServices } = ChromeUtils.importESModule(
                "resource:///modules/MailServices.sys.mjs"
              ));
            } catch (e1) {
              try {
                ({ MailServices } = ChromeUtils.import(
                  "resource:///modules/MailServices.jsm"
                ));
              } catch (e2) {
                throw new Error("MailServices not available: " + e2);
              }
            }

            // If explicit drafts URI provided — use it directly
            if (draftsUri) {
              try {
                const folder = MailServices.folderLookup
                  ? MailServices.folderLookup.getFolderForURL(draftsUri)
                  : MailServices.msgFolderLookup
                    ? MailServices.msgFolderLookup.getFolderForURL(draftsUri)
                    : null;
                let draftsFolder = folder;
                if (!draftsFolder) {
                  // older API
                  const rdf = null;
                  draftsFolder = MailServices.folderLookup
                    ? MailServices.folderLookup.getFolderForURL(draftsUri)
                    : Cc["@mozilla.org/mail/folder-lookup;1"]
                        .getService(Ci.nsIFolderLookupService)
                        .getFolderForURL(draftsUri);
                }
                if (draftsFolder) {
                  // write mime to temp and copy (reuse code below by jumping)
                  const tmpFile = Cc["@mozilla.org/file/directory_service;1"]
                    .getService(Ci.nsIProperties)
                    .get("TmpD", Ci.nsIFile);
                  tmpFile.append("schedulesend-" + Date.now() + ".eml");
                  tmpFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
                  const fos = Cc[
                    "@mozilla.org/network/file-output-stream;1"
                  ].createInstance(Ci.nsIFileOutputStream);
                  fos.init(tmpFile, 0x02 | 0x08 | 0x20, 0o600, 0);
                  const cos = Cc[
                    "@mozilla.org/intl/converter-output-stream;1"
                  ].createInstance(Ci.nsIConverterOutputStream);
                  cos.init(fos, "UTF-8", 0, 0);
                  cos.writeString(mimeContent);
                  cos.close();

                  await new Promise((resolve, reject) => {
                    const listener = {
                      OnStartCopy() {},
                      OnProgress() {},
                      SetMessageKey() {},
                      GetMessageId() {
                        return null;
                      },
                      OnStopCopy(status) {
                        if ((status & 0x80000000) === 0) resolve();
                        else reject(new Error("Copy failed: " + status));
                      }
                    };
                    MailServices.copy.copyFileMessage(
                      tmpFile,
                      draftsFolder,
                      null,
                      true,
                      0,
                      "",
                      listener,
                      null
                    );
                  });
                  try {
                    tmpFile.remove(false);
                  } catch (e) {}
                  return {
                    ok: true,
                    folder: draftsFolder.URI,
                    account: accountKey || ""
                  };
                }
              } catch (e) {
                Cu.reportError("[ScheduleSend] draftsUri path failed: " + e);
                // fall through to account discovery
              }
            }

            // Prefer Local Folders Drafts when:
            // - accountKey is empty / "local"
            // - or account is type "none"
            // This preserves X-Send-Later-* headers (IMAP/Exchange strip them).
            let account = null;
            const allAccounts = MailServices.accounts.accounts;
            const accCount =
              allAccounts.length !== undefined
                ? allAccounts.length
                : allAccounts.Count
                  ? allAccounts.Count()
                  : 0;

            function getAcc(i) {
              if (allAccounts.queryElementAt) {
                return allAccounts.queryElementAt(i, Ci.nsIMsgAccount);
              }
              if (allAccounts[i]) return allAccounts[i];
              return allAccounts.GetElementAt(i).QueryInterface(Ci.nsIMsgAccount);
            }

            const wantLocal =
              !accountKey ||
              accountKey === "local" ||
              /local/i.test(String(accountKey));

            if (wantLocal) {
              try {
                const local = MailServices.accounts.localFoldersServer;
                if (local) {
                  // Find a synthetic account that owns local folders if possible
                  for (let i = 0; i < accCount; i++) {
                    const acc = getAcc(i);
                    if (acc.incomingServer === local) {
                      account = acc;
                      break;
                    }
                  }
                }
              } catch (e) {}
            }

            if (!account && accountKey) {
              for (let i = 0; i < accCount; i++) {
                const acc = getAcc(i);
                if (acc.key === accountKey) {
                  account = acc;
                  break;
                }
              }
            }

            if (!account) {
              for (let i = 0; i < accCount; i++) {
                const acc = getAcc(i);
                const server = acc.incomingServer;
                if (!server) continue;
                const type = server.type || "";
                if (type === "none") continue;
                if (
                  acc.defaultIdentity ||
                  (acc.identities && acc.identities.length)
                ) {
                  account = acc;
                  break;
                }
              }
            }
            if (!account) {
              account = MailServices.accounts.defaultAccount;
            }
            if (!account) {
              throw new Error("No mail account found");
            }

            const server = account.incomingServer;
            let draftsFolder = null;

            // Prefer Local Folders Drafts for scheduled / when wantLocal
            if (wantLocal) {
              try {
                const local = MailServices.accounts.localFoldersServer;
                draftsFolder = local.rootFolder.getFolderWithFlags(
                  Ci.nsMsgFolderFlags.Drafts
                );
              } catch (e) {}
            }

            if (!draftsFolder && server) {
              try {
                draftsFolder = server.rootMsgFolder.getFolderWithFlags(
                  Ci.nsMsgFolderFlags.Drafts
                );
              } catch (e) {}
            }

            if (!draftsFolder && server) {
              try {
                const root = server.rootMsgFolder;
                const enumerate = (folder) => {
                  if (
                    folder.getFlag &&
                    folder.getFlag(Ci.nsMsgFolderFlags.Drafts)
                  ) {
                    return folder;
                  }
                  if (folder.folders) {
                    for (const sub of folder.folders) {
                      const f = enumerate(sub);
                      if (f) return f;
                    }
                  }
                  return null;
                };
                draftsFolder = enumerate(root);
              } catch (e) {}
            }

            if (!draftsFolder) {
              try {
                const local = MailServices.accounts.localFoldersServer;
                draftsFolder = local.rootFolder.getFolderWithFlags(
                  Ci.nsMsgFolderFlags.Drafts
                );
              } catch (e) {}
            }

            if (!draftsFolder) {
              throw new Error("Drafts folder not found via XPCOM");
            }

            Cu.reportError(
              "[ScheduleSend] Using account=" +
                (account ? account.key : "?") +
                " drafts=" +
                draftsFolder.URI
            );

            // Ensure folder is a real file-backed folder for addMessage
            // Write MIME to temp file then copy
            const tmpFile = Cc["@mozilla.org/file/directory_service;1"]
              .getService(Ci.nsIProperties)
              .get("TmpD", Ci.nsIFile);
            tmpFile.append("schedulesend-" + Date.now() + ".eml");
            tmpFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);

            const fos = Cc[
              "@mozilla.org/network/file-output-stream;1"
            ].createInstance(Ci.nsIFileOutputStream);
            fos.init(tmpFile, 0x02 | 0x08 | 0x20, 0o600, 0);
            const cos = Cc[
              "@mozilla.org/intl/converter-output-stream;1"
            ].createInstance(Ci.nsIConverterOutputStream);
            cos.init(fos, "UTF-8", 0, 0);
            cos.writeString(mimeContent);
            cos.close();

            // Import via copy service
            await new Promise((resolve, reject) => {
              const copyService = MailServices.copy;
              const listener = {
                OnStartCopy() {},
                OnProgress() {},
                SetMessageKey() {},
                GetMessageId() {
                  return null;
                },
                OnStopCopy(status) {
                  if ((status & 0x80000000) === 0) {
                    resolve();
                  } else {
                    reject(new Error("Copy failed: " + status));
                  }
                }
              };

              // copyFileMessage(file, dstFolder, msgToReplace, isDraftOrTemplate, newMsgFlags, msgKeywords, listener, msgWindow)
              copyService.copyFileMessage(
                tmpFile,
                draftsFolder,
                null,
                true, // isDraftOrTemplate
                0,
                "",
                listener,
                null
              );
            });

            try {
              tmpFile.remove(false);
            } catch (e) {}

            return {
              ok: true,
              folder: draftsFolder.URI,
              account: account.key
            };
          } catch (e) {
            fail(e);
          }
        },

        async sendMimeMessage(
          accountKey,
          identityEmail,
          mimeContent,
          to,
          subject,
          cc,
          bcc
        ) {
          try {
            let MailServices;
            try {
              ({ MailServices } = ChromeUtils.importESModule(
                "resource:///modules/MailServices.sys.mjs"
              ));
            } catch (e1) {
              ({ MailServices } = ChromeUtils.import(
                "resource:///modules/MailServices.jsm"
              ));
            }

            let identity = null;
            let resolvedAccountKey = accountKey || "";
            const allAccounts = MailServices.accounts.accounts;
            const accCount =
              allAccounts.length !== undefined
                ? allAccounts.length
                : allAccounts.Count
                  ? allAccounts.Count()
                  : 0;
            function getAcc(i) {
              if (allAccounts.queryElementAt) {
                return allAccounts.queryElementAt(i, Ci.nsIMsgAccount);
              }
              if (allAccounts[i]) return allAccounts[i];
              return allAccounts
                .GetElementAt(i)
                .QueryInterface(Ci.nsIMsgAccount);
            }

            const wantEmail = (identityEmail || "").toLowerCase().trim();
            for (let i = 0; i < accCount; i++) {
              const acc = getAcc(i);
              if (accountKey && acc.key !== accountKey) continue;
              const ids = acc.identities;
              const idCount =
                ids.length !== undefined
                  ? ids.length
                  : ids.Count
                    ? ids.Count()
                    : 0;
              function getId(j) {
                if (ids.queryElementAt) {
                  return ids.queryElementAt(j, Ci.nsIMsgIdentity);
                }
                if (ids[j]) return ids[j];
                return ids.GetElementAt(j).QueryInterface(Ci.nsIMsgIdentity);
              }
              for (let j = 0; j < idCount; j++) {
                const id = getId(j);
                if (
                  !wantEmail ||
                  (id.email || "").toLowerCase() === wantEmail
                ) {
                  identity = id;
                  resolvedAccountKey = acc.key;
                  break;
                }
              }
              if (identity) break;
            }
            if (!identity) {
              const def = MailServices.accounts.defaultAccount;
              identity = def ? def.defaultIdentity : null;
              if (def) resolvedAccountKey = def.key;
            }
            if (!identity) {
              throw new Error("No identity for send");
            }

            const fields = Cc[
              "@mozilla.org/messengercompose/composefields;1"
            ].createInstance(Ci.nsIMsgCompFields);
            fields.from = identity.fullName
              ? '"' + identity.fullName + '" <' + identity.email + ">"
              : identity.email;
            fields.to = to || "";
            if (subject) fields.subject = subject;
            if (cc) fields.cc = cc;
            if (bcc) fields.bcc = bcc;

            // Write MIME to temp — keep until SMTP fully finishes
            const tmpFile = Cc["@mozilla.org/file/directory_service;1"]
              .getService(Ci.nsIProperties)
              .get("TmpD", Ci.nsIFile);
            tmpFile.append("schedulesend-out-" + Date.now() + ".eml");
            tmpFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);

            const fos = Cc[
              "@mozilla.org/network/file-output-stream;1"
            ].createInstance(Ci.nsIFileOutputStream);
            // PR_WRONLY | PR_CREATE_FILE | PR_TRUNCATE
            fos.init(tmpFile, 0x02 | 0x08 | 0x20, 0o600, 0);
            const cos = Cc[
              "@mozilla.org/intl/converter-output-stream;1"
            ].createInstance(Ci.nsIConverterOutputStream);
            cos.init(fos, "UTF-8", 0, 0);
            cos.writeString(mimeContent);
            cos.close();

            if (!tmpFile.exists() || tmpFile.fileSize < 10) {
              throw new Error(
                "Temp MIME file missing or empty: " +
                  tmpFile.path +
                  " size=" +
                  (tmpFile.exists() ? tmpFile.fileSize : -1)
              );
            }
            Cu.reportError(
              "[ScheduleSend] Temp MIME ready: " +
                tmpFile.path +
                " size=" +
                tmpFile.fileSize
            );

            const msgSend = Cc[
              "@mozilla.org/messengercompose/send;1"
            ].createInstance(Ci.nsIMsgSend);

            // nsMsgDeliverNow = 0
            const deliverMode = 0;

            const sendResult = await new Promise((resolve, reject) => {
              let finished = false;
              const finish = (ok, data) => {
                if (finished) return;
                finished = true;
                if (ok) resolve(data);
                else reject(data instanceof Error ? data : new Error(String(data)));
              };

              const listener = {
                QueryInterface(iid) {
                  if (
                    iid.equals(Ci.nsIMsgSendListener) ||
                    iid.equals(Ci.nsISupports)
                  ) {
                    return this;
                  }
                  throw Components.Exception("NS_ERROR_NO_INTERFACE", Components.results.NS_ERROR_NO_INTERFACE);
                },
                onStartSending(msgId, msgSize) {
                  Cu.reportError(
                    "[ScheduleSend] onStartSending id=" + msgId + " size=" + msgSize
                  );
                },
                onProgress(msgId, progress, progressMax) {},
                onStatus(msgId, msg) {},
                onStopSending(msgId, status, msg, returnFile) {
                  Cu.reportError(
                    "[ScheduleSend] onStopSending status=" +
                      status +
                      " msg=" +
                      msg +
                      " id=" +
                      msgId
                  );
                  // status 0 or NS_OK = success; high bit set = failure
                  if (!status || (status & 0x80000000) === 0) {
                    finish(true, {
                      ok: true,
                      messageId: msgId || null,
                      status: status,
                    });
                  } else {
                    finish(
                      false,
                      new Error(
                        "Send failed status=0x" +
                          (status >>> 0).toString(16) +
                          (msg ? " " + msg : "")
                      )
                    );
                  }
                },
                onGetDraftFolderURI(folderURI) {},
                onSendNotPerformed(msgId, status) {
                  finish(
                    false,
                    new Error("Send not performed status=" + status)
                  );
                },
              };

              try {
                // CRITICAL: deleteSendFileOnCompletion = false
                // so SMTP can still read the file; we clean up later
                const maybePromise = msgSend.sendMessageFile(
                  identity,
                  resolvedAccountKey || "",
                  fields,
                  tmpFile,
                  false, // do NOT delete file on completion
                  false,
                  deliverMode,
                  null,
                  listener,
                  null,
                  null
                );
                if (maybePromise && typeof maybePromise.then === "function") {
                  maybePromise.then(
                    () => {
                      // Promise resolved — wait a bit for onStopSending if it also fires
                      scheduleMs(500, () => finish(true, { ok: true, via: "promise" }));
                    },
                    (err) => finish(false, err)
                  );
                }
              } catch (e) {
                finish(false, e);
              }

              // Safety timeout 3 minutes
              scheduleMs(180000, () => {
                finish(
                  false,
                  new Error("Send timeout (180s) — SMTP may be blocked/proxy")
                );
              });
            });

            // Cleanup temp file after successful send
            try {
              if (tmpFile.exists()) tmpFile.remove(false);
            } catch (_) {}

            Cu.reportError(
              "[ScheduleSend] Silent send finished OK to=" +
                to +
                " via " +
                identity.email
            );
            return Object.assign(
              { ok: true, from: identity.email, to: to },
              sendResult || {}
            );
          } catch (e) {
            fail(e);
          }
        },

        async sendJob(
          identityEmail,
          accountKey,
          to,
          subject,
          body,
          cc,
          bcc,
          files
        ) {
          try {
            let MailServices;
            try {
              ({ MailServices } = ChromeUtils.importESModule(
                "resource:///modules/MailServices.sys.mjs"
              ));
            } catch (e1) {
              ({ MailServices } = ChromeUtils.import(
                "resource:///modules/MailServices.jsm"
              ));
            }

            // Resolve identity by email only
            let identity = null;
            let resolvedAccountKey = "";
            const allAccounts = MailServices.accounts.accounts;
            const accCount =
              allAccounts.length !== undefined
                ? allAccounts.length
                : allAccounts.Count
                  ? allAccounts.Count()
                  : 0;
            function getAcc(i) {
              if (allAccounts.queryElementAt)
                return allAccounts.queryElementAt(i, Ci.nsIMsgAccount);
              if (allAccounts[i]) return allAccounts[i];
              return allAccounts
                .GetElementAt(i)
                .QueryInterface(Ci.nsIMsgAccount);
            }
            const wantEmail = (identityEmail || "").toLowerCase().trim();
            for (let i = 0; i < accCount; i++) {
              const acc = getAcc(i);
              const ids = acc.identities;
              const idCount =
                ids.length !== undefined
                  ? ids.length
                  : ids.Count
                    ? ids.Count()
                    : 0;
              function getId(j) {
                if (ids.queryElementAt)
                  return ids.queryElementAt(j, Ci.nsIMsgIdentity);
                if (ids[j]) return ids[j];
                return ids.GetElementAt(j).QueryInterface(Ci.nsIMsgIdentity);
              }
              for (let j = 0; j < idCount; j++) {
                const id = getId(j);
                if (
                  wantEmail &&
                  (id.email || "").toLowerCase() === wantEmail
                ) {
                  identity = id;
                  resolvedAccountKey = acc.key;
                  break;
                }
              }
              if (identity) break;
            }
            if (!identity) {
              const def = MailServices.accounts.defaultAccount;
              identity = def ? def.defaultIdentity : null;
              if (def) resolvedAccountKey = def.key;
            }
            if (!identity) throw new Error("No identity for sendJob");

            Cu.reportError(
              "[ScheduleSend] sendJob identity=" +
                identity.email +
                " account=" +
                resolvedAccountKey +
                " smtp=" +
                (identity.smtpServerKey || "?")
            );

            const fields = Cc[
              "@mozilla.org/messengercompose/composefields;1"
            ].createInstance(Ci.nsIMsgCompFields);
            fields.from = identity.fullName
              ? '"' +
                identity.fullName.replace(/"/g, "") +
                '" <' +
                identity.email +
                ">"
              : identity.email;
            fields.to = to || "";
            if (subject) fields.subject = subject;
            if (cc) fields.cc = cc;
            if (bcc) fields.bcc = bcc;
            fields.forcePlainText = false;
            fields.useMultipartAlternative = false;

            // Attach files via nsIMsgAttachment + file URI
            const fileList = Array.isArray(files) ? files : [];
            const attNames = [];
            let ioService;
            try {
              ioService = Cc["@mozilla.org/network/io-service;1"].getService(
                Ci.nsIIOService
              );
            } catch (_) {
              ioService = Services.io;
            }
            for (const fpath of fileList) {
              if (!fpath) continue;
              const file = Cc["@mozilla.org/file/local;1"].createInstance(
                Ci.nsIFile
              );
              file.initWithPath(fpath);
              if (!file.exists() || !file.isFile()) {
                throw new Error("Attachment not found: " + fpath);
              }
              const att = Cc[
                "@mozilla.org/messengercompose/attachment;1"
              ].createInstance(Ci.nsIMsgAttachment);
              let uri = ioService.newFileURI(file);
              att.url = uri.spec;
              att.name = file.leafName;
              att.size = file.fileSize;
              att.temporary = false;
              fields.addAttachment(att);
              attNames.push(file.leafName);
              Cu.reportError(
                "[ScheduleSend] att " + file.leafName + " " + att.url
              );
            }

            // Пароль SMTP. Без окна Thunderbird не может его запросить, поэтому
            // тихая отправка обязана передать сохранённый пароль явно
            // (у createAndSendMessage это параметр aPassword).
            let smtpPassword = "";
            let smtpPasswordSource = "none";
            try {
              const smtpServer = MailServices.smtp.getServerByKey(
                identity.smtpServerKey || ""
              );
              if (smtpServer) {
                if (smtpServer.password) {
                  smtpPassword = String(smtpServer.password);
                  smtpPasswordSource = "server";
                } else {
                  const candidates = [
                    "smtp://" + (smtpServer.key || identity.smtpServerKey),
                    "smtp://" + smtpServer.hostname,
                    smtpServer.key || "",
                    smtpServer.hostname || "",
                  ];
                  for (const host of candidates) {
                    if (!host) continue;
                    try {
                      const logins = Services.logins.findLogins(
                        {},
                        host,
                        null,
                        null
                      );
                      if (logins && logins.length && logins[0].password) {
                        smtpPassword = String(logins[0].password);
                        smtpPasswordSource = "logins:" + host;
                        break;
                      }
                    } catch (_) {}
                  }
                }
                Cu.reportError(
                  "[ScheduleSend] smtp password " +
                    (smtpPassword
                      ? "found (" + smtpPasswordSource + ")"
                      : "NOT found") +
                    " for " +
                    (smtpServer.key || identity.smtpServerKey) +
                    " / " +
                    smtpServer.username
                );
              }
            } catch (e) {
              Cu.reportError("[ScheduleSend] smtp password lookup: " + e);
            }

            const msgSend = Cc[
              "@mozilla.org/messengercompose/send;1"
            ].createInstance(Ci.nsIMsgSend);

            // Plain text body → minimal HTML so UTF-8/Cyrillic survives createAndSendMessage
            const rawBody = body || "";
            function escapeHtml(s) {
              return String(s)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;");
            }
            const bodyText =
              "<html><body><pre style=\"font-family:sans-serif;white-space:pre-wrap;\">" +
              escapeHtml(rawBody) +
              "</pre></body></html>";
            Cu.reportError(
              "[ScheduleSend] body rawLen=" +
                rawBody.length +
                " preview=" +
                rawBody.slice(0, 60)
            );
            // nsMsgDeliverNow
            const deliverMode = 0;
            const compType = Ci.nsIMsgCompType
              ? Ci.nsIMsgCompType.New
              : 0;

            const result = await new Promise((resolve, reject) => {
              let finished = false;
              const finish = (ok, val) => {
                if (finished) return;
                finished = true;
                if (ok) resolve(val);
                else
                  reject(
                    val instanceof Error ? val : new Error(String(val))
                  );
              };

              const listener = {
                QueryInterface(iid) {
                  if (
                    iid.equals(Ci.nsIMsgSendListener) ||
                    iid.equals(Ci.nsISupports)
                  )
                    return this;
                  throw Components.Exception(
                    "NS_ERROR_NO_INTERFACE",
                    Components.results.NS_ERROR_NO_INTERFACE
                  );
                },
                onStartSending(msgId, msgSize) {
                  Cu.reportError(
                    "[ScheduleSend] createAndSend onStartSending id=" +
                      msgId +
                      " size=" +
                      msgSize
                  );
                },
                onProgress(msgId, progress, progressMax) {
                  Cu.reportError(
                    "[ScheduleSend] progress " +
                      progress +
                      "/" +
                      progressMax
                  );
                },
                onStatus(msgId, msg) {
                  Cu.reportError(
                    "[ScheduleSend] status " + msgId + " " + msg
                  );
                },
                onStopSending(msgId, status, msg, returnFile) {
                  const st = status >>> 0;
                  Cu.reportError(
                    "[ScheduleSend] createAndSend onStopSending status=0x" +
                      st.toString(16) +
                      " msg=" +
                      msg +
                      " id=" +
                      msgId
                  );
                  if (!status || (status & 0x80000000) === 0) {
                    finish(true, {
                      ok: true,
                      messageId: msgId || null,
                      status: st,
                    });
                  } else {
                    finish(
                      false,
                      new Error(
                        "Send failed 0x" +
                          st.toString(16) +
                          (msg ? ": " + msg : "")
                      )
                    );
                  }
                },
                onGetDraftFolderURI() {},
                onSendNotPerformed(msgId, status) {
                  Cu.reportError(
                    "[ScheduleSend] createAndSend onSendNotPerformed status=0x" +
                      (status >>> 0).toString(16)
                  );
                  finish(
                    false,
                    new Error(
                      "SMTP не выполнил отправку (0x" +
                        (status >>> 0).toString(16) +
                        ") — проверьте пароль и настройки исходящего сервера"
                    )
                  );
                },
              };

              try {
                // createAndSendMessage — builds MIME internally + SMTP
                const maybe = msgSend.createAndSendMessage(
                  null, // editor
                  identity,
                  resolvedAccountKey || "",
                  fields,
                  false, // isDigest
                  false, // dontDeliver
                  deliverMode,
                  null, // msgToReplace
                  "text/html",
                  bodyText,
                  null, // parentWindow — silent
                  null, // progress
                  listener,
                  smtpPassword, // password — без окна запросить его нельзя
                  null, // originalMsgURI
                  compType
                );
                if (maybe && typeof maybe.then === "function") {
                  // Промис резолвится на старте SMTP-сессии, а не на доставке:
                  // отказ аутентификации (535) приходит позже через листенер.
                  // Поэтому успех объявляем только после паузы, чтобы
                  // onSendNotPerformed / onStopSending успели сработать.
                  maybe.then(
                    () =>
                      scheduleMs(15000, () =>
                        finish(true, { ok: true, via: "promise" })
                      ),
                    (err) => finish(false, err)
                  );
                }
              } catch (e) {
                finish(false, e);
              }

              scheduleMs(180000, () => {
                finish(
                  false,
                  new Error("Send timeout 180s (SMTP/proxy?)")
                );
              });
            });

            Cu.reportError(
              "[ScheduleSend] createAndSend OK to=" +
                to +
                " via " +
                identity.email +
                " atts=" +
                attNames.join(",")
            );
            return Object.assign(
              {
                ok: true,
                from: identity.email,
                to: to,
                silent: true,
                attachments: attNames,
              },
              result || {}
            );
          } catch (e) {
            fail(e);
          }
        },


        async hideComposeWindows() {
          try {
            const wm = Cc["@mozilla.org/appshell/window-mediator;1"].getService(
              Ci.nsIWindowMediator
            );
            const enumerator = wm.getEnumerator("msgcompose");
            let n = 0;
            while (enumerator.hasMoreElements()) {
              const win = enumerator.getNext();
              try {
                // Move off-screen and shrink — do not close (send may need it)
                if (win.moveTo) win.moveTo(-32000, -32000);
                if (win.resizeTo) win.resizeTo(1, 1);
                if (win.setTimeout) {
                  // try minimize
                  try {
                    win.minimize();
                  } catch (_) {}
                }
                n++;
              } catch (e) {
                Cu.reportError("[ScheduleSend] hide window: " + e);
              }
            }
            // also try messengercompose via Services.wm if available
            return { ok: true, hidden: n };
          } catch (e) {
            fail(e);
          }
        },

        async readAppConfig() {
          try {
            // Resolve %APPDATA% or platform config dir
            let dir;
            try {
              const env = Cc["@mozilla.org/process/environment;1"].getService(
                Ci.nsIEnvironment
              );
              if (env.exists("APPDATA")) {
                dir = env.get("APPDATA");
              } else if (env.exists("HOME")) {
                dir = env.get("HOME") + "/.config";
              } else if (env.exists("XDG_CONFIG_HOME")) {
                dir = env.get("XDG_CONFIG_HOME");
              }
            } catch (_) {}
            if (!dir) {
              // fallback Windows-style via directory service
              try {
                const dirSvc = Cc["@mozilla.org/file/directory_service;1"].getService(
                  Ci.nsIProperties
                );
                // AppData/Roaming ≈ Home on some builds; try "Home"
                const home = dirSvc.get("Home", Ci.nsIFile);
                dir = home.path + "\\AppData\\Roaming";
              } catch (_) {}
            }
            if (!dir) throw new Error("Cannot resolve APPDATA");

            const path = dir + "\\schedule-send-cli\\config.json";
            // also try forward slashes for non-Windows
            const paths = [
              path,
              dir + "/schedule-send-cli/config.json",
            ];
            let lastErr = null;
            for (const p of paths) {
              try {
                const file = getFile(p);
                if (!file.exists()) continue;
                const fstream = Cc[
                  "@mozilla.org/network/file-input-stream;1"
                ].createInstance(Ci.nsIFileInputStream);
                fstream.init(file, -1, 0, 0);
                const cstream = Cc[
                  "@mozilla.org/intl/converter-input-stream;1"
                ].createInstance(Ci.nsIConverterInputStream);
                cstream.init(fstream, "UTF-8", 0, 0);
                let data = "";
                const str = {};
                while (cstream.readString(4096, str) !== 0) {
                  data += str.value;
                }
                cstream.close();
                const cfg = JSON.parse(data);
                Cu.reportError(
                  "[ScheduleSend] readAppConfig OK: " + p + " -> " + cfg.queueRoot
                );
                return cfg;
              } catch (e) {
                lastErr = e;
              }
            }
            throw lastErr || new Error("config.json not found under " + dir);
          } catch (e) {
            fail(e);
          }
        },

      }
    };
  }
};
