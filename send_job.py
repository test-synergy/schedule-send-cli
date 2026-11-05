#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CLI для постановки писем в очередь Schedule Send CLI.

Корень очереди = папка, где лежит этот скрипт (queue/, scheduled/, done/, error/).
Путь также записывается в %APPDATA%\\schedule-send-cli\\config.json
чтобы расширение Thunderbird нашло ту же папку.

Примеры:

  python send_job.py add --to "user@mail.ru" --subject "Документы" --body "Текст" --file "report.pdf" --datetime "2026-10-31 09:30" --from "me@company.ru"

  python send_job.py add --to "a@mail.ru, b@mail.ru" --cc "boss@mail.ru" --subject "Документы" --body "Текст" --datetime "2026-10-31 09:30"

  python send_job.py where
  python send_job.py batch schedule.json
"""

import argparse
import json
import os
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path

# Корень = каталог со скриптом (переносимо на любой ПК)
ROOT = Path(__file__).resolve().parent
QUEUE_DIR = ROOT / "queue"
DONE_DIR = ROOT / "done"
ERROR_DIR = ROOT / "error"
SCHEDULED_DIR = ROOT / "scheduled"

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def config_path() -> Path:
    """Куда расширение смотрит за путём к очереди."""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        base = str(Path.home() / "Library" / "Application Support")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "schedule-send-cli" / "config.json"


def write_config():
    """Сообщить расширению, где лежит очередь."""
    cfg = {
        "queueRoot": str(ROOT),
        "queueDir": str(QUEUE_DIR),
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
    }
    p = config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return p


def ensure_dirs():
    for d in (QUEUE_DIR, DONE_DIR, ERROR_DIR, SCHEDULED_DIR):
        d.mkdir(parents=True, exist_ok=True)
    write_config()


def write_job(job: dict) -> Path:
    ensure_dirs()
    job_id = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    path = QUEUE_DIR / f"{job_id}.json"
    path.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def check_email(value: str, field: str) -> str:
    v = (value or "").strip()
    if not v:
        die(f"Не указан адрес: {field}")
    # допускаем "Name <email@x.ru>" и просто email
    m = re.search(r"<([^>]+)>", v)
    addr = (m.group(1) if m else v).strip()
    if not EMAIL_RE.match(addr):
        msg = f"Некорректный адрес ({field}): «{value}». Нужен вид user@domain.ru"
        domain = addr.rsplit("@", 1)[1] if "@" in addr else ""
        if domain and "." not in domain:
            msg += (
                f"\n  Похоже, в домене «{domain}» пропущена зона "
                f"— например {domain}.ru"
            )
        die(msg)
    return v


def split_addresses(value: str) -> list:
    """Разбить строку адресов по ',' или ';' вне кавычек и угловых скобок."""
    parts, buf, in_quote, in_angle = [], [], False, False
    for ch in value or "":
        if ch == '"':
            in_quote = not in_quote
            buf.append(ch)
        elif ch == "<" and not in_quote:
            in_angle = True
            buf.append(ch)
        elif ch == ">" and not in_quote:
            in_angle = False
            buf.append(ch)
        elif ch in ",;" and not in_quote and not in_angle:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    parts.append("".join(buf))
    return [p.strip() for p in parts if p.strip()]


def iter_chunks(value):
    """Развернуть вложенные списки аргументов (--to a b / --to "a, b")."""
    if value is None:
        return
    if isinstance(value, str):
        yield value
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from iter_chunks(item)


def check_email_list(value, field: str) -> str:
    """Проверить список адресов; вернуть нормализованную строку через ', '.

    Принимает строку, несколько аргументов подряд и повторённый флаг:
    «a@x.ru, b@y.ru», «a@x.ru b@y.ru», «Имя <a@x.ru>, b@y.ru».
    """
    addrs = []
    for chunk in iter_chunks(value):
        addrs.extend(split_addresses(str(chunk)))
    if not addrs:
        die(f"Не указан адрес: {field}")
    return ", ".join(check_email(a, field) for a in addrs)


def check_datetime(value: str) -> str:
    s = (value or "").strip()
    if not s:
        die("Пустая дата/время. Пример: \"2026-10-31 09:30\"")
    m = re.match(
        r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$",
        s,
    )
    if not m:
        die(
            f"Неверный формат даты/времени: «{value}».\n"
            f"  Нужно: ГГГГ-ММ-ДД ЧЧ:ММ  или  ГГГГ-ММ-ДД ЧЧ:ММ:СС\n"
            f"  Пример: \"2026-10-31 09:30\""
        )
    y, mo, d, h, mi, sec = (
        int(m.group(1)),
        int(m.group(2)),
        int(m.group(3)),
        int(m.group(4)),
        int(m.group(5)),
        int(m.group(6) or 0),
    )
    try:
        dt = datetime(y, mo, d, h, mi, sec)
    except ValueError as e:
        die(f"Несуществующая дата/время «{value}»: {e}")

    now = datetime.now()
    if dt < now:
        delta = now - dt
        mins = int(delta.total_seconds() // 60)
        if mins < 60:
            ago = f"{mins} мин. назад"
        elif mins < 24 * 60:
            ago = f"{mins // 60} ч. назад"
        else:
            ago = f"{mins // (24 * 60)} дн. назад"
        print(
            f"WARNING: время «{value}» уже прошло ({ago}). "
            f"Thunderbird отправит письмо сразу, черновик для расписания не создаст.",
            file=sys.stderr,
        )
    return s


def check_files(paths: list) -> list:
    out = []
    for raw in paths or []:
        p = Path(raw)
        if not p.is_file():
            die(
                f"Файл вложения не найден: «{raw}»\n"
                f"  Проверьте путь и права доступа. "
                f"Thunderbird должен иметь доступ к этому диску/папке."
            )
        if p.stat().st_size == 0:
            die(f"Файл вложения пустой (0 байт): «{raw}»")
        out.append(str(p.resolve()) if p.exists() else str(p))
    return out


def cmd_where(_args):
    ensure_dirs()
    print(f"ROOT (папка скрипта): {ROOT}")
    print(f"queue:               {QUEUE_DIR}")
    print(f"scheduled:           {SCHEDULED_DIR}")
    print(f"done:                {DONE_DIR}")
    print(f"error:               {ERROR_DIR}")
    print(f"config for addon:    {config_path()}")


def cmd_add(args):
    # --- валидация до записи в очередь ---
    to_addr = check_email_list(args.to, "получатель (--to)")
    cc_addr = check_email_list(args.cc, "копия (--cc)") if args.cc else None
    bcc_addr = check_email_list(args.bcc, "скрытая копия (--bcc)") if args.bcc else None
    from_addr = None
    if getattr(args, "from_addr", None):
        from_addr = check_email(args.from_addr, "отправитель (--from)")

    files = check_files(list(args.file or []))

    dt = None
    if args.datetime:
        dt = check_datetime(args.datetime)

    job = {
        "to": to_addr,
        "subject": args.subject or "",
        "body": args.body or "",
        "files": files,
    }
    if dt:
        job["datetime"] = dt
    if cc_addr:
        job["cc"] = cc_addr
    if bcc_addr:
        job["bcc"] = bcc_addr
    if args.identity:
        job["identityId"] = args.identity
    if from_addr:
        job["from"] = from_addr

    try:
        path = write_job(job)
    except OSError as e:
        die(f"Не удалось записать задание в очередь ({QUEUE_DIR}): {e}")

    print(f"OK: job written -> {path}")
    print(f"Queue root: {ROOT}")
    print(f"To:  {to_addr}")
    if cc_addr:
        print(f"Cc:  {cc_addr}")
    if bcc_addr:
        print(f"Bcc: {bcc_addr}")
    if dt:
        print(f"Scheduled for: {dt}")
    if files:
        print(f"Attachments: {len(files)}")
        for f in files:
            print(f"  - {f}")
    print("Thunderbird должен быть запущен с Schedule Send CLI.")


def cmd_batch(args):
    src = Path(args.json_file)
    if not src.is_file():
        die(f"Файл не найден: {src}")

    try:
        data = json.loads(src.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        die(f"Некорректный JSON в {src}: {e}")

    if not isinstance(data, list):
        die("JSON должен быть массивом заданий (list of jobs)")

    ok = 0
    for i, job in enumerate(data, 1):
        if not isinstance(job, dict):
            print(f"SKIP #{i}: элемент не объект", file=sys.stderr)
            continue
        if "to" not in job or not str(job.get("to") or "").strip():
            print(f"SKIP #{i}: отсутствует 'to'", file=sys.stderr)
            continue
        try:
            check_email_list(str(job["to"]), "to")
        except SystemExit:
            print(f"SKIP #{i}: некорректный to={job.get('to')!r}", file=sys.stderr)
            continue

        if "attachments" in job and "files" not in job:
            job["files"] = job.pop("attachments")

        # проверить вложения, если есть
        if job.get("files"):
            missing = [f for f in job["files"] if not Path(f).is_file()]
            if missing:
                print(
                    f"SKIP #{i}: файлы не найдены: {', '.join(missing)}",
                    file=sys.stderr,
                )
                continue

        if job.get("datetime"):
            try:
                check_datetime(str(job["datetime"]))
            except SystemExit:
                print(
                    f"SKIP #{i}: неверная дата «{job.get('datetime')}»",
                    file=sys.stderr,
                )
                continue

        path = write_job(job)
        ok += 1
        print(f"OK #{i}: {path.name} -> {job.get('to')} / {job.get('subject', '')}")

    if ok == 0:
        die("Ни одно задание не поставлено в очередь")
    print(f"Итого в очередь: {ok}")


def main():
    parser = argparse.ArgumentParser(
        description="Schedule Send CLI — очередь в папке со скриптом"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="Добавить одно письмо")
    p_add.add_argument(
        "--to",
        required=True,
        action="append",
        nargs="+",
        help='Кому: "a@x.ru, b@y.ru" или "a@x.ru" "b@y.ru"',
    )
    p_add.add_argument("--subject", default="", help="Тема")
    p_add.add_argument("--body", default="", help="Текст письма")
    p_add.add_argument(
        "--file", action="append", default=[], help="Вложение (можно несколько раз)"
    )
    p_add.add_argument(
        "--datetime",
        default=None,
        help='Когда отправить, например "2026-10-31 09:30"',
    )
    p_add.add_argument(
        "--cc",
        default=None,
        action="append",
        nargs="+",
        help='Копия: "a@x.ru, b@y.ru" или "a@x.ru" "b@y.ru"',
    )
    p_add.add_argument(
        "--bcc",
        default=None,
        action="append",
        nargs="+",
        help='Скрытая копия: "a@x.ru, b@y.ru" или "a@x.ru" "b@y.ru"',
    )
    p_add.add_argument("--identity", default=None, help="identityId (опционально)")
    p_add.add_argument(
        "--from", dest="from_addr", default=None, help="Email отправителя"
    )
    p_add.set_defaults(func=cmd_add)

    p_batch = sub.add_parser("batch", help="Пакет из JSON-файла")
    p_batch.add_argument("json_file", help="Путь к schedule.json")
    p_batch.set_defaults(func=cmd_batch)

    p_where = sub.add_parser("where", help="Показать пути очереди и конфига")
    p_where.set_defaults(func=cmd_where)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
