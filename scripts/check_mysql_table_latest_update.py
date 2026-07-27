#!/usr/bin/env python3
"""Check latest update time for every MySQL table.

This script reads MySQL connection settings from `.env` by default and
inspects each table in one or more databases. For each table it reports:
- table row count
- chosen "time-like" column
- MAX(value) of that column
- parsed datetime when value looks like epoch seconds/milliseconds

Usage examples:
  python scripts/check_mysql_table_latest_update.py
  python scripts/check_mysql_table_latest_update.py --databases stockml,stockml_exchange
  python scripts/check_mysql_table_latest_update.py --host 127.0.0.1 --port 3306 --user root --password xxx

Driver requirement (install one):
  pip install mysql-connector-python
  or
  pip install pymysql
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


PREFERRED_TIME_COLUMNS = [
    "time",
    "timestamp",
    "ts",
    "updated_at",
    "update_time",
    "modified_at",
    "created_at",
    "created_time",
    "event_time",
]

TIME_DATA_TYPES = {"timestamp", "datetime", "date", "time", "year"}
INT_DATA_TYPES = {"tinyint", "smallint", "mediumint", "int", "bigint", "decimal", "numeric", "float", "double"}


def load_env_file(path: str) -> Dict[str, str]:
    env: Dict[str, str] = {}
    if not os.path.exists(path):
        return env

    with open(path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if not key:
                continue
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            env[key] = value
    return env


class DBClient:
    def __init__(self, connection: Any, module_name: str) -> None:
        self.connection = connection
        self.module_name = module_name

    def query(self, sql: str, params: Sequence[Any] = ()) -> List[Tuple[Any, ...]]:
        cursor = self.connection.cursor()
        try:
            cursor.execute(sql, params)
            rows = cursor.fetchall()
            return rows
        finally:
            cursor.close()

    def close(self) -> None:
        self.connection.close()


def connect_mysql(host: str, port: int, user: str, password: str) -> DBClient:
    # Try mysql-connector-python first.
    try:
        import mysql.connector  # type: ignore

        conn = mysql.connector.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            connection_timeout=10,
            autocommit=True,
        )
        return DBClient(conn, "mysql-connector-python")
    except Exception:
        pass

    # Fallback to PyMySQL.
    try:
        import pymysql  # type: ignore

        conn = pymysql.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            connect_timeout=10,
            autocommit=True,
            charset="utf8mb4",
        )
        return DBClient(conn, "pymysql")
    except Exception as exc:
        raise RuntimeError(
            "No MySQL Python driver available. Install one with: "
            "pip install mysql-connector-python or pip install pymysql"
        ) from exc


def escape_identifier(name: str) -> str:
    return "`" + name.replace("`", "``") + "`"


def list_tables(client: DBClient, database: str) -> List[str]:
    rows = client.query(
        """
        SELECT TABLE_NAME
        FROM information_schema.tables
        WHERE table_schema = %s
          AND table_type = 'BASE TABLE'
        ORDER BY TABLE_NAME
        """,
        (database,),
    )
    return [str(r[0]) for r in rows]


def list_columns(client: DBClient, database: str, table: str) -> List[Tuple[str, str]]:
    rows = client.query(
        """
        SELECT COLUMN_NAME, DATA_TYPE
        FROM information_schema.columns
        WHERE table_schema = %s
          AND table_name = %s
        ORDER BY ORDINAL_POSITION
        """,
        (database, table),
    )
    return [(str(r[0]), str(r[1]).lower()) for r in rows]


def choose_time_column(columns: List[Tuple[str, str]]) -> Optional[Tuple[str, str]]:
    by_lower = {name.lower(): (name, dtype) for name, dtype in columns}

    for col in PREFERRED_TIME_COLUMNS:
        if col in by_lower:
            return by_lower[col]

    for name, dtype in columns:
        if dtype in TIME_DATA_TYPES:
            return (name, dtype)

    for name, dtype in columns:
        lname = name.lower()
        if ("time" in lname or "timestamp" in lname or lname.endswith("_ts")) and dtype in INT_DATA_TYPES:
            return (name, dtype)

    return None


def maybe_parse_epoch(value: Any) -> Optional[str]:
    if value is None:
        return None

    if isinstance(value, bool):
        return None

    if isinstance(value, (int, float)):
        numeric = float(value)
    elif isinstance(value, str) and re.fullmatch(r"\d+(\.\d+)?", value):
        numeric = float(value)
    else:
        return None

    # Heuristic for Unix timestamp in seconds / milliseconds.
    # seconds ~ 1e9..1e11, milliseconds ~ 1e12..1e14
    dt: Optional[datetime] = None
    if 1_000_000_000 <= numeric < 100_000_000_000:
        dt = datetime.fromtimestamp(numeric, tz=timezone.utc)
    elif 1_000_000_000_000 <= numeric < 100_000_000_000_000:
        dt = datetime.fromtimestamp(numeric / 1000.0, tz=timezone.utc)

    if dt is None:
        return None

    local_dt = dt.astimezone()
    return f"{local_dt.strftime('%Y-%m-%d %H:%M:%S %z')} (local), {dt.strftime('%Y-%m-%d %H:%M:%S %z')} (UTC)"


def normalize_value(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, datetime):
        local_dt = value.astimezone() if value.tzinfo else value
        return local_dt.strftime("%Y-%m-%d %H:%M:%S")
    return str(value)


def collect_database_report(client: DBClient, database: str) -> List[Dict[str, str]]:
    results: List[Dict[str, str]] = []
    for table in list_tables(client, database):
        columns = list_columns(client, database, table)
        selected = choose_time_column(columns)

        row: Dict[str, str] = {
            "database": database,
            "table": table,
            "rows": "-",
            "time_column": "-",
            "latest_raw": "-",
            "latest_parsed": "-",
        }

        if not selected:
            count_sql = f"SELECT COUNT(*) FROM {escape_identifier(database)}.{escape_identifier(table)}"
            count_rows = client.query(count_sql)
            row["rows"] = str(count_rows[0][0]) if count_rows else "0"
            results.append(row)
            continue

        column_name, _dtype = selected
        row["time_column"] = column_name

        latest_sql = (
            f"SELECT COUNT(*) AS cnt, MAX({escape_identifier(column_name)}) AS max_val "
            f"FROM {escape_identifier(database)}.{escape_identifier(table)}"
        )
        latest_rows = client.query(latest_sql)
        cnt = latest_rows[0][0] if latest_rows else 0
        max_val = latest_rows[0][1] if latest_rows else None

        row["rows"] = str(cnt)
        row["latest_raw"] = normalize_value(max_val)
        parsed = maybe_parse_epoch(max_val)
        row["latest_parsed"] = parsed if parsed else row["latest_raw"]
        results.append(row)

    return results


def print_report(rows: List[Dict[str, str]]) -> None:
    if not rows:
        print("No tables found.")
        return

    headers = ["database", "table", "rows", "time_column", "latest_raw", "latest_parsed"]
    widths = {h: len(h) for h in headers}

    for row in rows:
        for h in headers:
            widths[h] = max(widths[h], len(row.get(h, "")))

    line = " | ".join(h.ljust(widths[h]) for h in headers)
    sep = "-+-".join("-" * widths[h] for h in headers)

    print(line)
    print(sep)
    for row in rows:
        print(" | ".join(row.get(h, "").ljust(widths[h]) for h in headers))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check latest update time for each MySQL table")
    parser.add_argument("--env-file", default=".env", help="Path to .env file (default: .env)")
    parser.add_argument("--host", help="MySQL host (default from MYSQL_HOST / MYSQL_HOST_EXCHANGE)")
    parser.add_argument("--port", type=int, help="MySQL port (default from MYSQL_PORT / MYSQL_PORT_EXCHANGE / 3306)")
    parser.add_argument("--user", help="MySQL user (default from MYSQL_USER / MYSQL_USER_EXCHANGE)")
    parser.add_argument("--password", help="MySQL password (default from MYSQL_PASS / MYSQL_PASS_EXCHANGE)")
    parser.add_argument(
        "--databases",
        help="Comma-separated database list. Default uses MYSQL_DB and MYSQL_DB_EXCHANGE from env.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    file_env = load_env_file(args.env_file)

    merged_env = dict(file_env)
    for k, v in os.environ.items():
        merged_env[k] = v

    host = args.host or merged_env.get("MYSQL_HOST") or merged_env.get("MYSQL_HOST_EXCHANGE") or "127.0.0.1"
    port = args.port or int(merged_env.get("MYSQL_PORT") or merged_env.get("MYSQL_PORT_EXCHANGE") or "3306")
    user = args.user or merged_env.get("MYSQL_USER") or merged_env.get("MYSQL_USER_EXCHANGE")
    password = args.password or merged_env.get("MYSQL_PASS") or merged_env.get("MYSQL_PASS_EXCHANGE")

    if not user:
        print("Missing MySQL user. Provide --user or set MYSQL_USER / MYSQL_USER_EXCHANGE.", file=sys.stderr)
        return 2

    if password is None:
        print("Missing MySQL password. Provide --password or set MYSQL_PASS / MYSQL_PASS_EXCHANGE.", file=sys.stderr)
        return 2

    if args.databases:
        databases = [d.strip() for d in args.databases.split(",") if d.strip()]
    else:
        candidates = [merged_env.get("MYSQL_DB"), merged_env.get("MYSQL_DB_EXCHANGE")]
        databases = []
        for db in candidates:
            if db and db not in databases:
                databases.append(db)

    if not databases:
        print("No target databases found. Provide --databases or set MYSQL_DB / MYSQL_DB_EXCHANGE.", file=sys.stderr)
        return 2

    try:
        client = connect_mysql(host=host, port=port, user=user, password=password)
    except Exception as exc:
        print(f"Failed to connect MySQL: {exc}", file=sys.stderr)
        return 1

    print(f"Connected via: {client.module_name}")
    print(f"Host: {host}:{port}")
    print(f"Databases: {', '.join(databases)}")
    print()

    all_rows: List[Dict[str, str]] = []
    for db in databases:
        try:
            all_rows.extend(collect_database_report(client, db))
        except Exception as exc:
            print(f"Failed while scanning database '{db}': {exc}", file=sys.stderr)

    client.close()

    all_rows.sort(key=lambda x: (x["database"], x["table"]))
    print_report(all_rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
