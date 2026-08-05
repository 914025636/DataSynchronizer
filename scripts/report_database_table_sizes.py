#!/usr/bin/env python3
"""Print per-table sizes for QuestDB and MySQL using settings from .env."""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any, Dict, List, Sequence, Tuple

from check_mysql_table_latest_update import DBClient, connect_mysql, load_env_file


def format_bytes(value: int) -> str:
    size = float(value)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(size) < 1024 or unit == "TiB":
            return f"{size:.2f} {unit}"
        size /= 1024
    return f"{size:.2f} TiB"


def print_table(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> None:
    text_rows = [[str(value) for value in row] for row in rows]
    widths = [len(header) for header in headers]
    for row in text_rows:
        for index, value in enumerate(row):
            widths[index] = max(widths[index], len(value))

    print(" | ".join(header.ljust(widths[index]) for index, header in enumerate(headers)))
    print("-+-".join("-" * width for width in widths))
    for row in text_rows:
        print(" | ".join(value.ljust(widths[index]) for index, value in enumerate(row)))


def mysql_report(client: DBClient, database: str) -> Tuple[List[Tuple[Any, ...]], int]:
    rows = client.query(
        """
        SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH,
               DATA_LENGTH + INDEX_LENGTH AS TOTAL_BYTES
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = %s AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TOTAL_BYTES DESC, TABLE_NAME
        """,
        (database,),
    )
    total = sum(int(row[4] or 0) for row in rows)
    return rows, total


def connect_questdb(environment: Dict[str, str]) -> DBClient:
    host = environment.get("QUESTDB_SQL_HOST", environment.get("QUESTDB_HOST", "127.0.0.1"))
    port = int(environment.get("QUESTDB_SQL_PORT", "18812"))
    user = environment.get("QUESTDB_SQL_USER", "admin")
    password = environment.get("QUESTDB_SQL_PASSWORD", "quest")
    database = environment.get("QUESTDB_SQL_DATABASE", "qdb")

    try:
        import psycopg  # type: ignore

        connection = psycopg.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            dbname=database,
            connect_timeout=10,
        )
        return DBClient(connection, "psycopg")
    except ImportError:
        try:
            import psycopg2  # type: ignore
        except ImportError as exc:
            raise RuntimeError("Install psycopg or psycopg2-binary to query QuestDB") from exc

        connection = psycopg2.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            dbname=database,
            connect_timeout=10,
        )
        return DBClient(connection, "psycopg2")


def questdb_report(client: DBClient) -> Tuple[List[Tuple[Any, ...]], int]:
    tables = client.query(
        """
        SELECT table_name, table_row_count
        FROM tables()
        WHERE table_type = 'T'
        ORDER BY table_name
        """
    )
    rows: List[Tuple[Any, ...]] = []
    for table_name, row_count in tables:
        literal = str(table_name).replace("'", "''")
        partitions = client.query(
            f"SELECT coalesce(sum(diskSize), 0) FROM table_partitions('{literal}')"
        )
        disk_bytes = int(partitions[0][0] or 0)
        rows.append((str(table_name), int(row_count or 0), disk_bytes))

    rows.sort(key=lambda row: (-int(row[2]), str(row[0])))
    return rows, sum(int(row[2]) for row in rows)


def merged_environment(env_file: str) -> Dict[str, str]:
    environment = load_env_file(env_file)
    environment.update(os.environ)
    return environment


def mysql_configs(environment: Dict[str, str]) -> List[Tuple[str, str, int, str, str]]:
    configs: List[Tuple[str, str, int, str, str]] = []
    for suffix in ("", "_EXCHANGE"):
        database = environment.get(f"MYSQL_DB{suffix}")
        user = environment.get(f"MYSQL_USER{suffix}")
        password = environment.get(f"MYSQL_PASS{suffix}")
        if not database or not user or password is None:
            continue
        host = environment.get(f"MYSQL_HOST{suffix}", "127.0.0.1")
        port = int(environment.get(f"MYSQL_PORT{suffix}", "3306"))
        configs.append((database, host, port, user, password))
    return configs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Print QuestDB and MySQL table sizes")
    parser.add_argument("--env-file", default=".env", help="Environment file (default: .env)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    environment = merged_environment(args.env_file)
    failures: List[str] = []

    print("QuestDB table sizes (table_partitions.diskSize)")
    try:
        questdb = connect_questdb(environment)
        try:
            rows, total = questdb_report(questdb)
            print_table(
                ("table", "rows", "size", "bytes"),
                [(name, f"{count:,}", format_bytes(size), f"{size:,}") for name, count, size in rows],
            )
            print(f"QuestDB total: {format_bytes(total)} ({total:,} bytes)\n")
        finally:
            questdb.close()
    except Exception as exc:
        failures.append(f"QuestDB: {exc}")
        print(f"ERROR: {exc}\n", file=sys.stderr)

    configs = mysql_configs(environment)
    if not configs:
        failures.append("MySQL: no complete MYSQL_* database configuration found")

    for database, host, port, user, password in configs:
        print(f"MySQL {database} table sizes (TABLE_ROWS is an InnoDB estimate)")
        try:
            mysql = connect_mysql(host, port, user, password)
            try:
                rows, total = mysql_report(mysql, database)
                print_table(
                    ("table", "estimated rows", "data", "indexes", "total"),
                    [
                        (
                            name,
                            f"{int(count or 0):,}",
                            format_bytes(int(data or 0)),
                            format_bytes(int(indexes or 0)),
                            format_bytes(int(size or 0)),
                        )
                        for name, count, data, indexes, size in rows
                    ],
                )
                print(f"MySQL {database} total: {format_bytes(total)} ({total:,} bytes)\n")
            finally:
                mysql.close()
        except Exception as exc:
            failures.append(f"MySQL {database}: {exc}")
            print(f"ERROR: {exc}\n", file=sys.stderr)

    if failures:
        print("Failed sources:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())