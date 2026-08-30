"""调用 MinerU，并把稳定 content_list 转为冷启动来源块。"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import shutil
import subprocess
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

from cold_start.document.models import ParsedBlock, ParsedDocument, ParsedPage

MinerUBackend = Literal["pipeline", "vlm-engine", "hybrid-engine"]
MinerUEffort = Literal["medium", "high"]
MinerUMethod = Literal["auto", "txt", "ocr"]


class MinerUDocumentLoader:
    """用 MinerU 解析 PDF 和 Office 文档，并直接消费其稳定块列表。"""

    SUPPORTED_SUFFIXES = frozenset({".pdf", ".docx", ".pptx", ".xlsx"})

    def __init__(
        self,
        *,
        backend: MinerUBackend | None = None,
        effort: MinerUEffort | None = None,
        method: MinerUMethod | None = None,
        image_analysis: bool | None = None,
        progress: Callable[[str], None] | None = None,
    ) -> None:
        self.backend = self._choice(
            backend or os.getenv("COLD_START_MINERU_BACKEND", "hybrid-engine"),
            {"pipeline", "vlm-engine", "hybrid-engine"},
            "COLD_START_MINERU_BACKEND",
        )
        self.effort = self._choice(
            effort or os.getenv("COLD_START_MINERU_EFFORT", "high"),
            {"medium", "high"},
            "COLD_START_MINERU_EFFORT",
        )
        self.method = self._choice(
            method or os.getenv("COLD_START_MINERU_METHOD", "auto"),
            {"auto", "txt", "ocr"},
            "COLD_START_MINERU_METHOD",
        )
        self.image_analysis = (
            self._environment_bool("COLD_START_MINERU_IMAGE_ANALYSIS", True)
            if image_analysis is None
            else image_analysis
        )
        self.progress = progress or (lambda _message: None)

    @property
    def parser_name(self) -> str:
        image_mode = "image-analysis" if self.image_analysis else "no-image-analysis"
        return f"mineru-{self.backend}-{self.effort}-{image_mode}"

    def accelerator_description(self) -> str:
        """报告当前 Python 环境中 MinerU 能看到的主要计算设备。"""

        try:
            import torch
        except ImportError:
            return "未知（当前环境未安装 Torch）"
        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0)
            return f"cuda:0（{name}，CUDA {torch.version.cuda}）"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
        return "cpu"

    def load(self, source_path: Path, *, raw_output_directory: Path) -> ParsedDocument:
        path = source_path.expanduser().resolve()
        self._validate_path(path)
        executable = shutil.which("mineru")
        if executable is None:
            raise RuntimeError("未找到 mineru 命令；请先在 cold-start 目录执行 uv sync")

        raw_directory = raw_output_directory.expanduser().resolve()
        raw_directory.mkdir(parents=True, exist_ok=False)
        log_path = raw_directory.parent / "mineru.log"
        command = self._command(executable, path, raw_directory)
        self.progress(f"MinerU 命令：{subprocess.list2cmdline(command)}")
        return_code = self._stream_process(command, log_path)
        if return_code != 0:
            raise RuntimeError(
                f"MinerU 解析失败（退出码 {return_code}），完整日志：{log_path}"
            )
        self.progress("MinerU 推理完成，开始读取稳定 content_list")
        return self._load_content_list(path, raw_directory)

    def _command(
        self,
        executable: str,
        source_path: Path,
        raw_directory: Path,
    ) -> list[str]:
        return [
            executable,
            "-p",
            str(source_path),
            "-o",
            str(raw_directory),
            "-b",
            self.backend,
            "--effort",
            self.effort,
            "-m",
            self.method,
            "--image-analysis",
            str(self.image_analysis).lower(),
        ]

    def _stream_process(self, command: list[str], log_path: Path) -> int:
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
            for line in process.stdout:
                log.write(line)
                log.flush()
                message = line.strip()
                if message:
                    self.progress(message)
            return process.wait()

    def _load_content_list(
        self,
        source_path: Path,
        raw_directory: Path,
    ) -> ParsedDocument:
        content_list_path = self._find_content_list(raw_directory)
        raw_items = json.loads(content_list_path.read_text(encoding="utf-8"))
        if not isinstance(raw_items, list):
            raise ValueError(f"MinerU content_list 顶层必须是数组：{content_list_path}")

        run_directory = raw_directory.parent
        page_counts: Counter[int] = Counter()
        heading_stack: list[str] = []
        blocks: list[ParsedBlock] = []
        page_markdown: dict[int, list[str]] = {}
        for item in raw_items:
            if not isinstance(item, dict):
                raise ValueError("MinerU content_list 包含非对象项目")
            page_index = item.get("page_idx")
            if not isinstance(page_index, int) or page_index < 0:
                raise ValueError("MinerU content_list 项缺少有效 page_idx")
            source_type = str(item.get("type") or "unknown")
            text = self._block_text(item)
            asset_path = self._asset_path(
                item,
                content_list_directory=content_list_path.parent,
                run_directory=run_directory,
            )
            if not text and not asset_path:
                continue

            page_number = page_index + 1
            page_counts[page_number] += 1
            heading_level = self._heading_level(item)
            block_type = self._block_type(source_type, heading_level)
            markdown = self._block_markdown(
                source_type=source_type,
                text=text,
                heading_level=heading_level,
                asset_path=asset_path,
            )
            if block_type == "heading":
                assert heading_level is not None
                heading_stack = heading_stack[: heading_level - 1]
                heading_stack.append(text)
            bbox = self._bbox(item.get("bbox"))
            blocks.append(
                ParsedBlock(
                    block_id=f"p{page_number:04d}-b{page_counts[page_number]:04d}",
                    order=len(blocks),
                    block_type=block_type,
                    source_pages=(page_number,),
                    heading_level=heading_level,
                    heading_path=tuple(heading_stack),
                    source_type=source_type,
                    source_sub_type=(
                        str(item["sub_type"]) if item.get("sub_type") else None
                    ),
                    bbox=bbox,
                    asset_path=asset_path,
                    markdown=markdown,
                )
            )
            page_markdown.setdefault(page_number, []).append(markdown)

        if not blocks:
            raise ValueError("MinerU content_list 没有可用内容块")
        pages = tuple(
            ParsedPage(
                page_number=page_number,
                markdown="\n\n".join(page_markdown.get(page_number, ())).strip(),
            )
            for page_number in range(1, max(page_markdown) + 1)
        )
        markdown = "\n\n".join(
            f"<!-- Page {page.page_number} -->\n\n{page.markdown}" for page in pages
        ).strip()
        file_sha256 = hashlib.sha256(source_path.read_bytes()).hexdigest()
        try:
            version = importlib.metadata.version("mineru")
        except importlib.metadata.PackageNotFoundError:
            version = "unknown"
        return ParsedDocument(
            source_path=source_path,
            title=source_path.stem,
            file_sha256=file_sha256,
            parser_name=f"mineru-{version}-{self.backend}-{self.effort}",
            pages=pages,
            blocks=tuple(blocks),
            markdown=markdown,
        )

    @staticmethod
    def _find_content_list(directory: Path) -> Path:
        candidates = sorted(
            path
            for path in directory.rglob("*_content_list.json")
            if not path.name.endswith("_content_list_v2.json")
        )
        if len(candidates) != 1:
            rendered = ", ".join(str(path) for path in candidates) or "无"
            raise ValueError(f"预期恰好一个 MinerU content_list，实际为：{rendered}")
        return candidates[0]

    @staticmethod
    def _heading_level(item: dict[str, Any]) -> int | None:
        if item.get("type") != "text":
            return None
        value = item.get("text_level")
        if isinstance(value, int) and 1 <= value <= 6:
            return value
        return None

    @staticmethod
    def _block_type(source_type: str, heading_level: int | None) -> str:
        if heading_level is not None:
            return "heading"
        return {
            "text": "paragraph",
            "list": "list",
            "table": "table",
            "image": "figure",
            "chart": "figure",
            "page_footnote": "caption",
        }.get(source_type, "other")

    @classmethod
    def _block_markdown(
        cls,
        *,
        source_type: str,
        text: str,
        heading_level: int | None,
        asset_path: str | None,
    ) -> str:
        if heading_level is not None:
            return f"{'#' * heading_level} {text}"
        if source_type in {"image", "chart"} and asset_path:
            image = f"![MinerU {source_type}]({asset_path})"
            return f"{image}\n\n{text}" if text else image
        if source_type == "code":
            return f"```\n{text}\n```"
        return text

    @staticmethod
    def _block_text(item: dict[str, Any]) -> str:
        source_type = item.get("type")
        if source_type in {
            "text",
            "equation",
            "header",
            "footer",
            "page_number",
            "aside_text",
            "page_footnote",
        }:
            return str(item.get("text") or "").strip()
        if source_type == "list":
            return "\n".join(
                str(value).strip() for value in item.get("list_items", ()) if value
            )
        if source_type == "table":
            return MinerUDocumentLoader._join_fields(
                item, "table_caption", "table_body", "table_footnote"
            )
        if source_type in {"image", "chart"}:
            return MinerUDocumentLoader._join_fields(
                item,
                f"{source_type}_caption",
                "content",
                f"{source_type}_footnote",
            )
        if source_type == "code":
            return MinerUDocumentLoader._join_fields(
                item, "code_caption", "code_body", "code_footnote"
            )
        return str(item.get("text") or item.get("content") or "").strip()

    @staticmethod
    def _join_fields(item: dict[str, Any], *names: str) -> str:
        values: list[str] = []
        for name in names:
            value = item.get(name)
            if isinstance(value, list):
                values.extend(str(part).strip() for part in value if part)
            elif value:
                values.append(str(value).strip())
        return "\n\n".join(value for value in values if value)

    @staticmethod
    def _bbox(value: Any) -> tuple[float, float, float, float] | None:
        if value is None:
            return None
        if not isinstance(value, list) or len(value) != 4:
            raise ValueError("MinerU content_list 的 bbox 不是四元数组")
        if not all(isinstance(number, int | float) for number in value):
            raise ValueError("MinerU content_list 的 bbox 含非数值")
        return tuple(float(number) for number in value)  # type: ignore[return-value]

    @staticmethod
    def _asset_path(
        item: dict[str, Any],
        *,
        content_list_directory: Path,
        run_directory: Path,
    ) -> str | None:
        value = item.get("img_path")
        if not value:
            return None
        path = Path(str(value))
        resolved = path if path.is_absolute() else content_list_directory / path
        try:
            return resolved.resolve().relative_to(run_directory).as_posix()
        except ValueError as error:
            raise ValueError(f"MinerU 资源路径越出运行目录：{resolved}") from error

    @staticmethod
    def _choice(value: str, allowed: set[str], variable: str) -> Any:
        if value not in allowed:
            raise ValueError(f"{variable} 只支持：{', '.join(sorted(allowed))}")
        return value

    @staticmethod
    def _environment_bool(name: str, default: bool) -> bool:
        value = os.getenv(name)
        if value is None:
            return default
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
        raise ValueError(f"{name} 必须是 true 或 false")

    @staticmethod
    def _validate_path(path: Path) -> None:
        if not path.is_file():
            raise FileNotFoundError(f"文档不存在：{path}")
        if path.suffix.lower() not in MinerUDocumentLoader.SUPPORTED_SUFFIXES:
            supported = "、".join(sorted(MinerUDocumentLoader.SUPPORTED_SUFFIXES))
            raise ValueError(f"MinerU 解析入口只支持 {supported}：{path}")
