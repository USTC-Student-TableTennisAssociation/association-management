"""MinerU 独立解析与基准命令。"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from sydaris_mineru.adapter import normalize_mineru_output
from sydaris_mineru.benchmark import run_benchmark, write_benchmark_report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sydaris-mineru", description="独立运行 MinerU 并保存 Sydaris 基准产物"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("doctor", help="检查 MinerU、Torch 和 CUDA 环境")

    parse = subparsers.add_parser("parse", help="解析一份 PDF 并生成 Sydaris 适配产物")
    parse.add_argument("--pdf", type=Path, required=True)
    parse.add_argument("--output", type=Path, default=Path(".cold-start/mineru-runs"))
    parse.add_argument(
        "--backend",
        choices=("pipeline", "vlm-engine", "hybrid-engine"),
        default="hybrid-engine",
    )
    parse.add_argument("--effort", choices=("medium", "high"), default="medium")
    parse.add_argument("--method", choices=("auto", "txt", "ocr"), default="auto")
    parse.add_argument("--image-analysis", action=argparse.BooleanOptionalAction, default=None)
    parse.add_argument("--profile", type=Path, help="可选的 JSON 回归检查配置")
    parse.add_argument("--strict", action="store_true", help="存在未通过检查时返回非零状态")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "doctor":
        raise SystemExit(_doctor())
    raise SystemExit(_parse(args))


def _doctor() -> int:
    executable = shutil.which("mineru")
    print(f"Python: {sys.version.split()[0]} ({sys.executable})")
    print(f"MinerU CLI: {executable or '未找到'}")
    try:
        mineru_version = importlib.metadata.version("mineru")
    except importlib.metadata.PackageNotFoundError:
        mineru_version = "未安装"
    print(f"MinerU: {mineru_version}")
    try:
        import torch

        print(f"Torch: {torch.__version__}")
        print(f"CUDA runtime: {torch.version.cuda}")
        print(f"CUDA available: {torch.cuda.is_available()}")
        if torch.cuda.is_available():
            print(f"GPU: {torch.cuda.get_device_name(0)}")
    except ImportError:
        print("Torch: 未安装")
    return 0 if executable and mineru_version != "未安装" else 1


def _parse(args: argparse.Namespace) -> int:
    source_pdf = args.pdf.expanduser().resolve()
    if not source_pdf.is_file() or source_pdf.suffix.lower() != ".pdf":
        print(f"输入不是可读 PDF：{source_pdf}", file=sys.stderr)
        return 1
    if args.profile and not args.profile.expanduser().resolve().is_file():
        print(f"回归检查配置不存在：{args.profile}", file=sys.stderr)
        return 1
    executable = shutil.which("mineru")
    if not executable:
        print("未找到 mineru；请先执行 uv sync --python 3.11 --extra mineru", file=sys.stderr)
        return 1

    source_hash = _sha256(source_pdf)
    run_id = f"{datetime.now(UTC):%Y%m%dT%H%M%S%fZ}-{source_hash[:10]}"
    run_directory = args.output.expanduser().resolve() / run_id
    raw_directory = run_directory / "mineru-raw"
    raw_directory.mkdir(parents=True)
    log_path = run_directory / "mineru.log"
    command = _mineru_command(executable, source_pdf, raw_directory, args)
    metadata = {
        "status": "running",
        "source_pdf": str(source_pdf),
        "sha256": source_hash,
        "command": command,
        "started_at": datetime.now(UTC).isoformat(),
    }
    _write_run_metadata(run_directory, metadata)

    print(f"[MinerU] 运行目录：{run_directory}")
    print(f"[MinerU] 原始产物：{raw_directory}")
    print(f"[MinerU] 命令：{subprocess.list2cmdline(command)}")
    return_code = _stream_process(command, log_path)
    if return_code != 0:
        metadata.update(
            status="failed", exit_code=return_code, finished_at=datetime.now(UTC).isoformat()
        )
        _write_run_metadata(run_directory, metadata)
        print(f"[MinerU] 解析失败，完整日志：{log_path}", file=sys.stderr)
        return return_code

    try:
        mineru_version = importlib.metadata.version("mineru")
        document = normalize_mineru_output(
            source_pdf=source_pdf,
            raw_directory=raw_directory,
            run_directory=run_directory,
            mineru_version=mineru_version,
            backend=args.backend,
            effort=args.effort,
            method=args.method,
        )
        report = run_benchmark(
            document=document,
            markdown_path=run_directory / "parsed-document.md",
            profile_path=args.profile.expanduser().resolve() if args.profile else None,
        )
        write_benchmark_report(report, run_directory)
    except Exception as error:
        metadata.update(
            status="adapter_failed",
            error=f"{type(error).__name__}: {error}",
            finished_at=datetime.now(UTC).isoformat(),
        )
        _write_run_metadata(run_directory, metadata)
        print(f"[Sydaris 适配] 失败：{error}", file=sys.stderr)
        print(f"[Sydaris 适配] MinerU 原始产物仍保留在：{raw_directory}", file=sys.stderr)
        return 1

    metadata.update(
        status="completed",
        exit_code=0,
        finished_at=datetime.now(UTC).isoformat(),
        benchmark_summary=report["summary"],
    )
    _write_run_metadata(run_directory, metadata)
    print(f"[完成] Markdown：{run_directory / 'parsed-document.md'}")
    print(f"[完成] Sydaris 文档：{run_directory / 'sydaris-document.json'}")
    print(f"[完成] 检查报告：{run_directory / 'benchmark-report.md'}")
    return 2 if args.strict and report["summary"]["failed"] else 0


def _mineru_command(
    executable: str, source_pdf: Path, raw_directory: Path, args: argparse.Namespace
) -> list[str]:
    command = [
        executable,
        "-p",
        str(source_pdf),
        "-o",
        str(raw_directory),
        "-b",
        args.backend,
        "--effort",
        args.effort,
        "-m",
        args.method,
    ]
    if args.image_analysis is not None:
        command.extend(("--image-analysis", str(args.image_analysis).lower()))
    return command


def _stream_process(command: list[str], log_path: Path) -> int:
    environment = os.environ.copy()
    environment.setdefault("PYTHONUTF8", "1")
    environment.setdefault("PYTHONIOENCODING", "utf-8")
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
        )
        assert process.stdout is not None
        try:
            for line in process.stdout:
                print(line, end="")
                log.write(line)
                log.flush()
        except KeyboardInterrupt:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise
        return process.wait()


def _sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_run_metadata(run_directory: Path, value: dict[str, object]) -> None:
    (run_directory / "run.json").write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
