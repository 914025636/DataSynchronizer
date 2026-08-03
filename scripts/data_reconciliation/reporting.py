from __future__ import annotations

import csv
import json
from dataclasses import asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Sequence, Tuple

from .models import QualityInterval


def write_report(summary: Mapping[str, Any], intervals: Sequence[QualityInterval], output_dir: Path) -> Tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    json_path = output_dir / f"market-data-reconciliation-{stamp}.json"
    csv_path = output_dir / f"orderbook-quality-intervals-{stamp}.csv"
    payload = dict(summary)
    payload["orderbook_intervals"] = [asdict(item) for item in intervals]
    json_path.write_text(json.dumps(payload, indent=2, default=_json_default), encoding="utf-8")
    fieldnames = ["start_timestamp", "end_timestamp", "status", "reason", "start_sequence", "end_sequence", "evidence"]
    with csv_path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for interval in intervals:
            row = asdict(interval)
            row["status"] = interval.status.value
            row["evidence"] = json.dumps(row["evidence"], default=_json_default)
            writer.writerow(row)
    return json_path, csv_path


def _json_default(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if hasattr(value, "__dataclass_fields__"):
        return asdict(value)
    return str(value)