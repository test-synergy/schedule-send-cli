<p align="center">
  <img src="docs/icon.png" width="200" alt="Schedule Send CLI">
</p>

<h1 align="center">Schedule Send CLI</h1>

<p align="center">
  Scheduled email sending from Thunderbird — in bulk, from the command line.
</p>

<p align="center">
  <a href="README.md">Русский</a> ·
  <strong>English</strong>
</p>

<p align="center">
  <a href="https://github.com/test-synergy/schedule-send-cli">Repository</a> ·
  <a href="https://github.com/test-synergy/schedule-send-cli/releases/latest">Download .xpi</a> ·
  <a href="https://github.com/test-synergy/schedule-send-cli/tree/main/dist">dist/</a>
</p>

## Contents

- [Why this exists](#why-this-exists)
- [How Schedule Send CLI works](#how-schedule-send-cli-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Examples](#examples)
- [Commands](#commands)
- [Job format](#job-format)
- [Scheduling: now, past, future](#scheduling-now-past-future)
- [Folders and states](#folders-and-states)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Repository layout](#repository-layout)
- [License](#license)

## Why this exists

CLI stands for Command Line Interface: Schedule Send CLI is controlled by text commands in `cmd` or PowerShell, with no buttons and no windows.

Thunderbird cannot send a message later — it has no such feature. A message is either sent immediately or stays in Drafts until someone sends it by hand.

Schedule Send CLI adds that feature. A job is a single command: recipients, subject, body, attachments, date and time. Thunderbird performs the actual send at the appointed moment.

Sending can be done in bulk. One `batch` command queues dozens of letters, each with its own recipients, subject, attachments and time — all from the command line, with no manual work in the mail client's interface.

```bash
python send_job.py add --to "client@example.com" \
    --subject "Monthly report" \
    --body "Hello, the report is attached." \
    --file "C:\Reports\report-2026-10.pdf" \
    --datetime "2026-11-01 09:00" \
    --from "me@company.com"
```

## How Schedule Send CLI works

```
send_job.py add  ──►  queue/<id>.json  ──►  Schedule Send CLI (polls every 10 s)
                                                    │
                    ┌───────────────────────────────┼───────────────────────────────┐
                    │                               │                               │
              no datetime                    time has passed                time in the future
                    │                               │                               │
              draft only                     sent immediately             scheduled/<id>.json
                                                                                    │
                                                                            timer + draft
                                                                                    │
                                                                            sent on schedule
```

1. `send_job.py` validates addresses, the date and attachments, then writes a JSON job into `queue/`.
2. It also writes `config.json` into the user profile — that is how Schedule Send CLI finds the folder.
3. Schedule Send CLI reads the jobs, sends the mail through Thunderbird's internal API (`nsIMsgSend`) and moves processed files to `done/` or `error/`.

The script and Schedule Send CLI talk to each other through files only. No sockets, no services, no administrator rights.

## Requirements

- Windows (paths and configuration assume it).
- Thunderbird 115 or newer.
- Python 3.8+ for the `send_job.py` script.
- A mail account in Thunderbird with a working SMTP server: Schedule Send CLI sends on behalf of an existing account.

## Installation

### 1. Schedule Send CLI

Download the add-on: [**schedule-send-cli-0.6.6.xpi**](https://github.com/test-synergy/schedule-send-cli/releases/download/v0.6.6/schedule-send-cli-0.6.6.xpi) — the same file lives in the repository: [`dist/schedule-send-cli-0.6.6.xpi`](https://github.com/test-synergy/schedule-send-cli/blob/main/dist/schedule-send-cli-0.6.6.xpi).

1. Open the add-on installer:

   - English interface: `Tools → Add-ons and Themes → gear (⚙) → Install Add-on From File…`
   - Russian interface: `Инструменты → Дополнения и темы → шестерёнка (⚙) → Установить дополнение из файла…`

2. Select the downloaded `schedule-send-cli-0.6.6.xpi`.
3. Restart Thunderbird.

Schedule Send CLI is not signed by Mozilla, so installing from a file requires a profile that allows unsigned add-ons (or loading it through `about:debugging` as a temporary add-on — but then Schedule Send CLI disappears on restart).

### 2. The `send_job.py` script

Download the script from the release: [**send_job.py**](https://github.com/test-synergy/schedule-send-cli/releases/download/v0.6.6/send_job.py) — it is also in the repository: [`send_job.py`](https://github.com/test-synergy/schedule-send-cli/blob/main/send_job.py).

Copy it into any permanent folder — that folder becomes the queue root:

```
C:\Users\<you>\Documents\schedule-send\
└── send_job.py
```

Run it once:

```bash
python send_job.py where
```

The command creates `queue/`, `scheduled/`, `done/`, `error/` and `config.json`, which Schedule Send CLI uses to locate the queue.

> Important: the queue is bound to the folder containing the script. Do not keep two copies of `send_job.py` in different folders — every run rewrites `config.json` to point at its own folder, and the queue "moves".

## Quick start

```bash
# a single message in ten minutes
python send_job.py add --to "user@example.com" --subject "Test" \
    --body "Hello" --datetime "2026-11-01 10:00"

# several recipients, a CC and an attachment
python send_job.py add --to "a@example.com, b@example.com" \
    --cc "boss@example.com" --subject "Report" --body "Attached" \
    --file "C:\Reports\report.pdf" --datetime "2026-11-01 18:00" \
    --from "me@company.com"

# where everything lives
python send_job.py where

# a batch of jobs from JSON
python send_job.py batch examples/schedule.example.json
```

## Examples

All commands run from the folder containing `send_job.py`. Thunderbird must be running — Schedule Send CLI lives inside it.

### 1. The simplest case: one message to one recipient

```bash
python send_job.py add --to "client@example.com" --subject "Meeting moved" --body "Hello! The meeting has been moved to 15:00." --datetime "2026-11-06 09:00"
```

The job lands in `queue/`, Schedule Send CLI picks it up within 10 seconds, sets a timer for 09:00 and creates a draft. At 09:00 the message goes out and the draft disappears.

Script output:

```
OK: job written -> C:\schedule-send\queue\20261105-182000-1a2b3c4d.json
Queue root: C:\schedule-send
To:  client@example.com
Scheduled for: 2026-11-06 09:00
Thunderbird должен быть запущен с Schedule Send CLI.
```

If you pass a date in the past, the script warns you and the message is sent immediately.

### 2. A message with one attachment

```bash
python send_job.py add --to "client@example.com" --subject "October report" --body "Hello, the report is attached." --file "C:\Reports\october-2026.pdf" --datetime "2026-11-06 10:00"
```

### 3. A message with several attachments

```bash
python send_job.py add --to "client@example.com" --subject "Deal documents" --body "Contract, invoice and act are attached." --file "C:\Reports\contract.docx" --file "C:\Reports\invoice.xlsx" --file "C:\Reports\act.pdf" --datetime "2026-11-06 10:30"
```

Repeat `--file` once per attachment. Quote paths containing spaces; a network drive (`I:\Clip\file.pdf`) works as long as it is available at send time. Files are validated up front: a missing or empty file means no job is created and an `ERROR` is printed.

### 4. Several recipients, with CC and BCC

```bash
python send_job.py add --to "a@example.com, b@example.com" --cc "boss@example.com" --bcc "archive@example.com" --subject "October report" --body "Colleagues, the report is attached." --file "C:\Reports\october-2026.pdf" --datetime "2026-11-06 11:00"
```

Everyone receives one message: `a` and `b` see each other in To, `boss` is in CC, `archive` is hidden.

Separate addresses with a comma or a semicolon, or just spaces: `--to a@example.com b@example.com`.

### 5. Sending from a different account

```bash
python send_job.py add --to "client@example.com" --subject "Invoice" --body "The invoice is attached." --file "C:\Reports\invoice.pdf" --datetime "2026-11-06 12:00" --from "billing@company.com"
```

The `--from` address must match an account configured in Thunderbird. Otherwise Schedule Send CLI sends from the default account.

### 6. A draft for review, without sending

Drop `--datetime` — nothing is sent, and the message appears in Drafts ready for editing:

```bash
python send_job.py add --to "a@example.com, b@example.com" --subject "Draft report" --body "Please review the wording." --file "C:\Reports\october-2026.pdf"
```

You can then edit and send it by hand, or queue the job again — this time with `--datetime`.

### 7. A batch of different messages from JSON

One file holds many jobs, each with its own recipients, subject and time. A ready sample is in [`examples/schedule.example.json`](examples/schedule.example.json).

```bash
python send_job.py batch examples/schedule.example.json
```

Output per job:

```
OK #1: 20261105-182000-aaaa1111.json -> client-a@example.com, client-b@example.com / October report
OK #2: 20261105-182000-bbbb2222.json -> client-c@example.com / Reminder
Итого в очередь: 2
```

The element format is described in [Job format](#job-format).

### 8. Bulk sending from a table

When there are dozens of recipients, keep the list in a CSV. The repository ships a ready script and a sample table:

- [`examples/bulk-from-csv.ps1`](examples/bulk-from-csv.ps1)
- [`examples/clients.csv`](examples/clients.csv)

```powershell
.\examples\bulk-from-csv.ps1 -Csv .\examples\clients.csv -Datetime "2026-11-01 09:00" -From "me@company.com"
```

The script reads the `email`, `subject`, `body` and `attachment` columns and calls `send_job.py add` for each row, then reports how many jobs were queued and how many failed validation.

To send the same message to everyone at once, one command with a list of addresses is enough:

```bash
python send_job.py add --to "a@example.com, b@example.com, c@example.com" --subject "October report" --body "Attached." --file "C:\Reports\october-2026.pdf" --datetime "2026-11-06 09:00"
```

Recipients see each other in the To field. To keep addresses private, list them in `--bcc`.

### 9. Checking that everything is queued

```bash
python send_job.py where
```

The command prints the queue and config paths. Then look into `queue/`: a fresh JSON file stays there only briefly — about 10 seconds — before moving to `done/` (success) or `error/` (failure, with an error file next to it).

### Common mistakes

| Message | Cause | Fix |
|---|---|---|
| `usage: … unrecognized arguments: b@example.com` | addresses separated by a space outside quotes, on an older script version | use `send_job.py` from this repository, or quote: `--to "a, b"` |
| `Некорректный адрес … пропущена зона` | typo in the domain: `user@company` instead of `user@company.com` | fix the address |
| `Файл вложения не найден` | wrong path, or the network drive is unavailable | check the file in Explorer |
| `Неверный формат даты/времени` | the format must be `YYYY-MM-DD HH:MM` | `--datetime "2026-11-06 09:00"` |
| `WARNING: время … уже прошло` | the date is in the past | the message is sent immediately; use a future time to schedule |

## Commands

| Command | What it does |
|---|---|
| `add` | Queues a single message for Schedule Send CLI |
| `batch <file.json>` | Queues a set of jobs from a JSON file |
| `where` | Prints the queue and config paths |

`add` parameters:

| Parameter | Required | Description |
|---|---|---|
| `--to` | yes | Recipients: `"a@x.com, b@x.com"` or `"a@x.com" "b@x.com"` |
| `--subject` | no | Subject |
| `--body` | no | Message body |
| `--file` | no | Attachment; repeatable |
| `--datetime` | no | `"YYYY-MM-DD HH:MM"`; without it only a draft is created |
| `--cc`, `--bcc` | no | Carbon copy and blind carbon copy, also lists |
| `--from` | no | Sender address — must match an account in Thunderbird |
| `--identity` | no | Explicit identity id instead of `--from` |

## Job format

One message is one JSON file in `queue/`:

```json
{
  "to": "a@example.com, b@example.com",
  "cc": "boss@example.com",
  "subject": "Report",
  "body": "Hello, the report is attached.",
  "files": ["C:\\Reports\\report.pdf"],
  "datetime": "2026-11-01 18:00",
  "from": "me@company.com"
}
```

A batch file is an array of such objects; see [examples/schedule.example.json](examples/schedule.example.json).

## Scheduling: now, past, future

| `--datetime` value | Schedule Send CLI behaviour |
|---|---|
| Not set | A silent draft is created, nothing is sent |
| In the past or "now" | The script warns, the message is sent immediately |
| In the future | The job is stored, a timer is armed, a draft is created |
| Less than 15 seconds away at processing time | Sent immediately, without a timer |

Thunderbird must be running at send time — the timer lives inside it.

## Folders and states

| Folder | Contents |
|---|---|
| `queue/` | Jobs waiting to be processed (Schedule Send CLI picks them up within ~10 seconds) |
| `scheduled/` | Scheduled jobs until their time comes |
| `done/` | Processed jobs plus `<name>.result.json` with the status |
| `error/` | Jobs Schedule Send CLI failed on, plus the error text |

An empty `queue/` is normal, not a failure: files move to `done/` or `error/` quickly.

## Troubleshooting

**The message was not sent and `error/` is empty.** Check that Thunderbird is running and Schedule Send CLI is enabled (`Ctrl+Shift+A`), then open the error console (`Ctrl+Shift+J`, filter `ScheduleSend`) — every processing stage is logged there.

**`535 authentication failed`.** SMTP rejected the password. Schedule Send CLI sends without a compose window, so the password must be stored in Thunderbird (tick "Use Password Manager to remember this password" when prompted). Also check the username and authentication method in the outgoing server settings.

**`connection to the SMTP server timed out`.** The network could not reach SMTP: VPN, proxy or a filter. Manual sending from Thunderbird fails at the same moment.

**The job sits in `queue/` and is never processed.** Schedule Send CLI is not running or is looking at another folder. Compare the path in `config.json` with the script folder: a second copy of `send_job.py` rewrites the config when run.

**Attachment not found.** The path must be reachable by the Thunderbird process at send time; network drives disconnect when the session is idle.

## Limitations

- Thunderbird must be running at send time.
- No automatic retries on SMTP failure: the error is recorded in `error/` and the draft stays in Drafts.
- The queue and paths assume Windows.
- The sending account must exist in Thunderbird; otherwise the message goes out from the default account.

## Repository layout

```
schedule-send-cli/
├── send_job.py                 # command line client
├── extension/                  # Schedule Send CLI sources for Thunderbird
│   ├── manifest.json
│   ├── background.js           # scheduler and queue processing
│   ├── experiments/fileio/     # XPCOM experiment: files and silent sending
│   └── icons/
├── dist/                       # built .xpi
├── docs/                       # icons and previews
└── examples/                   # batch and CSV examples
```

## License

The code is released under the MIT license — see [LICENSE](LICENSE).

The project is not affiliated with the Mozilla Foundation. Thunderbird is a trademark of Mozilla. The icon is an original stylization, not the official logo.
