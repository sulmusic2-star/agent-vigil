"""vigil-probe command line.

    vigil-probe audit  <spec.toml>     audit one task's grader against the catalog
    vigil-probe screen <diff|->        statically screen a rollout/PR diff
    vigil-probe demo                   run the bundled demo environments
    vigil-probe list                   print the probe catalog and signatures
    vigil-probe version

Exit codes are CI-friendly: `audit` exits 1 when the grader is HACKABLE and 2
when INCONCLUSIVE; `screen` exits 1 when a finding at/above --fail-on is present.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

from . import report
from .audit import audit
from .probes import catalog
from .screen import SIGNATURES, screen_diff
from .spec import SpecError, load_spec
from .version import __version__

_SEVERITY_RANK = {"medium": 1, "high": 2, "critical": 3}


def _cmd_audit(args: argparse.Namespace) -> int:
    try:
        spec = load_spec(args.spec)
    except SpecError as exc:
        print(f"vigil-probe: spec error: {exc}", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="vigil-probe-") as tmp:
        work_root = Path(args.work_dir) if args.work_dir else Path(tmp)
        result = audit(spec, work_root)
    text = report.render(result, args.format)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"vigil-probe: wrote {args.format} report to {args.out}", file=sys.stderr)
    else:
        print(text)
    if result.verdict == "INCONCLUSIVE":
        return 2
    return 1 if result.hackable else 0


def _read_diff(source: str) -> str:
    if source == "-":
        return sys.stdin.read()
    return Path(source).read_text(encoding="utf-8")


def _cmd_screen(args: argparse.Namespace) -> int:
    diff = _read_diff(args.diff)
    findings = screen_diff(diff)
    threshold = _SEVERITY_RANK[args.fail_on]
    if args.format == "json":
        import json
        print(json.dumps({
            "tool": "vigil-probe", "version": __version__,
            "findings": [f.__dict__ for f in findings],
        }, indent=2))
    else:
        if not findings:
            print("vigil-probe screen: no reward-hack signatures found.")
        for f in findings:
            print(f"  [{f.severity:^8}] {f.path}:{f.line_no}  {f.signature_id}  {f.message}")
            print(f"             + {f.excerpt}")
    blocking = [f for f in findings if _SEVERITY_RANK[f.severity] >= threshold]
    return 1 if blocking else 0


def _cmd_demo(args: argparse.Namespace) -> int:
    demo_root = Path(__file__).resolve().parent / "demo_environments"
    specs = sorted(demo_root.glob("*/spec.toml"))
    if not specs:
        print("vigil-probe: no demo environments packaged", file=sys.stderr)
        return 2
    worst = 0
    for spec_path in specs:
        spec = load_spec(spec_path)
        with tempfile.TemporaryDirectory(prefix="vigil-probe-") as tmp:
            result = audit(spec, Path(tmp))
        print(report.to_text(result))
        print("-" * 60)
        worst = max(worst, {"ROBUST": 0, "HACKABLE": 1, "INCONCLUSIVE": 2}[result.verdict])
    return 0  # demo always exits 0; it is illustrative, not a gate


def _cmd_list(args: argparse.Namespace) -> int:
    print("Executable probes (vigil-probe audit):\n")
    for p in catalog(grader_paths=("run_tests.sh",)):
        print(f"  {p.id:<26} {p.severity:<8} {p.title}")
    print("\nStatic signatures (vigil-probe screen):\n")
    for s in SIGNATURES:
        print(f"  {s.id:<26} {s.severity:<8} {s.message}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="vigil-probe",
        description="Independent robustness auditor for AI coding graders.",
    )
    parser.add_argument("--version", action="version", version=f"vigil-probe {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    a = sub.add_parser("audit", help="audit one task's grader against the probe catalog")
    a.add_argument("spec", help="path to a task spec (.toml or .json)")
    a.add_argument("--format", choices=["text", "json", "markdown"], default="text")
    a.add_argument("--out", help="write the report to a file instead of stdout")
    a.add_argument("--work-dir", help="directory for disposable workspace copies")
    a.set_defaults(func=_cmd_audit)

    s = sub.add_parser("screen", help="statically screen a diff for reward-hack signatures")
    s.add_argument("diff", help="path to a unified diff, or - for stdin")
    s.add_argument("--format", choices=["text", "json"], default="text")
    s.add_argument("--fail-on", choices=["medium", "high", "critical"], default="high")
    s.set_defaults(func=_cmd_screen)

    d = sub.add_parser("demo", help="run the bundled demo environments")
    d.set_defaults(func=_cmd_demo)

    listing = sub.add_parser("list", help="print the probe catalog and screen signatures")
    listing.set_defaults(func=_cmd_list)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
